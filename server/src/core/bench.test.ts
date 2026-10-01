import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  BenchEngine,
  BenchError,
  CELL_ID_RE,
  evaluateQualification,
  newCellId,
  shuffleArms,
  summarizeRecord,
  type RecordSummary,
} from './bench.js';
import { MemoryBenchStore } from './bench-store.js';
import { BundleError, storeBundle } from './bench-artifacts.js';
import { BenchRecordMessageSchema, type BenchJoinMessage } from '../ws/schemas.js';

const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function fakeHub() {
  const sent: Array<{ to: string; msg: any }> = [];
  const telao: any[] = [];
  const offline = new Set<string>();
  return {
    sent,
    telao,
    offline,
    broadcastToTelao: (m: unknown) => void telao.push(m),
    sendToParticipant: (to: string, msg: unknown) => {
      if (offline.has(to)) return false;
      sent.push({ to, msg });
      return true;
    },
  };
}

function fakeEvents() {
  const events: any[] = [];
  return { events, log: vi.fn(async (e: any) => void events.push(e)) } as any;
}

const join = (id: string): BenchJoinMessage => ({
  type: 'bench_join',
  participant_id: id,
  runner_version: '0.1.0',
  tau_intent_sha: 'abc',
  task_set_sha: 'def',
  model: { id: 'qwen2.5-coder:7b', digest: null, runner_kind: 'ollama' },
  hardware: { os: 'linux', chip: 'x', ram_gb: 16, accel: 'cpu' },
});

function rec(cellId: string, pid: string, arm: 'A' | 'B' | 'C' | 'Q', k: number, pass = true, over: Record<string, unknown> = {}) {
  const harness = { A: 'tau', B: 'tau_intent', C: 'tau_intent_llm_rescue', Q: 'tau' }[arm];
  const on = arm === 'B' || arm === 'C';
  return {
    schema_version: 'gambiarra-coleta-2',
    draft: true,
    cell_id: cellId,
    participant_id: pid,
    session_pin_hash: null,
    arm_id: arm,
    harness_id: harness,
    task_set_sha: 'def',
    task_index: arm === 'Q' ? 0 : k,
    task_id: `t${k}`,
    task_hash: 'h',
    model: { id: 'qwen2.5-coder:7b', digest: null, runner_kind: 'ollama' },
    hardware: { os: 'linux', chip: 'x', ram_gb: 16, accel: 'cpu' },
    arm_order: ['A', 'B', 'C'],
    seed: 1,
    mechanism: { flags: { capture: on, gate: on, project: on, serve: on, llm_rescue: arm === 'C' } },
    oracle: { pass, passed: pass ? 3 : 1, failed: pass ? 0 : 2, errors: 0, duration_s: 1.5 },
    evolution: {},
    tokens: { in: 100, out: 50, rescue_in: 0, rescue_out: 0, source: 'provider_usage', cost_usd: 0 },
    turns: [{ turn_index: 1, kind: 'productive', tokens_in: 100, tokens_out: 50, tool_calls: 3 }],
    mechanism_telemetry: {},
    terminated_by: 'completed',
    started_at: '2026-10-01T10:00:00Z',
    ended_at: '2026-10-01T10:00:30Z',
    artifacts: {},
    ...over,
  };
}

function recMsg(cellId: string, r: ReturnType<typeof rec>) {
  const msg = { type: 'bench_record', cell_id: cellId, record: r };
  return { msg: BenchRecordMessageSchema.parse(msg), raw: r };
}

