import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from './Toast';
import QRCodeGenerator from './QRCodeGenerator';
import { useBenchState } from '../bench/useBenchState';
import { useBackends } from '../bench/useBackends';
import {
  ARM_COLOR,
  ARM_LABEL,
  fmtDuration,
  fmtHardware,
  type BenchBackendView,
  type BenchArm,
  type BenchMode,
  type BenchParticipant,
  type QualificationStatus,
} from '../bench/types';

interface Session {
  id: string;
  pin: string;
  status: string;
}

const API = '/api';
const ALL_ARMS: BenchArm[] = ['A', 'B', 'C'];

const QUAL_CHIP: Record<QualificationStatus, { label: string; cls: string }> = {
  qualified: { label: 'passou Q0', cls: 'bg-green-700 text-green-100' },
  pending: { label: 'Q0 em curso', cls: 'bg-yellow-700 text-yellow-100' },
  failed: { label: 'não passou Q0', cls: 'bg-red-700 text-red-100' },
  incomplete: { label: 'Q0 interrompido', cls: 'bg-orange-700 text-orange-100' },
  none: { label: 'sem Q0', cls: 'bg-gray-700 text-gray-300' },
};

const CELL_CHIP: Record<string, string> = {
  planned: 'bg-gray-700 text-gray-300',
  sent: 'bg-yellow-700 text-yellow-100',
  running: 'bg-cyan-700 text-cyan-100 animate-pulse',
  stopping: 'bg-orange-700 text-orange-100 animate-pulse',
  done: 'bg-green-700 text-green-100',
  stopped: 'bg-orange-800 text-orange-100',
  error: 'bg-red-700 text-red-100',
};

const RUNNER_CHIP: Record<BenchBackendView['runner']['status'], { label: string; cls: string }> = {
  waiting: { label: 'aguardando runner', cls: 'bg-gray-700 text-gray-300' },
  connected: { label: 'runner conectado', cls: 'bg-green-700 text-green-100' },
  running: { label: 'rodando célula', cls: 'bg-cyan-700 text-cyan-100 animate-pulse' },
};

