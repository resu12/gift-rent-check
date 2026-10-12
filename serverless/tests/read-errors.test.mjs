import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudReadErrorResponse} from '../tgcloud/lib/bounded-response.js';
import {portableModules} from './fixtures/portable-modules.mjs';

const result=(error,name='getDashboard')=>cloudReadErrorResponse(name,error);
const code=error=>result(error).error.code;

test('read failures recognize only explicit busy, resource and deadline categories',()=>{
  for(const value of ['SQLITE_BUSY','SQLITE_BUSY_RECOVERY','SQLITE_BUSY_SNAPSHOT','SQLITE_BUSY_TIMEOUT','SQLITE_LOCKED','SQLITE_LOCKED_SHAREDCACHE','SQLITE_LOCKED_VTAB'])
    assert.equal(code({code:value}),'READ_BUSY');
  for(const value of ['SQLITE_TOOBIG','SQLITE_NOMEM','SQLITE_IOERR_NOMEM','RESOURCE_EXHAUSTED'])
    assert.equal(code({code:value}),'READ_LIMIT');
  for(const value of ['DEADLINE_EXCEEDED','ETIMEDOUT','QUERY_TIMEOUT'])
    assert.equal(code({type:value}),'READ_TIMEOUT');
  for(const value of ['database is locked','Database table is locked','database is busy'])assert.equal(code(Error(value)),'READ_BUSY');
  for(const value of ['string or blob too big','out of memory'])assert.equal(code(Error(value)),'READ_LIMIT');
  for(const value of ['deadline exceeded','context deadline exceeded','Database query timed out','query timed out','query timeout'])assert.equal(code(Error(value)),'READ_TIMEOUT');
});

test('unknown read failures reveal only a fixed code, never error content or nested details',()=>{
  const marker='private SQL account wallet key snapshot';
  for(const error of [undefined,null,marker,{code:marker,message:marker,stack:marker,cause:{code:'SQLITE_BUSY'}},
    {code:'SQLITE_INTERRUPT'},{type:'INTERNAL',message:'interrupted'},{code:5},
    Error(`database is locked: ${marker}`),Error(`query timed out: ${marker}`),Error(`out of memory: ${marker}`),
    Error('Storage is full'),{message:{toString(){throw Error(marker);}}},
    Object.defineProperty({},'code',{get(){throw Error(marker);}})]) {
    assert.deepEqual(result(error),{error:{code:'READ_FAILED'}});
  }
  const error={code:'SQLITE_BUSY',message:marker,stack:marker,parameters:{query:marker}};
  assert.deepEqual(result(error),{error:{code:'READ_BUSY'}});
  assert.doesNotMatch(JSON.stringify(result(error)),new RegExp(marker));
});

test('read classification never adds retry semantics to mutations or other wrappers',()=>{
  for(const name of ['getDashboard','getDashboardRevision','getJobs'])assert.deepEqual(result(Error('database is locked'),name),{error:{code:'READ_BUSY'}});
  for(const name of ['startJob','stepJob','stopJob','resumeJob','refreshStartupComparisons','importChunk','importPersonalAnalytics','getStatus','status',null,undefined,'getDashboard '])
    assert.equal(cloudReadErrorResponse(name,{code:'SQLITE_BUSY'}),null);
});

test('read classification runs in the deployed bare V8 environment',()=>{
  const helper=portableModules().load('bounded-response.js');
  assert.equal(helper.cloudReadErrorResponse('getJobs',{type:'DEADLINE_EXCEEDED'}).error.code,'READ_TIMEOUT');
  assert.equal(helper.cloudReadErrorResponse('getDashboard',{message:'unknown private value'}).error.code,'READ_FAILED');
});
