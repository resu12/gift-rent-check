import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPublicDatabase} from './fixtures/public-database.mjs';
import {createPublicRepository,verifiedTelegramUserId,PublicAccountError,PublicCredentialChangedError,PublicStorageLimitError,migrateLegacyOwner} from '../tgcloud/lib/public-repository.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';

const at=Date.parse('2026-10-10T12:00:00Z');
const state=name=>({version:2,next_job_id:2,attempts:[at],next_allowed_at:at+1000,
  job:{id:1,state:'partial',reason:'invocation_limit',streams:[{cursor:`${name}/opaque`,complete:false}]},
  owned_prices:{version:2,next_run_id:2,attempts:[at],next_allowed_at:at+1000,run:{id:1,wallet:'same-wallet',state:'partial',total:1,checked:0,
    targets:[{nft_address:name,collection_address:'collection',unknown:null,label:'🦋'.repeat(40)}],pending:[]},last_session:{id:'same-refresh-session-0001',run_id:1}}});
const event=(name,key='same-event')=>({key,state:state(name),job:state(name).job,records:[{kind:'listing',record:{name,price_per_day:'0.170000001'}}],
  raw_body:JSON.stringify({evidence:name}),observed_at:new Date(at).toISOString()});
const snapshot=(name,fingerprint='same-fingerprint',wallet='same-wallet')=>({version:1,source:'marketapp_personal_rent_page',currency:'GRAM',
  timezone:'UTC',volume_basis:'gross_before_fees',summary:{rent_volume:'0.17'},period_start:'2026-10-10',period_end:'2026-10-10',
  fingerprint,wallet,captured_at:new Date(at).toISOString(),name,daily:[{date:'2026-10-10',income_raw:'170000001'}]});

test('fixture tracks every additive public table and rejects invalid verified identities',t=>{
  const f=createPublicDatabase(t),source=readFileSync(new URL('../tgcloud/schema.js',import.meta.url),'utf8');
  const declared=[...source.matchAll(/table\('(public_[^']+)'/g)].map(value=>value[1]).sort();
  assert.deepEqual(f.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'public_%'").all().map(value=>value.name).sort(),declared);
  assert.equal(verifiedTelegramUserId({initData:{user:{id:101}}}),'101');
  for(const value of [undefined,null,0,-1,1.2,'001','1 OR 1=1','1;DROP TABLE public_accounts',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>createPublicRepository(f.db,value),PublicAccountError);
});

test('initial provisioning and reactivation obey the atomic account cap',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101,{maxAccounts:1}),b=f.repository(202,{maxAccounts:1});
  const attempts=await Promise.allSettled([a.ensureAccount(),b.ensureAccount()]);assert.equal(attempts.filter(value=>value.status==='fulfilled').length,1);
  const winner=attempts[0].status==='fulfilled'?a:b,loser=winner===a?b:a;
  assert.equal((await winner.deleteAccountData()).pending_cleanup,false);await loser.ensureAccount();
  await assert.rejects(winner.reactivateAccount(),PublicAccountError);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM public_accounts WHERE status='active'").get().n,1);
});
test('account metadata pins its first generation before asynchronous wallet queries',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101);await a.ensureAccount();let raced=false;
  const db={...f.db,async get(sql,args){if(!raced&&sql.includes('AS wallet_challenge_id')){
    raced=true;await a.deleteAccountData();await a.reactivateAccount();
    await f.repository(101).append(0,{key:'new-wallet',state:{version:2,job:null},records:[{kind:'settings',record:{wallet:'new-wallet'}}],observed_at:new Date(at).toISOString()});
  }return f.db.get(sql,args);}};
  const worker=createPublicRepository(db,101);await assert.rejects(worker.publicAccount(),PublicAccountError);
  assert.equal((await f.repository(101).publicAccount()).wallet,'new-wallet');
});

test('same checkpoint, event, job, run and refresh-session identities are isolated for two users',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101,{dashboardCache:true}),b=f.repository(202,{dashboardCache:true});
  for(const [repo,name] of [[a,'alpha'],[b,'beta']]) {
    assert.equal(await repo.append(0,event(name)),true);
    const next=event(name,'owned-price:1:next');next.state.owned_prices.run.checked=1;next.job=null;assert.equal(await repo.append(1,next),true);
    assert.deepEqual((await repo.read()).state,next.state);assert.equal((await repo.job(1)).streams[0].cursor,`${name}/opaque`);
    assert.equal((await repo.jobs())[0].streams[0].cursor,`${name}/opaque`);assert.equal((await repo.event('same-event'))[0].record.name,name);
    assert.deepEqual((await repo.records()).map(value=>value.record.name),[name,name]);assert.equal(await repo.ownedRefreshSession('same-refresh-session-0001'),1);
    assert.equal((await repo.ownedRefreshRun(1)).checked,1);assert.equal((await repo.ownedTargetSource(1)).run_id,1);
    await repo.saveDashboardSnapshot('identical-selection',2,1,{name,value:'🦋'.repeat(140000)});
  }
  assert.equal((await a.dashboardSnapshot('identical-selection',2,1)).name,'alpha');assert.equal((await b.dashboardSnapshot('identical-selection',2,1)).name,'beta');
  assert.deepEqual(await a.dashboardRevision(),await b.dashboardRevision());
  const physical=f.database.prepare('SELECT state_json FROM public_cloud_events WHERE user_id=? AND sequence=2').get('101');
  assert.equal(JSON.parse(physical.state_json).__checkpoint_owned_targets_sequence,1);
});

