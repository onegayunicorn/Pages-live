import { copyFile, cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const REQUIRED_FILES = ['index.html', 'claim.json', 'verify.html'];
const PORTAL_FILES = ['portal/favicon.svg', 'portal/site.webmanifest'];
const OPTIONAL_FILES = ['bridge.jpg', 'bridge.png'];

async function exists(file) {
  try {
    return (await stat(path.join(ROOT, file))).isFile();
  } catch {
    return false;
  }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const file of [...REQUIRED_FILES, ...PORTAL_FILES]) {
  if (!(await exists(file))) throw new Error(`Required Pages file is missing: ${file}`);
  const destination = path.join(OUT, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(ROOT, file), destination);
}

let bridgeCount = 0;
for (const file of OPTIONAL_FILES) {
  if (!(await exists(file))) continue;
  await copyFile(path.join(ROOT, file), path.join(OUT, file));
  bridgeCount += 1;
}

if (!(await exists('cops/index.html'))) throw new Error('Required COPS microsite is missing: cops/index.html');
if (!(await exists('cops/SHA256SUMS'))) throw new Error('Required COPS installer checksum manifest is missing: cops/SHA256SUMS');
await cp(path.join(ROOT, 'cops'), path.join(OUT, 'cops'), { recursive: true });

await writeFile(path.join(OUT, '.nojekyll'), '');
console.log(`Pages artifact built at ${OUT}`);
console.log(`Included root portal, claim/verifier, ${PORTAL_FILES.length} portal assets, COPS microsite${bridgeCount ? `, ${bridgeCount} bridge image(s)` : ''}.`);
if (!bridgeCount) console.warn('No bridge.jpg/bridge.png found; the current claim cannot verify an image until one is published.');
