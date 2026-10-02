import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import {
  BackendError,
  BackendRegistry,
  MemoryBackendStore,
  backendEventMeta,
  backendExportRow,
  backendView,
  hostSha256,
  isLoopbackHost,
  makeBackendId,
  normalizeHost,
  normalizeModel,
  parseDetails,
  parseShow,
  parseTags,
  parseVersion,
  probeOllama,
  providerUrl,
  redactHosts,
  slugify,
  type ProbeResult,
} from './bench-backends.js';

// ------------------------------------------------------------ a fake Ollama on an ephemeral 127.0.0.1 port

interface FakeOpts {
  version?: string;
  models?: Array<{ name: string; digest: string; details?: Record<string, string> }>;
  hang?: boolean; // never answers: exercises the timeout
  notOllama?: boolean; // answers HTML
}

function startFakeOllama(opts: FakeOpts = {}): Promise<{ port: number; close: () => Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  const models = opts.models ?? [
    { name: 'qwen2.5-coder:7b', digest: 'abc123', details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' } },
  ];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (opts.hang) return; // keep the socket open, say nothing
    if (opts.notOllama) {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>hi</html>');
      return;
    }
    const json = (code: number, body: unknown) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (req.method === 'GET' && req.url === '/api/version') return json(200, { version: opts.version ?? '0.6.5' });
    if (req.method === 'GET' && req.url === '/api/tags') return json(200, { models: models.map((m) => ({ name: m.name, model: m.name, digest: m.digest, details: m.details })) });
    if (req.method === 'POST' && req.url === '/api/show') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const want = JSON.parse(body).model as string;
        const hit = models.find((m) => m.name === want);
        if (!hit) return json(404, { error: `model '${want}' not found` });
        json(200, { details: hit.details ?? {}, modelfile: '…' });
      });
      return;
    }
    json(404, { error: 'nope' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        hits,
        close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
      });
    });
  });
}

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c()));
});
const fake = async (o?: FakeOpts) => {
  const f = await startFakeOllama(o);
  open.push(f.close);
  return f;
};

// ------------------------------------------------------------ helpers

describe('redactHosts', () => {
  it('removes participant addresses from runner error text, keeps loopback', () => {
    expect(redactHosts('connect ECONNREFUSED 192.168.1.5:11434')).toBe('connect ECONNREFUSED [host]:11434');
    expect(redactHosts('GET http://192.168.1.5:11434/v1/chat failed')).toBe('GET http://[host]:11434/v1/chat failed');
    expect(redactHosts('http://ana-pc.local:11434/v1 timed out')).toBe('http://[host]:11434/v1 timed out');
    expect(redactHosts('http://[fe80::1]:11434/v1')).toBe('http://[host]:11434/v1');
    expect(redactHosts('arena at 127.0.0.1:3000 and http://localhost:3000')).toBe('arena at 127.0.0.1:3000 and http://localhost:3000');
    expect(redactHosts('no address here')).toBe('no address here');
  });
});