test('checkpoint references cannot resolve a source belonging only to another tenant',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101),b=f.repository(202);await a.append(0,event('alpha'));await b.ensureAccount();
  const insert=f.database.prepare('INSERT INTO public_cloud_events(row_id,user_id,sequence,event_key,state_json,job_id,job_json,records_json,raw_body,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  insert.run(JSON.stringify(['202','event',2]),'202',2,'forged',JSON.stringify({version:2,__checkpoint_job_sequence:1}),null,null,'[]',null,new Date(at).toISOString());
  await assert.rejects(b.read(),/checkpoint reference/);assert.equal(await b.ownedTargetSource(1),null);
  f.database.prepare('UPDATE public_cloud_events SET state_json=? WHERE user_id=?').run(JSON.stringify({owned_prices:{run:{id:1,wallet:'same-wallet'}},__checkpoint_owned_targets_sequence:1}),'202');
  await assert.rejects(b.read(),/owned-target/);assert.equal(await b.findOwnedTargetSource(state('alpha').owned_prices.run,3),null);
});

test('CAS and idempotency are per tenant, including concurrent equal event IDs',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101),b=f.repository(202);
  assert.deepEqual(await Promise.all([a.append(0,event('a')),b.append(0,event('b'))]),[true,true]);
  const result=await Promise.all([a.append(1,event('a1','race1')),a.append(1,event('a2','race2'))]);assert.equal(result.filter(Boolean).length,1);
  assert.equal(await a.append(2,event('replay','same-event')),false);assert.equal((await b.read()).revision,1);
  assert.equal((await a.read()).revision,2);
});

test('identical personal snapshot fingerprints and wallets remain private and independently deduplicated',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101),b=f.repository(202);
  assert.equal(await a.importPersonalAnalytics(snapshot('alpha'),'raw-a',new Date(at).toISOString()),true);
  assert.equal(await b.importPersonalAnalytics(snapshot('beta'),'raw-b',new Date(at).toISOString()),true);
  assert.equal(await a.importPersonalAnalytics(snapshot('duplicate'),'raw-other',new Date(at).toISOString()),false);
  assert.equal((await a.latestPersonalAnalytics('same-wallet')).name,'alpha');assert.equal((await b.personalAnalyticsSnapshots('same-wallet'))[0].name,'beta');
  assert.equal(await b.latestPersonalAnalytics('foreign-wallet'),null);
});

test('the same analytics fingerprint may belong to different wallets in different accounts',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101),b=f.repository(202);
  await a.importPersonalAnalytics(snapshot('alpha','same-fingerprint','alpha-wallet'),'raw-a',new Date(at).toISOString());
  await b.importPersonalAnalytics(snapshot('beta','same-fingerprint','beta-wallet'),'raw-b',new Date(at).toISOString());
  assert.equal((await a.latestPersonalAnalytics('alpha-wallet')).name,'alpha');assert.equal((await b.latestPersonalAnalytics('beta-wallet')).name,'beta');
  assert.equal(await a.latestPersonalAnalytics('beta-wallet'),null);assert.equal(await b.latestPersonalAnalytics('alpha-wallet'),null);
});

test('login attempts and encrypted session/wallet fences never accept a foreign owner',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101),b=f.repository(202),limits={cooldown_ms:60000,hourly_attempts:5};
  for(const [repo,id] of [[a,'101'],[b,'202']]) {
    assert.equal(await repo.reserveMarketappLoginAttempt({owner:id,id:'same-attempt',wallet:'same-wallet',created:at,expires:at+300000},limits),true);
    assert.equal(await repo.issueMarketappLoginAttempt('same-attempt',id,'same-wallet',`fp-${id}`,at),true);
    const fence=await repo.marketappSessionFence(id),nonce=await repo.reserveMarketappSessionNonce(id,fence.generation);
    assert.equal(await repo.storeMarketappSession(id,fence,{wallet:'same-wallet',cookie_version:nonce,ciphertext:`encrypted-${id}`,created_at:at,expires_at:at+300000},0),true);
    assert.equal((await repo.marketappLoginAttempt('same-attempt',id)).nonce_fingerprint,`fp-${id}`);
    assert.equal(await repo.consumeMarketappLoginAttempt('same-attempt',id,'same-wallet',at),true);
  }
  const old=await a.marketappSessionFence('101');await b.append(0,{...event('b'),records:[{kind:'settings',record:{wallet:'b'}}]});
  assert.equal(await a.marketappSessionIsCurrent('101',old),true);
  await a.append(0,{...event('a'),records:[{kind:'settings',record:{wallet:'a'}}]});assert.equal(await a.marketappSessionIsCurrent('101',old),false);
  for(const call of [()=>a.marketappSession('202'),()=>a.marketappSessionFence('202'),()=>a.marketappLoginAttempt('same-attempt','202'),()=>a.cancelMarketappLoginAttempt('same-attempt','202')])await assert.rejects(call,PublicAccountError);
  assert.equal((await b.marketappSession('202')).ciphertext,'encrypted-202');
});

