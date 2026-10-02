import { z } from 'zod';

// Server -> Client messages
export const ChallengeMessageSchema = z.object({
  type: z.literal('challenge'),
  session_id: z.string(),
  round: z.number(),
  prompt: z.string(),
  max_tokens: z.number(),
  temperature: z.number(),
  deadline_ms: z.number(),
  seed: z.number().optional(),
});

export const HeartbeatMessageSchema = z.object({
  type: z.literal('heartbeat'),
  ts: z.number(),
});

export const ServerMessageSchema = z.discriminatedUnion('type', [
  ChallengeMessageSchema,
  HeartbeatMessageSchema,
]);

// Client -> Server messages
export const RegisterMessageSchema = z.object({
  type: z.literal('register'),
  participant_id: z.string(),
  nickname: z.string(),
  pin: z.string(),
  runner: z.string(),
  model: z.string(),
});

export const TokenMessageSchema = z.object({
  type: z.literal('token'),
  round: z.number(),
  participant_id: z.string(),
  seq: z.number(),
  content: z.string(),
});

export const CompleteMessageSchema = z.object({
  type: z.literal('complete'),
  round: z.number(),
  participant_id: z.string(),
  tokens: z.number(),
  latency_ms_first_token: z.number().optional(),
  duration_ms: z.number(),
  model_info: z.object({
    name: z.string(),
    runner: z.string(),
    device: z.string().optional(),
  }).optional(),
});

export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  round: z.number(),
  participant_id: z.string(),
  code: z.string(),
  message: z.string(),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  RegisterMessageSchema,
  TokenMessageSchema,
  CompleteMessageSchema,
  ErrorMessageSchema,
]);

export const TelaoRegisterMessageSchema = z.object({
  type: z.literal('telao_register'),
  view: z.string().optional(),
});

// ============ WORLD MODE (agent arena) ============
export const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'STAY'] as const;

// Agent enters the 2D world (sent after `register`)
export const WorldJoinMessageSchema = z.object({
  type: z.literal('world_join'),
  participant_id: z.string(),
  emoji: z.string().optional(),
  color: z.string().optional(),
  strategy_summary: z.string().optional(),
});

// Agent's movement decision (reply to a `perception`)
// Participante salvou um template de prompt customizado no /agent — vai para
// o event log (pesquisa: cruzar prompt x desempenho nos world_snapshots).
export const AgentPromptMessageSchema = z.object({
  type: z.literal('agent_prompt'),
  participant_id: z.string(),
  template: z.string().min(1).max(4000),
  is_default: z.boolean().optional(),
});

export const AgentActionMessageSchema = z.object({
  type: z.literal('agent_action'),
  participant_id: z.string(),
  direction: z.enum(DIRECTIONS),
  say: z.string().optional(),
  pulse: z.number().optional(),
});

// ============ BENCH MODE (tau-intent runner × arms A/B/C) ============
// Contract: docs/BENCH-V0-CONTRACT.md §3 (protocol) and §4 (record,
// `gambiarra-coleta-2`, V0 draft). The server stores records AS RECEIVED and
// never recomputes outcomes — validation here only protects the dataset from
// malformed or self-contradictory records.
export const BENCH_ARMS = ['A', 'B', 'C'] as const;
export const BENCH_ARM_IDS = ['A', 'B', 'C', 'Q'] as const;
export const BENCH_MODES = ['qualification', 'bench'] as const;
export const BENCH_PHASES = ['start', 'turn', 'oracle', 'done'] as const;
export const BENCH_TERMINATIONS = ['completed', 'teto_turnos', 'deadline', 'stopped', 'error'] as const;
export const BENCH_RUNNER_KINDS = ['ollama', 'lmstudio', 'llamacpp', 'other'] as const;
export const BENCH_ACCELS = ['cuda', 'metal', 'cpu', 'other'] as const;

