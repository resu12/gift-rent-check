import test from 'node:test';
import assert from 'node:assert/strict';
import {expectedCounts, validateVerificationDestination, validateVerificationResult, VERIFICATION_SOURCE} from '../tools/verify-deployment.mjs';

test('verification pins explicit production app and official transport', () => {
  assert.doesNotThrow(() => validateVerificationDestination('app54321:synthetic', '54321', {}));
  assert.doesNotThrow(() => validateVerificationDestination('app65432:synthetic', '65432', {}));
  assert.throws(() => validateVerificationDestination('app123:synthetic', '54321', {}));
  assert.throws(() => validateVerificationDestination('app54321:synthetic', undefined, {}));
  assert.throws(() => validateVerificationDestination('app54321:synthetic', '54321', {TG_CLOUD_API_URL:'https://example.test'}));
  assert.throws(() => validateVerificationDestination('app54321:synthetic', '54321', {TGCLOUD_BETA:'1'}));
});

test('verification membership expectations are explicit and permit empty datasets', () => {
  assert.deepEqual(expectedCounts(['--expect-portfolio', '7', '--expect-unresolved', '2']), {portfolio: 7, unresolved: 2});
  assert.deepEqual(expectedCounts(['--expect-portfolio', '0', '--expect-unresolved', '0']), {portfolio: 0, unresolved: 0});
  assert.throws(() => expectedCounts([]));
  assert.throws(() => expectedCounts(['--expect-portfolio', '7']));
  for (const value of ['-1', '1.5', 'Infinity', 'NaN', '9007199254740992', '', ' ', '7\n']) {
    assert.throws(() => expectedCounts(['--expect-portfolio', value, '--expect-unresolved', '0']));
  }
});

test('verification result requires expected membership, auth, selection and unchanged state', () => {
  const selection={source:'rentals',timeframe:'30d',backdrop:'Black'};
  const result={verified:true,database_unchanged:true,provider_ledger_unchanged:true,
    ...selection,portfolio_gifts:7,unresolved_candidates:2,gift_rows:9,
    authorization:{dashboard_missing:true,dashboard_foreign:true,jobs_missing:true,jobs_foreign:true},db_sequence:152,provider_ledger_entries:20};
  const expected={portfolio:7,unresolved:2};
  assert.doesNotThrow(()=>validateVerificationResult(result,selection,expected));
  for(const patch of [{verified:false},{portfolio_gifts:6},{gift_rows:8},{source:'listings'},
    {backdrop:null},{authorization:{dashboard_missing:true}}, {provider_ledger_unchanged:false}]) {
    assert.throws(()=>validateVerificationResult({...result,...patch},selection,expected));
  }
});

test('cloud verification wrapper only calls read endpoints and SQL selects', () => {
  assert.match(VERIFICATION_SOURCE,/import getDashboard/);
  assert.match(VERIFICATION_SOURCE,/import getJobs/);
  assert.doesNotMatch(VERIFICATION_SOURCE,/\b(?:fetch|startJob|stepJob|stopJob|resumeJob|importChunk)\b|\bdb\.(?:run|exec|all)\b/);
  assert.match(VERIFICATION_SOURCE,/SELECT sequence,state_json FROM cloud_events/);
});
