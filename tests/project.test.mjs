import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('portal is a single-file, syntactically valid browser app with static assets', async () => {
  const html = await read('index.html');
  assert.match(html, /<title>sandboxd/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /rel="manifest" href="\.\/portal\/site\.webmanifest"/);
  assert.match(html, /href="\.\/portal\/favicon\.svg"/);
  assert.match(html, /data-pane="ops"/);
  assert.match(html, /data-pane="bridge"/);
  assert.match(html, /SIMULATION <b>DEMO ONLY<\/b>/);
  assert.match(html, /do not run Docker[\s\S]*API is not connected to this dashboard yet/);
  assert.match(html, /Bridge claims are unsigned[\s\S]*audit ref is user-supplied/);
  const dockerignore = await read('.dockerignore');
  assert.match(dockerignore, /\.env/);
  assert.match(dockerignore, /sandbox\/data/);

  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1, 'inline app script is present');
  for (const [, source] of scripts) new vm.Script(source, { filename: 'index.inline.js' });

  const manifest = JSON.parse(await read('portal/site.webmanifest'));
  assert.equal(manifest.short_name, 'sandboxd');
  assert.equal(manifest.start_url, '../');
  assert.equal(manifest.scope, '../');
});

test('claim verifier checks an external artifact digest rather than the source-image digest', async () => {
  const verifier = await read('verify.html');
  assert.match(verifier, /claim\.json/);
  assert.match(verifier, /artifact\.sha256/);
  assert.match(verifier, /bridge\.jpg/);
  assert.match(verifier, /bridge\.png/);
  assert.doesNotMatch(verifier, /var want\s*=\s*manifest\.image\.sha256/);
});

test('bridge claim is well-formed in either legacy or artifact-verified form', async () => {
  const claim = JSON.parse(await read('claim.json'));
  assert.equal(claim.v, 'SBX1');
  assert.match(claim.image.sha256, /^[a-f0-9]{64}$/);
  assert.ok(['jpeg-app15', 'png-lsb'].includes(claim.codec));
  if (claim.artifact) {
    assert.ok(['bridge.jpg', 'bridge.png'].includes(claim.artifact.file));
    assert.match(claim.artifact.sha256, /^[a-f0-9]{64}$/);
  }
});