describe('bench helpers', () => {
  it('shuffleArms is a deterministic permutation of A/B/C per seed', () => {
    for (const seed of [1, 7, 42, 123456]) {
      const a = shuffleArms(seed);
      expect([...a].sort()).toEqual(['A', 'B', 'C']);
      expect(shuffleArms(seed)).toEqual(a);
    }
    const orders = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((s) => shuffleArms(s).join('')));
    expect(orders.size).toBeGreaterThan(2);
  });

  it('cell ids are file-name safe whatever the participant id', () => {
    for (const pid of ['maq-1', '../../etc/passwd', 'Zé Bug 🤖', '   ', 'a'.repeat(300)]) {
      const id = newCellId(pid);
      expect(CELL_ID_RE.test(id), id).toBe(true);
    }
    expect(newCellId('x')).not.toBe(newCellId('x'));
  });

  it('summarizeRecord derives tool calls and duration from the raw JSON', () => {
    const r = rec('c', 'p', 'Q', 0);
    const s = summarizeRecord({
      cellId: 'c', armId: 'Q', taskIndex: 0, oraclePass: true, tokensIn: 100, tokensOut: 50,
      terminatedBy: 'completed', receivedAt: new Date(1000), raw: JSON.stringify(r),
    });
    expect(s.toolCalls).toBe(3);
    expect(s.durationMs).toBe(30000);
  });

  const q = (pass: boolean, at: number): RecordSummary => ({
    cellId: 'c', armId: 'Q', taskIndex: 0, oraclePass: pass, tokensIn: 1, tokensOut: 1,
    toolCalls: 2, durationMs: 1000, terminatedBy: 'completed', receivedAt: at,
  });

  it('qualification rule: Q0 must pass in <= 2 attempts', () => {
    const active = { hadQualCell: true, qualActive: true };
    const idle = { hadQualCell: true, qualActive: false };
    expect(evaluateQualification([], { hadQualCell: false, qualActive: false }).status).toBe('none');
    expect(evaluateQualification([], active).status).toBe('pending');
    expect(evaluateQualification([q(true, 1)], active).status).toBe('qualified');
    expect(evaluateQualification([q(false, 1), q(true, 2)], active).status).toBe('qualified');
    expect(evaluateQualification([q(false, 1)], active).status).toBe('pending');
    expect(evaluateQualification([q(false, 1), q(false, 2)], active).status).toBe('failed');
    expect(evaluateQualification([q(false, 1), q(false, 2), q(true, 3)], active).status).toBe('failed');
    expect(evaluateQualification([q(false, 1)], idle).status).toBe('failed');
    expect(evaluateQualification([], idle).status).toBe('incomplete');
    // A/B/C records never count
    expect(evaluateQualification([{ ...q(true, 1), armId: 'A' }], active).status).toBe('pending');
  });
});

