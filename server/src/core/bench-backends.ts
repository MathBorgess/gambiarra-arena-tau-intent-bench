import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

/**
 * Bench V0.2 — model backends (docs/BENCH-V0.2-REMOTE-BACKENDS.md §2).
 *
 * A backend is a participant's Ollama, reached over the LAN from the arena
 * owner's machine. The participant registers it from /bench-join; the arena
 * takes the HOST from the request's remote address (never from the body),
 * probes /api/version, /api/show and /api/tags, and keeps one row per
 * (host, port, model). The orchestrator spawns one runner per ready backend
 * with `participant_id = backend_id`.
 *
 * PRIVACY: the raw host is stored (the orchestrator needs it for provider_url)
 * but never written to an export, snapshot or event-log row: those carry
 * `host_sha256` only. `backendEventMeta` and `backendExportRow` are the only
 * serialisers allowed to reach them, and neither has a host field.
 */

export const PROBE_TIMEOUT_MS = 3000;
export const MAX_BACKENDS_PER_HOST = 16;
const MAX_PROBE_BODY_BYTES = 2 * 1024 * 1024;

// ------------------------------------------------------------------ types

export type ProblemCode = 'unreachable' | 'model_missing' | 'timeout';

export interface Problem {
  code: ProblemCode;
  /** Participant-facing instruction (Portuguese). Never contains the host. */
  fix: string;
  /** Machine hint, e.g. a socket error code (ECONNREFUSED). Never contains the host. */
  detail?: string;
}

export interface ModelDetails {
  family: string | null;
  parameter_size: string | null;
  quantization_level: string | null;
}

export interface DeclaredHardware {
  chip: string | null;
  ram_gb: number | null;
  accel: 'cuda' | 'metal' | 'cpu' | 'other' | null;
}

export interface BrowserHints {
  user_agent: string | null;
  cores: number | null;
  device_memory_gb: number | null;
}

export interface ProbeResult {
  reachable: boolean;
  ollamaVersion: string | null;
  digest: string | null;
  details: ModelDetails | null;
  problems: Problem[];
  probedAt: Date;
}

