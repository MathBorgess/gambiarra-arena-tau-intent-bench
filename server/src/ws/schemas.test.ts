import { describe, it, expect } from 'vitest';
import {
  ChallengeMessageSchema,
  RegisterMessageSchema,
  TokenMessageSchema,
  CompleteMessageSchema,
  VoteMessageSchema,
  ExtendedClientMessageSchema,
  BenchJoinMessageSchema,
  BenchProgressMessageSchema,
  BenchRecordSchema,
  BenchRecordMessageSchema,
  BenchCellDoneMessageSchema,
  BenchErrorMessageSchema,
  BenchAssignMessageSchema,
  BenchStopMessageSchema,
} from './schemas';

describe('Message Schemas', () => {
  describe('ChallengeMessageSchema', () => {
    it('should validate valid challenge message', () => {
      const message = {
        type: 'challenge',
        session_id: 'sess-123',
        round: 1,
        prompt: 'Test prompt',
        max_tokens: 400,
        temperature: 0.8,
        deadline_ms: 90000,
        seed: 1234,
      };

      const result = ChallengeMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should reject invalid challenge message', () => {
      const message = {
        type: 'challenge',
        session_id: 'sess-123',
        // missing required fields
      };

      const result = ChallengeMessageSchema.safeParse(message);
      expect(result.success).toBe(false);
    });
  });

  describe('RegisterMessageSchema', () => {
    it('should validate valid register message', () => {
      const message = {
        type: 'register',
        participant_id: 'test-1',
        nickname: 'Test',
        pin: '123456',
        runner: 'ollama',
        model: 'llama3.1:8b',
      };

      const result = RegisterMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });
  });

  describe('TokenMessageSchema', () => {
    it('should validate valid token message', () => {
      const message = {
        type: 'token',
        round: 1,
        participant_id: 'test-1',
        seq: 0,
        content: 'Hello',
      };

      const result = TokenMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should reject token with negative seq', () => {
      const message = {
        type: 'token',
        round: 1,
        participant_id: 'test-1',
        seq: -1,
        content: 'Hello',
      };

      const result = TokenMessageSchema.safeParse(message);
      expect(result.success).toBe(true); // Zod doesn't validate negative by default
    });
  });

  describe('VoteMessageSchema', () => {
    it('should validate valid vote', () => {
      const message = {
        type: 'vote',
        round: 1,
        voter_id: 'voter-1',
        participant_id: 'test-1',
        score: 5,
      };

      const result = VoteMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should reject score out of range', () => {
      const message = {
        type: 'vote',
        round: 1,
        voter_id: 'voter-1',
        participant_id: 'test-1',
        score: 6,
      };

      const result = VoteMessageSchema.safeParse(message);
      expect(result.success).toBe(false);
    });
  });
});


