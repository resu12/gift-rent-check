// Local deploy check: never print private module values or bundle matches.
import {readFile, readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

try {
  const {ownerTelegramId, marketappToken} = await import('../tgcloud/lib/private-config.js');
  if (!Number.isSafeInteger(ownerTelegramId) || ownerTelegramId <= 0 || typeof marketappToken !== 'string' || !marketappToken.trim()) throw new Error();
  const root = fileURLToPath(new URL('../dist/', import.meta.url));
  async function check(dir) {
    for (const entry of await readdir(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error();
      if (entry.isDirectory()) await check(path);
      else {
        const body = await readFile(path, 'utf8');
        if (body.includes(marketappToken) || body.includes('mock-only-token') || body.includes('/mock-api/')) throw new Error();
      }
    }
  }
  await check(root);
  const html = await readFile(join(root, 'index.html'), 'utf8');
  if (!html.includes('https://telegram.org/js/telegram-web-app.js?64')) throw new Error();
  console.log('Private owner, provider configuration, and credential-free static build verified.');
} catch {
  console.error('Preflight failed. Verify the private owner/provider configuration and rebuild the Serverless frontend. No values were logged.');
  process.exitCode = 1;
}