describe('host and id helpers', () => {
  it('normalises IPv4-mapped IPv6, brackets, zones and case', () => {
    expect(normalizeHost('::ffff:192.168.0.5')).toBe('192.168.0.5');
    expect(normalizeHost('::FFFF:c0a8:5')).toBe('192.168.0.5');
    expect(normalizeHost('[fe80::1%en0]')).toBe('fe80::1');
    expect(normalizeHost('  LOCALHOST ')).toBe('localhost');
    expect(normalizeHost('10.0.0.7')).toBe('10.0.0.7');
  });

  it('detects loopback', () => {
    for (const h of ['127.0.0.1', '127.0.0.9', '::1', '::ffff:127.0.0.1', 'localhost']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['192.168.0.5', '10.0.0.1', '::ffff:10.0.0.1', '128.0.0.1']) expect(isLoopbackHost(h)).toBe(false);
  });

  it('host_sha256 is sha256 of the normalised host, so v4-mapped and plain agree', () => {
    const expected = createHash('sha256').update('192.168.0.5').digest('hex');
    expect(hostSha256('192.168.0.5')).toBe(expected);
    expect(hostSha256('::ffff:192.168.0.5')).toBe(expected);
    expect(hostSha256('192.168.0.5')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalises model names the way Ollama does (:latest)', () => {
    expect(normalizeModel('llama3')).toBe('llama3:latest');
    expect(normalizeModel(' qwen2.5-coder:7b ')).toBe('qwen2.5-coder:7b');
    expect(normalizeModel('hf.co/user/model')).toBe('hf.co/user/model:latest');
    expect(normalizeModel('hf.co/user/model:Q4')).toBe('hf.co/user/model:Q4');
  });

  it('builds backend ids b-<slug>-<hex6>, stable per (host, port, model)', () => {
    const id = makeBackendId('João da Silva!', '192.168.0.5', 11434, 'qwen:7b');
    expect(id).toMatch(/^b-joao-da-silva-[0-9a-f]{6}$/);
    expect(makeBackendId('x', '192.168.0.5', 11434, 'qwen:7b').slice(-6)).toBe(id.slice(-6));
    expect(makeBackendId('x', '192.168.0.6', 11434, 'qwen:7b').slice(-6)).not.toBe(id.slice(-6));
    expect(slugify('***')).toBe('jogador');
    expect(slugify('A'.repeat(60))).toHaveLength(24);
  });

  it('builds provider_url with IPv6 brackets', () => {
    expect(providerUrl('192.168.0.5', 11434)).toBe('http://192.168.0.5:11434/v1');
    expect(providerUrl('fe80::1', 11434)).toBe('http://[fe80::1]:11434/v1');
  });
});

// ------------------------------------------------------------ probe parsers

describe('probe parsers', () => {
  it('parseVersion', () => {
    expect(parseVersion({ version: '0.6.5' })).toBe('0.6.5');
    expect(parseVersion({})).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion('0.6.5')).toBeNull();
  });

  it('parseShow / parseDetails read details.{family,parameter_size,quantization_level}', () => {
    expect(parseShow({ details: { family: 'llama', parameter_size: '8.0B', quantization_level: 'Q4_0', format: 'gguf' } })).toEqual({
      family: 'llama',
      parameter_size: '8.0B',
      quantization_level: 'Q4_0',
    });
    expect(parseShow({ details: {} })).toBeNull();
    expect(parseShow({})).toBeNull();
    expect(parseDetails({ family: 'x' })).toEqual({ family: 'x', parameter_size: null, quantization_level: null });
  });

  it('parseTags finds the model, prefixes the digest and tolerates :latest', () => {
    const tags = {
      models: [
        { name: 'llama3:latest', model: 'llama3:latest', digest: 'deadbeef', details: { family: 'llama' } },
        { name: 'qwen2.5-coder:7b', digest: 'sha256:cafe' },
      ],
    };
    const a = parseTags(tags, 'llama3');
    expect(a.found).toBe(true);
    expect(a.digest).toBe('sha256:deadbeef');
    expect(a.details?.family).toBe('llama');
    expect(parseTags(tags, 'qwen2.5-coder:7b').digest).toBe('sha256:cafe'); // already prefixed: not doubled
    const miss = parseTags(tags, 'phi4:14b');
    expect(miss.found).toBe(false);
    expect(miss.digest).toBeNull();
    expect(miss.names).toEqual(['llama3:latest', 'qwen2.5-coder:7b']);
    expect(parseTags('garbage', 'x').names).toEqual([]);
  });
});

// ------------------------------------------------------------ probeOllama against a real local HTTP server