test('startup analytics audit reads are isolated by tenant, wallet and period including unfinished reservations',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101),b=f.repository(202),limits={cooldown_ms:60000,hourly_attempts:5};
  const recorded=owner=>({version:1,flow:'analytics_refresh',state:'awaiting_approval',stage:'prepare',code:null,
    observed_at:new Date(at).toISOString(),period_days:owner==='101'?30:365,authenticated:false,analytics_refreshed:false});
  for(const [repo,owner] of [[a,'101'],[b,'202']]) {
    await repo.reserveMarketappLoginAttempt({owner,id:'same-attempt',wallet:'same-wallet',created:at,expires:at+300000},limits);
    await repo.issueMarketappLoginAttempt('same-attempt',owner,'same-wallet','synthetic-nonce',at);
    await repo.recordMarketappRefreshOutcome('same-attempt',owner,recorded(owner));
  }
  assert.equal((await a.latestMarketappRefreshAttempt('101','same-wallet',30)).created_at,at);
  assert.equal(await a.latestMarketappRefreshAttempt('101','same-wallet',365),null);
  assert.equal((await b.latestMarketappRefreshAttempt('202','same-wallet',365)).created_at,at);
  assert.equal(await b.latestMarketappRefreshAttempt('202','same-wallet',30),null);
  assert.equal(await a.pendingMarketappRefreshAttempt('101','foreign-wallet',at),null);
  assert.equal((await a.pendingMarketappRefreshAttempt('101','same-wallet',at)).attempt_id,'same-attempt');
  for(const action of [()=>a.latestMarketappRefreshAttempt('202','same-wallet',365),()=>a.pendingMarketappRefreshAttempt('202','same-wallet',at)])
    await assert.rejects(action,PublicAccountError);
  await a.cancelMarketappLoginAttempt('same-attempt','101');
  assert.equal(await a.pendingMarketappRefreshAttempt('101','same-wallet',at),null);
  assert.equal((await b.pendingMarketappRefreshAttempt('202','same-wallet',at)).attempt_id,'same-attempt');
  const created=at+900000;
  await a.reserveMarketappLoginAttempt({owner:'101',id:'unannotated',wallet:'same-wallet',created,expires:created+300000},limits);
  assert.equal((await a.latestMarketappRefreshAttempt('101','same-wallet',365)).attempt_id,'unannotated');
  assert.equal(await b.latestMarketappRefreshAttempt('202','same-wallet',30),null);
});

test('credential nonces, CAS, checkpoint gate and rotation fence retain old data after a race',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101),gen=await a.accountGeneration(),nonce=await a.reserveCredentialNonce('marketapp',gen);
  const value={credential_version:nonce.counter,ciphertext:'encrypted-key',credential_fingerprint:'a'.repeat(64),created_at:at,updated_at:at};
  assert.equal(await a.storeCredentialCAS('marketapp',gen,0,value,0),true);
  const fence={provider:'marketapp',credential_version:nonce.counter,fingerprint:value.credential_fingerprint},worker=f.repository(101,{credentialFence:fence});
  const input=event('a');await worker.append(0,input);assert.equal(input.state.job.public_credential,undefined,'append never mutates caller');
  assert.deepEqual((await a.read()).state.job.public_credential,fence);
  const next=await a.reserveCredentialNonce('marketapp',gen);assert.equal(await a.storeCredentialCAS('marketapp',gen,1,{...value,credential_version:next.counter},0),false);
  assert.equal(await a.clearCredential('marketapp',gen,0),false);assert.equal((await a.credentialStatus('marketapp')).ciphertext,'encrypted-key');
  assert.equal(await a.clearCredential('marketapp',gen,1),true);await assert.rejects(worker.append(1,event('old-response','stale-response')),PublicCredentialChangedError);
  const fresh=await a.reserveCredentialNonce('marketapp',gen),oldRow=await a.credentialStatus('marketapp');
  assert.equal(await a.storeCredentialCAS('marketapp',gen,oldRow.credential_version,{...value,credential_version:fresh.counter,credential_fingerprint:'b'.repeat(64)},1),true);
  const newWorker=f.repository(101,{credentialFence:{provider:'marketapp',credential_version:fresh.counter,fingerprint:'b'.repeat(64)}});
  const saved=await a.read();await assert.rejects(newWorker.append(saved.revision,{...event('a','resume'),state:saved.state,job:saved.state.job}),PublicCredentialChangedError);
});

