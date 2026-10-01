import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { EventLogger, EventType } from './eventlog.js';
import type { BenchStore, BenchCellStatus, StoredCell, StoredRecord, StoredArtifact } from './bench-store.js';
import {
  BENCH_ARMS,
  type BenchArm,
  type BenchArmId,
  type BenchAssignMessage,
  type BenchCellDoneMessage,
  type BenchErrorMessage,
  type BenchJoinMessage,
  type BenchMode,
  type BenchProgressMessage,
  type BenchRecordMessage,
  type BenchStopMessage,
} from '../ws/schemas.js';

/**
 * Bench mode engine (Recipe B, step 3) — mirrors WorldEngine's anatomy:
 * minimal hub interface, DEFAULT_CONFIG, start/stop/isRunning/ensureLoop,
 * handleJoin/handleProgress/..., snapshot(), broadcast() via the hub, and a
 * 5 s snapshot of the FULL state into the event log (the 23/05 lesson).
 *
 * What it owns: which arms each runner runs (cells), the live progress grid
 * for the telão, and the bookkeeping of what was received. What it does NOT
 * do: run anything, judge anything or recompute any outcome — records are
 * stored as received (BENCH-V0-CONTRACT §3).
 */

/** Minimal surface of the WebSocketHub that the engine needs (avoids a circular import). */
export interface BenchHub {
  broadcastToTelao(message: unknown): void;
  sendToParticipant(participantId: string, message: unknown): boolean;
}

export const DEFAULT_BENCH_CONFIG = {
  kMax: 6,
  deadlineS: 600,
  maxProductiveTurns: 8,
} as const;

// Cadence of the full-state snapshot in the event log (same as WORLD_SNAPSHOT_INTERVAL_MS).
const BENCH_SNAPSHOT_INTERVAL_MS = 5000;
const LOOP_INTERVAL_MS = 1000;
// Progress messages can come every turn from every runner: telão broadcasts are coalesced.
const BROADCAST_COALESCE_MS = 250;
// Pre-registered rule (design §4.5): Q0 must pass in <= 2 attempts.
export const QUALIFICATION_MAX_ATTEMPTS = 2;

export class BenchError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus = 400,
    public details?: unknown
  ) {
    super(message);
  }
}

export interface BenchResult {
  ok: boolean;
  code?: string;
  message?: string;
  duplicate?: boolean;
}

// ---------------------------------------------------------------- pure helpers

/** mulberry32: tiny seeded PRNG so an arm order is reproducible from the stored seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Default arm order: A, B, C shuffled (Fisher-Yates) with the cell's seed. */
export function shuffleArms(seed: number): BenchArm[] {
  const arms: BenchArm[] = [...BENCH_ARMS];
  const rnd = seededRandom(seed);
  for (let i = arms.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arms[i], arms[j]] = [arms[j], arms[i]];
  }
  return arms;
}

export function randomSeed(): number {
  return randomInt(1, 2 ** 31 - 1);
}

/** Cell ids are used as file names: only [A-Za-z0-9_-], bounded length. */
export const CELL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function newCellId(participantId: string): string {
  const slug = participantId.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+/, '').slice(0, 40) || 'runner';
  return `c-${slug}-${randomBytes(3).toString('hex')}`;
}

export interface RecordSummary {
  cellId: string;
  armId: string;
  taskIndex: number;
  oraclePass: boolean | null;
  tokensIn: number | null;
  tokensOut: number | null;
  toolCalls: number;
  durationMs: number | null;
  terminatedBy: string;
  receivedAt: number;
}

