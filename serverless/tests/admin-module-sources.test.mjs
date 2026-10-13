import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {posix} from 'node:path';
import {adminModuleSources} from '../tools/admin-module-sources.mjs';

const owner='export const ownerTelegramId=42;';
const endpoint='endpoints/adminTest';

test('administration bundles exclude a full unrelated app and retain the complete import closure',()=>{
  const canonical=Object.fromEntries(Array.from({length:100},(_,i)=>['endpoints/unrelated'+i,'export default 1;']));
  Object.assign(canonical,{
    'lib/private-config':owner,
    'lib/main':"import './cycle.js'; export {value} from './reexport.js';",
    'lib/cycle':"import './main.js'; export const ready=true;",
    'lib/reexport':"export * from './vendor/value.js';",
    'lib/vendor/value':'export const value=1;',
    'endpoints/reader':"export default async()=>import('../lib/dynamic.js');",
    'lib/dynamic':'export default 2;',
    'lib/private-refresh-key':'secret not needed by this endpoint',
    schema:'unrelated schema',
  });
  const main="import {db} from 'sdk';\nimport {value} from '../lib/main.js';\nimport reader from '../endpoints/reader.js';\nimport {ownerTelegramId} from '../lib/private-config.js';\nexport default async()=>({value,ownerTelegramId});";
  const sources=adminModuleSources(canonical,{},endpoint,main);
  assert.deepEqual(Object.keys(sources).sort(),[endpoint,'endpoints/reader','lib/private-config','lib/main','lib/cycle','lib/reexport','lib/vendor/value','lib/dynamic'].sort());
  assert.equal(sources['lib/private-config'],owner);
  assert.equal(sources[endpoint],main);
  assert.equal(Object.keys(canonical).filter(name=>name.startsWith('endpoints/unrelated')).length,100);
});

test('local library overrides are used without replacing deployed authorization or credentials',()=>{
  const canonical={'lib/private-config':owner,'lib/helper':'export const value=1;'};
  const sources=adminModuleSources(canonical,{'lib/helper':'export const value=2;'},endpoint,"import '../lib/helper.js';");
  assert.equal(sources['lib/helper'],'export const value=2;');assert.equal(sources['lib/private-config'],owner);
  for(const name of ['lib/private-config','lib/private-refresh-key','lib/public-release-config'])
    assert.throws(()=>adminModuleSources(canonical,{[name]:'override'},endpoint,''),/Invalid administration library/);
  assert.throws(()=>adminModuleSources({}, {},endpoint,''),/Missing administration dependency/);
});

test('module count includes authorization and admin code bound counts UTF-8 bytes',()=>{
  const chain=count=>Object.fromEntries(Array.from({length:count},(_,i)=>['lib/m'+i,i+1<count?`import './m${i+1}.js';`:'export const end=true;']));
  const canonical={...chain(98),'lib/private-config':owner};
  assert.equal(Object.keys(adminModuleSources(canonical,{},endpoint,"import '../lib/m0.js';")).length,100);
  assert.throws(()=>adminModuleSources({...chain(99),'lib/private-config':owner},{},endpoint,"import '../lib/m0.js';"),/supported layout/);
  assert.equal(adminModuleSources({'lib/private-config':owner},{},endpoint,' '.repeat(65536))[endpoint].length,65536);
  assert.throws(()=>adminModuleSources({'lib/private-config':owner},{},endpoint,' '.repeat(65537)),/64 KiB tool limit/);
  assert.throws(()=>adminModuleSources({'lib/private-config':owner},{'lib/large':'é'.repeat(32769)},endpoint,"import '../lib/large.js';"),/64 KiB tool limit/);
  const deployedLarge='//'+ 'é'.repeat(40000);
  assert.equal(adminModuleSources({'lib/private-config':owner,'lib/large':deployedLarge},{},endpoint,"import '../lib/large.js';")['lib/large'],deployedLarge);
});

test('missing or unsupported imports fail before a hosted request',()=>{
  const canonical={'lib/private-config':owner};
  for(const specifier of ['../lib/missing.js','node:fs','../../outside.js','../lib\\private-config.js','https://example.invalid/module.js'])
    assert.throws(()=>adminModuleSources(canonical,{},endpoint,`import '${specifier}';`),/administration dependency/);
  assert.throws(()=>adminModuleSources(canonical,{},'../endpoints/admin',''),/Invalid administration endpoint/);
});

