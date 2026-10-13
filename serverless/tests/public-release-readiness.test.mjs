import test from 'node:test';
import assert from 'node:assert/strict';
import {publicRegistrationReadiness} from '../tgcloud/lib/storage-policy.js';
const now=1791800000000;
const config=()=>({maxAccounts:5,experimentalPersonalAnalytics:true,releaseReadiness:{verifiedDatabaseBytes:1073741824,
  capacityVerifiedAt:now,restoreVerifiedAt:now,loadTestedAt:now,loadTestedAccounts:5}});
test('unknown hosting and untested backup or concurrent capacity cannot pass release review',()=>{
  const result=publicRegistrationReadiness({maxAccounts:25},{now,requireRecent:true});
  assert.equal(result.ready,false);assert.deepEqual(result.blockers,['hosting_capacity','backup_restore','concurrent_load','account_capacity','marketapp_login']);
});
test('public release evidence must cover the selected cap and physical headroom',()=>{
  assert.equal(publicRegistrationReadiness(config(),{now,requireRecent:true}).ready,true);
  for(const [field,value,reason] of [['verifiedDatabaseBytes',536870912,'hosting_capacity'],['loadTestedAccounts',4,'concurrent_load'],['restoreVerifiedAt',now+1,'backup_restore']]) {
    const input=config();input.releaseReadiness[field]=value;assert.ok(publicRegistrationReadiness(input,{now}).blockers.includes(reason));
  }
  const input=config();input.maxAccounts=17;input.releaseReadiness.loadTestedAccounts=17;
  assert.ok(publicRegistrationReadiness(input,{now}).blockers.includes('account_capacity'));
});
test('deployment requires recent drills without disabling an already-running app when dates age',()=>{
  const input=config();input.releaseReadiness.restoreVerifiedAt=now-8*86400000;
  assert.equal(publicRegistrationReadiness(input,{now}).ready,true);
  assert.deepEqual(publicRegistrationReadiness(input,{now,requireRecent:true}).blockers,['backup_restore']);
});
