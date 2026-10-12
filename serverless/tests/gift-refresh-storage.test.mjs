import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createGiftRefreshStorage,giftRefreshSessionKey} from '../tgcloud/lib/gift-refresh-storage.js';
import {createCloudRepository} from '../tgcloud/lib/cloud-repository.js';
function fixture(t){
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());
  database.exec(`CREATE TABLE cloud_events(sequence INTEGER PRIMARY KEY,event_key TEXT NOT NULL,state_json TEXT NOT NULL,
    job_id INTEGER,job_json TEXT,records_json TEXT NOT NULL,raw_body TEXT,observed_at TEXT NOT NULL);
    CREATE TABLE collector_state(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,document TEXT NOT NULL);`);
  const db={async get(sql,params={}){return database.prepare(sql).get(params)||null;},async all(sql,params={}){return database.prepare(sql).all(params);},async run(sql,params={}){return {rowsAffected:Number(database.prepare(sql).run(params).changes)};}};
  const storage=createGiftRefreshStorage(db),repository=createCloudRepository(db);
  function event(sequence,key,run,records=[]){database.prepare('INSERT INTO cloud_events VALUES(?,?,?,?,?,?,?,?)').run(sequence,key,JSON.stringify({version:2,gift_refresh:{run}}),null,null,JSON.stringify(records),null,'2026-10-11T12:00:00.000Z');}
  function bind(sequence,session,run){event(sequence,giftRefreshSessionKey(session),run,[{kind:'gift_refresh_session',record:{session_id:session,run_id:run.id}}]);}
  return {database,storage,repository,event,bind};
}
test('gift refresh session keys are fixed content addresses and do not expose the raw browser identifier',()=>{
  const key=giftRefreshSessionKey('synthetic-browser-session');assert.match(key,/^gift-refresh-session:[0-9a-f]{64}$/);assert.equal(key.includes('synthetic'),false);
  assert.equal(giftRefreshSessionKey('synthetic-browser-session'),key);assert.notEqual(giftRefreshSessionKey('synthetic-browser-session-2'),key);
});
test('permanent browser bindings retain their original run when active refresh is replaced',async t=>{
  const f=fixture(t),first={id:1,state:'running',provider:'marketapp_website',checked:0};f.bind(1,'first-browser-session',first);
  f.event(2,'gift-refresh:2',{...first,state:'complete',checked:161});
  const next={id:2,state:'running',provider:'toncenter',checked:0};f.bind(3,'second-browser-session',next);
  assert.equal(await f.storage.giftRefreshSession('first-browser-session'),1);
  assert.equal(await f.storage.giftRefreshSession('second-browser-session'),2);
  assert.equal(await f.storage.giftRefreshSession('unknown-browser-session'),null);
  assert.deepEqual(await f.storage.giftRefreshRun(1),{...first,state:'complete',checked:161});
  assert.deepEqual(await f.storage.giftRefreshRun(2),next);
  assert.equal(await f.storage.giftRefreshRun(999),null);
  assert.equal(await f.repository.giftRefreshSession('first-browser-session'),1);
  assert.deepEqual(await f.repository.giftRefreshRun(1),{...first,state:'complete',checked:161});
});
test('lookup excludes unrelated collector checkpoints and malformed JSON without confusing latest website progress',async t=>{
  const f=fixture(t),run={id:17,state:'running',checked:1};f.bind(1,'browser-session-17',run);
  f.event(2,'collector:2',{...run,checked:99});
  f.database.prepare('INSERT INTO cloud_events VALUES(3,?,?,?,?,?,?,?)').run('gift-refresh:bad','synthetic malformed state',null,null,'[]',null,'2026-10-11T12:00:00.000Z');
  assert.deepEqual(await f.storage.giftRefreshRun(17),run);
  f.event(4,'gift-refresh:4',{...run,state:'partial',checked:12});assert.equal((await f.storage.giftRefreshRun(17)).checked,12);
});
test('corrupt or mismatched session bindings cannot resolve as an approved refresh',async t=>{
  const f=fixture(t);
  for(const [index,binding] of [{session_id:'other-session',run_id:1},{session_id:'saved-session-1',run_id:0},{session_id:'saved-session-2',run_id:1.5},{session_id:'saved-session-3',run_id:'1'}].entries()){
    const id=`saved-session-${index}`;f.event(index+1,giftRefreshSessionKey(id),{id:1},[{record:binding}]);await assert.rejects(f.storage.giftRefreshSession(id),/Invalid saved gift refresh binding/);
  }
});
test('a committed binding cannot be reinterpreted by page replay and an event CAS retains the newest checkpoint',async t=>{
  const f=fixture(t),first={id:1,state:'running',checked:0};f.bind(1,'same-session',first);
  const previous=await f.repository.read();
  const replay={key:giftRefreshSessionKey('same-session'),state:{...previous.state,gift_refresh:{run:{id:2,state:'running'}}},records:[{kind:'gift_refresh_session',record:{session_id:'same-session',run_id:2}}],observed_at:'2026-10-11T12:00:01.000Z'};
  assert.equal(await f.repository.append(previous.revision,replay),false);
  assert.equal(await f.storage.giftRefreshSession('same-session'),1);assert.deepEqual(await f.storage.giftRefreshRun(1),first);
  assert.equal(await f.repository.append(previous.revision,{...replay,key:'gift-refresh:next',state:{...previous.state,gift_refresh:{run:{...first,checked:80}}},records:[]}),true);
  assert.equal(await f.repository.append(previous.revision,{...replay,key:'gift-refresh:stale'}),false);
  assert.equal((await f.storage.giftRefreshRun(1)).checked,80);assert.equal(await f.storage.giftRefreshRun(2),null);
});
