// Generate once, locally. The key is never printed or bundled for the browser.
import {randomBytes} from 'node:crypto';
import {writeFile, readFile} from 'node:fs/promises';
const path = new URL('../tgcloud/lib/private-refresh-key.js', import.meta.url);
try {
  await writeFile(path, `export const marketappRefreshKey = '${randomBytes(32).toString('hex')}';\n`, {flag:'wx',mode:0o600});
  console.log('Private analytics refresh key created.');
} catch (error) {
  if (error.code !== 'EEXIST') throw new Error('Could not prepare private refresh key');
  const existing = await readFile(path,'utf8');
  if (!/^export const marketappRefreshKey = '[a-f0-9]{64}';\r?\n$/.test(existing)) throw new Error('Invalid private refresh key file');
  console.log('Existing private analytics refresh key retained.');
}
