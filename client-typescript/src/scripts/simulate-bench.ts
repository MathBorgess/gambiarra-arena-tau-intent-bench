#!/usr/bin/env node
/**
 * Bench-mode simulator: N fake `tau-intent bench` runners, so the whole mode
 * (control panel, telão, records, bundles, export) can be exercised without
 * Python, Ollama or a model. Speaks exactly the BENCH-V0-CONTRACT §3 protocol:
 *
 *   register -> bench_join -> (bench_assign) -> bench_progress* -> bench_record*
 *            -> bench_cell_done -> POST /bench/artifacts/:cellId (tar.gz)
 *
 * Usage (server running, session created in /bench-control or via --auto-owner):
 *   pnpm simulate:bench -- --runners 4 --pin 123456
 *   pnpm simulate:bench -- --runners 4 --auto-owner        # also plays the owner via HTTP
 *
 * Options (or env): --server ws://localhost:3000/ws  --pin  --runners N  --tasks K
 *   --delay-ms 150 (per simulated turn)  --fail-q M (every M-th runner fails Q0, default 4)
 *   --auto-owner  --exit-when-done  --prefix sim-bench
 *
 * V0.2 backends mode (docs/BENCH-V0.2-REMOTE-BACKENDS.md): `--backends N` starts N FAKE OLLAMA
 * HTTP servers (/api/version, /api/show, /api/tags) on 127.0.0.2.. (one loopback address each,
 * port --backend-port, default 11500) and registers each through POST /bench/backends, as the
 * /bench-join page would. The remote address of all those requests is 127.0.0.1, so the simulator
 * sends the dev-only header `x-bench-dev-host: 127.0.0.<n>`, which the server honours ONLY when it
 * runs with BENCH_DEV=1:
 *
 *   BENCH_DEV=1 pnpm dev                                   # or: BENCH_DEV=1 pnpm event
 *   pnpm simulate:bench -- --backends 5                    # register 5 backends, stay up (orchestrator tests)
 *   pnpm simulate:bench -- --backends 5 --backends-flaky   # last one unreachable, the one before lacks the model
 *   pnpm simulate:bench -- --backends 5 --pin <PIN>        # also a fake runner per ready backend,
 *                                                          #   participant_id = backend_id (as the orchestrator does)
 *   pnpm simulate:bench -- --backends 5 --auto-owner       # whole flow, exits with a summary
 */
import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import nodeHttp from 'node:http';

// ------------------------------------------------------------------ args

function arg(name: string, env: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.env[env] ?? dflt;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const SERVER_URL = arg('server', 'SERVER_URL', 'ws://localhost:3000/ws');
const HTTP_BASE = SERVER_URL.replace(/^ws/, 'http').replace(/\/ws$/, '');
let PIN = arg('pin', 'PIN', '');
const RUNNERS = parseInt(arg('runners', 'RUNNERS', '4'), 10);
const TASKS_CAP = parseInt(arg('tasks', 'TASKS', '0'), 10); // 0 = use k_max from the assignment
const DELAY_MS = parseInt(arg('delay-ms', 'DELAY_MS', '150'), 10);
const FAIL_Q_EVERY = parseInt(arg('fail-q', 'FAIL_Q', '4'), 10);
const PREFIX = arg('prefix', 'PREFIX', 'sim-bench');
const BACKENDS = parseInt(arg('backends', 'BACKENDS', '0'), 10);
const BACKEND_PORT = parseInt(arg('backend-port', 'BACKEND_PORT', '11500'), 10);
const BACKENDS_FLAKY = flag('backends-flaky');
const AUTO_OWNER = flag('auto-owner');
const EXIT_WHEN_DONE = flag('exit-when-done') || AUTO_OWNER;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (who: string, msg: string) => console.log(`[${who}] ${msg}`);

// ------------------------------------------------------------------ deterministic rng

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ minimal tar.gz (ustar), no dependency

function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136); // mtime 0: reproducible bundles
  header.write('        ', 148); // checksum placeholder
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(pad)]);
}

