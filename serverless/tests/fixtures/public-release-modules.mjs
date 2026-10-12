import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicReleaseConfig} from '../../public-release-config.example.js';

// Publish fixtures use the safe example and real validator. Follow only their
// explicit source imports, never the working deployment's ignored files.
const sourceRoot = fileURLToPath(new URL('../../tgcloud/lib/', import.meta.url));
export function stagePublicReleaseModules(project, {runtime = false} = {}) {
  assert.equal(typeof publicReleaseConfig.enabled, 'boolean');
  const visited = new Set();
  function stage(relative) {
    const source = resolve(sourceRoot, relative);
    assert.ok(source.startsWith(resolve(sourceRoot) + sep));
    assert.ok(!/[/\\]private-[^/\\]+\.js$/.test(source), 'Private deployment files cannot enter test fixtures');
    if (visited.has(source)) return;
    visited.add(source);
    const body = readFileSync(source, 'utf8'), destination = join(project, 'tgcloud/lib', relative);
    mkdirSync(dirname(destination), {recursive: true}); writeFileSync(destination, body);
    for (const match of body.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?(['"])(\.[^'"]+)\1/g)) {
      stage(join(dirname(relative), match[2]));
    }
  }
  mkdirSync(join(project, 'tgcloud/lib'), {recursive: true});
  // A configured working deployment must not influence the private test fixture.
  writePublicReleaseConfig(project, {enabled: false, preservePrivateOwner: false});
  if (runtime) stage('public-runtime.js');
}

export function writePublicReleaseConfig(project, overrides) {
  writeFileSync(join(project, 'tgcloud/lib/public-release-config.js'),
    `export const publicReleaseConfig=Object.freeze(${JSON.stringify({...publicReleaseConfig, ...overrides})});`);
}

export const syntheticPublicReleaseConfig = Object.freeze({
  enabled: true, preservePrivateOwner: false, invitedUserIds: [42], origin: 'https://app54321.tgcloud.ai',
  privacyPolicyUrl: 'https://app54321.tgcloud.ai/privacy', termsUrl: 'https://app54321.tgcloud.ai/terms',
  storageEncryptionConfirmed: true, providerUseApproved: true,
});