// Load only source-control-safe runtime files. Real ignored credentials are
// never read by this test, including in a developer's configured checkout.
function runtimeSources() {
  const result={};
  const privateNames=new Set(['lib/private-config','lib/private-refresh-key','lib/public-release-config']);
  function walk(directory,prefix) {
    for(const entry of readdirSync(directory,{withFileTypes:true})) {
      const name=prefix+'/'+entry.name.replace(/\.js$/,'');
      if(entry.isDirectory())walk(new URL(entry.name+'/',directory),name);
      else if(entry.name.endsWith('.js')&&!privateNames.has(name))result[name]=readFileSync(new URL(entry.name,directory),'utf8');
    }
  }
  walk(new URL('../tgcloud/lib/',import.meta.url),'lib');walk(new URL('../tgcloud/endpoints/',import.meta.url),'endpoints');
  result['lib/private-config']=owner+' export const marketappToken="synthetic";';
  result['lib/private-refresh-key']='export const marketappRefreshKey="synthetic";';
  result['lib/public-release-config']='export const publicReleaseConfig={enabled:false};';
  for(let i=0;i<100;i++)result['endpoints/unrelated'+i]='export default 1;';
  return result;
}
const tool=name=>readFileSync(new URL('../tools/'+name,import.meta.url),'utf8');
const endpointBody=(name,variable)=>{
  const match=tool(name).match(new RegExp('const '+variable+'=`([\\s\\S]*?)`;'));
  assert.ok(match,'Administrative endpoint source must be available to validate the actual bundle');return match[1];
};

test('actual analytics installer dependencies fit a full deployed application',()=>{
  const canonical=runtimeSources(),overrides={};
  for(const name of ['storage-policy','personal-analytics'])overrides['lib/'+name]=canonical['lib/'+name];
  overrides['lib/storage-accounting']=tool('storage-accounting.mjs').replaceAll("from '../tgcloud/lib/","from './");
  overrides['lib/analytics-daily-storage']=tool('analytics-daily-storage.mjs').replaceAll("from '../tgcloud/lib/","from './").replace("from './storage-accounting.mjs'","from './storage-accounting.js'");
  const sources=adminModuleSources(canonical,overrides,'endpoints/installAnalyticsDailyStorage',endpointBody('install-analytics-daily-storage.mjs','endpoint'));
  for(const name of ['storage-accounting','analytics-daily-storage','storage-admission','storage-policy','personal-analytics','budget-reset-checkpoint-storage','cloud-pricing-core','ton-price-decoder'])assert.equal(typeof sources['lib/'+name],'string',name);
  assert.ok(Object.keys(sources).length<20);assert.ok(!Object.hasOwn(sources,'lib/public-runtime'));
  assert.ok(!Object.hasOwn(sources,'lib/private-refresh-key'));assert.ok(!Object.hasOwn(sources,'endpoints/unrelated0'));
});

test('actual backup and public verification bundles keep authorization and exclude unrelated endpoints',()=>{
  const canonical=runtimeSources();
  const backup=adminModuleSources(canonical,{'lib/admin-database-snapshot':tool('database-snapshot.mjs')},'endpoints/adminBackupSnapshot',endpointBody('backup.mjs','endpoint'));
  assert.deepEqual(Object.keys(backup).sort(),['endpoints/adminBackupSnapshot','lib/admin-database-snapshot','lib/private-config']);
  const verify=adminModuleSources(canonical,{},'endpoints/adminVerifyPublicRelease',endpointBody('verify-public-release.mjs','source'));
  assert.equal(verify['lib/private-config'],canonical['lib/private-config']);
  for(const name of ['endpoints/getDashboard','endpoints/getMarketappAnalyticsRefreshStatus','lib/public-runtime','lib/public-release-config','lib/private-refresh-key'])assert.equal(verify[name],canonical[name]);
  assert.ok(Object.keys(verify).length<=100);assert.ok(!Object.hasOwn(verify,'endpoints/unrelated0'));
});