test('account deletion fences in-flight work, purges in bounded pages and retains counters and shared ledgers',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101),b=f.repository(202);await a.ensureAccount();await b.append(0,event('b'));
  const gen=await a.accountGeneration(),nonce=await a.reserveCredentialNonce('marketapp',gen);
  await a.storeCredentialCAS('marketapp',gen,0,{credential_version:nonce.counter,ciphertext:'key',credential_fingerprint:'a'.repeat(64),created_at:at,updated_at:at});
  await a.marketappSessionFence('101');const sessionNonce=await a.reserveMarketappSessionNonce('101',0);await a.reserveWalletChallengeNonce('101');
  for(let i=0;i<5;i++)await a.append(i,event('a',`row:${i}`));
  const stale=f.repository(101);await stale.read();
  f.database.prepare('INSERT INTO public_provider_gates VALUES(?,?,?)').run('shared-ledger',3,'{"attempts":[1,2,3]}');
  let result=await a.deleteAccountData(1);assert.equal(result.pending_cleanup,true);await assert.rejects(stale.append(5,event('late','late')),PublicAccountError);
  await assert.rejects(f.repository(101).read(),PublicAccountError);await assert.rejects(a.reactivateAccount(),PublicAccountError);
  for(let i=0;result.pending_cleanup&&i<20;i++)result=await a.processAccountDeletion(1);assert.equal(result.pending_cleanup,false);
  const current=await a.reactivateAccount();assert.ok(current.generation>gen);assert.equal((await a.read()).revision,0);assert.deepEqual(await a.records(),[]);
  const fresh=await a.reserveCredentialNonce('marketapp',current.generation);assert.ok(fresh.counter>nonce.counter);
  assert.ok(await a.reserveMarketappSessionNonce('101',(await a.marketappSessionFence('101')).generation)>sessionNonce);
  assert.ok((await a.reserveWalletChallengeNonce('101')).counter>1);
  assert.equal((await b.event('same-event'))[0].record.name,'b');assert.equal(f.database.prepare('SELECT document FROM public_provider_gates').get().document,'{"attempts":[1,2,3]}');
});

test('atomic append fence rejects an account deleted immediately before INSERT execution',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101);await a.ensureAccount();let deleted=false;
  const db={...f.db,async run(sql,params){if(!deleted&&sql.startsWith('INSERT OR IGNORE INTO public_cloud_events')){deleted=true;f.database.prepare("UPDATE public_accounts SET generation=generation+1,status='deleted' WHERE user_id=?").run('101');}return f.db.run(sql,params);}};
  const worker=createPublicRepository(db,101);await worker.read();await assert.rejects(worker.append(0,event('a')),PublicAccountError);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_cloud_events').get().n,0);
});

test('wallet challenge is single-use, rate-limited, scoped and disconnect keeps portfolio identity',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101),b=f.repository(202);
  const value={challenge_id:'same-wallet-challenge',payload:'nonce',domain:'gift.example',created_at:at,expires_at:at+300000};
  assert.equal(await a.issueWalletChallenge('101',value),true);assert.equal(await b.issueWalletChallenge('202',value),true);
  assert.equal(await a.issueWalletChallenge('101',{...value,challenge_id:'second',created_at:at+1}),false);
  assert.equal(await a.consumeWalletChallenge('101',value.challenge_id,'wrong',at+1),null);
  assert.ok(await a.consumeWalletChallenge('101',value.challenge_id,'nonce',at+1));assert.equal(await a.consumeWalletChallenge('101',value.challenge_id,'nonce',at+1),null);
  assert.equal(await a.bindVerifiedWallet('101','same-wallet',at+1,value.challenge_id),true);
  assert.equal((await a.publicAccount()).wallet_verified_at,new Date(at+1).toISOString());
  assert.equal((await a.analyticsWalletRecords()).at(-1).record.wallet_verification,'ton_proof');
  assert.equal(await a.disconnectWallet(),true);const disconnected=await a.publicAccount();assert.equal(disconnected.wallet,'same-wallet');assert.equal(disconnected.wallet_verified_at,null);
  assert.ok(await b.consumeWalletChallenge('202',value.challenge_id,'nonce',at+1));assert.equal(await b.bindVerifiedWallet('202','other-wallet',at+1,value.challenge_id),true);
  assert.equal(await a.bindVerifiedWallet('101','other-wallet',at+1,value.challenge_id),false);
  const deletion=await a.deleteAccountData();assert.equal(deletion.pending_cleanup,false);await a.reactivateAccount();
  assert.equal(await a.issueWalletChallenge('101',{...value,challenge_id:'post-deletion',created_at:at+2}),false,'deletion does not reset proof cooldown');
});