function makeTarGz(files: Record<string, string>): Buffer {
  const parts = Object.entries(files).map(([name, content]) => tarEntry(name, Buffer.from(content)));
  parts.push(Buffer.alloc(1024)); // end-of-archive
  return gzipSync(Buffer.concat(parts), { level: 6 });
}

// ------------------------------------------------------------------ the fake runner

const MODELS = [
  { name: 'qwen2.5-coder:7b', family: 'qwen2', size: '7.6B', quant: 'Q4_K_M' },
  { name: 'llama3.1:8b', family: 'llama', size: '8.0B', quant: 'Q4_0' },
  { name: 'deepseek-coder-v2:16b', family: 'deepseek2', size: '15.7B', quant: 'Q4_0' },
  { name: 'phi4:14b', family: 'phi3', size: '14.7B', quant: 'Q4_K_M' },
];
const modelDigest = (name: string) => createHash('sha256').update(`model:${name}`).digest('hex');

type Arm = 'A' | 'B' | 'C';
const HARNESS: Record<Arm | 'Q', string> = { A: 'tau', B: 'tau_intent', C: 'tau_intent_llm_rescue', Q: 'tau' };
const PASS_RATE: Record<Arm, number> = { A: 0.55, B: 0.75, C: 0.7 };

interface Assign {
  type: 'bench_assign';
  cell_id: string;
  mode: 'qualification' | 'bench';
  arms: Arm[];
  seed: number;
  k_max: number;
  deadline_s: number;
  max_productive_turns: number;
}

class FakeRunner {
  private ws!: WebSocket;
  private busyCell: string | null = null;
  private stopRequested = new Set<string>();
  cellsDone = 0;
  uploads: Array<{ cell: string; sha256: string; bytes: number; status: number }> = [];
  rejections: string[] = [];
  readonly joinPayload;

  constructor(
    readonly index: number,
    readonly participantId: string,
    readonly nickname: string,
    private pin: string,
    modelOverride?: string,
    /** V0.2: runner for a remote backend -> declared hardware (undeclared = null) and the record's `backend` block. */
    private backendInfo?: { hostSha256: string; declared: { chip: string | null; ram_gb: number | null; accel: string | null } }
  ) {
    const model = modelOverride ?? MODELS[(index - 1) % MODELS.length].name;
    this.joinPayload = {
      type: 'bench_join',
      participant_id: participantId,
      runner_version: 'sim-0.1.0',
      tau_intent_sha: 'simulated-tau-intent-sha',
      task_set_sha: 'simulated-task-set-sha',
      model: { id: model, digest: index % 2 ? `sha256:${createHash('sha256').update(model).digest('hex')}` : null, runner_kind: 'ollama' },
      hardware: backendInfo
        ? { os: 'linux-sim', chip: null, ram_gb: null, accel: null, source: 'declared', declared: backendInfo.declared }
        : { os: 'linux-sim', chip: index % 2 ? 'Apple M2 (sim)' : 'RTX 4070 (sim)', ram_gb: index % 2 ? 16 : 32, accel: index % 2 ? 'metal' : 'cuda' },
    };
  }

