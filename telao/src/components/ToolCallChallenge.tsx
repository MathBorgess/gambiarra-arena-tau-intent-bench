import type { BenchParticipant, BenchState, Qualification } from '../bench/types';
import { fmtDuration, fmtTokens } from '../bench/types';

/**
 * "Tool Call Challenge" — the playful face of the qualification round (Q0).
 * It is also the pre-registered eligibility filter: a machine enters the bench
 * only if Q0 passes the oracle in at most 2 attempts. The status chips here are
 * derived by the server from the stored Q records, never stored themselves.
 */

type Rank = 0 | 1 | 2 | 3 | 4;

function rankOf(q: Qualification): Rank {
  if (q.status === 'qualified') return 0;
  if (q.status === 'pending') return 1;
  if (q.status === 'failed') return 2;
  if (q.status === 'incomplete') return 3;
  return 4;
}

const CHIP: Record<Qualification['status'], { label: string; cls: string }> = {
  qualified: { label: 'PASSOU NO Q0', cls: 'bg-[#39FF14]/20 text-[#39FF14] border-[#39FF14]' },
  pending: { label: 'TENTANDO…', cls: 'bg-[#FFE66D]/15 text-[#FFE66D] border-[#FFE66D] animate-pulse' },
  failed: { label: 'NÃO PASSOU', cls: 'bg-[#FF006E]/20 text-[#FF006E] border-[#FF006E]' },
  incomplete: { label: 'INTERROMPIDO', cls: 'bg-orange-500/20 text-orange-300 border-orange-400' },
  none: { label: 'NA LARGADA', cls: 'bg-white/5 text-gray-400 border-white/20' },
};

const MEDALS = ['🥇', '🥈', '🥉'];

function sorted(ps: BenchParticipant[]): BenchParticipant[] {
  return [...ps].sort((a, b) => {
    const ra = rankOf(a.qualification);
    const rb = rankOf(b.qualification);
    if (ra !== rb) return ra - rb;
    if (ra === 0) {
      // fewer attempts first, then faster
      return (
        a.qualification.attempts - b.qualification.attempts ||
        a.qualification.duration_ms - b.qualification.duration_ms
      );
    }
    return b.qualification.tool_calls - a.qualification.tool_calls || a.nickname.localeCompare(b.nickname);
  });
}

function AttemptPips({ q, live }: { q: Qualification; live: boolean }) {
  const pips = [0, 1].map((i) => {
    const r = q.results[i];
    if (r === true) return { ch: '✓', cls: 'bg-[#39FF14] text-black' };
    if (r === false) return { ch: '✗', cls: 'bg-[#FF006E] text-white' };
    const isNext = live && i === q.results.length;
    return { ch: '·', cls: `bg-white/10 text-gray-500 ${isNext ? 'animate-pulse ring-2 ring-[#FFE66D]' : ''}` };
  });
  return (
    <div className="flex gap-1.5" title="Até 2 tentativas na tarefa Q0">
      {pips.map((p, i) => (
        <span key={i} className={`w-8 h-8 rounded-md flex items-center justify-center font-bold text-lg ${p.cls}`}>
          {p.ch}
        </span>
      ))}
    </div>
  );
}

export default function ToolCallChallenge({ state }: { state: BenchState }) {
  const ps = sorted(state.participants.filter((p) => p.connected || p.qualification.status !== 'none'));
  const count = (s: Qualification['status'][]) => ps.filter((p) => s.includes(p.qualification.status)).length;
  const passed = count(['qualified']);
  const trying = count(['pending']);
  const failed = count(['failed', 'incomplete']);
  let medal = 0;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="text-center mb-8">
        <h1
          className="text-5xl lg:text-6xl font-black tracking-wide"
          style={{ fontFamily: 'Orbitron, sans-serif', color: '#FF6B35', textShadow: '0 0 24px rgba(255,107,53,.6)' }}
        >
          🛠️ TOOL CALL CHALLENGE
        </h1>
        <p className="text-xl text-gray-300 mt-3">
          O seu modelo local consegue <b className="text-[#00F5D4]">ler</b>, <b className="text-[#FFE66D]">editar</b> e{' '}
          <b className="text-[#39FF14]">rodar o teste</b>? Uma tarefa, até 2 tentativas.
        </p>
        <p className="text-sm text-gray-500 mt-1">Quem passa entra na rodada do bench.</p>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-8">
        {[
          { n: passed, label: 'passaram', color: '#39FF14' },
          { n: trying, label: 'tentando', color: '#FFE66D' },
          { n: failed, label: 'não passaram', color: '#FF006E' },
        ].map((c) => (
          <div key={c.label} className="rounded-xl bg-white/5 border border-white/10 py-4 text-center">
            <div className="text-5xl font-black" style={{ color: c.color, fontFamily: 'Orbitron, sans-serif' }}>
              {c.n}
            </div>
            <div className="text-gray-400 uppercase tracking-widest text-sm">{c.label}</div>
          </div>
        ))}
      </div>

      {ps.length === 0 && (
        <p className="text-center text-gray-500 text-xl py-16">Aguardando os runners entrarem… 🔌</p>
      )}

      <div className="space-y-3">
        {ps.map((p) => {
          const q = p.qualification;
          const chip = CHIP[q.status];
          const live = p.grid.find((g) => g.arm_id === 'Q' && g.phase !== 'done');
          const showMedal = q.status === 'qualified' && medal < 3 ? MEDALS[medal++] : null;
          return (
            <div
              key={p.participant_id}
              className={`flex items-center gap-4 rounded-xl px-5 py-3 border transition-all duration-500 ${
                q.status === 'qualified'
                  ? 'bg-[#39FF14]/5 border-[#39FF14]/40'
                  : q.status === 'failed'
                    ? 'bg-[#FF006E]/5 border-[#FF006E]/30 opacity-80'
                    : 'bg-white/5 border-white/10'
              }`}
            >
              <div className="w-12 text-3xl text-center">{showMedal ?? (q.status === 'failed' ? '💥' : q.status === 'pending' ? '🔧' : '⏳')}</div>
              <div className="flex-1 min-w-0">
                <div className="text-2xl font-bold truncate">{p.nickname}</div>
                <div className="text-sm text-gray-400 font-mono truncate">
                  {p.join?.model.id ?? '—'}
                  {p.join ? ` · ${p.join.hardware.chip}` : ''}
                </div>
              </div>

              <AttemptPips q={q} live={q.status === 'pending'} />

              <div className="w-28 text-center" title="Chamadas de ferramenta nas tentativas">
                <div className="text-3xl font-black text-[#00F5D4]" style={{ fontFamily: 'Orbitron, sans-serif' }}>
                  {q.tool_calls}
                </div>
                <div className="text-xs text-gray-500 uppercase">tool calls</div>
              </div>
              <div className="w-24 text-center">
                <div className="text-2xl font-bold text-[#FFE66D]">{q.duration_ms ? fmtDuration(q.duration_ms) : '—'}</div>
                <div className="text-xs text-gray-500 uppercase">tempo</div>
              </div>

              <div className="w-56 text-right">
                <span className={`inline-block px-3 py-1 rounded-full border text-sm font-bold ${chip.cls}`}>{chip.label}</span>
                {live && (
                  <div className="text-xs text-gray-400 mt-1 font-mono">
                    turno {live.turn ?? 0} · {fmtTokens((live.tokens_in ?? 0) + (live.tokens_out ?? 0))} tokens
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