test('checkpoint maintenance and archive rebuilding preserve exact values without touching another user',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101),b=f.repository(202);
  for(let i=0;i<4;i++)await a.append(i,event('a',`owned-price:${i}`));await b.append(0,event('b'));
  const before=await a.read(),other=f.database.prepare('SELECT * FROM public_cloud_events WHERE user_id=?').all('202');
  await a.compactCheckpointJobs(4,2);await a.compactCheckpointOwnedTargets(4,2);assert.deepEqual(await a.read(),before);
  assert.deepEqual(f.database.prepare('SELECT * FROM public_cloud_events WHERE user_id=?').all('202'),other);
  assert.equal(await a.ownedRefreshSession('same-refresh-session-0001'),1);assert.equal((await a.ownedRefreshRun(1)).total,1);
});

test('account and service storage quotas refuse atomic appends without advancing or exposing private bodies',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101,{maxAccountBytes:2500,maxServiceBytes:3500}),b=f.repository(202,{maxAccountBytes:2500,maxServiceBytes:3500});
  await a.append(0,event('a'));await b.append(0,event('b'));const before=await a.read();
  await assert.rejects(a.append(1,{...event('private-sentinel','oversized'),records:[{kind:'listing',record:{value:'private-sentinel'.repeat(300)}}]}),error=>error instanceof PublicStorageLimitError&&error.code==='PUBLIC_STORAGE_LIMIT'&&!error.message.includes('private-sentinel'));
  assert.deepEqual(await a.read(),before);assert.equal(await a.event('oversized'),null);
  const big={...event('c'),records:[{kind:'listing',record:{value:'x'.repeat(2200)}}]};await assert.rejects(f.repository(303,{maxAccountBytes:3500,maxServiceBytes:3500}).append(0,big),PublicStorageLimitError);
});

test('personal captures replace obsolete same-period snapshots beyond ten refreshes and retain idempotency',async t=>{
  const f=createPublicDatabase(t),repo=f.repository(101);
  let latest;
  for(let i=0;i<24;i++) {
    latest={...snapshot(`n${i}`,`fp${i}`),captured_at:new Date(at+i*1000).toISOString()};
    assert.equal(await repo.importPersonalAnalytics(latest,'raw',new Date(at+i*1000).toISOString()),true);
  }
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_personal_rental_analytics').get().n,1);
  assert.equal((await repo.latestPersonalAnalytics('same-wallet')).name,'n23');
  assert.equal(await repo.importPersonalAnalytics(latest,'raw',new Date(at).toISOString()),false);
});

test('legacy owner migration restores bounded evidence/checkpoints and session counters while requiring a fresh public login',async t=>{
  const f=createPublicDatabase(t),old=createCloudRepository(f.db),source=event('legacy','legacy-start');await old.append(0,source);
  const next=event('legacy','owned-price:legacy-next');next.job=null;next.state.owned_prices.run.checked=1;await old.append(1,next);
  await old.importPersonalAnalytics(snapshot('legacy'),'legacy-raw',new Date(at).toISOString());
  const fence=await old.marketappSessionFence('101'),nonce=await old.reserveMarketappSessionNonce('101',fence.generation);
  await old.storeMarketappSession('101',fence,{wallet:'same-wallet',cookie_version:nonce,ciphertext:'legacy-encrypted',created_at:at,expires_at:at+300000},0);
  const physical=f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all(),logical=await old.read();
  assert.equal((await migrateLegacyOwner(f.db,'101')).status,'not_started');assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_accounts').get().n,0);
  await assert.rejects(migrateLegacyOwner(f.db,'101',{mode:'apply',confirmOwnerId:'202'}),/confirmation/);
  let result=await migrateLegacyOwner(f.db,'101',{mode:'apply',confirmOwnerId:'101',limit:1});assert.equal(result.status,'copying');
  await assert.rejects(f.repository(101).read(),PublicAccountError);
  for(let i=0;result.status!=='complete'&&i<20;i++)result=await migrateLegacyOwner(f.db,'101',{mode:'apply',confirmOwnerId:'101',limit:1});assert.equal(result.status,'complete');
  const repo=f.repository(101);assert.deepEqual(await repo.read(),logical);assert.equal((await repo.latestPersonalAnalytics('same-wallet')).name,'legacy');
  assert.equal((await repo.marketappSession('101')).nonce_counter,nonce);assert.equal((await repo.marketappSession('101')).ciphertext,null);
  assert.equal((await repo.marketappSession('101')).wallet,null);assert.equal((await repo.marketappSession('101')).cookie_version,nonce);
  assert.equal(await repo.ownedRefreshSession('same-refresh-session-0001'),1);
  assert.deepEqual(f.database.prepare('SELECT * FROM cloud_events ORDER BY sequence').all(),physical);
  assert.deepEqual(await f.repository(202).records(),[]);assert.equal((await repo.publicAccount()).wallet_verified_at,null);
});

test('legacy writes during migration keep the partial copy inaccessible',async t=>{
  const f=createPublicDatabase(t),old=createCloudRepository(f.db);await old.append(0,event('legacy'));
  await migrateLegacyOwner(f.db,'101',{mode:'apply',confirmOwnerId:'101',limit:1});await old.append(1,event('new','changed'));
  await assert.rejects(migrateLegacyOwner(f.db,'101',{mode:'apply',confirmOwnerId:'101',limit:1}),/changed during migration/);
  await assert.rejects(f.repository(101).read(),PublicAccountError);
});

