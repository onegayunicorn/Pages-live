import http from 'node:http';

export class DockerApiError extends Error {
  constructor(message, status = 503, details = undefined) {
    super(message);
    this.name = 'DockerApiError';
    this.status = status;
    this.details = details;
  }
}

function decodeMultiplexed(buffer) {
  const streams = { stdout: [], stderr: [] };
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const type = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);
    if (length > buffer.length - offset - 8) break;
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 1) streams.stdout.push(chunk);
    else if (type === 2) streams.stderr.push(chunk);
    offset += 8 + length;
  }
  return {
    stdout: Buffer.concat(streams.stdout).toString('utf8'),
    stderr: Buffer.concat(streams.stderr).toString('utf8')
  };
}

function makeContainerConfig({ image, labels, memoryBytes, nanoCpus, pidsLimit, command, workspaceHostPath }) {
  const config = {
    Image: image,
    Entrypoint: ['/bin/sh', '-lc'],
    Cmd: [command || 'while :; do sleep 3600; done'],
    User: '65534:65534',
    WorkingDir: workspaceHostPath ? '/workspace' : '/tmp',
    Env: ['HOME=/tmp', 'TMPDIR=/tmp', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
    Labels: labels,
    AttachStdout: false,
    AttachStderr: false,
    OpenStdin: false,
    Tty: false
  };
  const binds = workspaceHostPath ? [`${workspaceHostPath}:/workspace:ro`] : [];
  const hostConfig = {
    AutoRemove: false,
    Binds: binds,
    Mounts: [],
    NetworkMode: 'none',
    PortBindings: {},
    Privileged: false,
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    Memory: memoryBytes,
    MemorySwap: memoryBytes,
    NanoCpus: nanoCpus,
    PidsLimit: pidsLimit,
    ShmSize: 32 * 1024 * 1024,
    Init: true,
    RestartPolicy: { Name: 'no' },
    LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } },
    Tmpfs: {
      '/tmp': 'rw,nosuid,nodev,size=64m,mode=1777'
    }
  };
  return { config, hostConfig };
}

export class DockerEngine {
  constructor({ socketPath = process.env.DOCKER_SOCKET || '/run/user/1000/docker.sock', apiVersion = process.env.DOCKER_API_VERSION || null } = {}) {
    this.socketPath = socketPath;
    this.apiVersion = apiVersion;
    this.versionPromise = null;
  }

