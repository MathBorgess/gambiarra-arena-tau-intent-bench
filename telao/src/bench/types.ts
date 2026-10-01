// Shape of the `bench_state` message / GET /bench/state (server/src/core/bench.ts buildState()).

export type BenchArm = 'A' | 'B' | 'C';
export type BenchArmId = BenchArm | 'Q';
export type BenchMode = 'qualification' | 'bench';
export type CellStatus = 'planned' | 'sent' | 'running' | 'stopping' | 'done' | 'stopped' | 'error';
export type QualificationStatus = 'none' | 'pending' | 'qualified' | 'failed' | 'incomplete';

export interface BenchCellView {
  cell_id: string;
  status: CellStatus;
  mode: BenchMode;
  arms: BenchArm[];
  arms_on_wire: BenchArm[];
  arms_source: 'owner' | 'default_shuffled';
  seed: number;
  k_max: number;
  deadline_s: number;
  max_productive_turns: number;
  created_at: number;
  sent_at: number | null;
  done_at: number | null;
  records: number;
  summary: { records?: number; truncated?: boolean; manifest_sha256?: string } | null;
  last_error: { code: string; message: string; at: number } | null;
  artifact: { sha256: string; bytes: number; version: number } | null;
}

export interface GridEntry {
  arm_id: BenchArmId;
  task_index: number;
  phase: 'start' | 'turn' | 'oracle' | 'done';
  turn: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  oracle_pass: boolean | null;
  terminated_by: string | null;
  updated_at: number;
}

export interface Qualification {
  status: QualificationStatus;
  attempts: number;
  passed: boolean;
  tool_calls: number;
  duration_ms: number;
  results: boolean[];
}

export interface BenchParticipant {
  participant_id: string;
  nickname: string;
  connected: boolean;
  join: {
    runner_version: string;
    tau_intent_sha: string;
    task_set_sha: string;
    model: { id: string; digest?: string | null; runner_kind: string };
    hardware: { os: string; chip: string; ram_gb: number; accel: string };
  } | null;
  cell: BenchCellView | null; // the live cell, or the last one that ran
  plan: BenchCellView | null; // the next cell (what the owner is editing)
  grid: GridEntry[];
  qualification: Qualification;
}

export interface BenchState {
  type: 'bench_state';
  t: number;
  session_id: string | null;
  running: boolean;
  mode: BenchMode | 'mixed';
  counts: { runners: number; connected: number; cells_active: number; cells_finished: number; records: number };
  shas: { task_set: Array<{ sha: string; count: number }>; tau_intent: Array<{ sha: string; count: number }> };
  participants: BenchParticipant[];
}

export const ARM_LABEL: Record<BenchArmId, string> = {
  A: 'tau (sem mecanismo)',
  B: 'tau-intent',
  C: 'tau-intent + rescue',
  Q: 'qualificação',
};

export const ARM_COLOR: Record<BenchArmId, string> = {
  A: '#9B5DE5',
  B: '#00F5D4',
  C: '#FFE66D',
  Q: '#FF6B35',
};

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