test('credential revision changed immediately before commit prevents a provider response write atomically',async t=>{
  const f=createPublicDatabase(t),repo=f.repository(101),generation=await repo.accountGeneration(),nonce=await repo.reserveCredentialNonce('marketapp',generation);
  await repo.storeCredentialCAS('marketapp',generation,0,{credential_version:nonce.counter,ciphertext:'key',credential_fingerprint:'a'.repeat(64),created_at:at,updated_at:at});
  let raced=false;const db={...f.db,async run(sql,params){if(!raced&&sql.startsWith('INSERT OR IGNORE INTO public_cloud_events')){raced=true;
    f.database.prepare('UPDATE public_provider_credentials SET credential_version=credential_version+1 WHERE user_id=?').run('101');}return f.db.run(sql,params);}};
  const worker=createPublicRepository(db,101,{credentialFence:{provider:'marketapp',credential_version:nonce.counter,fingerprint:'a'.repeat(64)}});
  await worker.read();await assert.rejects(worker.append(0,event('late')),PublicCredentialChangedError);assert.equal((await repo.read()).revision,0);
});

test('challenge reservation interrupted before ledger copy still enforces the durable cooldown',async t=>{
  const f=createPublicDatabase(t);let failed=false;
  const db={...f.db,async run(sql,params){if(!failed&&sql.startsWith('INSERT OR IGNORE INTO public_wallet_attempts')){failed=true;throw Error('synthetic interruption');}return f.db.run(sql,params);}};
  const repo=createPublicRepository(db,101),value={challenge_id:'issued-once',payload:'nonce',domain:'gift.example',created_at:at,expires_at:at+300000};
  await assert.rejects(repo.issueWalletChallenge('101',value),/synthetic interruption/);
  assert.equal(await repo.issueWalletChallenge('101',{...value,challenge_id:'retry',created_at:at+1}),false);
  await repo.deleteAccountData();await repo.reactivateAccount();assert.equal(await repo.issueWalletChallenge('101',{...value,challenge_id:'after-delete',created_at:at+2}),false);
});

test('derived cache is tenant-scoped, limited to four manifests and cannot overrun configured storage',async t=>{
  const f=createPublicDatabase(t),a=f.repository(101,{dashboardCache:true,maxAccountBytes:6000,maxServiceBytes:8000}),b=f.repository(202,{dashboardCache:true,maxAccountBytes:6000,maxServiceBytes:8000});
  for(let i=0;i<7;i++)await a.saveDashboardSnapshot(`selection-${i}`,1,i,{value:`snapshot-${i}`});
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM public_dashboard_projection_cache WHERE user_id=? AND selection_key LIKE 'm:%'").get('101').n,4);
  assert.equal(await b.dashboardSnapshot('selection-6',1,6),null);
  await b.saveDashboardSnapshot('big',1,1,{private:'x'.repeat(9000)});assert.equal(await b.dashboardSnapshot('big',1,1),null);
  const total=f.database.prepare('SELECT SUM(length(CAST(snapshot_json AS BLOB))) AS bytes FROM public_dashboard_projection_cache').get().bytes;assert.ok(total<=8000);
  assert.deepEqual(await a.dashboardSnapshot('selection-6',1,6),{value:'snapshot-6'});
});

test('fenced personal analytics refuse a lost logout fence even when the snapshot already exists',async t=>{
  const f=createPublicDatabase(t),repo=f.repository(101),fence=await repo.marketappSessionFence('101'),saved=snapshot('old');
  assert.equal(await repo.importPersonalAnalyticsFenced(saved,'raw',new Date(at).toISOString(),'101',fence),true);
  await repo.clearMarketappSession('101');assert.equal(await repo.importPersonalAnalyticsFenced(saved,'raw',new Date(at).toISOString(),'101',fence),false);
  assert.equal((await repo.latestPersonalAnalytics('same-wallet')).name,'old');
});

test('account deletion wipes terminal encrypted counters without resetting their nonce high-watermarks',async t=>{
  const f=createPublicDatabase(t),repo=f.repository(101),generation=await repo.accountGeneration();await repo.reserveCredentialNonce('marketapp',generation);await repo.marketappSessionFence('101');
  f.database.prepare('UPDATE public_provider_credentials SET generation=?,nonce_counter=?,credential_version=?,ciphertext=? WHERE user_id=?').run(Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,'encrypted-credential','101');
  f.database.prepare('UPDATE public_marketapp_analytics_sessions SET generation=?,nonce_counter=?,ciphertext=? WHERE owner_id=?').run(Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,'encrypted-cookie','101');
  assert.equal((await repo.deleteAccountData()).pending_cleanup,false);await repo.reactivateAccount();
  assert.equal((await repo.credentialStatus('marketapp')).ciphertext,null);assert.equal((await repo.marketappSession('101')).ciphertext,null);
  assert.equal(await repo.reserveCredentialNonce('marketapp',(await repo.ensureAccount()).generation),null);
  assert.equal(await repo.reserveMarketappSessionNonce('101',Number.MAX_SAFE_INTEGER),null);
});