/** arm_id <-> harness_id bijection (A↔tau, B↔tau_intent, C↔tau_intent_llm_rescue, Q↔tau). */
export const BENCH_HARNESS_BY_ARM = {
  A: 'tau',
  B: 'tau_intent',
  C: 'tau_intent_llm_rescue',
  Q: 'tau',
} as const;

export const BenchArmIdSchema = z.enum(BENCH_ARM_IDS);
export const BenchArmSchema = z.enum(BENCH_ARMS);
export const BenchModeSchema = z.enum(BENCH_MODES);

const BenchModelSchema = z
  .object({
    id: z.string().min(1),
    digest: z.string().nullable().optional(),
    runner_kind: z.enum(BENCH_RUNNER_KINDS),
  })
  .passthrough();

/**
 * V0.2: with `--hardware-source declared` the runner cannot read the participant's hardware. Undeclared
 * values are null; the real declared values travel in `declared`, and `source` says which to trust
 * (`declared` -> prefer `declared`, `local` -> the top-level fields, V0 behaviour). Extra keys are kept.
 */
const BenchDeclaredHardwareSchema = z
  .object({
    chip: z.string().nullable().optional(),
    ram_gb: z.number().nonnegative().nullable().optional(),
    accel: z.enum(BENCH_ACCELS).nullable().optional(),
  })
  .passthrough();

const BenchHardwareSchema = z
  .object({
    os: z.string(),
    chip: z.string().nullable(),
    ram_gb: z.number().nonnegative().nullable(),
    accel: z.enum(BENCH_ACCELS).nullable(),
    source: z.enum(['declared', 'local']).optional(),
    declared: BenchDeclaredHardwareSchema.nullable().optional(),
  })
  .passthrough();

// Runner enters the bench (sent after `register`)
export const BenchJoinMessageSchema = z.object({
  type: z.literal('bench_join'),
  participant_id: z.string().min(1),
  runner_version: z.string(),
  tau_intent_sha: z.string(),
  task_set_sha: z.string(),
  model: BenchModelSchema,
  hardware: BenchHardwareSchema,
});

// Live progress for the telão (one per phase change / turn)
export const BenchProgressMessageSchema = z.object({
  type: z.literal('bench_progress'),
  cell_id: z.string().min(1),
  arm_id: BenchArmIdSchema,
  task_index: z.number().int().min(0),
  phase: z.enum(BENCH_PHASES),
  turn: z.number().int().min(0).optional(),
  tokens_in: z.number().nonnegative().optional(),
  tokens_out: z.number().nonnegative().optional(),
});

const nonNegInt = z.number().int().min(0);

/**
 * `gambiarra-coleta-2` record (contract §4). `.passthrough()` everywhere:
 * unknown extra fields are kept (the raw JSON is what gets stored), only the
 * fields the arena indexes or the §4 constraints talk about are checked.
 */