test('actual compact setup retains deployed repositories and private configuration',()=>{
  const canonical=runtimeSources(),overrides={};
  for(const name of ['storage-policy','checkpoint-storage','budget-reset-checkpoint-storage'])overrides['lib/'+name]=canonical['lib/'+name];
  for(const name of ['storage-accounting','compact-operational-storage','normalized-record-storage','development-storage-reset'])
    overrides['lib/admin-'+name]=tool(name+'.mjs').replaceAll("from '../tgcloud/lib/","from './").replaceAll("from './compact-operational-storage.mjs'","from './admin-compact-operational-storage.js'");
  const sources=adminModuleSources(canonical,overrides,'endpoints/adminCompactStorage',endpointBody('compact-storage.mjs','endpoint'));
  for(const name of ['private-config','cloud-repository','public-repository'])assert.equal(sources['lib/'+name],canonical['lib/'+name]);
  for(const name of ['storage-accounting','compact-operational-storage','normalized-record-storage','development-storage-reset'])assert.equal(sources['lib/admin-'+name],overrides['lib/admin-'+name]);
  assert.ok(Object.keys(sources).length<100);assert.ok(!Object.hasOwn(sources,'endpoints/unrelated0'));
  assert.ok(!/readdirSync/.test(tool('compact-storage.mjs')),'Ignored local credentials must not be read by blanket directory loading');
});

test('v0.4.0 with 100 modules resolves upgrade dependencies and retains deployed credentials',()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/v0.4.0-module-graph.json',import.meta.url),'utf8'));
  const canonical=Object.fromEntries(Object.entries(fixture.modules).map(([name,entry])=>[name,
    entry.imports.map(specifier=>`import ${JSON.stringify(specifier)};`).join('\n')+'\n'
    +entry.exports.map(exported=>`export const ${exported}=null;`).join('\n')+(entry.default?'\nexport default null;':'')]));
  Object.assign(canonical,{'lib/private-config':owner+' export const marketappToken="synthetic";',
    'lib/private-refresh-key':'export const marketappRefreshKey="synthetic";',
    'lib/public-release-config':'export const publicReleaseConfig={enabled:false};'});
  assert.equal(Object.keys(canonical).length,100);
  const current=runtimeSources(),analytics={},compact={};
  for(const name of ['storage-policy','personal-analytics'])analytics['lib/'+name]=current['lib/'+name];
  analytics['lib/storage-accounting']=tool('storage-accounting.mjs').replaceAll("from '../tgcloud/lib/","from './");
  analytics['lib/analytics-daily-storage']=tool('analytics-daily-storage.mjs').replaceAll("from '../tgcloud/lib/","from './").replace("from './storage-accounting.mjs'","from './storage-accounting.js'");
  for(const name of ['storage-policy','checkpoint-storage','budget-reset-checkpoint-storage'])compact['lib/'+name]=current['lib/'+name];
  for(const name of ['storage-accounting','compact-operational-storage','normalized-record-storage','development-storage-reset'])
    compact['lib/admin-'+name]=tool(name+'.mjs').replaceAll("from '../tgcloud/lib/","from './").replaceAll("from './compact-operational-storage.mjs'","from './admin-compact-operational-storage.js'");
  const cases=[['installAnalyticsDailyStorage','install-analytics-daily-storage.mjs','endpoint',analytics],
    ['adminCompactStorage','compact-storage.mjs','endpoint',compact],
    ['adminBackupSnapshot','backup.mjs','endpoint',{'lib/admin-database-snapshot':tool('database-snapshot.mjs')}],
    ['adminVerifyPublicRelease','verify-public-release.mjs','source',{}]];
  const names=source=>new Set([...source.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)].map(match=>match[1]));
  for(const [name,file,variable,overrides] of cases) {
    const endpointName='endpoints/'+name,body=endpointBody(file,variable);
    const sources=adminModuleSources(canonical,overrides,endpointName,body);
    assert.ok(Object.keys(sources).length<=100,name);assert.equal(sources['lib/private-config'],canonical['lib/private-config']);
    // Check the real new code's named imports against the release's retained
    // export contract, not just whether a dependency has a module name.
    for(const [module,source] of Object.entries({...overrides,[endpointName]:body}))
      for(const match of source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
        if(match[2]==='sdk')continue;
        const dependency=posix.normalize(posix.join(posix.dirname(module),match[2])).replace(/\.js$/,'');
        const exported=names(sources[dependency]);
        for(const binding of match[1].split(',').map(value=>value.trim().split(/\s+as\s+/)[0]))
          assert.ok(exported.has(binding),`${name}: ${dependency} must export ${binding} for ${module}`);
      }
  }
});