test('migration is resumable after an uncertain initial reservation and completion publication',async t=>{
  const f=createPublicDatabase(t),old=createCloudRepository(f.db);await old.append(0,event('legacy'));let failed=false;
  const db={...f.db,async run(sql,params){if(!failed&&sql.startsWith('INSERT OR IGNORE INTO public_legacy_migrations')){failed=true;throw Error('uncertain initial reservation');}return f.db.run(sql,params);}};
  await assert.rejects(migrateLegacyOwner(db,'101',{mode:'apply',confirmOwnerId:'101'}),/uncertain initial reservation/);
  let result=await migrateLegacyOwner(f.db,'101',{mode:'apply',confirmOwnerId:'101'});
  let activationFailed=false;const interrupted={...f.db,async run(sql,params){if(!activationFailed&&sql.includes("UPDATE public_accounts SET status='active'")){activationFailed=true;throw Error('uncertain activation');}return f.db.run(sql,params);}};
  await assert.rejects(migrateLegacyOwner(interrupted,'101',{mode:'apply',confirmOwnerId:'101'}),/uncertain activation/);
  assert.equal(f.database.prepare('SELECT status FROM public_accounts WHERE user_id=?').get('101').status,'migrating');
  result=await migrateLegacyOwner(f.db,'101',{mode:'apply',confirmOwnerId:'101'});assert.equal(result.status,'complete');assert.deepEqual(await f.repository(101).read(),await old.read());
});

test('migration copies oversized raw rows alone and rejects an over-quota source before writing',async t=>{
  const f=createPublicDatabase(t),old=createCloudRepository(f.db);for(let i=0;i<3;i++)await old.append(i,event('legacy',`large:${i}`));
  // Old deployments retained bodies. Seed those legacy bytes directly: new
  // appends intentionally persist only validated records and checkpoints.
  f.database.prepare('UPDATE cloud_events SET raw_body=?').run('🦋'.repeat(80000));
  let result=await migrateLegacyOwner(f.db,'101',{mode:'apply',confirmOwnerId:'101',limit:25});assert.equal(result.copied_events,1);
  for(let i=0;result.status!=='complete'&&i<10;i++)result=await migrateLegacyOwner(f.db,'101',{mode:'apply',confirmOwnerId:'101',limit:25});assert.equal(result.status,'complete');
  const large=createPublicDatabase(t),source=createCloudRepository(large.db);await source.append(0,event('large'));
  large.database.prepare('UPDATE cloud_events SET raw_body=?').run('x'.repeat(9000000));
  await assert.rejects(migrateLegacyOwner(large.db,'101',{mode:'apply',confirmOwnerId:'101'}),PublicStorageLimitError);
  assert.equal(large.database.prepare('SELECT count(*) AS n FROM public_accounts').get().n,0);
  assert.ok(!large.queries.some(query=>query.sql.includes('AS source_key')||query.sql.includes('AS content')),'capacity rejection precedes bounded snapshot reads');
});

async function legacyMigrationFixture(t) {
  const f=createPublicDatabase(t),old=createCloudRepository(f.db);await old.append(0,event('legacy'));
  await old.importPersonalAnalytics(snapshot('legacy'),'legacy-raw',new Date(at).toISOString());
  f.database.prepare('INSERT INTO marketapp_login_attempts VALUES(?,?,?,?,?,?,?,?)').run('attempt','101','same-wallet',at,at+300000,'pending',null,null);
  const fence=await old.marketappSessionFence('101');await old.reserveMarketappSessionNonce('101',fence.generation);
  f.database.prepare('INSERT INTO collector_state VALUES(?,?,?)').run(1,3,'{"version":1}');
  return f;
}
const migrationOptions={mode:'apply',confirmOwnerId:'101',limit:1};
test('late inserts and same-count source updates atomically block completion and activation',async t=>{
  const races=[
    ['analytics insert',"UPDATE public_legacy_migrations SET status='complete'",f=>f.database.prepare('INSERT INTO personal_rental_analytics VALUES(?,?,?,?,?,?)').run('late','same-wallet','time','time','raw','{}')],
    ['analytics update',"UPDATE public_legacy_migrations SET status='complete'",f=>f.database.prepare('UPDATE personal_rental_analytics SET raw_snapshot=?').run('same-size!')],
    ['attempt insert',"UPDATE public_legacy_migrations SET status='complete'",f=>f.database.prepare('INSERT INTO marketapp_login_attempts VALUES(?,?,?,?,?,?,?,?)').run('late','101','same-wallet',at,at+300000,'pending',null,null)],
    ['attempt outcome',"UPDATE public_accounts SET status='active'",f=>f.database.prepare('UPDATE marketapp_login_attempts SET outcome_json=?').run('{"state":"changed"}')],
    ['session nonce',"UPDATE public_accounts SET status='active'",f=>f.database.prepare('UPDATE marketapp_analytics_sessions SET nonce_counter=nonce_counter+1 WHERE owner_id=?').run('101')],
    ['prototype revision',"UPDATE public_accounts SET status='active'",f=>f.database.prepare('UPDATE collector_state SET revision=revision+1 WHERE id=1').run()],
    ['old event content',"UPDATE public_legacy_migrations SET status='complete'",f=>f.database.prepare('UPDATE cloud_events SET raw_body=? WHERE sequence=1').run('new evidence')],
  ];
  for(const [name,trigger,mutate] of races)await t.test(name,async child=>{
    const f=await legacyMigrationFixture(child);let injected=false;
    const db={...f.db,async run(sql,params){if(!injected&&sql.startsWith(trigger)){injected=true;mutate(f);}return f.db.run(sql,params);}};
    let refused=false;for(let i=0;i<10;i++)try{await migrateLegacyOwner(db,'101',migrationOptions);}catch(error){assert.match(error.message,/changed during migration/);refused=true;break;}
    assert.equal(injected,true);assert.equal(refused,true);assert.equal(f.database.prepare('SELECT status FROM public_accounts WHERE user_id=?').get('101').status,'migrating');
    await assert.rejects(f.repository(101).read(),PublicAccountError);assert.equal(f.database.prepare('SELECT count(*) AS n FROM cloud_events').get().n,1);
    await assert.rejects(migrateLegacyOwner(f.db,'101',migrationOptions),/changed during migration/,'retry cannot activate a changed completed source');
  });
});