export interface StoredBackend {
  id: string;
  host: string;
  port: number;
  model: string;
  nickname: string;
  declaredHardware: DeclaredHardware | null;
  browser: BrowserHints | null;
  enabled: boolean;
  reachable: boolean;
  ollamaVersion: string | null;
  digest: string | null;
  details: ModelDetails | null;
  problems: Problem[];
  lastProbeAt: Date | null;
  hostSha256: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RegisterInput {
  nickname: string;
  model: string;
  port: number;
  declaredHardware?: DeclaredHardware | null;
  browser?: BrowserHints | null;
}

export class BackendError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ host / id helpers

/**
 * Canonical host string: no brackets, no IPv6 zone, lower case, IPv4-mapped
 * IPv6 (`::ffff:192.168.0.5`, `::ffff:c0a8:5`) reduced to the dotted IPv4.
 */
export function normalizeHost(raw: string): string {
  let h = (raw ?? '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.replace(/%.*$/, '');
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (dotted) return dotted[1];
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return h;
}

export function isLoopbackHost(raw: string): boolean {
  const h = normalizeHost(raw);
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** sha256 (hex) of the normalised host: no port, no brackets. The runner computes the same for `provider_host_sha256`. */
export function hostSha256(host: string): string {
  return createHash('sha256').update(normalizeHost(host)).digest('hex');
}

/** Ollama treats `llama3` and `llama3:latest` as the same model; so do we. */
export function normalizeModel(model: string): string {
  const m = (model ?? '').trim();
  const last = m.split('/').pop() ?? m;
  return last.includes(':') ? m : `${m}:latest`;
}

export function slugify(nickname: string): string {
  const s = (nickname ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return s || 'jogador';
}

const keyOf = (host: string, port: number, model: string) => `${host}|${port}|${model}`;

/** `b-<slug>-<hex6>`: stable for a (host, port, model); the slug comes from the nickname at creation time. */
export function makeBackendId(nickname: string, host: string, port: number, model: string, salt = ''): string {
  const hex = createHash('sha256').update(keyOf(host, port, model) + salt).digest('hex').slice(0, 6);
  return `b-${slugify(nickname)}-${hex}`;
}

export const BACKEND_ID_RE = /^b-[a-z0-9-]{1,40}-[0-9a-f]{6}$/;

export function providerUrl(host: string, port: number): string {
  const h = normalizeHost(host);
  return `http://${h.includes(':') ? `[${h}]` : h}:${port}/v1`;
}

// ------------------------------------------------------------------ Ollama probe

class ProbeIoError extends Error {
  constructor(
    readonly kind: 'timeout' | 'connect' | 'protocol',
    readonly code: string
  ) {
    super(`${kind}:${code}`);
  }
}

interface HttpReply {
  status: number;
  json: unknown;
}

/** One JSON request straight over node:http (never through a proxy), with a hard overall deadline. */
function ollamaRequest(host: string, port: number, method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };
    const req = http.request(
      {
        host: normalizeHost(host),
        port,
        method,
        path,
        agent: false,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_PROBE_BODY_BYTES) {
            req.destroy();
            done(() => reject(new ProbeIoError('protocol', 'too_large')));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON: not an Ollama answer */
          }
          done(() => resolve({ status: res.statusCode ?? 0, json }));
        });
        res.on('error', (e: NodeJS.ErrnoException) => done(() => reject(new ProbeIoError('connect', e.code ?? 'ERES'))));
      }
    );
    const deadline = setTimeout(() => {
      req.destroy();
      done(() => reject(new ProbeIoError('timeout', 'ETIMEDOUT')));
    }, timeoutMs);
    req.on('error', (e: NodeJS.ErrnoException) => {
      const code = e.code ?? 'EUNKNOWN';
      done(() => reject(new ProbeIoError(code === 'ETIMEDOUT' ? 'timeout' : 'connect', code)));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function parseVersion(json: unknown): string | null {
  return str(obj(json)?.version);
}

export function parseDetails(raw: unknown): ModelDetails | null {
  const d = obj(raw);
  if (!d) return null;
  const details: ModelDetails = {
    family: str(d.family),
    parameter_size: str(d.parameter_size),
    quantization_level: str(d.quantization_level),
  };
  return details.family || details.parameter_size || details.quantization_level ? details : null;
}

export function parseShow(json: unknown): ModelDetails | null {
  return parseDetails(obj(json)?.details);
}

const withShaPrefix = (d: string) => (d.startsWith('sha256:') ? d : `sha256:${d}`);

/** `/api/tags` → the entry for `model` (digest, details) and the list of installed names. */
export function parseTags(json: unknown, model: string): { digest: string | null; details: ModelDetails | null; names: string[]; found: boolean } {
  const list = obj(json)?.models;
  const entries = Array.isArray(list) ? list.map(obj).filter((e): e is Record<string, unknown> => !!e) : [];
  const names = entries.map((e) => str(e.name) ?? str(e.model)).filter((n): n is string => !!n);
  const want = normalizeModel(model);
  const hit = entries.find((e) => [str(e.name), str(e.model)].some((n) => n && normalizeModel(n) === want));
  const digest = hit ? str(hit.digest) : null;
  return { digest: digest ? withShaPrefix(digest) : null, details: hit ? parseDetails(hit.details) : null, names, found: !!hit };
}

function unreachableProblem(port: number, err: ProbeIoError): Problem {
  if (err.kind === 'timeout' || ['EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EHOSTDOWN'].includes(err.code)) {
    return {
      code: 'timeout',
      detail: err.code,
      fix:
        `A arena não obteve resposta do seu computador na porta ${port} em ${PROBE_TIMEOUT_MS / 1000} s. ` +
        `Quase sempre é o firewall do sistema descartando a conexão (libere a porta ${port} para a rede local) ` +
        `ou o computador está em outra rede/Wi-Fi com isolamento de clientes. Depois toque em "testar de novo".`,
    };
  }
  if (err.code === 'ECONNREFUSED') {
    return {
      code: 'unreachable',
      detail: err.code,
      fix:
        `Conexão recusada na porta ${port}: o Ollama só está aceitando conexões de dentro do seu computador (ou não está rodando). ` +
        `Reinicie com OLLAMA_HOST=0.0.0.0:${port} ollama serve e toque em "testar de novo".`,
    };
  }
  return {
    code: 'unreachable',
    detail: err.code,
    fix:
      `Algo respondeu na porta ${port}, mas não parece ser o Ollama (${err.code}). ` +
      `Confira a porta e rode OLLAMA_HOST=0.0.0.0:${port} ollama serve.`,
  };
}

/**
 * Probe a participant's Ollama: /api/version, then /api/show and /api/tags
 * (in parallel), each with its own timeout. Never throws: failures become
 * `problems` with a participant-facing `fix`.
 */
export async function probeOllama(host: string, port: number, model: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const probedAt = new Date();
  const problems: Problem[] = [];
  const blank = { ollamaVersion: null, digest: null, details: null };

  let version: string | null;
  try {
    const r = await ollamaRequest(host, port, 'GET', '/api/version', undefined, timeoutMs);
    version = r.status === 200 ? parseVersion(r.json) : null;
    if (!version) throw new ProbeIoError('protocol', `HTTP_${r.status}`);
  } catch (e) {
    const err = e instanceof ProbeIoError ? e : new ProbeIoError('connect', 'EUNKNOWN');
    return { reachable: false, ...blank, problems: [unreachableProblem(port, err)], probedAt };
  }

  const [show, tags] = await Promise.allSettled([
    ollamaRequest(host, port, 'POST', '/api/show', { model, name: model }, timeoutMs),
    ollamaRequest(host, port, 'GET', '/api/tags', undefined, timeoutMs),
  ]);

  const tagInfo = tags.status === 'fulfilled' && tags.value.status === 200 ? parseTags(tags.value.json, model) : null;
  const showOk = show.status === 'fulfilled' && show.value.status === 200;
  const details = show.status === 'fulfilled' && showOk ? parseShow(show.value.json) : null;

  const modelMissing =
    (show.status === 'fulfilled' && show.value.status === 404) || (!showOk && tagInfo !== null && !tagInfo.found);
  if (modelMissing) {
    const installed = tagInfo && tagInfo.names.length ? ` Modelos instalados: ${tagInfo.names.slice(0, 8).join(', ')}.` : '';
    problems.push({
      code: 'model_missing',
      fix: `O Ollama respondeu, mas não tem o modelo "${model}". Rode  ollama pull ${model}  e toque em "testar de novo".${installed}`,
    });
  } else if (!showOk && show.status === 'rejected') {
    const err = show.reason instanceof ProbeIoError ? show.reason : new ProbeIoError('connect', 'EUNKNOWN');
    problems.push(unreachableProblem(port, err));
  } else if (!showOk) {
    const status = show.status === 'fulfilled' ? show.value.status : 0;
    problems.push({
      code: 'unreachable',
      detail: `HTTP_${status}`,
      fix: `O Ollama respondeu com erro (HTTP ${status}) ao consultar o modelo "${model}". Veja o terminal do "ollama serve" e toque em "testar de novo".`,
    });
  }

  return {
    reachable: true,
    ollamaVersion: version,
    digest: tagInfo?.digest ?? null,
    details: details ?? tagInfo?.details ?? null,
    problems,
    probedAt,
  };
}

// ------------------------------------------------------------------ store

export interface BackendStore {
  findById(id: string): Promise<StoredBackend | null>;
  findByKey(host: string, port: number, model: string): Promise<StoredBackend | null>;
  list(): Promise<StoredBackend[]>;
  countByHost(host: string): Promise<number>;
  /** Insert or replace by id. */
  save(b: StoredBackend): Promise<void>;
}

export class MemoryBackendStore implements BackendStore {
  readonly rows = new Map<string, StoredBackend>();
  async findById(id: string) {
    return this.rows.get(id) ?? null;
  }
  async findByKey(host: string, port: number, model: string) {
    return [...this.rows.values()].find((b) => b.host === host && b.port === port && b.model === model) ?? null;
  }
  async list() {
    return [...this.rows.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async countByHost(host: string) {
    return [...this.rows.values()].filter((b) => b.host === host).length;
  }
  async save(b: StoredBackend) {
    this.rows.set(b.id, { ...b });
  }
}

const j = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
const parse = <T>(s: string | null, dflt: T): T => {
  if (!s) return dflt;
  try {
    return JSON.parse(s) as T;
  } catch {
    return dflt;
  }
};

export class PrismaBackendStore implements BackendStore {
  constructor(private prisma: PrismaClient) {}

  private fromRow(r: any): StoredBackend {
    return {
      id: r.id,
      host: r.host,
      port: r.port,
      model: r.model,
      nickname: r.nickname,
      declaredHardware: parse(r.declaredHardware, null),
      browser: parse(r.browser, null),
      enabled: r.enabled,
      reachable: r.reachable,
      ollamaVersion: r.ollamaVersion,
      digest: r.digest,
      details: parse(r.details, null),
      problems: parse(r.problems, []),
      lastProbeAt: r.lastProbeAt,
      hostSha256: r.hostSha256,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async findById(id: string) {
    const r = await this.prisma.benchBackend.findUnique({ where: { id } });
    return r ? this.fromRow(r) : null;
  }
  async findByKey(host: string, port: number, model: string) {
    const r = await this.prisma.benchBackend.findUnique({ where: { host_port_model: { host, port, model } } });
    return r ? this.fromRow(r) : null;
  }
  async list() {
    const rows = await this.prisma.benchBackend.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.fromRow(r));
  }
  async countByHost(host: string) {
    return this.prisma.benchBackend.count({ where: { host } });
  }
  async save(b: StoredBackend) {
    const data = {
      host: b.host,
      port: b.port,
      model: b.model,
      nickname: b.nickname,
      declaredHardware: j(b.declaredHardware),
      browser: j(b.browser),
      enabled: b.enabled,
      reachable: b.reachable,
      ollamaVersion: b.ollamaVersion,
      digest: b.digest,
      details: j(b.details),
      problems: JSON.stringify(b.problems),
      lastProbeAt: b.lastProbeAt,
      hostSha256: b.hostSha256,
    };
    await this.prisma.benchBackend.upsert({ where: { id: b.id }, create: { id: b.id, ...data }, update: data });
  }
}

// ------------------------------------------------------------------ views (the only serialisers)

export interface RunnerView {
  /** A WS runner registered with participant_id === backend_id is connected right now. */
  connected: boolean;
  /** waiting: no runner · connected: runner idle · running: it has an active cell */
  status: 'waiting' | 'connected' | 'running';
  cell_id: string | null;
  cell_status: string | null;
  records: number;
}

export const NO_RUNNER: RunnerView = { connected: false, status: 'waiting', cell_id: null, cell_status: null, records: 0 };

/** True when the backend is something the orchestrator may start a runner for. */
export const isReady = (b: StoredBackend) => b.enabled && b.reachable && b.problems.length === 0;

/**
 * GET /bench/backends row. `rawHost` (loopback callers only) adds `provider_url`;
 * everyone else gets `provider_url: null` and the hashed host.
 */
export function backendView(b: StoredBackend, opts: { rawHost: boolean; runner?: RunnerView }) {
  return {
    backend_id: b.id,
    nickname: b.nickname,
    model: { id: b.model, digest: b.digest, details: b.details },
    port: b.port,
    provider_url: opts.rawHost ? providerUrl(b.host, b.port) : null,
    host_sha256: b.hostSha256,
    enabled: b.enabled,
    reachable: b.reachable,
    ready: isReady(b),
    ollama_version: b.ollamaVersion,
    problems: b.problems,
    last_probe_at: b.lastProbeAt ? b.lastProbeAt.getTime() : null,
    declared_hardware: b.declaredHardware,
    browser: b.browser,
    runner: opts.runner ?? NO_RUNNER,
    created_at: b.createdAt.getTime(),
    updated_at: b.updatedAt.getTime(),
  };
}

/** Event-log metadata and export rows: hashed host only, never `host`/`provider_url`. */
export function backendEventMeta(b: StoredBackend, extra: Record<string, unknown> = {}) {
  return {
    backend_id: b.id,
    host_sha256: b.hostSha256,
    port: b.port,
    model: b.model,
    nickname: b.nickname,
    enabled: b.enabled,
    reachable: b.reachable,
    ollama_version: b.ollamaVersion,
    digest: b.digest,
    details: b.details,
    problems: b.problems.map((p) => p.code),
    last_probe_at: b.lastProbeAt ? b.lastProbeAt.toISOString() : null,
    ...extra,
  };
}

export function backendExportRow(b: StoredBackend) {
  return {
    ...backendEventMeta(b),
    declared_hardware: b.declaredHardware,
    browser: b.browser,
    created_at: b.createdAt.toISOString(),
    updated_at: b.updatedAt.toISOString(),
  };
}

// ------------------------------------------------------------------ registry

export type BackendEvent = 'bench_backend_registered' | 'bench_backend_probed' | 'bench_backend_toggled';

export interface RegistryOptions {
  probe?: typeof probeOllama;
  log?: (type: BackendEvent, backend: StoredBackend, extra: Record<string, unknown>) => void;
  maxPerHost?: number;
}

export class BackendRegistry {
  private chains = new Map<string, Promise<unknown>>();
  private readonly probe: typeof probeOllama;
  private readonly maxPerHost: number;

  constructor(
    private store: BackendStore,
    private opts: RegistryOptions = {}
  ) {
    this.probe = opts.probe ?? probeOllama;
    this.maxPerHost = opts.maxPerHost ?? MAX_BACKENDS_PER_HOST;
  }

  /** Serialise work per key so a double click cannot create two rows or interleave two probes. */
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    }).catch(() => undefined);
    return next;
  }

  /**
   * Register (or update) the backend for (host, port, model) and probe it.
   * `host` MUST be the request's remote address, already resolved by the caller.
   */
  async register(input: RegisterInput, rawHost: string): Promise<{ backend: StoredBackend; created: boolean }> {
    const host = normalizeHost(rawHost);
    const model = normalizeModel(input.model);
    return this.serial(keyOf(host, input.port, model), async () => {
      const now = new Date();
      let backend = await this.store.findByKey(host, input.port, model);
      const created = !backend;
      if (!backend) {
        if ((await this.store.countByHost(host)) >= this.maxPerHost) {
          throw new BackendError('too_many_backends', `This machine already has ${this.maxPerHost} registered backends`, 429);
        }
        let id = makeBackendId(input.nickname, host, input.port, model);
        if (await this.store.findById(id)) id = makeBackendId(input.nickname, host, input.port, model, randomBytes(4).toString('hex'));
        backend = {
          id,
          host,
          port: input.port,
          model,
          nickname: input.nickname,
          declaredHardware: input.declaredHardware ?? null,
          browser: input.browser ?? null,
          enabled: true,
          reachable: false,
          ollamaVersion: null,
          digest: null,
          details: null,
          problems: [],
          lastProbeAt: null,
          hostSha256: hostSha256(host),
          createdAt: now,
          updatedAt: now,
        };
      } else {
        backend = {
          ...backend,
          nickname: input.nickname,
          declaredHardware: input.declaredHardware ?? backend.declaredHardware,
          browser: input.browser ?? backend.browser,
          updatedAt: now,
        };
      }
      backend = this.applyProbe(backend, await this.probe(host, input.port, model));
      await this.store.save(backend);
      this.opts.log?.('bench_backend_registered', backend, { created });
      return { backend, created };
    });
  }

  private applyProbe(b: StoredBackend, p: ProbeResult): StoredBackend {
    return {
      ...b,
      reachable: p.reachable,
      // A failed probe keeps the last known facts (digest, version) rather than blanking the row.
      ollamaVersion: p.ollamaVersion ?? b.ollamaVersion,
      digest: p.digest ?? b.digest,
      details: p.details ?? b.details,
      problems: p.problems,
      lastProbeAt: p.probedAt,
      updatedAt: p.probedAt,
    };
  }

  async reprobe(id: string): Promise<StoredBackend> {
    const existing = await this.store.findById(id);
    if (!existing) throw new BackendError('unknown_backend', `No backend ${id}`, 404);
    return this.serial(keyOf(existing.host, existing.port, existing.model), async () => {
      const current = (await this.store.findById(id)) ?? existing;
      const next = this.applyProbe(current, await this.probe(current.host, current.port, current.model));
      await this.store.save(next);
      this.opts.log?.('bench_backend_probed', next, {});
      return next;
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<StoredBackend> {
    const existing = await this.store.findById(id);
    if (!existing) throw new BackendError('unknown_backend', `No backend ${id}`, 404);
    return this.serial(keyOf(existing.host, existing.port, existing.model), async () => {
      const current = (await this.store.findById(id)) ?? existing;
      const next = { ...current, enabled, updatedAt: new Date() };
      await this.store.save(next);
      this.opts.log?.('bench_backend_toggled', next, { previous: current.enabled });
      return next;
    });
  }

  get(id: string) {
    return this.store.findById(id);
  }

  list() {
    return this.store.list();
  }
}
