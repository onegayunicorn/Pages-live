import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'assets', 'bridge-source.jpg');
const OUTPUT = path.join(ROOT, 'bridge.jpg');
const CLAIM = path.join(ROOT, 'claim.json');
const MAGIC = Buffer.from([0x53, 0x42, 0x58, 0x31]); // SBX1

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function jpegDimensions(data) {
  if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('source must be a JPEG file');
  let offset = 2;
  while (offset + 4 < data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) break;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) break;
    const isStartOfFrame = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
    if (isStartOfFrame && length >= 7) {
      return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  throw new Error('could not read JPEG dimensions');
}

function segments(data) {
  const found = [];
  let offset = 2;
  while (offset < data.length - 3) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const markerOffset = offset;
    let markerCursor = offset + 1;
    while (data[markerCursor] === 0xff) markerCursor += 1;
    const marker = data[markerCursor];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset = markerCursor + 1; continue; }
    if (markerCursor + 2 >= data.length) break;
    const length = data.readUInt16BE(markerCursor + 1);
    if (length < 2) break;
    const end = markerCursor + 1 + length;
    if (end > data.length) break;
    found.push({ marker, start: markerOffset, end });
    offset = end;
  }
  return found;
}

function isSandboxSegment(data, segment) {
  if (segment.marker !== 0xef) return false;
  const payloadStart = segment.start + 4;
  return payloadStart + 4 <= segment.end && data.subarray(payloadStart, payloadStart + 4).equals(MAGIC);
}

function embedApp15(source, manifest) {
  const payload = Buffer.from(JSON.stringify(manifest), 'utf8');
  const dataLength = 8 + payload.length;
  const segmentLength = dataLength + 2;
  if (segmentLength > 65533) throw new Error('claim payload exceeds JPEG APP15 capacity');

  const segment = Buffer.alloc(4 + dataLength);
  segment[0] = 0xff;
  segment[1] = 0xef;
  segment.writeUInt16BE(segmentLength, 2);
  MAGIC.copy(segment, 4);
  segment.writeUInt32BE(payload.length, 8);
  payload.copy(segment, 12);

  const keep = [];
  let position = 2;
  for (const part of segments(source)) {
    if (position < part.start) keep.push(source.subarray(position, part.start));
    if (!isSandboxSegment(source, part)) keep.push(source.subarray(part.start, part.end));
    position = part.end;
  }
  if (position < source.length) keep.push(source.subarray(position));
  return Buffer.concat([source.subarray(0, 2), segment, ...keep]);
}

const source = await readFile(SOURCE);
const dimensions = jpegDimensions(source);
const sourceHash = sha256(source);
const issued = new Date().toISOString();
const baseUrl = (process.env.BRIDGE_BASE_URL || 'https://onegayunicorn.github.io/Pages-live').replace(/\/+$/, '');
const url = new URL(baseUrl);
if (!['https:', 'http:'].includes(url.protocol)) throw new Error('BRIDGE_BASE_URL must use http or https');
const domain = `${url.host}${url.pathname.replace(/\/+$/, '')}`;
const chain = 'unavailable';
const sandbox = `sbx_${randomBytes(3).toString('hex')}`;

const embeddedClaim = {
  v: 'SBX1',
  proto: 'sandboxd-bridge/1',
  domain,
  claim: `${baseUrl}/claim.json`,
  verify: `${baseUrl}/verify.html`,
  sandbox,
  chain,
  commit: null,
  codec: 'jpeg-app15',
  image: {
    sha256: sourceHash,
    px: `${dimensions.width}x${dimensions.height}`,
    bytes: source.length,
    type: 'image/jpeg'
  },
  issued,
  durable: 'artifact SHA-256 in claim.json',
  fragile: 'APP15 payload (lost on image re-encoding)'
};

const finalImage = embedApp15(source, embeddedClaim);
const externalClaim = {
  ...embeddedClaim,
  artifact: {
    file: 'bridge.jpg',
    sha256: sha256(finalImage),
    bytes: finalImage.length,
    type: 'image/jpeg'
  }
};

await mkdir(path.dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, finalImage);
await writeFile(CLAIM, `${JSON.stringify(externalClaim, null, 2)}\n`);
console.log(`Wrote ${path.relative(ROOT, OUTPUT)} (${finalImage.length} bytes)`);
console.log(`Source SHA-256:   ${sourceHash}`);
console.log(`Artifact SHA-256: ${externalClaim.artifact.sha256}`);
console.log(`Claim URL:        ${externalClaim.claim}`);