test('frozen fingerprints reject same-count changes before the changed row is copied',async t=>{
  const f=await legacyMigrationFixture(t);await migrateLegacyOwner(f.db,'101',migrationOptions);
  f.database.prepare('UPDATE personal_rental_analytics SET raw_snapshot=?').run('altered');
  let refused=false;for(let i=0;i<10;i++)try{await migrateLegacyOwner(f.db,'101',migrationOptions);}catch(error){assert.match(error.message,/changed during migration/);refused=true;break;}
  assert.equal(refused,true);assert.equal(f.database.prepare('SELECT raw_snapshot FROM public_personal_rental_analytics').get().raw_snapshot,'altered');
  assert.equal(f.database.prepare('SELECT status FROM public_accounts').get().status,'migrating');
});

test('clear recovery fences an in-flight migration, preserves private source and counters, and restarts safely',async t=>{
  const f=await legacyMigrationFixture(t);await f.repository(202).append(0,event('other'));
  await migrateLegacyOwner(f.db,'101',migrationOptions);const generation=f.database.prepare('SELECT generation FROM public_accounts WHERE user_id=?').get('101').generation;
  let interrupted=false;const paused={...f.db,async run(sql,params){if(!interrupted&&sql.includes('INSERT OR IGNORE INTO public_personal_rental_analytics')){
    interrupted=true;let clear=await migrateLegacyOwner(f.db,'101',{mode:'clear',confirmOwnerId:'101',limit:1});
    while(clear.pending_cleanup)clear=await migrateLegacyOwner(f.db,'101',{mode:'clear',confirmOwnerId:'101',limit:1});
  }return f.db.run(sql,params);}};
  await assert.rejects(migrateLegacyOwner(paused,'101',migrationOptions));assert.equal(interrupted,true);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_cloud_events WHERE user_id=?').get('101').n,0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM cloud_events').get().n,1);
  assert.equal((await f.repository(202).event('same-event'))[0].record.name,'other');
  let result;for(let i=0;i<10;i++){result=await migrateLegacyOwner(f.db,'101',migrationOptions);if(result.status==='complete')break;}
  assert.equal(result.status,'complete');assert.ok(f.database.prepare('SELECT generation FROM public_accounts WHERE user_id=?').get('101').generation>generation);
  const session=await f.repository(101).marketappSession('101');assert.ok(session.nonce_counter>=1);assert.equal(session.ciphertext,null);
  await assert.rejects(migrateLegacyOwner(f.db,'101',{mode:'clear',confirmOwnerId:'101'}),/inaccessible partial/);
});

test('clear racing activation cannot delete an active completed account',async t=>{
  const f=await legacyMigrationFixture(t);await migrateLegacyOwner(f.db,'101',migrationOptions);let raced=false;
  const db={...f.db,async run(sql,params){if(!raced&&sql.startsWith("UPDATE public_accounts SET generation=generation+1,status='deleting'")){
    raced=true;f.database.prepare("UPDATE public_accounts SET status='active' WHERE user_id=?").run('101');
  }return f.db.run(sql,params);}};
  await assert.rejects(migrateLegacyOwner(db,'101',{mode:'clear',confirmOwnerId:'101'}),/inaccessible partial/);
  assert.equal(raced,true);assert.equal(f.database.prepare('SELECT status FROM public_accounts WHERE user_id=?').get('101').status,'active');
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM public_cloud_events WHERE user_id=?').get('101').n,1);
});
