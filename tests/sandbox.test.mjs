import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSandboxServer } from '../sandbox/server.mjs';

const TOKEN = 'a'.repeat(64);
let server;
let base;
let tempDir;
let engine;

class FakeDockerEngine {
  constructor() {
    this.items = new Map();
    this.sequence = 0;
  }
  async ping() { return true; }
  async info() { return { SecurityOptions: ['name=seccomp,profile=default', 'name=rootless'], ServerVersion: 'test-rootless', NCPU: 4, MemTotal: 8 * 1024 ** 3 }; }
  isRootless(info) { return info.SecurityOptions.some((entry) => entry.includes('rootless')); }
  async hasImage(image) { return ['alpine:latest', 'python:3.11', 'ollama/qwen2.5:0.5b', 'redis:7-alpine', 'node:20-alpine'].includes(image); }
  async create(options) {
    this.sequence += 1;
    const id = String(this.sequence.toString(16)).padStart(64, 'a');
    const inspect = {
      Id: id,
      Config: { Image: options.image, Cmd: ['/bin/sh', '-lc', 'while :; do sleep 3600; done'], Labels: { 'sandboxd.managed': 'true', ...options.labels } },
      HostConfig: { Memory: options.memoryBytes, NanoCpus: options.nanoCpus, PidsLimit: options.pidsLimit },
      State: { Running: false }
    };
    this.items.set(id, { inspect, state: 'created', image: options.image, created: Math.floor(Date.now() / 1000) });
    return { Id: id };
  }
  async start(id) { const item = this.items.get(id); item.state = 'running'; item.inspect.State.Running = true; }
  async stop(id) { const item = this.items.get(id); if (item) { item.state = 'exited'; item.inspect.State.Running = false; } }
  async remove(id) { this.items.delete(id); }
  async kill(id) { return this.stop(id); }
  async inspect(id) { const item = this.items.get(id); if (!item) throw Object.assign(new Error('no such container'), { status: 404 }); return item.inspect; }
  async containers() {
    return [...this.items.entries()].map(([Id, item]) => ({ Id, Image: item.image, State: item.state, Status: item.state, Created: item.created, SizeRw: 0 }));
  }
  async stats() { return { memory_stats: { usage: 48 * 1024 * 1024, stats: { cache: 8 * 1024 * 1024 } }, pids_stats: { current: 2 }, cpu_stats: { online_cpus: 2, cpu_usage: { total_usage: 300 } }, precpu_stats: { system_cpu_usage: 0, cpu_usage: { total_usage: 0 } } }; }
  async exec(_id, command) { return { stdout: `ran ${command.at(-1)}\n`, stderr: '', exitCode: 0, running: false }; }
  async runJob({ name, command }) { await new Promise((resolve) => setTimeout(resolve, 20)); return { id: name, exitCode: 0, stdout: `job: ${command}\n`, stderr: '' }; }
}

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'sandboxd-test-'));
  process.env.SANDBOX_WORKSPACE_HOST_PATH = tempDir;
  engine = new FakeDockerEngine();
  server = await createSandboxServer({ engine, token: TOKEN, auditFile: path.join(tempDir, 'audit.jsonl'), allowedOrigins: new Set(['https://onegayunicorn.github.io']) });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  delete process.env.SANDBOX_WORKSPACE_HOST_PATH;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${TOKEN}` };

async function json(pathname, options = {}) {
  return fetch(`${base}${pathname}`, options);
}

test('health requires rootless Docker; status requires a bearer token', async () => {
  const health = await json('/api/v1/health').then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.mode, 'docker');
  assert.equal(health.rootless, true);

  assert.equal((await json('/api/v1/status')).status, 401);
  const status = await json('/api/v1/status', { headers: auth }).then((response) => response.json());
  assert.equal(status.dockerConnected, true);
  assert.equal(status.runtimeSocketExposedToWorkloads, false);
  assert.equal(status.usage.running, 0);
});

test('API enforces exact image allowlisting and creates real-Docker-shaped records', async () => {
  const denied = await json('/api/v1/containers', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ image: 'alpine:latest-malicious' })
  });
  assert.equal(denied.status, 403);

  const response = await json('/api/v1/containers', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ image: 'alpine:latest' })
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.mode, 'docker');
  assert.equal(payload.container.Config.Labels['sandboxd.managed'], 'true');

  const second = await json('/api/v1/containers', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ image: 'alpine:latest' })
  });
  assert.equal(second.status, 201);
  const quota = await json('/api/v1/containers', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ image: 'alpine:latest' })
  });
  assert.equal(quota.status, 429, 'aggregate PID quota limits the third container');

  const listing = await json('/api/v1/containers', { headers: auth }).then((item) => item.json());
  assert.equal(listing.containers.length, 2);
  assert.equal(listing.containers[0].st, 'running');
  assert.equal(listing.containers[0].mem, 40);
});

test('commands execute only through a managed-container API route and return output', async () => {
  const item = [...engine.items.keys()][0];
  const response = await json(`/api/v1/containers/${item}/exec`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'printf safe' })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.stdout, 'ran printf safe\n');
  assert.equal(result.exitCode, 0);

  const invalid = await json(`/api/v1/containers/${'f'.repeat(64)}/exec`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ command: 'echo no' })
  });
  assert.equal(invalid.status, 404);
});

test('stop-all, pipeline job, CORS, and durable audit verification use API results', async () => {
  const pipelineList = await json('/api/v1/pipelines', { headers: auth }).then((response) => response.json());
  assert.ok(pipelineList.pipelines.every((pipeline) => pipeline.available));

  const stopped = await json('/api/v1/containers/stop-all', { method: 'POST', headers: auth });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).stopped.length, 2);

  const requests = await Promise.all([0, 1].map(() => json('/api/v1/pipelines/test/run', {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}'
  })));
  assert.deepEqual(requests.map((response) => response.status).sort(), [200, 429]);
  const successfulJob = requests.find((response) => response.status === 200);
  assert.equal((await successfulJob.json()).state, 'success');

  const cors = await json('/api/v1/status', { headers: { ...auth, origin: 'https://evil.invalid' } });
  assert.equal(cors.status, 403);
  const allowed = await json('/api/v1/status', { headers: { ...auth, origin: 'https://onegayunicorn.github.io' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://onegayunicorn.github.io');

  const audit = await json('/api/v1/events', { headers: auth }).then((response) => response.json());
  assert.ok(audit.events.some((event) => event.kind === 'post_exec'));
  const verified = await json('/api/v1/audit/verify', { method: 'POST', headers: auth }).then((response) => response.json());
  assert.equal(verified.valid, true);
});

test('portal is served but backend source files are not public static routes', async () => {
  assert.match(await json('/').then((response) => response.text()), /sandboxd/);
  assert.equal((await json('/portal/site.webmanifest')).status, 200);
  assert.equal((await json('/sandbox/server.mjs')).status, 404);
});