export const BenchRecordSchema = z
  .object({
    schema_version: z.literal('gambiarra-coleta-2'),
    draft: z.boolean().optional(),
    cell_id: z.string().min(1),
    participant_id: z.string().min(1),
    arm_id: BenchArmIdSchema,
    harness_id: z.enum(['tau', 'tau_intent', 'tau_intent_llm_rescue']),
    task_set_sha: z.string(),
    task_index: nonNegInt,
    task_id: z.string(),
    task_hash: z.string(),
    model: BenchModelSchema.passthrough(), // V0.2: model.details {family, parameter_size, quantization_level} rides along
    hardware: BenchHardwareSchema,
    // V0.2 (docs/BENCH-V0.2 §3). Never carries the raw host: only provider_host_sha256.
    backend: z
      .object({
        backend_id: z.string().nullable().optional(),
        transport: z.string().nullable().optional(),
        provider_host_sha256: z.string().nullable().optional(),
        ollama_version: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    // kind: backend_unreachable | provider_error | instrument_error | not_run (kept a plain string: a new kind must not drop a record)
    error: z.object({ kind: z.string() }).passthrough().nullable().optional(),
    arm_order: z.array(BenchArmSchema),
    seed: z.number().int(),
    mechanism: z
      .object({
        flags: z.record(z.string(), z.boolean()),
      })
      .passthrough(),
    oracle: z
      .object({
        pass: z.boolean(),
        passed: nonNegInt.optional(),
        failed: nonNegInt.optional(),
        errors: nonNegInt.optional(),
        duration_s: z.number().nonnegative().optional(),
        per_test: z.array(z.object({ nodeid: z.string(), outcome: z.string() }).passthrough()).optional(),
      })
      .passthrough(),
    evolution: z.object({}).passthrough(),
    tokens: z
      .object({
        // null when the endpoint returned no usage: never estimated (contract §4)
        in: z.number().nonnegative().nullable(),
        out: z.number().nonnegative().nullable(),
        rescue_in: z.number().nonnegative().nullable().optional(),
        rescue_out: z.number().nonnegative().nullable().optional(),
        source: z.enum(['provider_usage', 'missing']),
        cost_usd: z.literal(0),
      })
      .passthrough(),
    turns: z.array(
      z
        .object({
          turn_index: z.number().int().min(0),
          kind: z.enum(['productive', 'block', 'rescue']),
          tokens_in: z.number().nonnegative().nullable().optional(),
          tokens_out: z.number().nonnegative().nullable().optional(),
          tool_calls: z.number().int().min(0).optional(),
          latency_ms: z.number().nonnegative().nullable().optional(),
          ttft_ms: z.number().nonnegative().nullable().optional(),
        })
        .passthrough()
    ),
    mechanism_telemetry: z.object({}).passthrough(),
    terminated_by: z.enum(BENCH_TERMINATIONS),
    started_at: z.string(),
    ended_at: z.string(),
    artifacts: z.object({}).passthrough(),
  })
  .passthrough()
  .superRefine((rec, ctx) => {
    const expected = BENCH_HARNESS_BY_ARM[rec.arm_id];
    if (rec.harness_id !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['harness_id'],
        message: `arm_id ${rec.arm_id} requires harness_id ${expected} (got ${rec.harness_id})`,
      });
    }
    // Qualification attempts are task 0 and never mixed with arm A; real tasks are 1..K.
    if (rec.arm_id === 'Q' && rec.task_index !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['task_index'], message: 'arm Q requires task_index 0' });
    }
    if (rec.arm_id !== 'Q' && rec.task_index < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['task_index'], message: 'arms A/B/C require task_index >= 1' });
    }
    // Arm A (and the Q round, same `tau` harness): no mechanism at all.
    if (rec.harness_id === 'tau') {
      const on = Object.entries(rec.mechanism.flags).filter(([, v]) => v).map(([k]) => k);
      if (on.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['mechanism', 'flags'],
          message: `harness tau requires all flags false (on: ${on.join(',')})`,
        });
      }
      const blockTurns = rec.turns.filter((t) => t.kind === 'block').length;
      const telemetryBlock = (rec.mechanism_telemetry as { block_turns?: unknown }).block_turns;
      if (blockTurns > 0 || (typeof telemetryBlock === 'number' && telemetryBlock !== 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['turns'],
          message: 'harness tau requires block_turns == 0',
        });
      }
    }
  });

export const BenchRecordMessageSchema = z.object({
  type: z.literal('bench_record'),
  cell_id: z.string().min(1),
  record: BenchRecordSchema,
});

export const BenchCellDoneMessageSchema = z.object({
  type: z.literal('bench_cell_done'),
  cell_id: z.string().min(1),
  records: nonNegInt,
  manifest_sha256: z.string(),
  truncated: z.boolean(),
});

export const BenchErrorMessageSchema = z.object({
  type: z.literal('bench_error'),
  cell_id: z.string().min(1),
  code: z.string(),
  message: z.string(),
});

// Server -> runner: arms to run (ordered) for one cell
export const BenchAssignMessageSchema = z.object({
  type: z.literal('bench_assign'),
  cell_id: z.string().min(1),
  mode: BenchModeSchema,
  arms: z.array(BenchArmSchema).min(1),
  seed: z.number().int(),
  k_max: z.number().int().min(1),
  deadline_s: z.number().int().min(1),
  max_productive_turns: z.number().int().min(1),
});