const ago = (t: number | null) => {
  if (!t) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s atrás` : s < 3600 ? `${Math.round(s / 60)} min atrás` : `${Math.round(s / 3600)} h atrás`;
};

const short = (s: string | null | undefined, n = 8) => (s ? s.replace(/^sha256:/, '').slice(0, n) : '—');

/** Ordered arm picker: checkbox per arm + arrows to reorder the chosen ones. */
function ArmPicker({ arms, onChange, disabled }: { arms: BenchArm[]; onChange: (a: BenchArm[]) => void; disabled?: boolean }) {
  const toggle = (a: BenchArm) => onChange(arms.includes(a) ? arms.filter((x) => x !== a) : [...arms, a]);
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= arms.length) return;
    const next = [...arms];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        {ALL_ARMS.map((a) => (
          <label
            key={a}
            title={ARM_LABEL[a]}
            className={`flex items-center gap-1 px-2 py-1 rounded cursor-pointer select-none border ${
              arms.includes(a) ? 'border-transparent text-black font-bold' : 'border-gray-600 text-gray-400'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            style={arms.includes(a) ? { background: ARM_COLOR[a] } : undefined}
          >
            <input type="checkbox" className="accent-black" checked={arms.includes(a)} disabled={disabled} onChange={() => toggle(a)} />
            {a}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-1 text-xs text-gray-400 min-h-[22px]">
        ordem:
        {arms.length === 0 && <span className="text-red-400 ml-1">escolha ao menos um braço</span>}
        {arms.map((a, i) => (
          <span key={a} className="flex items-center gap-0.5">
            {i > 0 && <span>→</span>}
            <button disabled={disabled || i === 0} onClick={() => move(i, -1)} className="px-1 rounded bg-gray-700 disabled:opacity-30" title="mais cedo">
              ◀
            </button>
            <b style={{ color: ARM_COLOR[a] }}>{a}</b>
            <button disabled={disabled || i === arms.length - 1} onClick={() => move(i, 1)} className="px-1 rounded bg-gray-700 disabled:opacity-30" title="mais tarde">
              ▶
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

export function BenchControl() {
  const toast = useToast();
  const { state, connected, refresh } = useBenchState('bench-control');
  const { data: backendData, refresh: refreshBackends } = useBackends();
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<BenchMode>('qualification');
  const [modeInit, setModeInit] = useState(false);
  const [onlyQualified, setOnlyQualified] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, { arms: BenchArm[]; dirty: boolean }>>({});
  const [bulk, setBulk] = useState<BenchArm[]>(['A', 'B', 'C']);

  const host = window.location.hostname;
  const wsUrl = `ws://${host}:3000/ws`;
  // Participants need the LAN address, not "localhost": prefer the one the server reports.
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  const joinUrl = isLocalHost ? backendData?.join_urls[0] ?? `http://${host}:3000/bench-join` : `http://${host}:3000/bench-join`;
  const backends = backendData?.backends ?? [];
  const challengeUrl = '/bench';

  const loadSession = useCallback(async () => {
    try {
      const r = await fetch(`${API}/session`);
      setSession(r.ok ? await r.json() : null);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // First state from the server: adopt its mode (e.g. page reloaded mid-event).
  useEffect(() => {
    if (state && !modeInit) {
      setModeInit(true);
      if (state.mode === 'bench' || state.mode === 'qualification') setMode(state.mode);
    }
  }, [state, modeInit]);

  // Keep drafts in sync with the server plan, except rows the owner is editing.
  useEffect(() => {
    if (!state) return;
    setDrafts((prev) => {
      const next = { ...prev };
      for (const p of state.participants) {
        const cur = next[p.participant_id];
        if (!cur || !cur.dirty) next[p.participant_id] = { arms: p.plan?.arms ?? [], dirty: false };
      }
      return next;
    });
  }, [state]);

  const call = useCallback(
    async (path: string, body?: unknown): Promise<any | null> => {
      try {
        const r = await fetch(`${API}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          const detail = data?.details?.skipped
            ? ` (${data.details.skipped.map((s: any) => `${s.participant_id}: ${s.reason}`).join('; ')})`
            : '';
          toast.error(`${data?.message || data?.error || r.status}${detail}`);
          return null;
        }
        return data;
      } catch {
        toast.error('Erro de conexão com o servidor');
        return null;
      }
    },
    [toast]
  );

  const createSession = async () => {
    setBusy(true);
    const r = await fetch(`${API}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinLength: 6 }) });
    if (r.ok) {
      const d = await r.json();
      toast.success(`Sessão criada! PIN: ${d.pin}`);
      await loadSession();
      await refresh();
    } else toast.error('Erro ao criar sessão');
    setBusy(false);
  };

  const assignRow = async (p: BenchParticipant, arms: BenchArm[] | null) => {
    const res = await call('/bench/assign', { participant_id: p.participant_id, arms, mode });
    if (res) {
      setDrafts((d) => ({ ...d, [p.participant_id]: { arms: res.cell.arms, dirty: false } }));
      toast.success(`${p.nickname}: ${res.cell.arms.join(' → ')}${res.sent ? ' (enviado)' : ''}`);
      await refresh();
    }
  };

  const applyBulk = async () => {
    if (bulk.length === 0 || !state) return;
    setBusy(true);
    for (const p of state.participants) {
      await call('/bench/assign', { participant_id: p.participant_id, arms: bulk, mode });
      setDrafts((d) => ({ ...d, [p.participant_id]: { arms: bulk, dirty: false } }));
    }
    toast.success(`Braços ${bulk.join(' → ')} aplicados a todos`);
    await refresh();
    setBusy(false);
  };

  const start = async () => {
    if (!session) return toast.error('Crie uma sessão primeiro');
    if (!state) return;
    setBusy(true);
    // Flush edits first, so what the owner sees is what gets sent.
    for (const p of state.participants) {
      const d = drafts[p.participant_id];
      if (d?.dirty) {
        if (d.arms.length === 0) {
          toast.error(`${p.nickname}: escolha ao menos um braço`);
          setBusy(false);
          return;
        }
        await call('/bench/assign', { participant_id: p.participant_id, arms: d.arms, mode });
      }
    }
    const res = await call('/bench/start', { mode, only_qualified: mode === 'bench' ? onlyQualified : false });
    if (res) {
      toast.success(`${mode === 'qualification' ? 'Tool Call Challenge' : 'Bench'} iniciado em ${res.sent.length} runner(s)`);
      if (res.skipped.length) toast.info(`Pulados: ${res.skipped.map((s: any) => `${s.participant_id} (${s.reason})`).join(', ')}`);
      setDrafts({});
      await refresh();
    }
    setBusy(false);
  };

  const stop = async (participantId?: string) => {
    setBusy(true);
    const res = await call('/bench/stop', participantId ? { participant_id: participantId } : {});
    if (res) toast.success(participantId ? 'Parada solicitada' : 'Bench parando: aguardando os runners subirem os bundles');
    await refresh();
    setBusy(false);
  };

  const toggleBackend = async (b: BenchBackendView) => {
    const res = await call(`/bench/backends/${b.backend_id}`, { enabled: !b.enabled });
    if (res) toast.success(`${b.nickname}: ${res.enabled ? 'ligado' : 'desligado'}`);
    await refreshBackends();
  };

  const reprobeBackend = async (b: BenchBackendView) => {
    const res = await call(`/bench/backends/${b.backend_id}/probe`, {});
    if (res) toast[res.ready ? 'success' : 'info'](`${b.nickname}: ${res.ready ? 'alcançável' : res.problems.map((p: any) => p.code).join(', ') || 'com problema'}`);
    await refreshBackends();
  };

  const participants = state?.participants ?? [];
  const running = state?.running ?? false;
  const taskSetMismatch = (state?.shas.task_set.length ?? 0) > 1;
  const tauMismatch = (state?.shas.tau_intent.length ?? 0) > 1;
  const majority = useMemo(
    () => ({ task: state?.shas.task_set[0]?.sha, tau: state?.shas.tau_intent[0]?.sha }),
    [state]
  );
  const qualified = participants.filter((p) => p.qualification.status === 'qualified').length;

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6 lg:p-8">
      <ToastContainer toasts={toast.toasts} onRemove={toast.removeToast} />
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <h1 className="text-3xl lg:text-4xl font-bold">🧪 Controle do Bench</h1>
          <div className="flex gap-2">
            <a href="/bench" target="_blank" rel="noreferrer" className="bg-orange-600 hover:bg-orange-700 px-4 py-2 rounded-lg font-bold">
              📺 Telão /bench
            </a>
            <a href="/bench?view=challenge" target="_blank" rel="noreferrer" className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg font-bold">
              🛠️ Challenge
            </a>
            <a href="/bench?view=grid" target="_blank" rel="noreferrer" className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg font-bold">
              ▦ Grade
            </a>
          </div>
        </div>

        {!connected && <div className="bg-red-800 rounded-lg px-4 py-2 mb-4 text-sm font-bold">Sem WebSocket — usando polling. Estado pode atrasar alguns segundos.</div>}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          {/* Session */}
          <div className="bg-gray-800 rounded-xl p-6">
            <h2 className="text-xl font-bold mb-3">Sessão</h2>
            {session ? (
              <>
                <p className="text-sm text-gray-400">PIN</p>
                <p className="text-green-400 text-5xl font-mono font-bold tracking-widest mb-3">{session.pin}</p>
                <button onClick={createSession} disabled={busy} className="bg-yellow-600 hover:bg-yellow-700 px-3 py-1.5 rounded text-xs font-bold disabled:opacity-50 mb-4">
                  🔄 Nova sessão
                </button>
                <div className="border-t border-gray-700 pt-3">
                  <p className="text-sm text-gray-400 mb-1">O orquestrador sobe um runner por backend (na máquina do dono):</p>
                  <pre className="bg-black/40 rounded p-2 text-[11px] text-cyan-300 whitespace-pre-wrap break-all select-all">{`tau-intent bench --server ${wsUrl} --pin ${session.pin} \\
  --participant-id <backend_id> --backend-id <backend_id> \\
  --provider-url <provider_url> --model <modelo> \\
  --runner-kind ollama --hardware-source declared`}</pre>
                  <p className="text-[11px] text-gray-500 mt-2">
                    <code>python -m mathai_harness.orchestrator up</code> faz isso sozinho a partir da tabela de backends.
                  </p>
                </div>
              </>
            ) : (
              <div>
                <p className="mb-4 text-gray-400">Nenhuma sessão ativa.</p>
                <button onClick={createSession} disabled={busy} className="bg-green-600 hover:bg-green-700 px-6 py-3 rounded-lg font-bold disabled:opacity-50 w-full">
                  Criar sessão
                </button>
              </div>
            )}
          </div>

          {/* Round control */}
          <div className="lg:col-span-2 bg-gray-800 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold">Rodada</h2>
              <span className={`px-3 py-1 rounded-full text-sm font-bold ${running ? 'bg-green-600' : 'bg-gray-600'}`}>
                {running ? '● AO VIVO' : '○ parado'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              {(
                [
                  { m: 'qualification', title: '🛠️ Tool Call Challenge', sub: 'Qualificação: só a Q0, no braço A, até 2 tentativas. É o filtro de elegibilidade.' },
                  { m: 'bench', title: '🧪 Bench', sub: 'Roda os braços atribuídos, intercalados por tarefa (k=1: A,B,C → k=2 …).' },
                ] as const
              ).map((o) => (
                <button
                  key={o.m}
                  onClick={() => setMode(o.m)}
                  className={`text-left rounded-lg p-3 border-2 transition ${mode === o.m ? 'border-orange-500 bg-orange-500/10' : 'border-gray-700 hover:border-gray-500'}`}
                >
                  <div className="font-bold">{o.title}</div>
                  <div className="text-xs text-gray-400">{o.sub}</div>
                </button>
              ))}
            </div>

            {mode === 'bench' && (
              <label className="flex items-center gap-2 text-sm mb-4 cursor-pointer">
                <input type="checkbox" checked={onlyQualified} onChange={(e) => setOnlyQualified(e.target.checked)} className="w-4 h-4" />
                Só quem passou na qualificação <span className="text-gray-500">({qualified} de {participants.length})</span>
                <span className="text-gray-500 text-xs">— desmarque para ensaio (E0) ou para forçar uma máquina</span>
              </label>
            )}

            <div className="flex flex-wrap gap-3 items-center">
              <button onClick={start} disabled={busy || !session || participants.length === 0} className="flex-1 min-w-[180px] bg-green-600 hover:bg-green-700 px-6 py-3 rounded-lg font-bold text-lg disabled:opacity-50">
                ▶️ Iniciar {mode === 'qualification' ? 'qualificação' : 'bench'}
              </button>
              <button onClick={() => stop()} disabled={busy || !state || state.counts.cells_active === 0} className="bg-red-600 hover:bg-red-700 px-6 py-3 rounded-lg font-bold text-lg disabled:opacity-50">
                ⏹️ Parar tudo
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Parar não mata execução em curso: cada runner termina o (braço, tarefa) atual como <code>stopped</code>, sobe o bundle e responde com <code>bench_cell_done</code> (truncado).
              Iniciar de novo cria células novas; uma célula em curso nunca recebe um segundo <code>bench_assign</code>.
            </p>

            <div className="flex flex-wrap gap-x-6 gap-y-1 mt-4 text-sm text-gray-300">
              <span><b className="text-cyan-400 text-lg">{state?.counts.connected ?? 0}</b> runners conectados</span>
              <span><b className="text-yellow-300 text-lg">{state?.counts.cells_active ?? 0}</b> células ativas</span>
              <span><b className="text-green-400 text-lg">{state?.counts.cells_finished ?? 0}</b> finalizadas</span>
              <span><b className="text-white text-lg">{state?.counts.records ?? 0}</b> registros</span>
            </div>
          </div>
        </div>

        {(taskSetMismatch || tauMismatch) && (
          <div className="bg-yellow-900/60 border border-yellow-600 rounded-lg px-4 py-3 mb-6 text-sm">
            ⚠️ Runners com {taskSetMismatch ? 'conjuntos de tarefas (task_set_sha)' : ''}
            {taskSetMismatch && tauMismatch ? ' e ' : ''}
            {tauMismatch ? 'versões do tau-intent (tau_intent_sha)' : ''} diferentes. As linhas fora da maioria estão destacadas; os registros delas não são comparáveis.
          </div>
        )}

        {/* Backends (V0.2): participants' Ollamas, registered from /bench-join */}
        <div className="bg-gray-800 rounded-xl p-6 mb-6">
          <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
            <div>
              <h2 className="text-xl font-bold">Backends ({backends.length})</h2>
              <p className="text-sm text-gray-400 max-w-xl">
                O Ollama de cada participante, alcançado pela rede. O orquestrador sobe um runner por backend ligado e alcançável, com <code>participant_id = backend_id</code>.
              </p>
            </div>
            <div className="flex items-center gap-3 bg-gray-900/60 rounded-lg p-3">
              <QRCodeGenerator value={joinUrl} size={96} />
              <div>
                <p className="text-xs text-gray-400">Participantes abrem:</p>
                <p className="font-mono text-cyan-300 text-sm break-all select-all">{joinUrl}</p>
                {isLocalHost && !backendData?.join_urls.length && <p className="text-[11px] text-yellow-300 mt-1">Abra o painel pelo IP da rede para o QR sair certo.</p>}
              </div>
            </div>
          </div>

          {backends.length === 0 ? (
            <p className="text-gray-500 text-sm">Nenhum backend registrado ainda. Peça aos participantes para abrir o endereço ao lado.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-700">
                    <th className="py-2 pr-3">Participante</th>
                    <th className="pr-3">Modelo</th>
                    <th className="pr-3">Digest · Ollama</th>
                    <th className="pr-3">Alcançável</th>
                    <th className="pr-3">Runner</th>
                    <th className="pr-3">Ligado</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {backends.map((b) => {
                    const d = b.model.details;
                    const rc = RUNNER_CHIP[b.runner.status];
                    const hw = b.declared_hardware;
                    return (
                      <tr key={b.backend_id} className={`border-b border-gray-700/60 align-top ${b.enabled ? '' : 'opacity-50'}`}>
                        <td className="py-3 pr-3">
                          <div className="font-bold">{b.nickname}</div>
                          <div className="text-xs text-gray-500 font-mono">{b.backend_id}</div>
                          <div className="text-[11px] text-gray-600 font-mono" title="sha256 do host; o IP nunca aparece aqui">host {short(b.host_sha256, 8)} · :{b.port}</div>
                          {hw && (hw.chip || hw.ram_gb || hw.accel) && (
                            <div className="text-[11px] text-gray-500">declarado: {[hw.chip, hw.ram_gb ? `${hw.ram_gb} GB` : null, hw.accel].filter(Boolean).join(' · ')}</div>
                          )}
                        </td>
                        <td className="pr-3">
                          <div className="font-mono text-cyan-300">{b.model.id}</div>
                          <div className="text-xs text-gray-400">{d ? [d.family, d.parameter_size, d.quantization_level].filter(Boolean).join(' · ') : '—'}</div>
                        </td>
                        <td className="pr-3 text-xs font-mono">
                          <div className="text-gray-400" title={b.model.digest ?? 'sem digest'}>digest {short(b.model.digest, 12)}</div>
                          <div className="text-gray-500">ollama {b.ollama_version ?? '—'}</div>
                        </td>
                        <td className="pr-3">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${b.reachable && b.problems.length === 0 ? 'bg-green-700 text-green-100' : b.reachable ? 'bg-yellow-700 text-yellow-100' : 'bg-red-700 text-red-100'}`}>
                            {b.reachable && b.problems.length === 0 ? 'alcançável' : b.reachable ? 'sem o modelo' : 'inalcançável'}
                          </span>
                          {b.problems.map((p) => (
                            <div key={p.code} className="text-[11px] text-red-300 mt-1" title={p.fix}>{p.code}{p.detail ? ` · ${p.detail}` : ''}</div>
                          ))}
                          <div className="text-[11px] text-gray-500 mt-1">checado {ago(b.last_probe_at)}</div>
                        </td>
                        <td className="pr-3">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${rc.cls}`}>{rc.label}</span>
                          {b.runner.cell_id && (
                            <div className="text-[11px] font-mono text-gray-500 mt-1" title={b.runner.cell_id}>
                              {b.runner.cell_status} · {b.runner.records} reg.
                            </div>
                          )}
                        </td>
                        <td className="pr-3">
                          <label className="inline-flex items-center gap-2 cursor-pointer select-none" title="Desligado: o orquestrador não sobe runner para este backend">
                            <input type="checkbox" className="w-4 h-4" checked={b.enabled} onChange={() => toggleBackend(b)} />
                            <span className="text-xs text-gray-400">{b.enabled ? 'ligado' : 'desligado'}</span>
                          </label>
                        </td>
                        <td>
                          <button onClick={() => reprobeBackend(b)} className="bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded text-xs font-bold" title="Testar de novo o Ollama deste participante">
                            ↻ testar
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Runners */}
        <div className="bg-gray-800 rounded-xl p-6 mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h2 className="text-xl font-bold">Runners ({participants.length})</h2>
            <div className="flex flex-wrap items-center gap-3 bg-gray-900/60 rounded-lg px-3 py-2">
              <span className="text-sm text-gray-400">Definir para todos:</span>
              <ArmPicker arms={bulk} onChange={setBulk} />
              <button onClick={applyBulk} disabled={busy || bulk.length === 0 || participants.length === 0} className="bg-blue-600 hover:bg-blue-700 px-3 py-2 rounded font-bold text-sm disabled:opacity-50">
                Aplicar a todos
              </button>
            </div>
          </div>

          {participants.length === 0 ? (
            <p className="text-gray-500 text-sm">
              Nenhum runner entrou ainda. Rode o comando acima em cada máquina (o runner faz <code>register</code> + <code>bench_join</code>).
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-400 border-b border-gray-700">
                    <th className="py-2 pr-3">Runner</th>
                    <th className="pr-3">Modelo · hardware</th>
                    <th className="pr-3">Hashes</th>
                    <th className="pr-3">Q0</th>
                    <th className="pr-3">Braços da próxima célula</th>
                    <th className="pr-3">Célula</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {participants.map((p) => {
                    const d = drafts[p.participant_id] ?? { arms: p.plan?.arms ?? [], dirty: false };
                    const cell = p.cell;
                    const active = !!cell && ['sent', 'running', 'stopping'].includes(cell.status);
                    const expected = cell ? (cell.mode === 'bench' ? cell.arms.length * cell.k_max : 2) : 0;
                    const q = QUAL_CHIP[p.qualification.status];
                    const taskBad = !!majority.task && p.join?.task_set_sha !== majority.task;
                    const tauBad = !!majority.tau && p.join?.tau_intent_sha !== majority.tau;
                    return (
                      <tr key={p.participant_id} className="border-b border-gray-700/60 align-top">
                        <td className="py-3 pr-3">
                          <div className="flex items-center gap-2">
                            <span className={`w-2.5 h-2.5 rounded-full ${p.connected ? 'bg-green-400' : 'bg-gray-600'}`} title={p.connected ? 'conectado' : 'desconectado'} />
                            <span className="font-bold">{p.nickname}</span>
                          </div>
                          <div className="text-xs text-gray-500 font-mono">{p.participant_id}</div>
                        </td>
                        <td className="pr-3">
                          <div className="font-mono text-cyan-300">{p.join?.model.id ?? '—'}</div>
                          <div className="text-xs text-gray-400">
                            {p.join ? `${p.join.model.runner_kind} · ${fmtHardware(p.join.hardware)}` : ''}
                          </div>
                          <div className="text-xs text-gray-500 font-mono" title={p.join?.model.digest ?? 'sem digest'}>
                            digest {short(p.join?.model.digest)}
                          </div>
                        </td>
                        <td className="pr-3 text-xs font-mono">
                          <div className={taskBad ? 'text-yellow-300 font-bold' : 'text-gray-400'} title={p.join?.task_set_sha}>tasks {short(p.join?.task_set_sha)}</div>
                          <div className={tauBad ? 'text-yellow-300 font-bold' : 'text-gray-400'} title={p.join?.tau_intent_sha}>tau-i {short(p.join?.tau_intent_sha)}</div>
                          <div className="text-gray-600" title="versão do runner">{p.join?.runner_version}</div>
                        </td>
                        <td className="pr-3">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${q.cls}`}>{q.label}</span>
                          {p.qualification.attempts > 0 && (
                            <div className="text-xs text-gray-400 mt-1">
                              {p.qualification.results.map((r) => (r ? '✓' : '✗')).join(' ')} · 🔧{p.qualification.tool_calls}
                              {p.qualification.duration_ms ? ` · ${fmtDuration(p.qualification.duration_ms)}` : ''}
                            </div>
                          )}
                        </td>
                        <td className="pr-3">
                          <ArmPicker arms={d.arms} onChange={(arms) => setDrafts((x) => ({ ...x, [p.participant_id]: { arms, dirty: true } }))} />
                          <div className="flex gap-2 mt-1">
                            <button
                              onClick={() => assignRow(p, d.arms)}
                              disabled={busy || d.arms.length === 0 || (!d.dirty && p.plan?.mode === mode)}
                              className="bg-blue-600 hover:bg-blue-700 px-2 py-1 rounded text-xs font-bold disabled:opacity-40"
                            >
                              {d.dirty ? 'Aplicar' : 'Aplicado'}
                            </button>
                            <button onClick={() => assignRow(p, null)} disabled={busy} className="bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded text-xs disabled:opacity-40" title="Todos os braços, ordem sorteada pela semente">
                              Padrão (sorteio)
                            </button>
                          </div>
                          {p.plan && (
                            <div className="text-[11px] text-gray-500 mt-1 font-mono">
                              {p.plan.arms_source === 'owner' ? 'escolha do dono' : 'sorteado'} · seed {p.plan.seed} · {p.plan.mode}
                            </div>
                          )}
                        </td>
                        <td className="pr-3">
                          {cell ? (
                            <>
                              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${CELL_CHIP[cell.status]}`}>{cell.status}</span>
                              <div className="text-xs text-gray-400 mt-1">
                                {cell.mode === 'bench' ? cell.arms.join('→') : 'Q0'} · {cell.records}/{expected} reg.
                              </div>
                              <div className="h-1.5 rounded bg-gray-700 mt-1 w-28 overflow-hidden">
                                <div className="h-full bg-cyan-400" style={{ width: `${expected ? Math.min(100, (cell.records / expected) * 100) : 0}%` }} />
                              </div>
                              <div className="text-[11px] font-mono text-gray-500 mt-1" title={cell.cell_id}>{short(cell.cell_id, 18)}</div>
                              {cell.artifact && (
                                <a href={`${API}/bench/artifacts/${cell.cell_id}`} className="text-[11px] text-green-400 underline" title={cell.artifact.sha256}>
                                  bundle ✓ v{cell.artifact.version} · {(cell.artifact.bytes / 1024).toFixed(1)} KB · {short(cell.artifact.sha256, 8)}
                                </a>
                              )}
                              {cell.last_error && (
                                <div className="text-[11px] text-red-400" title={cell.last_error.message}>
                                  {cell.last_error.code.startsWith('backend') ? '⚠ backend perdido' : `erro: ${cell.last_error.code}`}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="text-gray-500 text-xs">ainda não rodou</span>
                          )}
                        </td>
                        <td>
                          {active && (
                            <button onClick={() => stop(p.participant_id)} disabled={busy || cell?.status === 'stopping'} className="bg-red-700 hover:bg-red-800 px-2 py-1 rounded text-xs font-bold disabled:opacity-40">
                              ⏹ parar
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Export */}
        <div className="bg-gray-800 rounded-xl p-6 mb-6">
          <h2 className="text-xl font-bold mb-3">Dados</h2>
          <div className="flex flex-wrap gap-3">
            <a href={`${API}/export-bench.jsonl`} className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-sm font-bold">⬇ export-bench.jsonl (registros, como recebidos)</a>
            <a href={`${API}/export-bench.jsonl?envelope=1`} className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-sm font-bold">⬇ com receivedAt/ids</a>
            <a href={`${API}/bench/artifacts`} target="_blank" rel="noreferrer" className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-sm font-bold">📦 bundles + sha256</a>
            <a href={`${API}/export-events.csv`} className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded-lg text-sm font-bold">⬇ event log (bench_*)</a>
          </div>
          <p className="text-xs text-gray-500 mt-3">
            V0 é instrumentação: registros chegam com <code>draft: true</code> e não são resultado do TG. Guarde <code>server/prisma/*.db</code> e <code>server/data/</code> (inclui <code>data/bench/</code>) ao final.
          </p>
        </div>

        <a href="/" className="text-blue-400 hover:text-blue-300">← Voltar para o telão</a>
      </div>
    </div>
  );
}