describe('BenchEngine', () => {
  let hub: ReturnType<typeof fakeHub>;
  let store: MemoryBenchStore;
  let events: ReturnType<typeof fakeEvents>;
  let engine: BenchEngine;
  const S = 'sess-1';

  beforeEach(() => {
    hub = fakeHub();
    store = new MemoryBenchStore();
    events = fakeEvents();
    engine = new BenchEngine(hub, logger, store, events);
  });
  afterEach(() => engine.cleanup());

  const joinAll = async (...ids: string[]) => {
    for (const id of ids) await engine.handleJoin(id, join(id), { nickname: id.toUpperCase(), sessionId: S });
  };
  const assignsTo = (id: string) => hub.sent.filter((s) => s.to === id && s.msg.type === 'bench_assign').map((s) => s.msg);

  it('gives every runner a default plan: all three arms, shuffled by the stored seed', async () => {
    await joinAll('m1');
    const st = (await engine.state(S)).participants[0];
    expect(st.plan!.status).toBe('planned');
    expect([...st.plan!.arms].sort()).toEqual(['A', 'B', 'C']);
    expect(st.plan!.arms).toEqual(shuffleArms(st.plan!.seed));
    expect(st.plan!.arms_source).toBe('default_shuffled');
    expect(st.join!.model.id).toBe('qwen2.5-coder:7b');
    expect(events.events.some((e: any) => e.eventType === 'bench_joined')).toBe(true);
  });

  it('assign stores the owner arms (ordered, subset) and does not send before start', async () => {
    await joinAll('m1');
    const r = await engine.assign(S, { participantId: 'm1', arms: ['C', 'A'], mode: 'bench' });
    expect(r.sent).toBe(false);
    expect(r.cell.arms).toEqual(['C', 'A']);
    expect(r.cell.arms_source).toBe('owner');
    expect(hub.sent.length).toBe(0);
    expect(store.cells.get(r.cell.cell_id)?.arms).toEqual(['C', 'A']);
    await expect(engine.assign(S, { participantId: 'ghost' })).rejects.toBeInstanceOf(BenchError);
    // arms: null goes back to the default order, derived from the stored seed
    const back = await engine.assign(S, { participantId: 'm1', arms: null });
    expect(back.cell.arms_source).toBe('default_shuffled');
    expect(back.cell.arms).toEqual(shuffleArms(back.cell.seed));
  });

  it('start sends bench_assign with exactly the owner arms, in order, with the cell seed', async () => {
    await joinAll('m1', 'm2');
    await engine.assign(S, { participantId: 'm1', arms: ['B', 'A', 'C'], mode: 'bench', seed: 7 });
    await engine.assign(S, { participantId: 'm2', arms: ['A'], mode: 'bench' });
    const res = await engine.start(S, { mode: 'bench' });
    expect(res.sent.length).toBe(2);
    const m1 = assignsTo('m1')[0];
    expect(m1).toMatchObject({ type: 'bench_assign', mode: 'bench', arms: ['B', 'A', 'C'], seed: 7, k_max: 6, deadline_s: 600, max_productive_turns: 8 });
    expect(assignsTo('m2')[0].arms).toEqual(['A']);
    expect(engine.isRunning()).toBe(true);
    expect(events.events.filter((e: any) => e.eventType === 'bench_assigned' && e.metadata.sent).length).toBe(2);
    expect(events.events.some((e: any) => e.eventType === 'bench_started')).toBe(true);
    // a cell is live, a fresh plan exists for the next round, reassign does not touch the live cell
    const st = (await engine.state(S)).participants.find((p) => p.participant_id === 'm1')!;
    expect(st.cell!.status).toBe('sent');
    expect(st.plan!.cell_id).not.toBe(st.cell!.cell_id);
    const again = await engine.assign(S, { participantId: 'm1', arms: ['A'] });
    expect(again.sent).toBe(false);
    expect(again.reason).toBe('cell_active');
    expect(assignsTo('m1').length).toBe(1);
  });

  it('qualification sends only arm A and mode qualification (Q0, no arm choice)', async () => {
    await joinAll('m1');
    await engine.assign(S, { participantId: 'm1', arms: ['B', 'C'] });
    await engine.start(S, { mode: 'qualification' });
    expect(assignsTo('m1')[0]).toMatchObject({ mode: 'qualification', arms: ['A'] });
  });

  it('accepts valid records, stores them raw, updates the grid; rejects contradictions', async () => {
    await joinAll('m1');
    await engine.assign(S, { participantId: 'm1', arms: ['B', 'A'], mode: 'bench' });
    await engine.start(S, { mode: 'bench' });
    const cellId = assignsTo('m1')[0].cell_id;

    engine.handleProgress('m1', { type: 'bench_progress', cell_id: cellId, arm_id: 'B', task_index: 1, phase: 'turn', turn: 2, tokens_in: 10, tokens_out: 5 });
    let st = (await engine.state(S)).participants[0];
    expect(st.cell!.status).toBe('running');
    expect(st.grid[0]).toMatchObject({ arm_id: 'B', task_index: 1, phase: 'turn', turn: 2, tokens_in: 10 });

    const ok = recMsg(cellId, rec(cellId, 'm1', 'B', 1, true, { future_field: 1 }));
    expect(await engine.handleRecord('m1', ok.msg, ok.raw)).toMatchObject({ ok: true });
    expect(store.records.length).toBe(1);
    expect(JSON.parse(store.records[0].raw).future_field).toBe(1); // as received, unknown fields kept
    expect(store.records[0]).toMatchObject({ armId: 'B', taskIndex: 1, oraclePass: true, tokensIn: 100, tokensOut: 50, terminatedBy: 'completed' });
    st = (await engine.state(S)).participants[0];
    expect(st.grid.find((g) => g.arm_id === 'B' && g.task_index === 1)).toMatchObject({ phase: 'done', oracle_pass: true });

    // identical retry is idempotent
    expect(await engine.handleRecord('m1', ok.msg, ok.raw)).toMatchObject({ ok: true, duplicate: true });
    expect(store.records.length).toBe(1);

    // arm C was not assigned
    const c = recMsg(cellId, rec(cellId, 'm1', 'C', 1));
    expect(await engine.handleRecord('m1', c.msg, c.raw)).toMatchObject({ ok: false, code: 'arm_not_assigned' });
    // wrong participant / unknown cell / task out of range / cell id mismatch
    expect((await engine.handleRecord('m1', recMsg(cellId, rec(cellId, 'other', 'B', 2)).msg, {})).code).toBe('participant_mismatch');
    expect((await engine.handleRecord('m1', recMsg('nope', rec('nope', 'm1', 'B', 2)).msg, {})).code).toBe('unknown_cell');
    expect((await engine.handleRecord('m1', recMsg(cellId, rec(cellId, 'm1', 'B', 9)).msg, {})).code).toBe('task_out_of_range');
    expect((await engine.handleRecord('m1', recMsg(cellId, rec('x', 'm1', 'B', 2)).msg, {})).code).toBe('cell_mismatch');
    expect(store.records.length).toBe(1);
    expect(events.events.filter((e: any) => e.eventType === 'bench_record').length).toBe(1);
  });

  it('runs the whole qualification -> bench flow with the eligibility filter', async () => {
    await joinAll('good', 'bad');
    await engine.start(S, { mode: 'qualification' });
    const g = assignsTo('good')[0].cell_id;
    const b = assignsTo('bad')[0].cell_id;
    const gq = recMsg(g, rec(g, 'good', 'Q', 0, true));
    expect((await engine.handleRecord('good', gq.msg, gq.raw)).ok).toBe(true);
    for (let i = 0; i < 2; i++) {
      const bq = recMsg(b, rec(b, 'bad', 'Q', 0, false, { started_at: `2026-10-01T10:0${i}:00Z` }));
      expect((await engine.handleRecord('bad', bq.msg, bq.raw)).ok).toBe(true);
    }
    // arm A record in a qualification cell is rejected (Q is never mixed with A)
    const mixed = recMsg(g, rec(g, 'good', 'A', 1));
    expect((await engine.handleRecord('good', mixed.msg, mixed.raw)).code).toBe('arm_not_assigned');

    for (const [pid, cid] of [['good', g], ['bad', b]]) {
      await engine.handleCellDone(pid, { type: 'bench_cell_done', cell_id: cid, records: 1, manifest_sha256: 'x', truncated: false });
    }
    expect(engine.isRunning()).toBe(false); // every cell finished
    expect(events.events.some((e: any) => e.eventType === 'bench_stopped' && e.metadata.reason === 'all_done')).toBe(true);
    let st = await engine.state(S);
    expect(st.participants.find((p) => p.participant_id === 'good')!.qualification.status).toBe('qualified');
    expect(st.participants.find((p) => p.participant_id === 'bad')!.qualification.status).toBe('failed');
    expect(st.participants.find((p) => p.participant_id === 'bad')!.qualification.attempts).toBe(2);

    const res = await engine.start(S, { mode: 'bench', onlyQualified: true });
    expect(res.sent.map((s) => s.participant_id)).toEqual(['good']);
    expect(res.skipped).toEqual([expect.objectContaining({ participant_id: 'bad', reason: 'not_qualified (failed)' })]);
    const second = assignsTo('good')[1];
    expect(second.mode).toBe('bench');
    expect(second.cell_id).not.toBe(g);
    expect([...second.arms].sort()).toEqual(['A', 'B', 'C']);
    st = await engine.state(S);
    expect(st.mode).toBe('bench');
  });

  it('stop sends bench_stop, waits for bench_cell_done (truncated) and closes unreachable runners', async () => {
    await joinAll('m1', 'm2');
    await engine.start(S, { mode: 'bench' });
    const c1 = assignsTo('m1')[0].cell_id;
    hub.offline.add('m2');
    const res = await engine.stop(S);
    expect(res.running).toBe(false);
    expect(hub.sent.filter((s) => s.msg.type === 'bench_stop' && s.to === 'm1')[0].msg.cell_id).toBe(c1);
    let st = await engine.state(S);
    expect(st.participants.find((p) => p.participant_id === 'm1')!.cell!.status).toBe('stopping');
    expect(st.participants.find((p) => p.participant_id === 'm2')!.cell!.status).toBe('stopped');
    await engine.handleCellDone('m1', { type: 'bench_cell_done', cell_id: c1, records: 3, manifest_sha256: 'x', truncated: true });
    st = await engine.state(S);
    expect(st.participants.find((p) => p.participant_id === 'm1')!.cell!.status).toBe('stopped');
    expect(events.events.filter((e: any) => e.eventType === 'bench_stopped').length).toBeGreaterThanOrEqual(1);
  });

  it('stop for one participant leaves the others running', async () => {
    await joinAll('m1', 'm2');
    await engine.start(S, { mode: 'bench' });
    await engine.stop(S, { participantId: 'm1' });
    expect(engine.isRunning()).toBe(true);
    expect(hub.sent.filter((s) => s.msg.type === 'bench_stop').map((s) => s.to)).toEqual(['m1']);
  });

  it('a runner error before running marks the cell as error; a running cell keeps its status', async () => {
    await joinAll('m1', 'm2');
    await engine.start(S, { mode: 'bench' });
    const c1 = assignsTo('m1')[0].cell_id;
    const c2 = assignsTo('m2')[0].cell_id;
    engine.handleProgress('m2', { type: 'bench_progress', cell_id: c2, arm_id: 'A', task_index: 1, phase: 'start' });
    engine.handleError('m1', { type: 'bench_error', cell_id: c1, code: 'taskset_mismatch', message: 'x' });
    engine.handleError('m2', { type: 'bench_error', cell_id: c2, code: 'model_down', message: 'x' });
    const st = await engine.state(S);
    expect(st.participants.find((p) => p.participant_id === 'm1')!.cell!.status).toBe('error');
    expect(st.participants.find((p) => p.participant_id === 'm2')!.cell!.status).toBe('running');
    expect(events.events.filter((e: any) => e.eventType === 'bench_error').length).toBe(2);
  });

  it('start refuses when nobody joined or nobody can run', async () => {
    await expect(engine.start(S, {})).rejects.toMatchObject({ code: 'no_runners' });
    await joinAll('m1');
    engine.handleDisconnect('m1');
    await expect(engine.start(S, {})).rejects.toMatchObject({ code: 'nothing_to_start' });
  });

  it('logs a bench_snapshot with the full state every 5 s while running', async () => {
    vi.useFakeTimers();
    try {
      await joinAll('m1');
      await engine.start(S, { mode: 'bench' });
      const snaps = () => events.events.filter((e: any) => e.eventType === 'bench_snapshot');
      await vi.advanceTimersByTimeAsync(1100);
      const first = snaps().length;
      expect(first).toBeGreaterThanOrEqual(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(snaps().length).toBeGreaterThanOrEqual(first + 2);
      const last = snaps().at(-1);
      expect(last.metadata.participants[0]).toMatchObject({ id: 'm1', status: 'sent', mode: 'bench' });
      expect(last.metadata.participants[0].arms.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rebuilds cells and the progress grid from the database after a restart', async () => {
    await joinAll('m1');
    await engine.assign(S, { participantId: 'm1', arms: ['A', 'B'], mode: 'bench' });
    await engine.start(S, { mode: 'bench' });
    const cellId = assignsTo('m1')[0].cell_id;
    const r = recMsg(cellId, rec(cellId, 'm1', 'A', 1));
    await engine.handleRecord('m1', r.msg, r.raw);
    engine.cleanup();

    const engine2 = new BenchEngine(hub, logger, store, events);
    const st = await engine2.state(S);
    expect(engine2.isRunning()).toBe(true); // the cell was live
    const p = st.participants[0];
    expect(p.cell).toMatchObject({ cell_id: cellId, status: 'running', arms: ['A', 'B'] });
    expect(p.grid.find((g) => g.arm_id === 'A')).toMatchObject({ phase: 'done', oracle_pass: true });
    engine2.cleanup();
  });
});

describe('storeBundle', () => {
  let dir: string;
  let store: MemoryBenchStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-art-'));
    store = new MemoryBenchStore();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const upload = (body: Buffer, extra: Record<string, unknown> = {}) =>
    storeBundle({ store, dataDir: dir, sessionId: 's1', cellId: 'c-m1-aa', participantId: 'm1', body: Readable.from([body]), ...extra });

  it('stores under <session>/<cellId>.tar.gz with its sha256', async () => {
    const gz = gzipSync(Buffer.from('tar bytes'));
    const { artifact, duplicate } = await upload(gz);
    expect(duplicate).toBe(false);
    expect(artifact).toMatchObject({ path: 's1/c-m1-aa.tar.gz', sha256: sha(gz), bytes: gz.length, version: 1 });
    expect(sha(fs.readFileSync(path.join(dir, artifact.path)))).toBe(artifact.sha256);
  });

  it('is idempotent for identical bytes and versions different ones without overwriting', async () => {
    const a = gzipSync(Buffer.from('first'));
    const b = gzipSync(Buffer.from('second, longer'));
    await upload(a);
    expect((await upload(a)).duplicate).toBe(true);
    const v2 = await upload(b);
    expect(v2.artifact.version).toBe(2);
    expect(sha(fs.readFileSync(path.join(dir, 's1/c-m1-aa.tar.gz')))).toBe(sha(b));
    expect(sha(fs.readFileSync(path.join(dir, 's1/c-m1-aa.v1.tar.gz')))).toBe(sha(a));
    expect((await store.getArtifact('c-m1-aa', 1))!.path).toBe('s1/c-m1-aa.v1.tar.gz');
    expect((await store.latestArtifact('c-m1-aa'))!.version).toBe(2);
  });

  it('rejects non-gzip, empty, oversized and sha-mismatched bodies and leaves no partial file', async () => {
    await expect(upload(Buffer.from('plain text'))).rejects.toMatchObject({ code: 'not_gzip', httpStatus: 400 });
    await expect(upload(Buffer.alloc(0))).rejects.toBeInstanceOf(BundleError);
    await expect(upload(gzipSync(Buffer.alloc(5000)), { maxBytes: 10 })).rejects.toMatchObject({ code: 'too_large', httpStatus: 413 });
    await expect(upload(gzipSync(Buffer.from('x')), { expectedSha256: 'deadbeef' })).rejects.toMatchObject({ code: 'sha256_mismatch' });
    expect(fs.readdirSync(path.join(dir, 's1'))).toEqual([]);
    expect(store.artifacts.length).toBe(0);
  });
});