// Server -> runner: finish the current (arm, task) as `stopped`, start nothing new, upload
export const BenchStopMessageSchema = z.object({
  type: z.literal('bench_stop'),
  cell_id: z.string().min(1),
});

// Extend client message union to accept telao registrations + world messages
export const ExtendedClientMessageSchema = z.discriminatedUnion('type', [
  RegisterMessageSchema,
  TokenMessageSchema,
  CompleteMessageSchema,
  ErrorMessageSchema,
  TelaoRegisterMessageSchema,
  WorldJoinMessageSchema,
  AgentActionMessageSchema,
  AgentPromptMessageSchema,
  BenchJoinMessageSchema,
  BenchProgressMessageSchema,
  BenchRecordMessageSchema,
  BenchCellDoneMessageSchema,
  BenchErrorMessageSchema,
]);

// Vote messages
export const VoteMessageSchema = z.object({
  type: z.literal('vote'),
  round: z.number(),
  voter_id: z.string(),
  participant_id: z.string(),
  score: z.number().min(0).max(5),
});

// Type exports
export type ChallengeMessage = z.infer<typeof ChallengeMessageSchema>;
export type HeartbeatMessage = z.infer<typeof HeartbeatMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export type RegisterMessage = z.infer<typeof RegisterMessageSchema>;
export type TokenMessage = z.infer<typeof TokenMessageSchema>;
export type CompleteMessage = z.infer<typeof CompleteMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ExtendedClientMessage = z.infer<typeof ExtendedClientMessageSchema>;

export type VoteMessage = z.infer<typeof VoteMessageSchema>;

// World mode types
export type Direction = (typeof DIRECTIONS)[number];
export type WorldJoinMessage = z.infer<typeof WorldJoinMessageSchema>;
export type AgentActionMessage = z.infer<typeof AgentActionMessageSchema>;
export type AgentPromptMessage = z.infer<typeof AgentPromptMessageSchema>;

// Bench mode types
export type BenchArm = z.infer<typeof BenchArmSchema>;
export type BenchArmId = z.infer<typeof BenchArmIdSchema>;
export type BenchMode = z.infer<typeof BenchModeSchema>;
export type BenchJoinMessage = z.infer<typeof BenchJoinMessageSchema>;
export type BenchProgressMessage = z.infer<typeof BenchProgressMessageSchema>;
export type BenchRecord = z.infer<typeof BenchRecordSchema>;
export type BenchRecordMessage = z.infer<typeof BenchRecordMessageSchema>;
export type BenchCellDoneMessage = z.infer<typeof BenchCellDoneMessageSchema>;
export type BenchErrorMessage = z.infer<typeof BenchErrorMessageSchema>;
export type BenchAssignMessage = z.infer<typeof BenchAssignMessageSchema>;
export type BenchStopMessage = z.infer<typeof BenchStopMessageSchema>;

// Server -> agent: a radar pulse
export interface PerceptionMessage {
  type: 'perception';
  pulse: number;
  objective: string; // the game goal, so the agent's prompt always includes it
  nearest_food: { direction: Direction; distance: string } | null;
  walls: string;
  position: string;
  score: number;
  bumped: boolean; // the previous move hit a wall (clamped) — agent may be stuck
  radar_text: string; // pre-rendered PT sentence to drop into the LLM prompt
}

// Server -> telao: full world snapshot
export interface WorldStateMessage {
  type: 'world_state';
  t: number;
  running: boolean;
  objective: string;
  config: { width: number; height: number };
  agents: Array<{
    id: string;
    nickname: string;
    emoji: string;
    color: string;
    x: number;
    y: number;
    heading: number;
    score: number;
    say: string | null;
    radarAt: number | null;
    bumpedAt: number | null; // epoch ms of last wall collision (telao shake/impact fx)
    isBot: boolean;
  }>;
  food: Array<{ id: string; x: number; y: number }>;
}
