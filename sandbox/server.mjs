import http from 'node:http';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerApiError, DockerEngine } from './docker-engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const POLICY = JSON.parse(await readFile(path.join(HERE, 'config', 'policy.json'), 'utf8'));
const MIB = 1024 * 1024;
const PIPELINES = {
  build: {
    label: '🔨 build',
    steps: ['run portal tests in Docker', 'build Pages artifact in isolated job'],
    command: POLICY.pipeline.buildCommand
  },
  test: {
    label: '🧪 test',
    steps: ['run Node test suite in Docker', 'check static bundle inputs'],
    command: POLICY.pipeline.testCommand
  }
};
const STATIC_FILES = new Map([
  ['/', 'index.html'], ['/index.html', 'index.html'], ['/claim.json', 'claim.json'], ['/verify.html', 'verify.html'],
  ['/portal/favicon.svg', 'portal/favicon.svg'], ['/portal/site.webmanifest', 'portal/site.webmanifest'],
  ['/bridge.jpg', 'bridge.jpg'], ['/bridge.png', 'bridge.png']
]);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.png': 'image/png'
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  res.end(data);
}

function sendError(res, status, code, message, details = undefined) {
  sendJson(res, status, { error: code, message, details });
}

function validToken(req, expected) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const supplied = Buffer.from(match[1]);
  const actual = Buffer.from(expected);
  return supplied.length === actual.length && timingSafeEqual(supplied, actual);
}

