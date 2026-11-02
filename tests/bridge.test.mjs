import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function readEmbeddedClaim(jpeg) {
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
  let offset = 2;
  while (offset < jpeg.length - 3) {
    if (jpeg[offset] !== 0xff) { offset += 1; continue; }
    const marker = jpeg[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const length = jpeg.readUInt16BE(offset + 2);
    if (marker === 0xef && jpeg.subarray(offset + 4, offset + 8).equals(Buffer.from('SBX1'))) {
      const payloadLength = jpeg.readUInt32BE(offset + 8);
      return JSON.parse(jpeg.subarray(offset + 12, offset + 12 + payloadLength).toString('utf8'));
    }
    offset += 2 + length;
  }
  throw new Error('APP15 SBX1 claim segment not found');
}

test('bridge JPEG embeds the claim and external artifact digest matches final bytes', async () => {
  const jpeg = await read('bridge.jpg');
  const source = await read('assets/bridge-source.jpg');
  const manifest = JSON.parse((await read('claim.json')).toString('utf8'));
  const embedded = readEmbeddedClaim(jpeg);

  assert.equal(manifest.artifact.file, 'bridge.jpg');
  assert.equal(manifest.artifact.type, 'image/jpeg');
  assert.equal(manifest.artifact.bytes, jpeg.length);
  assert.equal(manifest.artifact.sha256, sha256(jpeg));
  assert.equal(manifest.chain, 'unavailable', 'offline bundle has no API audit root');
  assert.equal(manifest.image.sha256, sha256(source));
  assert.equal(embedded.image.sha256, manifest.image.sha256);
  assert.equal(embedded.chain, 'unavailable');
  assert.equal(embedded.domain, manifest.domain);
  assert.equal(embedded.artifact, undefined, 'artifact digest is external to avoid a self-referential hash');
});