describe('probeOllama', () => {
  it('reads version, details and digest from a healthy Ollama', async () => {
    const f = await fake();
    const r = await probeOllama('127.0.0.1', f.port, 'qwen2.5-coder:7b');
    expect(r.reachable).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.ollamaVersion).toBe('0.6.5');
    expect(r.digest).toBe('sha256:abc123');
    expect(r.details).toEqual({ family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' });
    expect(f.hits).toEqual(expect.arrayContaining(['GET /api/version', 'POST /api/show', 'GET /api/tags']));
  });

  it('reports model_missing, with the installed models in the fix', async () => {
    const f = await fake();
    const r = await probeOllama('127.0.0.1', f.port, 'phi4:14b');
    expect(r.reachable).toBe(true);
    expect(r.ollamaVersion).toBe('0.6.5');
    expect(r.problems.map((p) => p.code)).toEqual(['model_missing']);
    expect(r.problems[0].fix).toContain('ollama pull phi4:14b');
    expect(r.problems[0].fix).toContain('qwen2.5-coder:7b');
    expect(r.digest).toBeNull();
  });

  it('reports unreachable on connection refused, with the OLLAMA_HOST fix and no host in the text', async () => {
    const f = await fake();
    const port = f.port;
    await f.close();
    const r = await probeOllama('127.0.0.1', port, 'x:1b');
    expect(r.reachable).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0].code).toBe('unreachable');
    expect(r.problems[0].detail).toBe('ECONNREFUSED');
    expect(r.problems[0].fix).toContain('OLLAMA_HOST=0.0.0.0');
    expect(JSON.stringify(r.problems)).not.toContain('127.0.0.1');
  });

  it('reports timeout when nothing answers within the deadline', async () => {
    const f = await fake({ hang: true });
    const t0 = Date.now();
    const r = await probeOllama('127.0.0.1', f.port, 'x:1b', 250);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.reachable).toBe(false);
    expect(r.problems[0].code).toBe('timeout');
    expect(r.problems[0].fix).toMatch(/firewall/i);
  });

  it('does not take a non-Ollama web server for Ollama', async () => {
    const f = await fake({ notOllama: true });
    const r = await probeOllama('127.0.0.1', f.port, 'x:1b');
    expect(r.reachable).toBe(false);
    expect(r.problems[0].code).toBe('unreachable');
  });
});

// ------------------------------------------------------------ registry: upsert, toggle, privacy

const okProbe = (over: Partial<ProbeResult> = {}) => async (): Promise<ProbeResult> => ({
  reachable: true,
  ollamaVersion: '0.6.5',
  digest: 'sha256:abc',
  details: { family: 'qwen2', parameter_size: '7B', quantization_level: 'Q4_K_M' },
  problems: [],
  probedAt: new Date(),
  ...over,
});

