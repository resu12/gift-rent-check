import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const tool=fileURLToPath(new URL('../tools/migrate-public-owner.mjs',import.meta.url));
const env={...process.env,TGCLOUD_TOKEN:'synthetic-token-never-used',TG_CLOUD_API_URL:'https://untrusted.example.invalid',TGCLOUD_DEBUG:'1'};
test('migration rejects malformed arguments and missing explicit owner confirmation before credential/network loading',()=>{
  for(const args of [[],['--app-id','77','--owner-id','101','--mode','apply'],
    ['--app-id','77','--owner-id','101','--mode','apply','--confirm-legacy-owner','202'],
    ['--app-id','77','--owner-id','101','--mode','clear'],
    ['--app-id','77','--owner-id','101','--mode','clear','--confirm-legacy-owner','202'],
    ['--app-id','77','--owner-id','101','--limit','26'],['--app-id','77','--owner-id','101','--mode','check','--confirm-legacy-owner','101'],
    ['--app-id','77','--owner-id','101','--app-id','88'],['--app-id','77','--owner-id','101','--unknown','private-sentinel']]) {
    const result=spawnSync(process.execPath,[tool,...args],{env,encoding:'utf8',timeout:3000});
    assert.equal(result.status,1);assert.equal(result.stdout,'');assert.ok(!result.stderr.includes('synthetic-token'));assert.ok(!result.stderr.includes('private-sentinel'));
    assert.ok(!result.stderr.includes('untrusted.example'),'argument guards execute before the destination guard');
  }
});
test('valid check arguments reject a nonofficial destination before loading CLI credentials',()=>{
  const result=spawnSync(process.execPath,[tool,'--app-id','77','--owner-id','101','--mode','check'],{env,encoding:'utf8',timeout:3000});
  assert.equal(result.status,1);assert.match(result.stderr,/official Telegram cloud API/);assert.equal(result.stdout,'');assert.ok(!result.stderr.includes('synthetic-token'));
});
test('check, apply and clear reject enabled public mode before loading CLI credentials',t=>{
  const fixture=mkdtempSync(join(tmpdir(),'public-owner-migration-'));
  t.after(()=>rmSync(fixture,{recursive:true,force:true}));
  const tools=join(fixture,'tools'),lib=join(fixture,'tgcloud','lib'),cli=join(fixture,'node_modules','@tgcloud','cli','src','core');
  for(const directory of [tools,lib,cli])mkdirSync(directory,{recursive:true});
  writeFileSync(join(fixture,'package.json'),JSON.stringify({type:'module'}));
  copyFileSync(tool,join(tools,'migrate-public-owner.mjs'));
  copyFileSync(fileURLToPath(new URL('../tools/destination.mjs',import.meta.url)),join(tools,'destination.mjs'));
  writeFileSync(join(lib,'public-release-config.js'),'export const publicReleaseConfig={enabled:true};\n');
  writeFileSync(join(fixture,'node_modules','@tgcloud','cli','package.json'),JSON.stringify({type:'module'}));
  const credentialMarker=join(fixture,'credentials-were-loaded');
  writeFileSync(join(cli,'credentials.js'),`import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(credentialMarker)},'loaded');\nthrow Error('CLI credentials unexpectedly loaded');\n`);
  for(const mode of ['check','apply','clear']) {
    const args=['--app-id','77','--owner-id','101','--mode',mode];
    if(mode!=='check')args.push('--confirm-legacy-owner','101');
    const result=spawnSync(process.execPath,[join(tools,'migrate-public-owner.mjs'),...args],{
      env:{...env,TG_CLOUD_API_URL:'https://cloud.telegram.org',TGCLOUD_BETA:'0'},encoding:'utf8',timeout:3000});
    assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/requires public mode disabled/);
    assert.equal(existsSync(credentialMarker),false,`${mode} must stop before credentials import`);
  }
});
test('administrative migration authorizes deployed owner and returns aggregate counts without provider calls',()=>{
  const source=readFileSync(tool,'utf8');assert.match(source,/ctx\?\.initData\?\.user\?\.id/);assert.match(source,/String\(input\?\.owner_id\)!==owner/);
  assert.match(source,/confirm_owner_id/);assert.match(source,/migrateLegacyOwner/);assert.doesNotMatch(source,/fetch\(/);
  assert.match(source,/provider_requests!==0/);assert.doesNotMatch(source,/console\.log\(JSON\.stringify\(result\)\)/);
  assert.equal(source.match(/publicReleaseConfig\.enabled!==false/g)?.length,2,'both local command and ephemeral endpoint guard public mode');
  assert.ok(source.indexOf('if(publicReleaseConfig.enabled!==false) throw')<source.indexOf('return await migrateLegacyOwner'),'deployed guard precedes migration database reads');
  assert.ok(source.indexOf("await import('../tgcloud/lib/public-release-config.js')")<source.indexOf("await import('../node_modules/@tgcloud/cli/src/core/credentials.js')"),'local guard precedes credential loading');
});