async function readJsonBody(req, maxBytes) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw Object.assign(new Error('content-type must be application/json'), { status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be a JSON object');
    return value;
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
}

function workspacePath() {
  const configured = process.env.SANDBOX_WORKSPACE_HOST_PATH || '';
  if (!configured || !path.isAbsolute(configured) || /[\0\r\n,:]/.test(configured)) return null;
  try {
    const resolved = path.resolve(configured);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return null;
    return resolved;
  } catch {
    return null;
  }
}

class AuditLog {
  constructor(filePath) {
    this.filePath = filePath;
    this.events = [];
    this.root = '00000000';
    this.seq = 0;
    this.queue = Promise.resolve();
  }

  static async open(filePath) {
    const log = new AuditLog(filePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    let content = '';
    try { content = await readFile(filePath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let previous = '00000000';
    for (const line of content.split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      const base = { seq: entry.seq, at: entry.at, kind: entry.kind, message: entry.message, level: entry.level, details: entry.details || {} };
      const expected = sha256(`${previous}|${JSON.stringify(base)}`);
      if (entry.prev !== previous || entry.hash !== expected) throw new Error(`Audit log chain failed at sequence ${entry.seq}`);
      previous = entry.hash;
      log.events.push(entry);
      log.seq = entry.seq;
    }
    log.root = previous;
    return log;
  }

  append(kind, message, level = 'info', details = {}) {
    const operation = async () => {
      const base = { seq: this.seq + 1, at: new Date().toISOString(), kind, message: String(message).slice(0, 1000), level, details };
      const entry = { ...base, prev: this.root, hash: sha256(`${this.root}|${JSON.stringify(base)}`) };
      await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
      this.seq = entry.seq;
      this.root = entry.hash;
      this.events.push(entry);
      if (this.events.length > POLICY.limits.maxAuditEvents) this.events.splice(0, this.events.length - POLICY.limits.maxAuditEvents);
      return entry;
    };
    this.queue = this.queue.then(operation);
    return this.queue;
  }

  async verify() {
    let content = '';
    try { content = await readFile(this.filePath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let previous = '00000000';
    let count = 0;
    for (const line of content.split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      const base = { seq: entry.seq, at: entry.at, kind: entry.kind, message: entry.message, level: entry.level, details: entry.details || {} };
      const expected = sha256(`${previous}|${JSON.stringify(base)}`);
      if (entry.prev !== previous || entry.hash !== expected) return { valid: false, events: count, root: previous, failedAt: entry.seq };
      previous = entry.hash;
      count += 1;
    }
    return { valid: true, events: count, root: previous };
  }
}

function dockerCpuCores(stats) {
  const current = stats?.cpu_stats?.cpu_usage?.total_usage || 0;
  const previous = stats?.precpu_stats?.cpu_usage?.total_usage || 0;
  const systemCurrent = stats?.cpu_stats?.system_cpu_usage || 0;
  const systemPrevious = stats?.precpu_stats?.system_cpu_usage || 0;
  const cpuDelta = current - previous;
  const systemDelta = systemCurrent - systemPrevious;
  const cores = stats?.cpu_stats?.online_cpus || stats?.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  return systemDelta > 0 && cpuDelta > 0 ? Number(((cpuDelta / systemDelta) * cores).toFixed(2)) : 0;
}

async function getContainerRows(engine) {
  const containers = await engine.containers();
  const rows = await Promise.all(containers.map(async (container) => {
    const inspect = await engine.inspect(container.Id);
    if (inspect?.Config?.Labels?.['sandboxd.managed'] !== 'true') return null;
    let stats = null;
    if (container.State === 'running') {
      try { stats = await engine.stats(container.Id); } catch { stats = null; }
    }
    const statsAvailable = container.State !== 'running' || (
      typeof stats?.memory_stats?.usage === 'number' &&
      typeof stats?.cpu_stats?.cpu_usage?.total_usage === 'number' &&
      typeof stats?.pids_stats?.current === 'number'
    );
    const memoryCache = stats?.memory_stats?.stats?.inactive_file ?? stats?.memory_stats?.stats?.cache ?? 0;
    const memoryUsage = Math.max(0, (stats?.memory_stats?.usage || 0) - memoryCache);
    const cpu = dockerCpuCores(stats);
    const pids = stats?.pids_stats?.current || 0;
    return {
      id: container.Id,
      img: container.Image || inspect.Config.Image,
      cmd: (inspect.Config.Cmd || []).join(' '),
      st: container.State,
      status: container.Status,
      cpu,
      mem: Math.round(memoryUsage / MIB),
      pids,
      disk: Math.max(0, container.SizeRw || 0),
      born: (container.Created || Math.floor(Date.now() / 1000)) * 1000,
      memoryLimitMb: Math.round((inspect.HostConfig?.Memory || 0) / MIB),
      cpuLimit: Number(((inspect.HostConfig?.NanoCpus || 0) / 1e9).toFixed(2)),
      pidsLimit: Number(inspect.HostConfig?.PidsLimit || 0),
      pipeline: inspect.Config?.Labels?.['sandboxd.pipeline'] === 'true',
      statsAvailable
    };
  }));
  return rows.filter(Boolean);
}

function usageFromRows(rows) {
  const running = rows.filter((row) => row.st === 'running');
  const statsAvailable = running.every((row) => row.statsAvailable);
  return {
    running: running.length,
    statsAvailable,
    memoryMb: statsAvailable ? running.reduce((sum, row) => sum + row.mem, 0) : null,
    cpuCores: statsAvailable ? Number(running.reduce((sum, row) => sum + row.cpu, 0).toFixed(2)) : null,
    pids: statsAvailable ? running.reduce((sum, row) => sum + row.pids, 0) : null,
    diskMb: Math.round(rows.reduce((sum, row) => sum + row.disk, 0) / MIB)
  };
}

function createPolicyLock() {
  let tail = Promise.resolve();
  return async function acquire() {
    const previous = tail;
    let unlock;
    tail = new Promise((resolve) => { unlock = resolve; });
    await previous;
    let released = false;
    return () => { if (!released) { released = true; unlock(); } };
  };
}

function parseAllowedOrigins() {
  return new Set(String(process.env.SANDBOX_ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    try { return new URL(item).origin; } catch { return ''; }
  }).filter(Boolean));
}

function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const protocol = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  const host = req.headers.host;
  const sameOrigin = host ? `${protocol}://${host}` : '';
  if (origin !== sameOrigin && !allowedOrigins.has(origin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'Authorization,Content-Type');
  res.setHeader('access-control-max-age', '600');
  res.setHeader('vary', 'Origin');
  return true;
}

async function sendStatic(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }
  const relative = STATIC_FILES.get(pathname);
  if (!relative) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
    res.end('Not found');
    return;
  }
  try {
    const file = path.join(ROOT, relative);
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': relative.endsWith('.html') ? 'no-cache' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'SAMEORIGIN'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
      res.end('Not found');
      return;
    }
    throw error;
  }
}

function requireRootless(engine, info) {
  if (!engine.isRootless(info)) throw new DockerApiError('Rootless Docker is required; refusing to control a rootful host daemon.', 503);
  return info;
}

function safeWorkspace() {
  const folder = workspacePath();
  if (!folder) throw new DockerApiError('Set SANDBOX_WORKSPACE_HOST_PATH to an existing absolute project directory to enable build/test pipelines.', 503);
  return folder;
}

async function pipelineList(engine, pipelineSlots) {
  const workspace = workspacePath();
  const imageReady = workspace ? await engine.hasImage(POLICY.pipeline.image) : false;
  const runningPipelines = (await engine.containers()).filter((container) =>
    container.State === 'running' && container.Labels?.['sandboxd.pipeline'] === 'true'
  ).length;
  const busy = pipelineSlots.active >= POLICY.limits.maxConcurrentPipelines || runningPipelines >= POLICY.limits.maxConcurrentPipelines;
  const result = [];
  for (const [name, pipeline] of Object.entries(PIPELINES)) {
    result.push({
      name,
      label: pipeline.label,
      steps: pipeline.steps,
      available: !!workspace && imageReady && !busy,
      reason: !workspace ? 'configure SANDBOX_WORKSPACE_HOST_PATH' : (!imageReady ? `pull ${POLICY.pipeline.image} on the rootless daemon` : (busy ? 'a pipeline is already running' : null))
    });
  }
  return result;
}

async function routeApi(req, res, pathname, { engine, audit, token, allowedOrigins, pipelineSlots, acquirePolicyLock }) {
  if (!applyCors(req, res, allowedOrigins)) {
    sendError(res, 403, 'origin_not_allowed', 'Browser origin is not in SANDBOX_ALLOWED_ORIGINS.');
    return;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'content-length': '0' });
    res.end();
    return;
  }
  if (pathname === '/api/v1/health' && req.method === 'GET') {
    try {
      await engine.ping();
      const info = requireRootless(engine, await engine.info());
      sendJson(res, 200, { ok: true, service: 'sandboxd', mode: 'docker', dockerConnected: true, rootless: true, serverVersion: info.ServerVersion || null });
    } catch (error) {
      const message = /^Rootless Docker is required\b/i.test(error.message) ? 'A rootless Docker daemon is required.' : 'Docker Engine is unavailable.';
      sendJson(res, error.status || 503, { ok: false, service: 'sandboxd', mode: 'docker', dockerConnected: false, error: message });
    }
    return;
  }
  if (!validToken(req, token)) {
    sendError(res, 401, 'unauthorized', 'A valid Bearer API token is required.');
    return;
  }

  try {
    await engine.ping();
    const info = requireRootless(engine, await engine.info());

    if (req.method === 'GET' && pathname === '/api/v1/status') {
      const rows = await getContainerRows(engine);
      sendJson(res, 200, {
        service: 'sandboxd', mode: 'docker', dockerConnected: true, rootless: true,
        serverVersion: info.ServerVersion || null, uptimeSeconds: Math.floor(process.uptime()),
        runtimeSocketExposedToWorkloads: false, network: 'isolated', quotas: POLICY.quotas,
        usage: usageFromRows(rows), chainRoot: audit.root, hooks: POLICY.hooks
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/policy') {
      sendJson(res, 200, POLICY);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/containers') {
      sendJson(res, 200, { mode: 'docker', containers: await getContainerRows(engine) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/containers') {
      const body = await readJsonBody(req, POLICY.limits.maxRequestBytes);
      const image = typeof body.image === 'string' ? body.image.trim() : '';
      const command = typeof body.command === 'string' ? body.command.trim() : '';
      if (!image || image.length > POLICY.limits.maxImageLength || !POLICY.allowlistedImages.includes(image)) {
        await audit.append('on_error', `blocked image request: ${image || '(empty)'}`, 'error');
        sendError(res, 403, 'image_not_allowlisted', 'Image must exactly match an entry in the server allowlist.');
        return;
      }
      if (command.length > POLICY.limits.maxCommandLength || /[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(command)) {
        sendError(res, 400, 'invalid_command', 'Command must be plain text within the configured length limit.');
        return;
      }
      if (!(await engine.hasImage(image))) {
        sendError(res, 409, 'image_not_pulled', `Allowlisted image ${image} is not present on the rootless daemon. Pull it on the host first.`);
        return;
      }
      const releasePolicy = await acquirePolicyLock();
      try {
      const existing = await getContainerRows(engine);
      const active = existing.filter((row) => row.st === 'running');
      const pendingPipelines = Math.max(0, pipelineSlots.active - active.filter((row) => row.pipeline).length);
      const memLimit = POLICY.containerLimits.memoryMb;
      const cpuLimit = POLICY.containerLimits.cpuCores;
      const memReserved = active.reduce((sum, row) => sum + row.memoryLimitMb, 0) + pendingPipelines * 1024;
      const cpuReserved = active.reduce((sum, row) => sum + row.cpuLimit, 0) + pendingPipelines;
      const pidsReserved = active.reduce((sum, row) => sum + row.pidsLimit, 0) + pendingPipelines * POLICY.containerLimits.pids;
      if (existing.length + pendingPipelines >= POLICY.limits.maxContainers || memReserved + memLimit > POLICY.quotas.memoryMb || cpuReserved + cpuLimit > POLICY.quotas.cpuCores || pidsReserved + POLICY.containerLimits.pids > POLICY.quotas.pids) {
        await audit.append('pre_start', 'resource quota rejected container', 'warn');
        sendError(res, 429, 'quota_exceeded', 'Configured container or resource quota would be exceeded.');
        return;
      }

      const name = `sandboxd-${randomBytes(4).toString('hex')}`;
      const labels = { 'sandboxd.requested-image': image };
      await audit.append('pre_create', `creating ${name}`, 'info', { image });
      const created = await engine.create({
        image, name, memoryBytes: memLimit * MIB, nanoCpus: Math.round(cpuLimit * 1e9),
        pidsLimit: POLICY.containerLimits.pids, labels
      });
      const id = created?.Id;
      if (!id) throw new DockerApiError('Docker did not return a container id.', 502);
      await audit.append('post_create', `created ${name}`, 'ok', { id: id.slice(0, 12), image });
      try {
        await audit.append('pre_start', `starting ${name}`, 'info', { id: id.slice(0, 12) });
        await engine.start(id);
      } catch (error) {
        await audit.append('on_error', `failed to start ${name}: ${error.message}`, 'error');
        await engine.remove(id, true).catch(() => {});
        throw error;
      }
      await audit.append('post_start', `started ${name}`, 'ok', { id: id.slice(0, 12) });
      releasePolicy();
      if (command) {
        await audit.append('pre_exec', `exec in ${name}`, 'info', { id: id.slice(0, 12) });
        const result = await engine.exec(id, ['/bin/sh', '-lc', command], {
          timeoutMs: POLICY.containerLimits.executionSeconds * 1000,
          maxBytes: POLICY.containerLimits.maxOutputBytes
        });
        await audit.append('post_exec', `command exited ${result.exitCode}`, result.exitCode === 0 ? 'ok' : 'warn', { id: id.slice(0, 12) });
        sendJson(res, 201, { mode: 'docker', container: await engine.inspect(id), commandResult: result });
        return;
      }
      sendJson(res, 201, { mode: 'docker', container: await engine.inspect(id) });
      return;
      } finally {
        releasePolicy();
      }
    }

    if (req.method === 'POST' && pathname === '/api/v1/containers/stop-all') {
      const rows = await getContainerRows(engine);
      const stopped = [];
      for (const row of rows.filter((item) => item.st === 'running')) {
        await audit.append('pre_destroy', `stopping ${row.id.slice(0, 12)}`, 'info');
        await engine.stop(row.id).catch((error) => { if (error.status !== 304) throw error; });
        stopped.push(row.id);
        await audit.append('post_destroy', `stopped ${row.id.slice(0, 12)}`, 'ok');
      }
      sendJson(res, 200, { mode: 'docker', stopped });
      return;
    }

    const execMatch = pathname.match(/^\/api\/v1\/containers\/([a-f0-9]{12,64})\/exec$/i);
    if (req.method === 'POST' && execMatch) {
      const body = await readJsonBody(req, POLICY.limits.maxRequestBytes);
      const command = typeof body.command === 'string' ? body.command.trim() : '';
      if (!command || command.length > POLICY.limits.maxCommandLength || /[\u0000\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(command)) {
        sendError(res, 400, 'invalid_command', 'command is required, plain text, and within the configured length limit.');
        return;
      }
      const id = execMatch[1];
      const inspect = await engine.inspect(id);
      if (inspect?.Config?.Labels?.['sandboxd.managed'] !== 'true') {
        sendError(res, 404, 'container_not_found', 'Container is not managed by sandboxd.');
        return;
      }
      if (inspect?.State?.Running !== true) {
        sendError(res, 409, 'container_not_running', 'Start a managed container before executing a command.');
        return;
      }
      await audit.append('pre_exec', `command requested in ${id.slice(0, 12)}`, 'info');
      const result = await engine.exec(id, ['/bin/sh', '-lc', command], {
        timeoutMs: POLICY.containerLimits.executionSeconds * 1000,
        maxBytes: POLICY.containerLimits.maxOutputBytes
      });
      await audit.append('post_exec', `command exited ${result.exitCode}`, result.exitCode === 0 ? 'ok' : 'warn', { id: id.slice(0, 12) });
      sendJson(res, 200, { mode: 'docker', ...result });
      return;
    }

    const startMatch = pathname.match(/^\/api\/v1\/containers\/([a-f0-9]{12,64})\/start$/i);
    if (req.method === 'POST' && startMatch) {
      const id = startMatch[1];
      const inspect = await engine.inspect(id);
      if (inspect?.Config?.Labels?.['sandboxd.managed'] !== 'true') {
        sendError(res, 404, 'container_not_found', 'Container is not managed by sandboxd.');
        return;
      }
      const memoryLimitMb = Math.round((inspect.HostConfig?.Memory || 0) / MIB);
      const cpuLimit = Number(((inspect.HostConfig?.NanoCpus || 0) / 1e9).toFixed(2));
      const pidsLimit = Number(inspect.HostConfig?.PidsLimit || 0);
      if (!POLICY.allowlistedImages.includes(inspect.Config.Image) || inspect.HostConfig?.NetworkMode !== 'none' || inspect.HostConfig?.ReadonlyRootfs !== true || inspect.HostConfig?.Privileged === true || inspect.Config.User !== '65534:65534' || !(inspect.HostConfig?.CapDrop || []).includes('ALL') || !(inspect.HostConfig?.SecurityOpt || []).includes('no-new-privileges:true') || memoryLimitMb <= 0 || memoryLimitMb > POLICY.containerLimits.memoryMb || cpuLimit <= 0 || cpuLimit > POLICY.containerLimits.cpuCores || pidsLimit <= 0 || pidsLimit > POLICY.containerLimits.pids) {
        sendError(res, 409, 'container_policy_mismatch', 'Container no longer matches the active sandbox policy and cannot be started.');
        return;
      }
      if (inspect.State?.Running === true) {
        sendJson(res, 200, { mode: 'docker', started: id, alreadyRunning: true });
        return;
      }
      const releasePolicy = await acquirePolicyLock();
      try {
      const rows = await getContainerRows(engine);
      const active = rows.filter((row) => row.st === 'running');
      const pendingPipelines = Math.max(0, pipelineSlots.active - active.filter((row) => row.pipeline).length);
      const memoryReserved = active.reduce((sum, row) => sum + row.memoryLimitMb, 0) + pendingPipelines * 1024;
      const cpuReserved = active.reduce((sum, row) => sum + row.cpuLimit, 0) + pendingPipelines;
      const pidsReserved = active.reduce((sum, row) => sum + row.pidsLimit, 0) + pendingPipelines * POLICY.containerLimits.pids;
      if (memoryReserved + memoryLimitMb > POLICY.quotas.memoryMb || cpuReserved + cpuLimit > POLICY.quotas.cpuCores || pidsReserved + pidsLimit > POLICY.quotas.pids) {
        await audit.append('pre_start', `resource quota rejected restart ${id.slice(0, 12)}`, 'warn');
        sendError(res, 429, 'quota_exceeded', 'Starting this container would exceed the configured resource quota.');
        return;
      }
      await audit.append('pre_start', `starting ${id.slice(0, 12)}`, 'info');
      await engine.start(id);
      await audit.append('post_start', `started ${id.slice(0, 12)}`, 'ok');
      sendJson(res, 200, { mode: 'docker', started: id });
      return;
      } finally {
        releasePolicy();
      }
    }

    const stopMatch = pathname.match(/^\/api\/v1\/containers\/([a-f0-9]{12,64})\/stop$/i);
    if (req.method === 'POST' && stopMatch) {
      const id = stopMatch[1];
      const inspect = await engine.inspect(id);
      if (inspect?.Config?.Labels?.['sandboxd.managed'] !== 'true') {
        sendError(res, 404, 'container_not_found', 'Container is not managed by sandboxd.');
        return;
      }
      await audit.append('pre_destroy', `stopping ${id.slice(0, 12)}`, 'info');
      await engine.stop(id);
      await audit.append('post_destroy', `stopped ${id.slice(0, 12)}`, 'ok');
      sendJson(res, 200, { mode: 'docker', stopped: id });
      return;
    }

    const removeMatch = pathname.match(/^\/api\/v1\/containers\/([a-f0-9]{12,64})$/i);
    if (req.method === 'DELETE' && removeMatch) {
      const id = removeMatch[1];
      const inspect = await engine.inspect(id);
      if (inspect?.Config?.Labels?.['sandboxd.managed'] !== 'true') {
        sendError(res, 404, 'container_not_found', 'Container is not managed by sandboxd.');
        return;
      }
      await audit.append('pre_destroy', `removing ${id.slice(0, 12)}`, 'info');
      if (inspect.State?.Running) await engine.stop(id);
      await engine.remove(id, true);
      await audit.append('post_destroy', `removed ${id.slice(0, 12)}`, 'ok');
      sendJson(res, 200, { mode: 'docker', removed: id });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/pipelines') {
      sendJson(res, 200, { mode: 'docker', pipelines: await pipelineList(engine, pipelineSlots) });
      return;
    }

    const pipelineMatch = pathname.match(/^\/api\/v1\/pipelines\/(build|test)\/run$/);
    if (req.method === 'POST' && pipelineMatch) {
      await readJsonBody(req, POLICY.limits.maxRequestBytes);
      const name = pipelineMatch[1];
      const runningPipelines = (await engine.containers()).filter((container) =>
        container.State === 'running' && container.Labels?.['sandboxd.pipeline'] === 'true'
      ).length;
      if (pipelineSlots.active >= POLICY.limits.maxConcurrentPipelines || runningPipelines >= POLICY.limits.maxConcurrentPipelines) {
        sendError(res, 429, 'pipeline_busy', 'The configured concurrent pipeline limit has been reached.');
        return;
      }
      pipelineSlots.active += 1;
      try {
        const workspace = safeWorkspace();
        if (!(await engine.hasImage(POLICY.pipeline.image))) {
          sendError(res, 409, 'pipeline_image_not_pulled', `Pull ${POLICY.pipeline.image} on the rootless daemon to enable pipelines.`);
          return;
        }
        const rows = await getContainerRows(engine);
        const active = rows.filter((row) => row.st === 'running');
        const pending = Math.max(0, pipelineSlots.active - active.filter((row) => row.pipeline).length);
        const memoryReserved = active.reduce((sum, row) => sum + row.memoryLimitMb, 0) + pending * 1024;
        const cpuReserved = active.reduce((sum, row) => sum + row.cpuLimit, 0) + pending;
        const pidsReserved = active.reduce((sum, row) => sum + row.pidsLimit, 0) + pending * POLICY.containerLimits.pids;
        if (rows.length + pending > POLICY.limits.maxContainers || memoryReserved > POLICY.quotas.memoryMb || cpuReserved > POLICY.quotas.cpuCores || pidsReserved > POLICY.quotas.pids) {
          await audit.append('pre_pipeline', `${name} pipeline rejected by resource quota`, 'warn');
          sendError(res, 429, 'quota_exceeded', 'Pipeline would exceed the configured container or resource quota.');
          return;
        }
        const jobId = `sandboxd-${name}-${randomBytes(4).toString('hex')}`;
        const startedAt = Date.now();
        await audit.append('pre_pipeline', `starting ${name} pipeline`, 'info', { jobId });
        const result = await engine.runJob({
          image: POLICY.pipeline.image,
          name: jobId,
          command: PIPELINES[name].command,
          workspaceHostPath: workspace,
          memoryBytes: 1024 * MIB,
          nanoCpus: 1e9,
          pidsLimit: POLICY.containerLimits.pids,
          timeoutMs: POLICY.limits.maxPipelineSeconds * 1000,
          maxBytes: POLICY.containerLimits.maxOutputBytes
        });
        const durationMs = Date.now() - startedAt;
        const level = result.exitCode === 0 ? 'ok' : 'error';
        await audit.append('post_pipeline', `${name} pipeline exited ${result.exitCode}`, level, { jobId, durationMs });
        sendJson(res, 200, { mode: 'docker', id: jobId, name, state: result.exitCode === 0 ? 'success' : 'failed', exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs });
        return;
      } finally {
        pipelineSlots.active -= 1;
      }
    }

    if (req.method === 'GET' && pathname === '/api/v1/events') {
      sendJson(res, 200, { mode: 'docker', chainRoot: audit.root, events: audit.events.slice(-120).reverse() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/audit/verify') {
      const result = await audit.verify();
      sendJson(res, result.valid ? 200 : 409, result);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/network') {
      sendJson(res, 200, { mode: 'docker', network: 'isolated', modes: ['isolated'] });
      return;
    }

    sendError(res, 404, 'not_found', 'Unknown API route.');
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) await audit.append('on_error', error.message, 'error').catch(() => {});
    sendError(res, status, error.status ? 'docker_or_request_error' : 'internal_error', error.message, error.details);
  }
}

export async function createSandboxServer({ engine = new DockerEngine(), token = process.env.SANDBOX_API_TOKEN, auditFile = process.env.SANDBOX_AUDIT_FILE || path.join(HERE, 'data', 'audit.jsonl'), allowedOrigins = parseAllowedOrigins() } = {}) {
  if (!token || token.length < 32) throw new Error('SANDBOX_API_TOKEN must be set to a random value of at least 32 characters.');
  const audit = await AuditLog.open(auditFile);
  const pipelineSlots = { active: 0 };
  const acquirePolicyLock = createPolicyLock();
  await audit.append('daemon', 'sandboxd API started', 'ok', { mode: 'docker' });

  return http.createServer(async (req, res) => {
    try {
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://sandbox.local').pathname); }
      catch { sendError(res, 400, 'invalid_url', 'Request URL is malformed.'); return; }
      if (pathname.startsWith('/api/')) {
        await routeApi(req, res, pathname, { engine, audit, token, allowedOrigins, pipelineSlots, acquirePolicyLock });
        return;
      }
      await sendStatic(req, res, pathname);
    } catch (error) {
      if (!res.headersSent) sendError(res, 500, 'internal_error', 'sandboxd encountered an internal error.');
      else res.destroy(error);
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const host = process.env.SANDBOX_API_HOST || process.env.SANDBOX_HOST || '127.0.0.1';
  const port = Number(process.env.SANDBOX_API_PORT || process.env.SANDBOX_PORT || process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('SANDBOX_API_PORT must be an integer between 0 and 65535.');
    process.exitCode = 1;
  } else if (!process.env.SANDBOX_API_TOKEN || process.env.SANDBOX_API_TOKEN.length < 32) {
    console.error('Set SANDBOX_API_TOKEN to a random value of at least 32 characters.');
    process.exitCode = 1;
  } else {
    createSandboxServer().then((server) => {
      server.listen(port, host, () => {
        const address = server.address();
        console.log(`sandboxd Docker API listening on ${host}:${address.port}`);
        console.log('Requires a reachable rootless Docker daemon. Workloads use no network, no host mounts, read-only roots, dropped capabilities, and fixed limits.');
      });
    }).catch((error) => {
      console.error(`sandboxd failed to start: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