  get modelId(): string {
    return this.joinPayload.model.id;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let registered = false;
      this.ws = new WebSocket(SERVER_URL);
      this.ws.on('error', reject);
      this.ws.on('open', () => {
        this.send({ type: 'register', participant_id: this.participantId, nickname: this.nickname, pin: this.pin, runner: 'tau-intent', model: this.modelId });
      });
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'registered') {
          registered = true;
          this.send(this.joinPayload);
          resolve();
        } else if (msg.type === 'error' && !registered) {
          reject(new Error(`register failed: ${msg.message}`));
        } else {
          void this.onMessage(msg);
        }
      });
    });
  }

  close() {
    this.ws?.close();
  }

  private send(m: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private async onMessage(msg: any) {
    if (msg.type === 'bench_assign') {
      if (this.busyCell) {
        // contract §3: a second assign for a running cell is refused
        this.send({ type: 'bench_error', cell_id: msg.cell_id, code: 'already_running', message: `cell ${this.busyCell} is running` });
        return;
      }
      this.busyCell = msg.cell_id;
      try {
        await this.runCell(msg as Assign);
      } finally {
        this.busyCell = null;
      }
    } else if (msg.type === 'bench_stop') {
      log(this.nickname, `bench_stop received for ${msg.cell_id}`);
      this.stopRequested.add(msg.cell_id);
    } else if (msg.type === 'error') {
      this.rejections.push(`${msg.code ?? 'error'}: ${msg.message}`);
      log(this.nickname, `server error: ${JSON.stringify(msg)}`);
    }
  }

  private makeRecord(a: Assign, arm: Arm | 'Q', task: number, r: () => number, over: { pass?: boolean; terminated?: string }) {
    const pass = over.pass ?? r() < PASS_RATE[arm === 'Q' ? 'A' : arm];
    const productive = 2 + Math.floor(r() * 5);
    const block = arm === 'B' || arm === 'C' ? Math.floor(r() * 3) : 0;
    const rescue = arm === 'C' ? 1 : 0;
    const turns = [
      ...Array.from({ length: productive }, (_, i) => ({ turn_index: i + 1, kind: 'productive', tokens_in: 800 + Math.floor(r() * 600), tokens_out: 120 + Math.floor(r() * 300), tool_calls: 1 + Math.floor(r() * 3) })),
      ...Array.from({ length: block }, (_, i) => ({ turn_index: productive + i + 1, kind: 'block', tokens_in: 300, tokens_out: 60, tool_calls: 0 })),
      ...Array.from({ length: rescue }, (_, i) => ({ turn_index: productive + block + i + 1, kind: 'rescue', tokens_in: 500, tokens_out: 90, tool_calls: 0 })),
    ];
    const sum = (k: 'tokens_in' | 'tokens_out', kind?: string) => turns.filter((t) => !kind || t.kind === kind).reduce((n, t) => n + t[k], 0);
    const mech = arm === 'B' || arm === 'C';
    const started = new Date(Date.now() - DELAY_MS * (productive + block));
    const edit = 5 + Math.floor(r() * 80);
    return {
      schema_version: 'gambiarra-coleta-2',
      draft: true,
      cell_id: a.cell_id,
      participant_id: this.participantId,
      session_pin_hash: null,
      arm_id: arm,
      harness_id: HARNESS[arm],
      task_set_sha: 'simulated-task-set-sha',
      task_index: arm === 'Q' ? 0 : task,
      task_id: arm === 'Q' ? 'q0' : `sim-task-${task}`,
      task_hash: createHash('sha256').update(`task-${task}`).digest('hex'),
      model: this.joinPayload.model,
      hardware: this.joinPayload.hardware,
      arm_order: a.mode === 'qualification' ? ['A'] : a.arms,
      seed: a.seed,
      mechanism: {
        tau_intent_sha: 'simulated-tau-intent-sha',
        tau_ai_version: '0.4.7',
        config_sha256: createHash('sha256').update(arm).digest('hex'),
        flags: { capture: mech, gate: mech, project: mech, serve: mech, llm_rescue: arm === 'C' },
      },
      oracle: { pass, passed: pass ? 12 : 9, failed: pass ? 0 : 3, errors: 0, duration_s: 1 + r() * 4, per_test: [{ nodeid: 'tests/test_sim.py::test_ok', outcome: 'passed' }] },
      evolution: { commit_before: 'a'.repeat(40), commit_after: 'b'.repeat(40), files_changed: 1 + Math.floor(r() * 4), insertions: edit, deletions: Math.floor(edit / 5), edit_size: edit + Math.floor(edit / 5), untracked_created: [] },
      tokens: { in: sum('tokens_in'), out: sum('tokens_out'), rescue_in: sum('tokens_in', 'rescue'), rescue_out: sum('tokens_out', 'rescue'), source: 'provider_usage', cost_usd: 0 },
      turns,
      mechanism_telemetry: { verdict: mech ? 'PASSA' : null, productive_turns: productive, block_turns: block, bloco_vazio: false, tokens_served: mech ? 210 : 0, nao_avaliaveis: [], servidas: [] },
      ...(this.backendInfo
        ? { backend: { backend_id: this.participantId, transport: 'lan', provider_host_sha256: this.backendInfo.hostSha256, ollama_version: '0.6.5-sim' }, error: null }
        : {}),
      terminated_by: over.terminated ?? 'completed',
      started_at: started.toISOString(),
      ended_at: new Date().toISOString(),
      artifacts: { bundle: `${a.cell_id}.tar.gz`, paths: { transcript: `arms/${arm}/task-${String(task).padStart(2, '0')}/transcript.jsonl`, diff: `arms/${arm}/task-${String(task).padStart(2, '0')}/diff.patch`, manifest: `arms/${arm}/task-${String(task).padStart(2, '0')}/manifest.json` } },
    };
  }

  /** One (arm, task): start -> turns -> oracle -> done, then the record. */
  private async runUnit(a: Assign, arm: Arm | 'Q', task: number, r: () => number, files: Record<string, string>, records: string[], over: { pass?: boolean } = {}) {
    const stopped = this.stopRequested.has(a.cell_id);
    const prog = (phase: string, turn?: number, tin?: number, tout?: number) =>
      this.send({ type: 'bench_progress', cell_id: a.cell_id, arm_id: arm, task_index: arm === 'Q' ? 0 : task, phase, turn, tokens_in: tin, tokens_out: tout });
    if (!stopped) {
      prog('start');
      let tin = 0;
      let tout = 0;
      const turns = 2 + Math.floor(r() * 3);
      for (let t = 1; t <= turns; t++) {
        await sleep(DELAY_MS);
        tin += 700 + Math.floor(r() * 500);
        tout += 100 + Math.floor(r() * 200);
        prog('turn', t, tin, tout);
        if (this.stopRequested.has(a.cell_id)) break; // finish the current unit as stopped
      }
      prog('oracle');
      await sleep(DELAY_MS);
    }
    const nowStopped = this.stopRequested.has(a.cell_id);
    const record = this.makeRecord(a, arm, task, r, { pass: nowStopped ? false : over.pass, terminated: nowStopped ? 'stopped' : 'completed' });
    const dir = `arms/${arm === 'Q' ? 'qualification' : arm}/task-${String(task).padStart(2, '0')}`;
    files[`${dir}/transcript.jsonl`] = JSON.stringify({ role: 'assistant', content: 'simulated transcript' }) + '\n';
    files[`${dir}/diff.patch`] = `--- a/pkg/mod.py\n+++ b/pkg/mod.py\n@@ -1 +1 @@\n-x = 0\n+x = ${task}\n`;
    files[`${dir}/manifest.json`] = JSON.stringify({ cell_id: a.cell_id, arm, task });
    records.push(JSON.stringify(record));
    this.send({ type: 'bench_record', cell_id: a.cell_id, record });
    prog('done', undefined, record.tokens.in, record.tokens.out);
    return nowStopped;
  }

  private async runCell(a: Assign) {
    log(this.nickname, `cell ${a.cell_id}: ${a.mode} arms=${a.arms.join(',')} seed=${a.seed}`);
    const r = rng(a.seed * 1000 + this.index);
    const files: Record<string, string> = {};
    const records: string[] = [];
    let truncated = false;

    if (a.mode === 'qualification') {
      const willFail = FAIL_Q_EVERY > 0 && this.index % FAIL_Q_EVERY === 0;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const pass = willFail ? false : attempt === 2 || r() < 0.6;
        const stopped = await this.runUnit(a, 'Q', 0, r, files, records, { pass });
        if (stopped) truncated = true;
        if (pass || stopped) break;
      }
    } else {
      const k = TASKS_CAP > 0 ? Math.min(TASKS_CAP, a.k_max) : a.k_max;
      outer: for (let task = 1; task <= k; task++) {
        for (const arm of a.arms) {
          if (this.stopRequested.has(a.cell_id)) {
            truncated = true;
            break outer;
          }
          if (await this.runUnit(a, arm, task, r, files, records)) {
            truncated = true;
            break outer;
          }
        }
      }
    }

    files['records.jsonl'] = records.join('\n') + '\n';
    files['cell.json'] = JSON.stringify({ assign: a, join: this.joinPayload, simulated: true }, null, 2);
    for (const arm of a.mode === 'bench' ? a.arms : []) files[`arms/${arm}/repo.bundle`] = `simulated git bundle for arm ${arm}\n`;
    const bundle = makeTarGz(files);
    const manifest = createHash('sha256').update(bundle).digest('hex');

    this.send({ type: 'bench_cell_done', cell_id: a.cell_id, records: records.length, manifest_sha256: manifest, truncated });
    await this.upload(a.cell_id, bundle, manifest);
    this.stopRequested.delete(a.cell_id);
    this.cellsDone++;
    log(this.nickname, `cell ${a.cell_id} done: ${records.length} records${truncated ? ' (truncated)' : ''}`);
  }

  private async upload(cellId: string, bundle: Buffer, sha256: string) {
    const res = await fetch(`${HTTP_BASE}/bench/artifacts/${cellId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip', 'x-participant-id': this.participantId, 'x-bench-sha256': sha256 },
      body: bundle,
    });
    this.uploads.push({ cell: cellId, sha256, bytes: bundle.length, status: res.status });
    if (!res.ok) log(this.nickname, `UPLOAD FAILED ${res.status}: ${await res.text()}`);
  }
}

// ------------------------------------------------------------------ V0.2: fake Ollama backends

/** The three Ollama endpoints the arena probes. `installed` = what /api/tags lists (and /api/show knows). */
function startFakeOllama(host: string, port: number, installed: typeof MODELS): Promise<nodeHttp.Server> {
  const server = nodeHttp.createServer((req, res): void => {
    const json = (code: number, body: unknown): void => void res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (req.method === 'GET' && req.url === '/api/version') return json(200, { version: '0.6.5-sim' });
    if (req.method === 'GET' && req.url === '/api/tags') {
      return json(200, {
        models: installed.map((m) => ({
          name: m.name,
          model: m.name,
          digest: modelDigest(m.name), // real Ollama: bare hex, no "sha256:" prefix
          size: 4_000_000_000,
          details: { family: m.family, parameter_size: m.size, quantization_level: m.quant, format: 'gguf' },
        })),
      });
    }
    if (req.method === 'POST' && req.url === '/api/show') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', (): void => {
        let want = '';
        try {
          want = JSON.parse(body).model ?? JSON.parse(body).name ?? '';
        } catch {
          /* bad body */
        }
        const m = installed.find((x) => x.name === want);
        if (!m) return json(404, { error: `model '${want}' not found` });
        json(200, { details: { family: m.family, parameter_size: m.size, quantization_level: m.quant, format: 'gguf' }, modelfile: '# simulated' });
      });
      return;
    }
    json(404, { error: 'not found' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

interface SimBackend {
  index: number;
  host: string;
  model: string;
  nickname: string;
  backendId: string;
  reachable: boolean;
  problems: Array<{ code: string }>;
  server: nodeHttp.Server | null;
}

/** Start N fake Ollamas on 127.0.0.2.. and register each, like /bench-join does. */
async function startBackends(n: number): Promise<SimBackend[]> {
  const out: SimBackend[] = [];
  for (let i = 1; i <= n; i++) {
    const host = `127.0.0.${i + 1}`;
    const m = MODELS[(i - 1) % MODELS.length];
    const unreachable = BACKENDS_FLAKY && n >= 2 && i === n;
    const lacksModel = BACKENDS_FLAKY && n >= 3 && i === n - 1;
    const installed = lacksModel ? MODELS.filter((x) => x.name !== m.name).slice(0, 1) : [m];
    const server = unreachable ? null : await startFakeOllama(host, BACKEND_PORT, installed);
    const res = await http('POST', '/bench/backends', {
      nickname: `Sim ${i}`,
      model: m.name,
      port: BACKEND_PORT,
      declared_hardware: i % 2 ? { chip: 'Apple M2 (sim)', ram_gb: 16, accel: 'metal' } : { chip: 'RTX 4070 (sim)', ram_gb: 32, accel: 'cuda' },
      browser: { user_agent: 'simulate-bench', cores: 8, device_memory_gb: 8 },
    }, { 'x-bench-dev-host': host });
    out.push({ index: i, host, model: m.name, nickname: `Sim ${i}`, backendId: res.backend_id, reachable: res.reachable, problems: res.problems, server });
    const status = res.reachable && res.problems.length === 0 ? 'ready' : `PROBLEMS ${res.problems.map((p: any) => p.code).join(',') || '-'}`;
    log('backend', `${res.backend_id}  ${m.name}  ${host}:${BACKEND_PORT}  ${status}${res.created ? '' : ' (updated)'}`);
  }
  const bad = out.filter((b) => !b.reachable && !b.server);
  if (!BACKENDS_FLAKY && bad.length) {
    console.error('\nNo backend was reachable: is the arena running with BENCH_DEV=1? (x-bench-dev-host is ignored otherwise)\n');
  }
  return out;
}

// ------------------------------------------------------------------ owner (optional)

async function http(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<any> {
  const res = await fetch(`${HTTP_BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...extraHeaders } : extraHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain text */
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
}

async function waitUntil(label: string, cond: () => Promise<boolean>, timeoutMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return;
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function playOwner(runners: FakeRunner[]) {
  const arms: Array<Arm[] | undefined> = [['B', 'A', 'C'], ['A', 'B'], ['C'], undefined]; // owner's choices; undefined = default shuffled
  log('owner', 'assigning arms per participant');
  for (const [i, r] of runners.entries()) {
    const res = await http('POST', '/bench/assign', { participant_id: r.participantId, arms: arms[i % arms.length], mode: 'qualification' });
    log('owner', `${r.nickname}: plan ${res.cell.arms.join(',')} (${res.cell.arms_source})`);
  }
  log('owner', 'START qualification (Tool Call Challenge)');
  await http('POST', '/bench/start', { mode: 'qualification' });
  await waitUntil('qualification done', async () => (await http('GET', '/bench/state')).counts.cells_active === 0);
  const q = (await http('GET', '/bench/state')).participants.map((p: any) => `${p.nickname}=${p.qualification.status}(${p.qualification.attempts})`);
  log('owner', `qualification: ${q.join('  ')}`);

  log('owner', 'START bench (only qualified)');
  await http('POST', '/bench/start', { mode: 'bench', only_qualified: true });
  await waitUntil('bench done', async () => (await http('GET', '/bench/state')).counts.cells_active === 0, 600_000);
}

// ------------------------------------------------------------------ main

async function main() {
  const backendsMode = BACKENDS > 0;
  if (!PIN) {
    if (AUTO_OWNER) {
      const s = await http('POST', '/session', { pinLength: 6 });
      PIN = s.pin;
      log('owner', `created session, PIN ${PIN}`);
    } else if (!backendsMode) {
      throw new Error('Pass --pin <PIN> (or --auto-owner to create a session via HTTP)');
    }
  }

  // V0.2: fake Ollamas + registration through POST /bench/backends (no runners unless a PIN is known).
  const backends: SimBackend[] = backendsMode ? await startBackends(BACKENDS) : [];
  const ready = backends.filter((b) => b.reachable && b.problems.length === 0);

  const runners: FakeRunner[] = [];
  if (backendsMode) {
    if (PIN) {
      console.log(`\nStarting ${ready.length} simulated runners (participant_id = backend_id) -> ${SERVER_URL}\n`);
      for (const b of ready) {
        const r = new FakeRunner(b.index, b.backendId, b.nickname, PIN, b.model, {
          hostSha256: createHash('sha256').update(b.host).digest('hex'),
          declared: b.index % 2 ? { chip: 'Apple M2 (sim)', ram_gb: 16, accel: 'metal' } : { chip: 'RTX 4070 (sim)', ram_gb: 32, accel: 'cuda' },
        });
        await r.connect();
        runners.push(r);
        await sleep(60);
      }
      log('sim', `${runners.length} runners joined as their backend_id; assign arms in /bench-control (or use --auto-owner)`);
    } else {
      console.log('\nNo --pin: backends registered, no runners started. An orchestrator (or --pin) can now attach runners by backend_id.\n');
    }
  } else {
    console.log(`\nStarting ${RUNNERS} simulated tau-intent runners -> ${SERVER_URL}\n`);
    for (let i = 1; i <= RUNNERS; i++) {
      const r = new FakeRunner(i, `${PREFIX}-${i}`, `Sim ${i}`, PIN);
      await r.connect();
      runners.push(r);
      await sleep(60);
    }
    log('sim', `${runners.length} runners joined; assign arms in /bench-control (or use --auto-owner)`);
  }

  const shutdown = () => {
    runners.forEach((r) => r.close());
    backends.forEach((b) => b.server?.closeAllConnections());
    backends.forEach((b) => b.server?.close());
    process.exit(0);
  };
  process.on('SIGINT', shutdown);

  if (AUTO_OWNER) {
    await playOwner(runners);
    await sleep(500);
    const state = await http('GET', '/bench/state');
    const arts = await http('GET', '/bench/artifacts');
    const jsonl: string = await fetch(`${HTTP_BASE}/export-bench.jsonl`).then((x) => x.text());
    const lines = jsonl.split('\n').filter(Boolean);
    console.log('\n=== SIMULATION SUMMARY ===');
    console.log(`runners: ${state.counts.runners}, cells finished: ${state.counts.cells_finished}, records (state): ${state.counts.records}`);
    console.log(`export-bench.jsonl lines: ${lines.length}`);
    console.log(`artifacts stored: ${arts.artifacts.length}`);
    for (const r of runners) for (const u of r.uploads) console.log(`  upload ${u.cell} -> HTTP ${u.status} sha256=${u.sha256.slice(0, 16)}… bytes=${u.bytes}`);
    const rejected = runners.flatMap((r) => r.rejections);
    if (rejected.length) console.log(`server rejections seen by runners: ${rejected.length}`, rejected.slice(0, 5));
    if (backendsMode) {
      const list = await http('GET', '/bench/backends');
      console.log(`backends: ${list.backends.length} registered, runner status: ${list.backends.map((b: any) => `${b.nickname}=${b.runner.status}`).join(' ')}`);
      // Privacy check: no export may contain a raw simulated host (127.0.0.N).
      const exports = await Promise.all(['/export-bench.jsonl', '/export-bench.jsonl?envelope=1', '/export-events.csv', '/export-all.json'].map((p) => fetch(`${HTTP_BASE}${p}`).then((x) => x.text())));
      const leaks = backends.filter((b) => exports.some((t) => t.includes(`${b.host}`)));
      console.log(`privacy: raw hosts in exports: ${leaks.length === 0 ? 'none' : leaks.map((b) => b.host).join(', ')}`);
    }
  }

  if (EXIT_WHEN_DONE) shutdown();
  else console.log(backendsMode ? '\nFake Ollamas up. Ctrl+C to stop.\n' : '\nRunners idle and waiting for bench_assign. Ctrl+C to stop.\n');
}

main().catch((err) => {
  console.error('simulate-bench failed:', err);
  process.exit(1);
});