/** Compact view of a stored record, derived from its raw JSON (used by the grid and the qualification score). */
export function summarizeRecord(rec: {
  cellId: string;
  armId: string;
  taskIndex: number;
  oraclePass: boolean | null;
  tokensIn: number | null;
  tokensOut: number | null;
  terminatedBy: string;
  receivedAt: Date;
  raw: unknown;
}): RecordSummary {
  const raw = (typeof rec.raw === 'string' ? safeParse(rec.raw) : rec.raw) as Record<string, any> | null;
  const turns: Array<{ tool_calls?: unknown }> = Array.isArray(raw?.turns) ? raw.turns : [];
  const toolCalls = turns.reduce((n, t) => n + (typeof t.tool_calls === 'number' ? t.tool_calls : 0), 0);
  const a = Date.parse(String(raw?.started_at ?? ''));
  const b = Date.parse(String(raw?.ended_at ?? ''));
  let durationMs: number | null = Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
  if (durationMs == null && typeof raw?.oracle?.duration_s === 'number') durationMs = Math.round(raw.oracle.duration_s * 1000);
  return {
    cellId: rec.cellId,
    armId: rec.armId,
    taskIndex: rec.taskIndex,
    oraclePass: rec.oraclePass,
    tokensIn: rec.tokensIn,
    tokensOut: rec.tokensOut,
    toolCalls,
    durationMs,
    terminatedBy: rec.terminatedBy,
    receivedAt: rec.receivedAt.getTime(),
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export type QualificationStatus = 'none' | 'pending' | 'qualified' | 'failed' | 'incomplete';

export interface Qualification {
  status: QualificationStatus;
  attempts: number;
  passed: boolean;
  tool_calls: number;
  duration_ms: number;
  results: boolean[]; // oracle result per attempt, in order
}

/**
 * Derived (never stored) eligibility view for the owner and the Tool Call Challenge:
 * pre-registered rule "Q0 passes the oracle in <= 2 attempts". Q records only.
 */
export function evaluateQualification(
  attempts: RecordSummary[],
  cells: { hadQualCell: boolean; qualActive: boolean }
): Qualification {
  const q = attempts.filter((r) => r.armId === 'Q').sort((x, y) => x.receivedAt - y.receivedAt);
  const results = q.map((r) => r.oraclePass === true);
  const passIdx = results.indexOf(true);
  let status: QualificationStatus;
  if (passIdx >= 0 && passIdx < QUALIFICATION_MAX_ATTEMPTS) status = 'qualified';
  else if (passIdx >= QUALIFICATION_MAX_ATTEMPTS) status = 'failed';
  else if (q.length >= QUALIFICATION_MAX_ATTEMPTS) status = 'failed';
  else if (cells.hadQualCell && !cells.qualActive) status = q.length > 0 ? 'failed' : 'incomplete';
  else if (cells.hadQualCell) status = 'pending';
  else status = 'none';
  return {
    status,
    attempts: q.length,
    passed: status === 'qualified',
    tool_calls: q.reduce((n, r) => n + r.toolCalls, 0),
    duration_ms: q.reduce((n, r) => n + (r.durationMs ?? 0), 0),
    results,
  };
}

// ---------------------------------------------------------------- engine

interface RunnerInfo {
  participantId: string;
  nickname: string;
  join: BenchJoinMessage;
  joinedAt: number;
  connected: boolean;
}

interface ProgressEntry {
  armId: BenchArmId;
  taskIndex: number;
  phase: 'start' | 'turn' | 'oracle' | 'done';
  turn: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  oraclePass: boolean | null;
  terminatedBy: string | null;
  updatedAt: number;
}

interface Cell extends StoredCell {
  progress: Map<string, ProgressEntry>;
  records: RecordSummary[];
  lastError: { code: string; message: string; at: number } | null;
  artifact: { sha256: string; bytes: number; version: number } | null;
}

const ACTIVE: BenchCellStatus[] = ['sent', 'running', 'stopping'];

export interface AssignOptions {
  participantId: string;
  /** Ordered arms chosen by the owner; `null` resets to the default (all arms, shuffled by the seed). */
  arms?: BenchArm[] | null;
  mode?: BenchMode;
  seed?: number;
  kMax?: number;
  deadlineS?: number;
  maxProductiveTurns?: number;
}

export interface StartOptions {
  mode?: BenchMode;
  onlyQualified?: boolean;
  participantIds?: string[];
}

export interface StopOptions {
  participantId?: string;
}

export class BenchEngine {
  private sessionId: string | null = null;
  private hydrating: Promise<void> | null = null;
  private runners = new Map<string, RunnerInfo>();
  private cells = new Map<string, Cell>();
  private running = false;
  private mode: BenchMode = 'qualification';
  private loop: NodeJS.Timeout | null = null;
  private lastSnapshotAt = 0;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private hub: BenchHub,
    private logger: FastifyBaseLogger,
    private store: BenchStore,
    private eventLogger?: EventLogger
  ) {}

  // ---------- session / hydration ----------

  /**
   * Bind the engine to the active session. A new session resets the in-memory
   * state; the DB is the source of truth, so a server restart (or re-binding)
   * rebuilds cells and the progress grid from stored assignments + records.
   */
  async ensureSession(sessionId: string): Promise<void> {
    if (this.sessionId === sessionId) {
      if (this.hydrating) await this.hydrating;
      return;
    }
    this.sessionId = sessionId;
    this.runners.clear();
    this.cells.clear();
    this.running = false;
    this.stopLoop();
    this.hydrating = this.hydrate(sessionId).finally(() => {
      this.hydrating = null;
    });
    await this.hydrating;
  }

  private async hydrate(sessionId: string) {
    const [cells, records, artifacts] = await Promise.all([
      this.store.loadCells(sessionId),
      this.store.loadRecords(sessionId),
      this.store.listArtifacts(sessionId),
    ]);
    if (this.sessionId !== sessionId) return;
    for (const c of cells) {
      this.cells.set(c.cellId, { ...c, progress: new Map(), records: [], lastError: null, artifact: null });
    }
    for (const r of records) {
      const cell = this.cells.get(r.cellId);
      if (!cell) continue;
      const summary = summarizeRecord(r);
      cell.records.push(summary);
      this.applyRecordToProgress(cell, summary);
    }
    for (const a of artifacts) {
      const cell = this.cells.get(a.cellId);
      if (cell && (!cell.artifact || a.version > cell.artifact.version)) {
        cell.artifact = { sha256: a.sha256, bytes: a.bytes, version: a.version };
      }
    }
    // Cells that were live when the server went down stay live: the runner may reconnect and keep reporting.
    if ([...this.cells.values()].some((c) => ACTIVE.includes(c.status))) {
      this.running = true;
      this.ensureLoop();
    }
    this.logger.info(
      { sessionId, cells: this.cells.size, records: records.length },
      'BENCH_HYDRATE: bench state rebuilt from the database'
    );
  }

  // ---------- lifecycle (HTTP) ----------

  isRunning() {
    return this.running;
  }

  async assign(sessionId: string, opts: AssignOptions) {
    await this.ensureSession(sessionId);
    const runner = this.runners.get(opts.participantId);
    if (!runner) {
      throw new BenchError('runner_not_joined', `Participant ${opts.participantId} has not sent bench_join in this session`, 404);
    }
    // Always edits the PLANNED cell (the next one). A live cell is never touched: the runner
    // refuses a second bench_assign while running, so the new plan waits for stop/finish.
    const cell = this.ensurePlanned(runner);
    const active = this.activeCell(opts.participantId);

    const mode = opts.mode ?? cell.mode;
    const seed = opts.seed ?? cell.seed;
    if (opts.arms) {
      cell.arms = [...opts.arms];
      cell.armsSource = 'owner';
    } else if (opts.arms === null) {
      cell.arms = shuffleArms(seed);
      cell.armsSource = 'default_shuffled';
    } else if (cell.armsSource === 'default_shuffled' && opts.seed != null) {
      cell.arms = shuffleArms(seed); // the default order is a function of the stored seed
    }
    cell.mode = mode;
    cell.seed = seed;
    cell.kMax = opts.kMax ?? cell.kMax;
    cell.deadlineS = opts.deadlineS ?? cell.deadlineS;
    cell.maxProductiveTurns = opts.maxProductiveTurns ?? cell.maxProductiveTurns;

    let sent = false;
    let reason: string | null = null;
    if (!this.running) reason = 'bench_not_running';
    else if (active) reason = 'cell_active';
    else if (!runner.connected) reason = 'disconnected';
    else sent = this.sendCell(cell, runner);
    if (sent) this.ensurePlanned(runner);
    await this.persistCell(cell);
    await this.persistPlanned(runner.participantId);

    this.logger.info(
      { participantId: runner.participantId, cellId: cell.cellId, arms: cell.arms, mode, seed, sent, reason },
      'BENCH_ASSIGN: arms assigned'
    );
    if (!sent) {
      this.logEvent('bench_assigned', 'admin', runner.participantId, {
        cell_id: cell.cellId,
        mode,
        arms: cell.arms,
        arms_source: cell.armsSource,
        seed,
        sent: false,
        reason,
      });
    }
    this.broadcastNow();
    return { cell: this.cellView(cell), sent, reason };
  }

  async start(sessionId: string, opts: StartOptions = {}) {
    await this.ensureSession(sessionId);
    if (opts.mode) this.mode = opts.mode;

    const targets = [...this.runners.values()].filter(
      (r) => !opts.participantIds || opts.participantIds.includes(r.participantId)
    );
    if (targets.length === 0) {
      throw new BenchError('no_runners', 'No runner has joined the bench in this session yet', 409);
    }

    const sent: Array<{ participant_id: string; cell_id: string; mode: BenchMode; arms: BenchArm[]; seed: number }> = [];
    const skipped: Array<{ participant_id: string; reason: string; cell_id?: string }> = [];

    for (const runner of targets) {
      const pid = runner.participantId;
      const active = this.activeCell(pid);
      if (active) {
        skipped.push({ participant_id: pid, reason: 'cell_active', cell_id: active.cellId });
        continue;
      }
      if (!runner.connected) {
        skipped.push({ participant_id: pid, reason: 'disconnected' });
        continue;
      }
      const cell = this.ensurePlanned(runner);
      if (opts.mode) cell.mode = opts.mode;
      if (cell.mode === 'bench' && opts.onlyQualified) {
        const q = this.qualificationOf(pid);
        if (q.status !== 'qualified') {
          skipped.push({ participant_id: pid, reason: `not_qualified (${q.status})`, cell_id: cell.cellId });
          await this.persistCell(cell);
          continue;
        }
      }
      if (this.sendCell(cell, runner)) {
        sent.push({ participant_id: pid, cell_id: cell.cellId, mode: cell.mode, arms: this.armsOnWire(cell), seed: cell.seed });
        this.ensurePlanned(runner);
      } else {
        skipped.push({ participant_id: pid, reason: 'send_failed', cell_id: cell.cellId });
      }
      await this.persistCell(cell);
      await this.persistPlanned(pid);
    }

    if (sent.length === 0) {
      this.broadcastNow();
      throw new BenchError('nothing_to_start', 'No runner could be started', 409, { skipped });
    }

    this.running = true;
    this.lastSnapshotAt = 0; // first snapshot right away
    this.ensureLoop();
    this.logger.info({ mode: this.mode, sent: sent.length, skipped: skipped.length }, 'BENCH_START: bench started');
    this.logEvent('bench_started', 'admin', undefined, { mode: opts.mode ?? this.mode, cells: sent, skipped });
    this.broadcastNow();
    return { running: true, mode: opts.mode ?? this.mode, sent, skipped };
  }

  async stop(sessionId: string, opts: StopOptions = {}) {
    await this.ensureSession(sessionId);
    const stopping: Array<{ participant_id: string; cell_id: string; delivered: boolean }> = [];
    for (const cell of this.cells.values()) {
      if (opts.participantId && cell.participantId !== opts.participantId) continue;
      if (cell.status !== 'sent' && cell.status !== 'running') continue;
      const msg: BenchStopMessage = { type: 'bench_stop', cell_id: cell.cellId };
      const delivered = this.hub.sendToParticipant(cell.participantId, msg);
      if (delivered) {
        cell.status = 'stopping';
      } else {
        // The runner is gone: nobody will send bench_cell_done. Close the cell as truncated.
        cell.status = 'stopped';
        cell.doneAt = new Date();
        cell.summary = { reason: 'runner_unreachable_at_stop' };
      }
      stopping.push({ participant_id: cell.participantId, cell_id: cell.cellId, delivered });
      await this.persistCell(cell);
      const r = this.runners.get(cell.participantId);
      if (!delivered && r) {
        this.ensurePlanned(r);
        await this.persistPlanned(cell.participantId);
      }
    }
    if (!opts.participantId) this.running = false;
    this.logger.info({ cells: stopping.length, participantId: opts.participantId }, 'BENCH_STOP: bench stop requested');
    this.logEvent('bench_stopped', 'admin', opts.participantId, { reason: 'owner', cells: stopping });
    this.logSnapshot('stop');
    this.broadcastNow();
    return { running: this.running, stopping };
  }

  // ---------- runner messages (WS) ----------

  async handleJoin(participantId: string, msg: BenchJoinMessage, info: { nickname: string; sessionId: string }) {
    await this.ensureSession(info.sessionId);
    const rejoin = this.runners.has(participantId);
    this.runners.set(participantId, {
      participantId,
      nickname: info.nickname || participantId,
      join: msg,
      joinedAt: Date.now(),
      connected: true,
    });
    // Every runner shows up in the control panel with a plan (default: all arms, shuffled by the cell's seed).
    this.ensurePlanned(this.runners.get(participantId)!);
    await this.persistPlanned(participantId);
    this.logger.info(
      { participantId, model: msg.model.id, rejoin, taskSet: msg.task_set_sha.slice(0, 12) },
      'BENCH_JOIN: runner joined the bench'
    );
    this.logEvent('bench_joined', 'participant', participantId, {
      nickname: info.nickname,
      rejoin,
      runner_version: msg.runner_version,
      tau_intent_sha: msg.tau_intent_sha,
      task_set_sha: msg.task_set_sha,
      model: msg.model,
      hardware: msg.hardware,
    });
    this.broadcastNow();
  }

  handleProgress(participantId: string, msg: BenchProgressMessage) {
    const cell = this.cells.get(msg.cell_id);
    if (!cell || cell.participantId !== participantId || !ACTIVE.includes(cell.status)) {
      this.logger.debug({ participantId, cellId: msg.cell_id }, 'BENCH_PROGRESS_IGNORED: unknown or inactive cell');
      return;
    }
    if (cell.status === 'sent') {
      cell.status = 'running';
      void this.persistCell(cell);
    }
    const key = progressKey(msg.arm_id, msg.task_index);
    const prev = cell.progress.get(key);
    cell.progress.set(key, {
      armId: msg.arm_id,
      taskIndex: msg.task_index,
      phase: msg.phase,
      turn: msg.turn ?? prev?.turn ?? null,
      tokensIn: msg.tokens_in ?? prev?.tokensIn ?? null,
      tokensOut: msg.tokens_out ?? prev?.tokensOut ?? null,
      oraclePass: prev?.oraclePass ?? null,
      terminatedBy: prev?.terminatedBy ?? null,
      updatedAt: Date.now(),
    });
    this.scheduleBroadcast();
  }

  /** `rawRecord` is the record object exactly as it arrived on the wire (stored verbatim). */
  async handleRecord(participantId: string, msg: BenchRecordMessage, rawRecord: unknown): Promise<BenchResult> {
    const cell = this.cells.get(msg.cell_id);
    const rec = msg.record;
    const reject = (code: string, message: string): BenchResult => {
      this.logger.warn({ participantId, cellId: msg.cell_id, code, message }, 'BENCH_RECORD_REJECTED');
      return { ok: false, code, message };
    };
    if (!cell || cell.participantId !== participantId) return reject('unknown_cell', `Cell ${msg.cell_id} is not assigned to ${participantId}`);
    if (cell.status === 'planned' || cell.status === 'error') return reject('cell_not_active', `Cell ${cell.cellId} is ${cell.status}`);
    if (rec.cell_id !== msg.cell_id) return reject('cell_mismatch', 'record.cell_id differs from the message cell_id');
    if (rec.participant_id !== participantId) return reject('participant_mismatch', 'record.participant_id differs from the registered participant');
    if (cell.mode === 'qualification') {
      if (rec.arm_id !== 'Q') return reject('arm_not_assigned', `qualification cells only accept arm Q (got ${rec.arm_id})`);
    } else {
      if (rec.arm_id === 'Q' || !cell.arms.includes(rec.arm_id)) {
        return reject('arm_not_assigned', `arm ${rec.arm_id} is not in the assigned arms [${cell.arms.join(',')}]`);
      }
      if (rec.task_index > cell.kMax) return reject('task_out_of_range', `task_index ${rec.task_index} > k_max ${cell.kMax}`);
    }

    const rawJson = JSON.stringify(rawRecord);
    const stored: StoredRecord = {
      cellId: cell.cellId,
      sessionId: cell.sessionId,
      participantId,
      armId: rec.arm_id,
      taskIndex: rec.task_index,
      oraclePass: rec.oracle.pass,
      tokensIn: toIntOrNull(rec.tokens.in),
      tokensOut: toIntOrNull(rec.tokens.out),
      terminatedBy: rec.terminated_by,
      receivedAt: new Date(),
      rawSha256: createHash('sha256').update(rawJson).digest('hex'),
      raw: rawJson,
    };
    let outcome: 'inserted' | 'duplicate';
    try {
      outcome = await this.store.insertRecord(stored);
    } catch (err) {
      this.logger.error({ err, cellId: cell.cellId }, 'BENCH_RECORD_DB_FAILED');
      return reject('storage_failed', 'The arena could not store the record; retry');
    }
    if (outcome === 'duplicate') {
      this.logger.info({ cellId: cell.cellId, arm: rec.arm_id, task: rec.task_index }, 'BENCH_RECORD_DUPLICATE: identical retry ignored');
      return { ok: true, duplicate: true };
    }

    const summary = summarizeRecord(stored);
    const repeated =
      rec.arm_id !== 'Q' && cell.records.some((r) => r.armId === rec.arm_id && r.taskIndex === rec.task_index);
    if (repeated) {
      this.logger.warn(
        { cellId: cell.cellId, arm: rec.arm_id, task: rec.task_index },
        'BENCH_RECORD_REVISION: a second, different record for the same (cell, arm, task) was stored too'
      );
    }
    cell.records.push(summary);
    if (cell.status === 'sent') {
      cell.status = 'running';
      void this.persistCell(cell);
    }
    this.applyRecordToProgress(cell, summary);
    this.logEvent('bench_record', 'participant', participantId, {
      cell_id: cell.cellId,
      arm_id: rec.arm_id,
      task_index: rec.task_index,
      oracle_pass: rec.oracle.pass,
      tokens_in: stored.tokensIn,
      tokens_out: stored.tokensOut,
      terminated_by: rec.terminated_by,
      repeated,
    });
    this.broadcastNow();
    return { ok: true };
  }

  async handleCellDone(participantId: string, msg: BenchCellDoneMessage): Promise<BenchResult> {
    const cell = this.cells.get(msg.cell_id);
    if (!cell || cell.participantId !== participantId) {
      this.logger.warn({ participantId, cellId: msg.cell_id }, 'BENCH_CELL_DONE_REJECTED: unknown cell');
      return { ok: false, code: 'unknown_cell', message: `Cell ${msg.cell_id} is not assigned to ${participantId}` };
    }
    if (cell.status === 'planned') {
      return { ok: false, code: 'cell_not_active', message: `Cell ${cell.cellId} was never sent` };
    }
    const stoppedEarly = cell.status === 'stopping' || msg.truncated;
    cell.status = stoppedEarly ? 'stopped' : 'done';
    cell.doneAt = new Date();
    cell.summary = {
      records: msg.records,
      manifest_sha256: msg.manifest_sha256,
      truncated: msg.truncated,
      records_received: cell.records.length,
    };
    await this.persistCell(cell);
    const runner = this.runners.get(participantId);
    if (runner) {
      this.ensurePlanned(runner);
      await this.persistPlanned(participantId);
    }
    this.logger.info(
      { cellId: cell.cellId, declared: msg.records, received: cell.records.length, truncated: msg.truncated },
      'BENCH_CELL_DONE: cell finished'
    );
    this.logEvent('bench_cell_done', 'participant', participantId, {
      cell_id: cell.cellId,
      records_declared: msg.records,
      records_received: cell.records.length,
      manifest_sha256: msg.manifest_sha256,
      truncated: msg.truncated,
      status: cell.status,
    });
    this.finishIfIdle('all_done');
    this.broadcastNow();
    return { ok: true };
  }

  handleError(participantId: string, msg: BenchErrorMessage) {
    const cell = this.cells.get(msg.cell_id);
    this.logger.warn({ participantId, cellId: msg.cell_id, code: msg.code, message: msg.message }, 'BENCH_RUNNER_ERROR');
    this.logEvent('bench_error', 'participant', participantId, {
      cell_id: msg.cell_id,
      code: msg.code,
      message: msg.message,
    });
    if (!cell || cell.participantId !== participantId) return;
    cell.lastError = { code: msg.code, message: msg.message, at: Date.now() };
    // Refused or failed before reporting anything: the cell is dead. A running cell keeps its status
    // (a refused *second* assign names the new cell id, never the live one).
    if (cell.status === 'sent') {
      cell.status = 'error';
      cell.doneAt = new Date();
      void this.persistCell(cell);
      const runner = this.runners.get(participantId);
      if (runner) {
        this.ensurePlanned(runner);
        void this.persistPlanned(participantId);
      }
      this.finishIfIdle('all_done');
    }
    this.broadcastNow();
  }

  handleDisconnect(participantId: string) {
    const runner = this.runners.get(participantId);
    if (!runner) return;
    runner.connected = false;
    this.logger.info({ participantId }, 'BENCH_LEAVE: runner disconnected');
    this.broadcastNow();
  }

  // ---------- artifacts ----------

  /** Called by the HTTP route after a bundle was stored; keeps the panel and the event log in sync. */
  noteArtifact(a: StoredArtifact, duplicate: boolean) {
    const cell = this.cells.get(a.cellId);
    if (cell) cell.artifact = { sha256: a.sha256, bytes: a.bytes, version: a.version };
    this.logEvent('bench_artifacts_uploaded', 'participant', a.participantId ?? undefined, {
      cell_id: a.cellId,
      sha256: a.sha256,
      bytes: a.bytes,
      version: a.version,
      path: a.path,
      duplicate,
    });
    this.broadcastNow();
  }

  /** Cell lookup for the upload route: memory first, then any session in the DB. */
  async findCell(cellId: string): Promise<{ cellId: string; sessionId: string; participantId: string } | null> {
    const c = this.cells.get(cellId);
    if (c) {
      return c.status === 'planned' ? null : { cellId: c.cellId, sessionId: c.sessionId, participantId: c.participantId };
    }
    const stored = await this.store.findCell(cellId);
    return stored && stored.status !== 'planned'
      ? { cellId: stored.cellId, sessionId: stored.sessionId, participantId: stored.participantId }
      : null;
  }

  // ---------- state ----------

  snapshot() {
    return this.buildState();
  }

  async state(sessionId?: string | null) {
    if (sessionId) await this.ensureSession(sessionId);
    return this.buildState();
  }

  /** Per-participant view used by the state and by tests. */
  private cellView(c: Cell) {
    return {
      cell_id: c.cellId,
      status: c.status,
      mode: c.mode,
      arms: c.arms,
      arms_on_wire: this.armsOnWire(c),
      arms_source: c.armsSource,
      seed: c.seed,
      k_max: c.kMax,
      deadline_s: c.deadlineS,
      max_productive_turns: c.maxProductiveTurns,
      created_at: c.createdAt.getTime(),
      sent_at: c.sentAt?.getTime() ?? null,
      done_at: c.doneAt?.getTime() ?? null,
      records: c.records.length,
      summary: c.summary,
      last_error: c.lastError,
      artifact: c.artifact,
    };
  }

  private gridOf(c: Cell) {
    return [...c.progress.values()]
      .sort((a, b) => a.taskIndex - b.taskIndex || armRank(c, a.armId) - armRank(c, b.armId))
      .map((p) => ({
        arm_id: p.armId,
        task_index: p.taskIndex,
        phase: p.phase,
        turn: p.turn,
        tokens_in: p.tokensIn,
        tokens_out: p.tokensOut,
        oracle_pass: p.oraclePass,
        terminated_by: p.terminatedBy,
        updated_at: p.updatedAt,
      }));
  }

  private buildState() {
    const ids = new Set<string>([...this.runners.keys(), ...[...this.cells.values()].map((c) => c.participantId)]);
    const participants = [...ids].map((pid) => {
      const runner = this.runners.get(pid);
      const cell = this.activeCell(pid) ?? this.latestStartedCell(pid);
      const plan = this.plannedCell(pid);
      return {
        participant_id: pid,
        nickname: runner?.nickname ?? pid,
        connected: runner?.connected ?? false,
        join: runner
          ? {
              runner_version: runner.join.runner_version,
              tau_intent_sha: runner.join.tau_intent_sha,
              task_set_sha: runner.join.task_set_sha,
              model: runner.join.model,
              hardware: runner.join.hardware,
            }
          : null,
        cell: cell ? this.cellView(cell) : null,
        plan: plan ? this.cellView(plan) : null,
        grid: cell ? this.gridOf(cell) : [],
        qualification: this.qualificationOf(pid),
      };
    });
    participants.sort((a, b) => a.nickname.localeCompare(b.nickname));

    const tally = (pick: (p: (typeof participants)[number]) => string | undefined) => {
      const m = new Map<string, number>();
      for (const p of participants) {
        const v = pick(p);
        if (v) m.set(v, (m.get(v) ?? 0) + 1);
      }
      return [...m.entries()].map(([sha, count]) => ({ sha, count })).sort((a, b) => b.count - a.count);
    };

    const all = [...this.cells.values()];
    return {
      type: 'bench_state' as const,
      t: Date.now(),
      session_id: this.sessionId,
      running: this.running,
      mode: this.stateMode(all),
      counts: {
        runners: participants.length,
        connected: participants.filter((p) => p.connected).length,
        cells_active: all.filter((c) => ACTIVE.includes(c.status)).length,
        cells_finished: all.filter((c) => c.status === 'done' || c.status === 'stopped').length,
        records: all.reduce((n, c) => n + c.records.length, 0),
      },
      shas: {
        task_set: tally((p) => p.join?.task_set_sha),
        tau_intent: tally((p) => p.join?.tau_intent_sha),
      },
      participants,
    };
  }

  // ---------- internals ----------

  private armsOnWire(c: Cell | StoredCell): BenchArm[] {
    // Qualification runs only Q0 in arm A (contract §3): say so explicitly.
    return c.mode === 'qualification' ? ['A'] : c.arms;
  }

  /** Mode shown by the telão: the live cells' mode (or `mixed`), else the last mode the owner started. */
  private stateMode(all: Cell[]): BenchMode | 'mixed' {
    const modes = new Set(all.filter((c) => ACTIVE.includes(c.status)).map((c) => c.mode));
    if (modes.size === 1) return [...modes][0];
    if (modes.size > 1) return 'mixed';
    return this.mode;
  }

  /**
   * Every known runner always has exactly one PLANNED cell (the next one): a fresh default
   * (all arms, order shuffled by the cell's seed) or a clone of its last cell (same arms,
   * order, seed and limits, new cell id).
   */
  private ensurePlanned(runner: RunnerInfo): Cell {
    const existing = this.plannedCell(runner.participantId);
    if (existing) return existing;
    const last = this.latestCell(runner.participantId);
    const seed = last?.seed ?? randomSeed();
    const cell: Cell = {
      cellId: newCellId(runner.participantId),
      sessionId: this.sessionId!,
      participantId: runner.participantId,
      mode: last?.mode ?? this.mode,
      arms: last ? [...last.arms] : shuffleArms(seed),
      armsSource: last?.armsSource ?? 'default_shuffled',
      seed,
      kMax: last?.kMax ?? DEFAULT_BENCH_CONFIG.kMax,
      deadlineS: last?.deadlineS ?? DEFAULT_BENCH_CONFIG.deadlineS,
      maxProductiveTurns: last?.maxProductiveTurns ?? DEFAULT_BENCH_CONFIG.maxProductiveTurns,
      status: 'planned',
      join: null,
      summary: null,
      createdAt: new Date(),
      sentAt: null,
      doneAt: null,
      progress: new Map(),
      records: [],
      lastError: null,
      artifact: null,
    };
    this.cells.set(cell.cellId, cell);
    return cell;
  }

  private async persistPlanned(participantId: string) {
    const p = this.plannedCell(participantId);
    if (p) await this.persistCell(p);
  }

  /** Deliver bench_assign. Returns false (cell stays planned) when the runner socket is gone. */
  private sendCell(cell: Cell, runner: RunnerInfo): boolean {
    if (cell.status !== 'planned') return false;
    const msg: BenchAssignMessage = {
      type: 'bench_assign',
      cell_id: cell.cellId,
      mode: cell.mode,
      arms: this.armsOnWire(cell),
      seed: cell.seed,
      k_max: cell.kMax,
      deadline_s: cell.deadlineS,
      max_productive_turns: cell.maxProductiveTurns,
    };
    if (!this.hub.sendToParticipant(cell.participantId, msg)) return false;
    cell.status = 'sent';
    cell.sentAt = new Date();
    cell.join = runner.join;
    this.logger.info({ participantId: cell.participantId, cellId: cell.cellId, mode: cell.mode, arms: msg.arms }, 'BENCH_SEND: bench_assign delivered');
    this.logEvent('bench_assigned', 'admin', cell.participantId, {
      cell_id: cell.cellId,
      mode: cell.mode,
      arms: msg.arms,
      planned_arms: cell.arms,
      arms_source: cell.armsSource,
      seed: cell.seed,
      k_max: cell.kMax,
      deadline_s: cell.deadlineS,
      max_productive_turns: cell.maxProductiveTurns,
      sent: true,
    });
    return true;
  }

  private cellsOf(participantId: string): Cell[] {
    return [...this.cells.values()]
      .filter((c) => c.participantId === participantId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  private plannedCell(participantId: string): Cell | undefined {
    return this.cellsOf(participantId).filter((c) => c.status === 'planned').pop();
  }

  private activeCell(participantId: string): Cell | undefined {
    return this.cellsOf(participantId).filter((c) => ACTIVE.includes(c.status)).pop();
  }

  /** Most recent cell that was actually sent (any final or live status). */
  private latestStartedCell(participantId: string): Cell | undefined {
    return this.cellsOf(participantId).filter((c) => c.status !== 'planned').pop();
  }

  private latestCell(participantId: string): Cell | undefined {
    return this.cellsOf(participantId).pop();
  }

  private qualificationOf(participantId: string): Qualification {
    const qualCells = [...this.cells.values()].filter(
      (c) => c.participantId === participantId && c.mode === 'qualification' && c.status !== 'planned'
    );
    return evaluateQualification(
      qualCells.flatMap((c) => c.records),
      { hadQualCell: qualCells.length > 0, qualActive: qualCells.some((c) => ACTIVE.includes(c.status)) }
    );
  }

  private applyRecordToProgress(cell: Cell, s: RecordSummary) {
    const key = progressKey(s.armId as BenchArmId, s.taskIndex);
    const prev = cell.progress.get(key);
    cell.progress.set(key, {
      armId: s.armId as BenchArmId,
      taskIndex: s.taskIndex,
      phase: 'done',
      turn: prev?.turn ?? null,
      tokensIn: s.tokensIn ?? prev?.tokensIn ?? null,
      tokensOut: s.tokensOut ?? prev?.tokensOut ?? null,
      oraclePass: s.oraclePass,
      terminatedBy: s.terminatedBy,
      updatedAt: s.receivedAt,
    });
  }

  private finishIfIdle(reason: string) {
    if (!this.running) return;
    if ([...this.cells.values()].some((c) => ACTIVE.includes(c.status))) return;
    this.running = false;
    this.logger.info({ reason }, 'BENCH_STOP: every cell finished');
    this.logEvent('bench_stopped', 'system', undefined, { reason });
    this.logSnapshot('idle');
  }

  private persistCell(cell: Cell): Promise<void> {
    // Serialised so a late write of an earlier state can never overwrite a newer one.
    const run = () =>
      this.store
        .upsertCell({
          cellId: cell.cellId,
          sessionId: cell.sessionId,
          participantId: cell.participantId,
          mode: cell.mode,
          arms: cell.arms,
          armsSource: cell.armsSource,
          seed: cell.seed,
          kMax: cell.kMax,
          deadlineS: cell.deadlineS,
          maxProductiveTurns: cell.maxProductiveTurns,
          status: cell.status,
          join: cell.join,
          summary: cell.summary,
          createdAt: cell.createdAt,
          sentAt: cell.sentAt,
          doneAt: cell.doneAt,
        })
        .catch((err) => this.logger.error({ err, cellId: cell.cellId }, 'BENCH_PERSIST_FAILED'));
    const p = this.writeQueue.then(run, run);
    this.writeQueue = p;
    return p;
  }

  private logEvent(
    eventType: EventType,
    actorType: 'admin' | 'participant' | 'system',
    actorId: string | undefined,
    metadata: Record<string, unknown>
  ) {
    this.eventLogger?.log({
      sessionId: this.sessionId ?? undefined,
      eventType,
      actorType,
      actorId,
      targetType: 'bench',
      targetId: typeof metadata.cell_id === 'string' ? metadata.cell_id : undefined,
      metadata,
    });
  }

  // ---------- snapshots + broadcast ----------

  private ensureLoop() {
    if (!this.loop) this.loop = setInterval(() => this.tick(), LOOP_INTERVAL_MS);
  }

  private stopLoop() {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  private tick() {
    const now = Date.now();
    const live = this.running || [...this.cells.values()].some((c) => ACTIVE.includes(c.status));
    if (!live) {
      this.stopLoop();
      return;
    }
    if (now - this.lastSnapshotAt >= BENCH_SNAPSHOT_INTERVAL_MS) this.logSnapshot('periodic');
  }

  /**
   * Full-state record in the event log every 5 s while the bench is live (and once at
   * stop/idle). Compact on purpose: grid rows are tuples
   * [arm, task, phase, turn, tokens_in, tokens_out, oracle_pass, terminated_by].
   */
  private logSnapshot(reason: string) {
    if (!this.sessionId) return;
    this.lastSnapshotAt = Date.now();
    const state = this.buildState();
    this.logEvent('bench_snapshot', 'system', undefined, {
      reason,
      t: state.t,
      running: state.running,
      mode: state.mode,
      counts: state.counts,
      participants: state.participants.map((p) => ({
        id: p.participant_id,
        nickname: p.nickname,
        connected: p.connected,
        model: p.join?.model.id ?? null,
        task_set_sha: p.join?.task_set_sha ?? null,
        cell_id: p.cell?.cell_id ?? null,
        status: p.cell?.status ?? null,
        mode: p.cell?.mode ?? null,
        arms: p.cell?.arms ?? null,
        seed: p.cell?.seed ?? null,
        records: p.cell?.records ?? 0,
        qualification: p.qualification,
        grid: p.grid.map((g) => [g.arm_id, g.task_index, g.phase, g.turn, g.tokens_in, g.tokens_out, g.oracle_pass, g.terminated_by]),
      })),
    });
  }

  private broadcastNow() {
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    this.hub.broadcastToTelao(this.buildState());
  }

  private scheduleBroadcast() {
    if (this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.hub.broadcastToTelao(this.buildState());
    }, BROADCAST_COALESCE_MS);
  }

  cleanup() {
    this.stopLoop();
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
  }
}

function progressKey(arm: string, task: number) {
  return `${arm}:${task}`;
}

function armRank(c: Cell, arm: string): number {
  const i = c.arms.indexOf(arm as BenchArm);
  return i === -1 ? 99 : i;
}

function toIntOrNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null;
}
