import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DockerEngine } from '../sandbox/docker-engine.mjs';

let tempDir;
let socketPath;
let server;
let engine;
let createdConfig;
const id = 'a'.repeat(64);

function json(res, status, value) {
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': data.length });
  res.end(data);
}

function frame(type, text) {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'docker-engine-test-'));
  socketPath = path.join(tempDir, 'docker.sock');
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    if (req.url === '/version') return json(res, 200, { ApiVersion: '1.47' });
    if (req.url === '/_ping') { res.writeHead(200); res.end('OK'); return; }
    if (req.url === '/v1.47/info') return json(res, 200, { SecurityOptions: ['name=rootless'], ServerVersion: 'test' });
    if (req.url === '/v1.47/images/json?all=1') return json(res, 200, [{ RepoTags: ['alpine:latest'] }]);
    if (req.url.startsWith('/v1.47/containers/create?')) {
      createdConfig = body;
      return json(res, 201, { Id: id, Warnings: [] });
    }
    if (req.url === `/v1.47/containers/${id}/start`) { res.writeHead(204); res.end(); return; }
    if (req.url === `/v1.47/containers/${id}/exec`) return json(res, 201, { Id: 'exec-1' });
    if (req.url === '/v1.47/exec/exec-1/start') {
      const output = Buffer.concat([frame(1, 'container output\n'), frame(2, 'container warning\n')]);
      res.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream', 'content-length': output.length });
      res.end(output);
      return;
    }
    if (req.url === '/v1.47/exec/exec-1/json') return json(res, 200, { Running: false, ExitCode: 0 });
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `unexpected route ${req.method} ${req.url}` }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  engine = new DockerEngine({ socketPath });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

test('Docker Engine API negotiation and rootless detection work over a Unix socket', async () => {
  assert.equal(await engine.ping(), true);
  const info = await engine.info();
  assert.equal(engine.isRootless(info), true);
  assert.equal(info.ServerVersion, 'test');
});

test('container creation sends hard isolation and resource controls', async () => {
  const result = await engine.create({ image: 'alpine:latest', name: 'sandboxd-test', memoryBytes: 512 * 1024 * 1024, nanoCpus: 500000000, pidsLimit: 128 });
  assert.equal(result.Id, id);
  assert.equal(createdConfig.HostConfig.NetworkMode, 'none');
  assert.equal(createdConfig.HostConfig.Privileged, false);
  assert.deepEqual(createdConfig.HostConfig.CapDrop, ['ALL']);
  assert.equal(createdConfig.HostConfig.ReadonlyRootfs, true);
  assert.equal(createdConfig.HostConfig.Memory, 512 * 1024 * 1024);
  assert.equal(createdConfig.HostConfig.PidsLimit, 128);
  assert.deepEqual(createdConfig.HostConfig.Binds, []);
  assert.equal(createdConfig.User, '65534:65534');
});

test('exec frames keep stdout and stderr separate and report exit status', async () => {
  const result = await engine.exec(id, ['/bin/sh', '-lc', 'echo hello']);
  assert.equal(result.stdout, 'container output\n');
  assert.equal(result.stderr, 'container warning\n');
  assert.equal(result.exitCode, 0);
});