  requestRaw(method, pathname, body = null, { timeoutMs = 10000, maxBytes = 2 * 1024 * 1024, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const payload = body === null ? null : Buffer.from(JSON.stringify(body));
      const requestHeaders = { accept: 'application/json', ...headers };
      if (payload) {
        requestHeaders['content-type'] = 'application/json';
        requestHeaders['content-length'] = String(payload.length);
      }
      const request = http.request({ socketPath: this.socketPath, path: pathname, method, headers: requestHeaders }, (response) => {
        const chunks = [];
        let received = 0;
        response.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            request.destroy(new DockerApiError('Docker response exceeded the configured output limit.', 502));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) });
        });
      });
      const timer = setTimeout(() => request.destroy(new DockerApiError('Docker Engine request timed out.', 504)), timeoutMs);
      timer.unref?.();
      request.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'ECONNREFUSED') {
          reject(new DockerApiError(`Cannot reach Docker Engine at ${this.socketPath}: ${error.message}`, 503));
        } else reject(error);
      });
      if (payload) request.write(payload);
      request.end();
    });
  }

  async versionPrefix() {
    if (this.apiVersion) return `/v${this.apiVersion}`;
    if (!this.versionPromise) {
      this.versionPromise = this.requestRaw('GET', '/version', null, { timeoutMs: 4000, maxBytes: 128 * 1024 })
        .then(({ status, body }) => {
          if (status < 200 || status >= 300) throw new DockerApiError('Docker Engine version negotiation failed.', 503);
          const data = JSON.parse(body.toString('utf8'));
          if (!/^\d+\.\d+$/.test(data.ApiVersion || '')) throw new DockerApiError('Docker Engine returned an invalid API version.', 503);
          this.apiVersion = data.ApiVersion;
          return `/v${this.apiVersion}`;
        })
        .catch((error) => {
          this.versionPromise = null;
          throw error;
        });
    }
    return this.versionPromise;
  }

  async json(method, apiPath, body = null, options = {}) {
    const prefix = options.unversioned ? '' : await this.versionPrefix();
    const response = await this.requestRaw(method, `${prefix}${apiPath}`, body, options);
    const text = response.body.toString('utf8');
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch { data = { message: text.slice(0, 1000) }; }
    }
    if ((response.status < 200 || response.status >= 300) && response.status !== 304) {
      throw new DockerApiError(data?.message || `Docker Engine returned HTTP ${response.status}.`, response.status, data);
    }
    return { status: response.status, data };
  }

  async ping() {
    const { status, body } = await this.requestRaw('GET', '/_ping', null, { unversioned: true, timeoutMs: 3000, maxBytes: 1024 });
    if (status !== 200 || body.toString('utf8').trim() !== 'OK') throw new DockerApiError('Docker Engine health check failed.', 503);
    return true;
  }

  async info() {
    return (await this.json('GET', '/info')).data;
  }

  isRootless(info) {
    return (info?.SecurityOptions || []).some((option) => /rootless/i.test(option));
  }

  async images() {
    return (await this.json('GET', '/images/json?all=1')).data || [];
  }

  async hasImage(reference) {
    const images = await this.images();
    return images.some((image) => (image.RepoTags || []).includes(reference) || (image.RepoDigests || []).includes(reference));
  }

  async containers() {
    const filters = encodeURIComponent(JSON.stringify({ label: ['sandboxd.managed=true'] }));
    return (await this.json('GET', `/containers/json?all=1&size=1&filters=${filters}`)).data || [];
  }

  async inspect(id) {
    return (await this.json('GET', `/containers/${encodeURIComponent(id)}/json`)).data;
  }

  async stats(id) {
    return (await this.json('GET', `/containers/${encodeURIComponent(id)}/stats?stream=false`, null, { timeoutMs: 5000, maxBytes: 1024 * 1024 })).data;
  }

  async create({ image, name, command, memoryBytes, nanoCpus, pidsLimit, workspaceHostPath = null, labels = {} }) {
    const fullLabels = { 'sandboxd.managed': 'true', 'sandboxd.owner': 'sandboxd-api', ...labels };
    const { config, hostConfig } = makeContainerConfig({ image, labels: fullLabels, memoryBytes, nanoCpus, pidsLimit, command, workspaceHostPath });
    const query = new URLSearchParams({ name });
    return (await this.json('POST', `/containers/create?${query}`, { ...config, HostConfig: hostConfig })).data;
  }

  async start(id) {
    return (await this.json('POST', `/containers/${encodeURIComponent(id)}/start`)).data;
  }

  async stop(id, timeoutSeconds = 3) {
    try {
      return (await this.json('POST', `/containers/${encodeURIComponent(id)}/stop?t=${timeoutSeconds}`)).data;
    } catch (error) {
      if (error.status === 304 || error.status === 404) return null;
      throw error;
    }
  }

  async kill(id) {
    try {
      return (await this.json('POST', `/containers/${encodeURIComponent(id)}/kill?signal=KILL`)).data;
    } catch (error) {
      if (error.status === 304 || error.status === 404) return null;
      throw error;
    }
  }

  async remove(id, force = false) {
    try {
      return (await this.json('DELETE', `/containers/${encodeURIComponent(id)}?force=${force ? '1' : '0'}&v=0`)).data;
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async exec(id, command, { timeoutMs = 15000, maxBytes = 1024 * 1024 } = {}) {
    const execResponse = await this.json('POST', `/containers/${encodeURIComponent(id)}/exec`, {
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: command,
      User: '65534:65534',
      WorkingDir: '/tmp'
    });
    const execId = execResponse.data?.Id;
    if (!execId) throw new DockerApiError('Docker did not return an exec id.', 502);
    let stream;
    try {
      stream = await this.requestRaw('POST', `${await this.versionPrefix()}/exec/${encodeURIComponent(execId)}/start`, { Detach: false, Tty: false }, { timeoutMs, maxBytes });
    } catch (error) {
      await this.kill(id).catch(() => {});
      throw error;
    }
    if (stream.status < 200 || stream.status >= 300) {
      throw new DockerApiError(`Docker exec returned HTTP ${stream.status}.`, stream.status, stream.body.toString('utf8'));
    }
    const output = decodeMultiplexed(stream.body);
    const inspect = (await this.json('GET', `/exec/${encodeURIComponent(execId)}/json`)).data;
    return {
      stdout: output.stdout,
      stderr: output.stderr,
      exitCode: Number.isInteger(inspect?.ExitCode) ? inspect.ExitCode : null,
      running: !!inspect?.Running
    };
  }

  async runJob({ image, name, command, workspaceHostPath, memoryBytes, nanoCpus, pidsLimit, timeoutMs = 120000, maxBytes = 1024 * 1024 }) {
    const created = await this.create({ image, name, command, workspaceHostPath, memoryBytes, nanoCpus, pidsLimit, labels: { 'sandboxd.pipeline': 'true' } });
    const id = created?.Id;
    if (!id) throw new DockerApiError('Docker did not return a job container id.', 502);
    try {
      await this.start(id);
      const waited = await this.json('POST', `/containers/${encodeURIComponent(id)}/wait?condition=not-running`, null, { timeoutMs, maxBytes: 64 * 1024 });
      const logsResponse = await this.requestRaw('GET', `${await this.versionPrefix()}/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&timestamps=0`, null, { timeoutMs: 10000, maxBytes });
      if (logsResponse.status < 200 || logsResponse.status >= 300) throw new DockerApiError(`Docker logs returned HTTP ${logsResponse.status}.`, logsResponse.status);
      const output = decodeMultiplexed(logsResponse.body);
      return { id, exitCode: waited.data?.StatusCode ?? null, ...output };
    } catch (error) {
      await this.kill(id).catch(() => {});
      throw error;
    } finally {
      await this.remove(id, true).catch(() => {});
    }
  }
}
