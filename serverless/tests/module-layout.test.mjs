import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {resolve, dirname, join, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

test('every deployed module imports only existing project JS modules or the supported SDK', () => {
  const root = fileURLToPath(new URL('../tgcloud/', import.meta.url));
  function scan(directory) {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {scan(path); continue;}
      if (!entry.name.endsWith('.js')) continue;
      const relative = path.slice(root.length).replaceAll('\\', '/');
      assert.ok(relative === 'schema.js' || /^(lib|endpoints|handlers)\//.test(relative), 'Only modules in supported directories are deployed');
      if (entry.name === 'private-config.js') continue;
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
        const target = match[1];
        if (['sdk', 'sdk/db', 'sdk/api', 'sdk/fetch'].includes(target)) continue;
        assert.ok(target.startsWith('.') && target.endsWith('.js'), `Unsupported runtime import in ${relative}`);
        const resolved = resolve(dirname(path), target);
        assert.ok(resolved.startsWith(resolve(root) + sep), `Import escapes tgcloud in ${relative}`);
        // A clean checkout generates private-config from the ignored example.
        assert.ok(existsSync(resolved) || resolved === join(root, 'lib/private-config.js'), `Missing dependency ${target} in ${relative}`);
      }
    }
  }
  scan(root);
});