describe('BackendRegistry', () => {
  let store: MemoryBackendStore;
  let events: Array<{ type: string; meta: Record<string, unknown> }>;
  const make = (probe = okProbe(), maxPerHost?: number) =>
    new BackendRegistry(store, {
      probe,
      maxPerHost,
      log: (type, b, extra) => events.push({ type, meta: backendEventMeta(b, extra) }),
    });
  const input = { nickname: 'Ana', model: 'qwen2.5-coder:7b', port: 11434 };

  beforeEach(() => {
    store = new MemoryBackendStore();
    events = [];
  });

  it('registers, probes and stores the host from the argument', async () => {
    const reg = make();
    const { backend, created } = await reg.register(input, '::ffff:192.168.0.5');
    expect(created).toBe(true);
    expect(backend.host).toBe('192.168.0.5');
    expect(backend.id).toMatch(/^b-ana-[0-9a-f]{6}$/);
    expect(backend.reachable).toBe(true);
    expect(backend.digest).toBe('sha256:abc');
    expect(backend.hostSha256).toBe(hostSha256('192.168.0.5'));
    expect(events.map((e) => e.type)).toEqual(['bench_backend_registered']);
  });

  it('upserts by (host, port, model): re-submitting updates the same backend and keeps its id and enabled flag', async () => {
    const reg = make();
    const a = await reg.register(input, '192.168.0.5');
    await reg.setEnabled(a.backend.id, false);
    const b = await reg.register({ ...input, nickname: 'Ana Maria', declaredHardware: { chip: 'M2', ram_gb: 16, accel: 'metal' } }, '::ffff:192.168.0.5');
    expect(b.created).toBe(false);
    expect(b.backend.id).toBe(a.backend.id);
    expect(b.backend.nickname).toBe('Ana Maria');
    expect(b.backend.declaredHardware?.chip).toBe('M2');
    expect(b.backend.enabled).toBe(false);
    expect(await reg.list()).toHaveLength(1);
    // `llama3` and `llama3:latest` are the same model
    const c = await reg.register({ ...input, model: 'llama3' }, '192.168.0.5');
    const d = await reg.register({ ...input, model: 'llama3:latest' }, '192.168.0.5');
    expect(d.created).toBe(false);
    expect(d.backend.id).toBe(c.backend.id);
  });

  it('a different host, port or model is a different backend', async () => {
    const reg = make();
    await reg.register(input, '192.168.0.5');
    await reg.register(input, '192.168.0.6');
    await reg.register({ ...input, port: 11435 }, '192.168.0.5');
    await reg.register({ ...input, model: 'llama3:8b' }, '192.168.0.5');
    expect(await reg.list()).toHaveLength(4);
  });

  it('two simultaneous registrations of the same key produce one row', async () => {
    const reg = make();
    const [x, y] = await Promise.all([reg.register(input, '192.168.0.5'), reg.register(input, '192.168.0.5')]);
    expect(x.backend.id).toBe(y.backend.id);
    expect([x.created, y.created].sort()).toEqual([false, true]);
    expect(await reg.list()).toHaveLength(1);
  });

  it('caps the backends per host', async () => {
    const reg = make(okProbe(), 2);
    await reg.register({ ...input, model: 'a:1' }, '192.168.0.5');
    await reg.register({ ...input, model: 'b:1' }, '192.168.0.5');
    await expect(reg.register({ ...input, model: 'c:1' }, '192.168.0.5')).rejects.toMatchObject({ code: 'too_many_backends', httpStatus: 429 });
    await expect(reg.register({ ...input, model: 'c:1' }, '192.168.0.9')).resolves.toBeTruthy();
  });

  it('re-probe updates the row and keeps last known facts when the machine goes away', async () => {
    let probe = okProbe();
    const reg = make((...a) => probe(...(a as [])));
    const { backend } = await reg.register(input, '192.168.0.5');
    probe = okProbe({ reachable: false, ollamaVersion: null, digest: null, details: null, problems: [{ code: 'timeout', fix: 'x' }] });
    const next = await reg.reprobe(backend.id);
    expect(next.reachable).toBe(false);
    expect(next.problems.map((p) => p.code)).toEqual(['timeout']);
    expect(next.digest).toBe('sha256:abc'); // last known
    expect(events.map((e) => e.type)).toEqual(['bench_backend_registered', 'bench_backend_probed']);
    await expect(reg.reprobe('b-nope-000000')).rejects.toBeInstanceOf(BackendError);
  });

  it('toggles enabled and logs it', async () => {
    const reg = make();
    const { backend } = await reg.register(input, '192.168.0.5');
    const off = await reg.setEnabled(backend.id, false);
    expect(off.enabled).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'bench_backend_toggled', meta: { enabled: false, previous: true } });
  });

  it('ready = enabled && reachable && no problems', async () => {
    const reg = make();
    const { backend } = await reg.register(input, '192.168.0.5');
    expect(backendView(backend, { rawHost: false }).ready).toBe(true);
    expect(backendView({ ...backend, enabled: false }, { rawHost: false }).ready).toBe(false);
    expect(backendView({ ...backend, problems: [{ code: 'model_missing', fix: '' }] }, { rawHost: false }).ready).toBe(false);
  });

  describe('privacy: the raw host never leaves except through the loopback-only provider_url', () => {
    const HOST = '192.168.77.123';

    it('event-log metadata and export rows carry host_sha256 and never the host', async () => {
      const reg = make(okProbe({ problems: [{ code: 'timeout', fix: 'libere a porta 11434', detail: 'ETIMEDOUT' }] }));
      const { backend } = await reg.register(input, `::ffff:${HOST}`);
      await reg.reprobe(backend.id);
      await reg.setEnabled(backend.id, false);
      const blob = JSON.stringify([events, backendExportRow(backend), backendEventMeta(backend)]);
      expect(blob).not.toContain(HOST);
      expect(blob).not.toContain('provider_url');
      expect(blob).toContain(hostSha256(HOST));
      for (const e of events) expect(e.meta.host_sha256).toBe(hostSha256(HOST));
    });

    it('the view shows provider_url only when rawHost is granted', async () => {
      const reg = make();
      const { backend } = await reg.register(input, HOST);
      const hashed = backendView(backend, { rawHost: false });
      expect(hashed.provider_url).toBeNull();
      expect(JSON.stringify(hashed)).not.toContain(HOST);
      expect(hashed.host_sha256).toBe(hostSha256(HOST));
      const raw = backendView(backend, { rawHost: true });
      expect(raw.provider_url).toBe(`http://${HOST}:11434/v1`);
      expect(raw.host_sha256).toBe(hostSha256(HOST));
    });

    it('probe problem texts never include the host', async () => {
      const f = await fake();
      const port = f.port;
      await f.close();
      const reg = new BackendRegistry(store, {});
      const { backend } = await reg.register({ ...input, port }, '127.0.0.1');
      expect(backend.reachable).toBe(false);
      expect(JSON.stringify(backend.problems)).not.toContain('127.0.0.1');
    });
  });
});