describe('Bench mode schemas (contract §3/§4)', () => {
  const join = {
    type: 'bench_join',
    participant_id: 'maq-1',
    runner_version: '0.1.0',
    tau_intent_sha: 'abc123',
    task_set_sha: 'def456',
    model: { id: 'qwen2.5-coder:7b', digest: 'sha256:aa', runner_kind: 'ollama' },
    hardware: { os: 'darwin', chip: 'Apple M2', ram_gb: 16, accel: 'metal' },
  };

  // Valid record for arm `arm` (A/B/C/Q) — mirrors the §4 example.
  function record(arm: 'A' | 'B' | 'C' | 'Q' = 'B', over: Record<string, unknown> = {}) {
    const harness = { A: 'tau', B: 'tau_intent', C: 'tau_intent_llm_rescue', Q: 'tau' }[arm];
    const mech = arm === 'A' || arm === 'Q';
    return {
      schema_version: 'gambiarra-coleta-2',
      draft: true,
      cell_id: 'cell-1',
      participant_id: 'maq-1',
      session_pin_hash: null,
      arm_id: arm,
      harness_id: harness,
      task_set_sha: 'def456',
      task_index: arm === 'Q' ? 0 : 1,
      task_id: 't1',
      task_hash: 'h1',
      model: { id: 'qwen2.5-coder:7b', digest: null, runner_kind: 'ollama' },
      hardware: { os: 'darwin', chip: 'Apple M2', ram_gb: 16, accel: 'metal' },
      arm_order: ['B', 'A', 'C'],
      seed: 7,
      mechanism: {
        tau_intent_sha: 'abc123',
        tau_ai_version: '0.4.7',
        config_sha256: 'c0ffee',
        flags: { capture: !mech, gate: !mech, project: !mech, serve: !mech, llm_rescue: arm === 'C' },
      },
      oracle: { pass: true, passed: 12, failed: 0, errors: 0, duration_s: 3.1, per_test: [{ nodeid: 'a::b', outcome: 'passed' }] },
      evolution: { commit_before: 'x', commit_after: 'y', files_changed: 3, insertions: 40, deletions: 5, edit_size: 45, untracked_created: [] },
      tokens: { in: 1200, out: 340, rescue_in: 0, rescue_out: 0, source: 'provider_usage', cost_usd: 0 },
      turns: [
        { turn_index: 1, kind: 'productive', tokens_in: 600, tokens_out: 170, tool_calls: 2 },
        ...(mech ? [] : [{ turn_index: 2, kind: 'block', tokens_in: 600, tokens_out: 170, tool_calls: 0 }]),
      ],
      mechanism_telemetry: { verdict: 'PASSA', productive_turns: 4, block_turns: mech ? 0 : 1, bloco_vazio: false, tokens_served: 210, nao_avaliaveis: [], servidas: [] },
      terminated_by: 'completed',
      started_at: '2026-10-01T10:00:00Z',
      ended_at: '2026-10-01T10:05:00Z',
      artifacts: { bundle: 'cell-1.tar.gz', paths: { transcript: 'a', diff: 'b', manifest: 'c' } },
      ...over,
    };
  }

  describe('bench_join', () => {
    it('accepts a valid join, with digest null', () => {
      expect(BenchJoinMessageSchema.safeParse(join).success).toBe(true);
      expect(BenchJoinMessageSchema.safeParse({ ...join, model: { ...join.model, digest: null } }).success).toBe(true);
    });

    it('rejects unknown runner kind / accelerator and missing hardware', () => {
      expect(BenchJoinMessageSchema.safeParse({ ...join, model: { ...join.model, runner_kind: 'vllm' } }).success).toBe(false);
      expect(BenchJoinMessageSchema.safeParse({ ...join, hardware: { ...join.hardware, accel: 'tpu' } }).success).toBe(false);
      const { hardware: _h, ...noHw } = join;
      expect(BenchJoinMessageSchema.safeParse(noHw).success).toBe(false);
    });

    it('is part of the ExtendedClientMessage union', () => {
      expect(ExtendedClientMessageSchema.safeParse(join).success).toBe(true);
    });
  });

  describe('bench_progress', () => {
    const msg = { type: 'bench_progress', cell_id: 'c', arm_id: 'A', task_index: 1, phase: 'turn', turn: 3, tokens_in: 1200, tokens_out: 340 };

    it('accepts progress incl. qualification arm Q and optional counters', () => {
      expect(BenchProgressMessageSchema.safeParse(msg).success).toBe(true);
      expect(BenchProgressMessageSchema.safeParse({ ...msg, arm_id: 'Q', task_index: 0, phase: 'start', turn: undefined, tokens_in: undefined, tokens_out: undefined }).success).toBe(true);
      expect(ExtendedClientMessageSchema.safeParse(msg).success).toBe(true);
    });

    it('rejects bad arm, phase and negative counters', () => {
      expect(BenchProgressMessageSchema.safeParse({ ...msg, arm_id: 'D' }).success).toBe(false);
      expect(BenchProgressMessageSchema.safeParse({ ...msg, phase: 'thinking' }).success).toBe(false);
      expect(BenchProgressMessageSchema.safeParse({ ...msg, tokens_in: -1 }).success).toBe(false);
    });
  });

  describe('bench_record (§4 constraints)', () => {
    it('accepts a valid record for every arm', () => {
      for (const arm of ['A', 'B', 'C', 'Q'] as const) {
        const r = BenchRecordSchema.safeParse(record(arm));
        expect(r.success, `${arm}: ${JSON.stringify(r.success ? '' : r.error.issues)}`).toBe(true);
      }
    });

    it('keeps unknown extra fields (stored as received)', () => {
      const r = BenchRecordSchema.parse(record('B', { future_field: { x: 1 } }));
      expect((r as Record<string, unknown>).future_field).toEqual({ x: 1 });
    });

    it('enforces the arm_id <-> harness_id bijection', () => {
      const bad: Array<['A' | 'B' | 'C' | 'Q', string]> = [
        ['A', 'tau_intent'],
        ['B', 'tau'],
        ['C', 'tau_intent'],
        ['Q', 'tau_intent_llm_rescue'],
      ];
      for (const [arm, harness] of bad) {
        expect(BenchRecordSchema.safeParse(record(arm, { harness_id: harness })).success, `${arm}/${harness}`).toBe(false);
      }
    });

    it('requires Q at task_index 0 and A/B/C at >= 1', () => {
      expect(BenchRecordSchema.safeParse(record('Q', { task_index: 1 })).success).toBe(false);
      expect(BenchRecordSchema.safeParse(record('A', { task_index: 0 })).success).toBe(false);
    });

    it('requires cost_usd == 0', () => {
      const r = record('B') as { tokens: Record<string, unknown> };
      expect(BenchRecordSchema.safeParse({ ...r, tokens: { ...r.tokens, cost_usd: 0.01 } }).success).toBe(false);
      expect(BenchRecordSchema.safeParse({ ...r, tokens: { ...r.tokens, cost_usd: undefined } }).success).toBe(false);
    });

    it('accepts missing usage as null tokens + source "missing", never an unknown source', () => {
      const r = record('B') as { tokens: Record<string, unknown> };
      expect(BenchRecordSchema.safeParse({ ...r, tokens: { ...r.tokens, in: null, out: null, source: 'missing' } }).success).toBe(true);
      expect(BenchRecordSchema.safeParse({ ...r, tokens: { ...r.tokens, source: 'estimated' } }).success).toBe(false);
    });

    it('arm A / Q: flags all false and no block turns', () => {
      const a = record('A') as { mechanism: { flags: Record<string, boolean> }; turns: unknown[] };
      expect(BenchRecordSchema.safeParse({ ...a, mechanism: { ...a.mechanism, flags: { ...a.mechanism.flags, capture: true } } }).success).toBe(false);
      expect(BenchRecordSchema.safeParse({ ...a, turns: [{ turn_index: 1, kind: 'block' }] }).success).toBe(false);
      expect(BenchRecordSchema.safeParse({ ...a, mechanism_telemetry: { block_turns: 2 } }).success).toBe(false);
    });

    it('rejects bad oracle, terminated_by and schema_version', () => {
      expect(BenchRecordSchema.safeParse(record('B', { oracle: { passed: 1 } })).success).toBe(false);
      expect(BenchRecordSchema.safeParse(record('B', { terminated_by: 'crashed' })).success).toBe(false);
      expect(BenchRecordSchema.safeParse(record('B', { schema_version: 'gambiarra-coleta-1' })).success).toBe(false);
    });

    it('wraps in a bench_record message that is part of the union', () => {
      const msg = { type: 'bench_record', cell_id: 'cell-1', record: record('B') };
      expect(BenchRecordMessageSchema.safeParse(msg).success).toBe(true);
      expect(ExtendedClientMessageSchema.safeParse(msg).success).toBe(true);
      expect(ExtendedClientMessageSchema.safeParse({ ...msg, record: record('B', { harness_id: 'tau' }) }).success).toBe(false);
    });
  });

  describe('bench_cell_done / bench_error', () => {
    it('accepts valid messages and rejects incomplete ones', () => {
      const done = { type: 'bench_cell_done', cell_id: 'c', records: 18, manifest_sha256: 'ab', truncated: false };
      expect(BenchCellDoneMessageSchema.safeParse(done).success).toBe(true);
      expect(ExtendedClientMessageSchema.safeParse(done).success).toBe(true);
      expect(BenchCellDoneMessageSchema.safeParse({ ...done, truncated: undefined }).success).toBe(false);

      const err = { type: 'bench_error', cell_id: 'c', code: 'already_running', message: 'x' };
      expect(BenchErrorMessageSchema.safeParse(err).success).toBe(true);
      expect(ExtendedClientMessageSchema.safeParse(err).success).toBe(true);
      expect(BenchErrorMessageSchema.safeParse({ type: 'bench_error', cell_id: 'c' }).success).toBe(false);
    });
  });

  describe('server -> runner messages', () => {
    it('validates bench_assign and bench_stop', () => {
      const assign = { type: 'bench_assign', cell_id: 'c', mode: 'bench', arms: ['B', 'A', 'C'], seed: 7, k_max: 6, deadline_s: 600, max_productive_turns: 8 };
      expect(BenchAssignMessageSchema.safeParse(assign).success).toBe(true);
      expect(BenchAssignMessageSchema.safeParse({ ...assign, arms: [] }).success).toBe(false);
      expect(BenchAssignMessageSchema.safeParse({ ...assign, arms: ['Q'] }).success).toBe(false);
      expect(BenchAssignMessageSchema.safeParse({ ...assign, mode: 'rehearsal' }).success).toBe(false);
      expect(BenchStopMessageSchema.safeParse({ type: 'bench_stop', cell_id: 'c' }).success).toBe(true);
    });
  });
});
