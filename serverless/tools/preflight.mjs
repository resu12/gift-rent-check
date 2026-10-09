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
  // A wallet receives this public manifest. Never publish a build that asks it
  // to connect to a different deployment from the explicitly guarded target.
  let manifest;
  try { manifest = JSON.parse(await readFile(join(root, 'tonconnect-manifest.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (manifest !== undefined) {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--app-id' || !/^[1-9]\d*$/.test(args[1])) throw new Error();
    const expectedOrigin = `https://app${args[1]}.tgcloud.ai`;
    if (manifest?.url !== expectedOrigin || manifest?.name !== 'Gift Rent Check' ||
        manifest?.iconUrl !== `${expectedOrigin}/wallet-icon.png` ||
        Object.keys(manifest).sort().join(',') !== 'iconUrl,name,url') throw new Error();
    const icon = await readFile(join(root, 'wallet-icon.png'));
    if (icon.length < 24 || !icon.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        icon.toString('ascii', 12, 16) !== 'IHDR' || icon.readUInt32BE(16) !== 180 || icon.readUInt32BE(20) !== 180) throw new Error();
  }
  console.log('Private owner, provider configuration, credential-free static build, and wallet manifest destination verified.');
} catch {
  console.error('Preflight failed. Verify the private owner/provider configuration and rebuild the Serverless frontend for the explicit app ID. No values were logged.');
  process.exitCode = 1;
}
