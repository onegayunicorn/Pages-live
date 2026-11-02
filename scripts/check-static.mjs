import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
if (!scripts.length) throw new Error('No inline portal script found.');
for (const [, source] of scripts) new vm.Script(source, { filename: 'index.inline.js' });

const claim = JSON.parse(await readFile(path.join(ROOT, 'claim.json'), 'utf8'));
if (!/^[a-f0-9]{64}$/i.test(claim?.image?.sha256 || '')) throw new Error('claim.json has an invalid source image SHA-256.');

const pageFiles = [
  'index.html',
  'claim.json',
  'verify.html',
  'portal/favicon.svg',
  'portal/site.webmanifest'
];
for (const file of pageFiles) await access(path.join(ROOT, file));

let image = claim?.artifact?.file;
if (!image) image = claim.codec === 'jpeg-app15' ? 'bridge.jpg' : 'bridge.png';
try {
  await access(path.join(ROOT, image));
  if (!claim?.artifact?.sha256) console.warn(`Warning: ${image} exists, but claim.json has no artifact.sha256.`);
} catch {
  console.warn(`Warning: ${image} is absent; the current legacy claim cannot verify an encoded image yet.`);
}
console.log('Static portal checks passed.');
