import { useMemo } from 'react';
import { useBenchState } from '../bench/useBenchState';
import {
  ARM_COLOR,
  ARM_LABEL,
  fmtTokens,
  type BenchArm,
  type BenchArmId,
  type BenchParticipant,
  type BenchState,
  type GridEntry,
} from '../bench/types';
import ToolCallChallenge from './ToolCallChallenge';

/**
 * Projector view of the bench: participant × arm × task index.
 * `/bench` picks the view from the live mode (qualification -> Tool Call Challenge,
 * otherwise the grid); `?view=grid|challenge` forces one, `/bench-challenge` is the
 * challenge alias. Pure display: it never writes anything.
 */

function forcedView(prop?: 'grid' | 'challenge'): 'grid' | 'challenge' | null {
  if (prop) return prop;
  const q = new URLSearchParams(window.location.search).get('view');
  return q === 'grid' || q === 'challenge' ? q : null;
}

const END_BADGE: Record<string, { ch: string; title: string }> = {
  deadline: { ch: 'D', title: 'deadline por tempo' },
  teto_turnos: { ch: 'T', title: 'teto de turnos' },
  stopped: { ch: 'S', title: 'parado pelo dono' },
  error: { ch: 'E', title: 'erro' },
};

function TaskCell({ e, k }: { e: GridEntry | undefined; k: number }) {
  const base = 'relative w-9 h-9 rounded-md flex items-center justify-center text-sm font-bold border transition-colors duration-300';
  if (!e) return <div className={`${base} border-white/10 bg-white/[0.03] text-white/20`} title={`tarefa ${k}`}>{k}</div>;
  const tok = (e.tokens_in ?? 0) + (e.tokens_out ?? 0);
  const title = `tarefa ${k} · ${e.phase}${e.turn != null ? ` · turno ${e.turn}` : ''} · ${tok} tokens`;
  const badge = e.terminated_by && e.terminated_by !== 'completed' ? END_BADGE[e.terminated_by] : null;
  let cls = '';
  let ch: string = String(k);
  if (e.phase === 'done') {
    if (e.oracle_pass) {
      cls = 'bg-[#39FF14]/25 border-[#39FF14] text-[#39FF14]';
      ch = '✓';
    } else {
      cls = 'bg-[#FF006E]/25 border-[#FF006E] text-[#FF006E]';
      ch = '✗';
    }
  } else if (e.phase === 'oracle') {
    cls = 'bg-[#00F5D4]/20 border-[#00F5D4] text-[#00F5D4] animate-pulse';
    ch = '⚖';
  } else {
    cls = 'bg-[#FFE66D]/15 border-[#FFE66D] text-[#FFE66D] animate-pulse';
    ch = e.turn != null ? `t${e.turn}` : '…';
  }
  return (
    <div className={`${base} ${cls}`} title={title}>
      {ch}
      {badge && (
        <span
          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-orange-500 text-black text-[10px] leading-4 text-center font-black"
          title={badge.title}
        >
          {badge.ch}
        </span>
      )}
    </div>
  );
}

function ArmRow({ arm, k, grid, maxTok }: { arm: BenchArmId; k: number; grid: GridEntry[]; maxTok: number }) {
  const mine = grid.filter((g) => g.arm_id === arm);
  const byTask = new Map(mine.map((g) => [g.task_index, g]));
  const total = mine.reduce((n, g) => n + (g.tokens_in ?? 0) + (g.tokens_out ?? 0), 0);
  const color = ARM_COLOR[arm];
  return (
    <div className="flex items-center gap-2">
      <span
        className="w-7 h-7 rounded flex items-center justify-center font-black text-black text-sm shrink-0"
        style={{ background: color }}
        title={ARM_LABEL[arm]}
      >
        {arm}
      </span>
      <div className="flex gap-1.5">
        {Array.from({ length: k }, (_, i) => (
          <TaskCell key={i} k={i + 1} e={byTask.get(i + 1)} />
        ))}
      </div>
      <div className="flex-1 min-w-[70px] ml-1" title="tokens (entrada + saída) deste braço">
        <div className="h-2 rounded bg-white/10 overflow-hidden">
          <div className="h-full rounded transition-all duration-500" style={{ width: `${maxTok && total ? Math.max(2, (total / maxTok) * 100) : 0}%`, background: color }} />
        </div>
        <div className="text-[11px] text-gray-400 font-mono text-right mt-0.5">{fmtTokens(total)} tok</div>
      </div>
    </div>
  );
}

function rowArms(p: BenchParticipant): { arms: BenchArm[]; k: number; live: boolean } {
  // The live/last bench cell wins; otherwise show what is planned next (all cells grey).
  if (p.cell && p.cell.mode === 'bench') return { arms: p.cell.arms, k: p.cell.k_max, live: true };
  const plan = p.plan ?? p.cell;
  return { arms: plan?.arms ?? [], k: plan?.k_max ?? 6, live: false };
}

const QUAL_LABEL: Record<string, string> = {
  qualified: 'passou',
  pending: 'em andamento',
  failed: 'não passou',
  incomplete: 'interrompido',
  none: '—',
};

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  sent: { label: 'enviado', cls: 'text-yellow-300 border-yellow-300/60' },
  running: { label: 'rodando', cls: 'text-[#00F5D4] border-[#00F5D4]/60 animate-pulse' },
  stopping: { label: 'parando…', cls: 'text-orange-300 border-orange-300/60 animate-pulse' },
  done: { label: 'concluído', cls: 'text-[#39FF14] border-[#39FF14]/60' },
  stopped: { label: 'truncado', cls: 'text-orange-300 border-orange-300/60' },
  error: { label: 'erro', cls: 'text-[#FF006E] border-[#FF006E]/60' },
};

function ParticipantCard({ p, maxTok }: { p: BenchParticipant; maxTok: number }) {
  const { arms, k, live } = rowArms(p);
  const grid = live ? p.grid : [];
  const chip = live && p.cell ? STATUS_CHIP[p.cell.status] : null;
  return (
    <div className={`rounded-xl border bg-white/[0.04] px-4 py-3 ${p.connected ? 'border-white/15' : 'border-white/5 opacity-60'}`}>
      <div className="flex items-baseline gap-2 mb-2">
        <span className={`w-2.5 h-2.5 rounded-full self-center ${p.connected ? 'bg-[#39FF14]' : 'bg-gray-600'}`} />
        <span className="text-xl font-bold truncate">{p.nickname}</span>
        <span className="text-xs text-gray-400 font-mono truncate flex-1">
          {p.join?.model.id ?? ''} {p.join ? `· ${p.join.hardware.chip}` : ''}
        </span>
        {chip && p.cell && <span className={`text-xs px-2 py-0.5 rounded-full border ${chip.cls}`}>{chip.label}</span>}
      </div>
      {arms.length === 0 ? (
        <div className="text-sm text-gray-500">sem braços atribuídos</div>
      ) : (
        <div className="space-y-1.5">
          {arms.map((a) => (
            <ArmRow key={a} arm={a} k={k} grid={grid} maxTok={maxTok} />
          ))}
        </div>
      )}
      {!live && (
        <div className="text-xs text-gray-500 mt-2">
          aguardando o início · ordem {arms.join(' → ') || '—'}
          {p.qualification.status !== 'none' && ` · Q0: ${QUAL_LABEL[p.qualification.status]}`}
        </div>
      )}
    </div>
  );
}

function Grid({ state }: { state: BenchState }) {
  const ps = useMemo(
    () => state.participants.filter((p) => p.connected || p.cell).sort((a, b) => a.nickname.localeCompare(b.nickname)),
    [state.participants]
  );
  const maxTok = useMemo(() => {
    let m = 0;
    for (const p of state.participants) {
      const perArm = new Map<string, number>();
      for (const g of p.grid) perArm.set(g.arm_id, (perArm.get(g.arm_id) ?? 0) + (g.tokens_in ?? 0) + (g.tokens_out ?? 0));
      for (const v of perArm.values()) m = Math.max(m, v);
    }
    return m;
  }, [state.participants]);
  const totalTasks = ps.reduce((n, p) => n + p.grid.filter((g) => g.arm_id !== 'Q' && g.phase === 'done').length, 0);
  const pass = ps.reduce((n, p) => n + p.grid.filter((g) => g.arm_id !== 'Q' && g.phase === 'done' && g.oracle_pass).length, 0);

  return (
    <div className="px-6 py-6">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 mb-5">
        <h1 className="text-3xl lg:text-4xl font-black" style={{ fontFamily: 'Orbitron, sans-serif', color: '#00F5D4' }}>
          🧪 BENCH
        </h1>
        <span className={`px-3 py-1 rounded-full text-sm font-bold ${state.running ? 'bg-green-600 animate-pulse' : 'bg-gray-600'}`}>
          {state.running ? '● AO VIVO' : '○ parado'}
        </span>
        <div className="flex gap-5 text-sm text-gray-300">
          <span><b className="text-xl text-white">{state.counts.connected}</b> runners</span>
          <span><b className="text-xl text-white">{state.counts.cells_active}</b> células rodando</span>
          <span><b className="text-xl text-white">{state.counts.records}</b> registros</span>
          <span><b className="text-xl text-[#39FF14]">{pass}</b>/<b className="text-xl text-white">{totalTasks}</b> tarefas no oráculo</span>
        </div>
        <div className="ml-auto flex gap-3 text-xs">
          {(['A', 'B', 'C'] as BenchArm[]).map((a) => (
            <span key={a} className="flex items-center gap-1.5">
              <span className="w-4 h-4 rounded" style={{ background: ARM_COLOR[a] }} />
              {a} · {ARM_LABEL[a]}
            </span>
          ))}
        </div>
      </div>

      {ps.length === 0 ? (
        <p className="text-center text-gray-500 text-2xl py-24">Aguardando os runners entrarem… 🔌</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">
          {ps.map((p) => (
            <ParticipantCard key={p.participant_id} p={p} maxTok={maxTok} />
          ))}
        </div>
      )}

      <p className="text-xs text-gray-600 mt-6 text-center">
        V0 · instrumentação, não é coleta medida (registros marcados <code>draft</code>) · ✓ oráculo passou · ✗ oráculo falhou · D deadline · T teto de turnos · S parado
      </p>
    </div>
  );
}

export default function BenchArena({ view }: { view?: 'grid' | 'challenge' }) {
  const { state, connected, lastUpdate } = useBenchState('bench');
  const stale = lastUpdate > 0 && !connected;
  const chosen = forcedView(view) ?? (state?.mode === 'qualification' ? 'challenge' : 'grid');

  return (
    <div className="min-h-screen text-white">
      {!connected && (
        <div className="bg-red-700/90 text-white text-center py-1.5 text-sm font-bold">
          {lastUpdate === 0 ? 'Conectando ao servidor…' : 'Conexão perdida — reconectando… (mostrando o último estado)'}
        </div>
      )}
      {!state ? (
        <p className="text-center text-gray-500 text-2xl py-32">Carregando…</p>
      ) : (
        <div className={stale ? 'opacity-70' : ''}>
          {chosen === 'challenge' ? <ToolCallChallenge state={state} /> : <Grid state={state} />}
        </div>
      )}
    </div>
  );
}
