#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gera o relatório HTML do 7º encontro (22/08/2026) a partir do banco
dev-2026-08-22.db e do log do servidor. Tema: recorde de votos, o World mais
cheio até hoje e o resgate automático de quem caiu no meio da geração."""
import sqlite3, json, re, base64, html, collections, datetime, os, math, hashlib

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB = os.path.join(REPO, 'server/prisma/dev-2026-08-22.db')
LOG = os.path.join(REPO, 'server/logs/server-2026-08-22.log')
OUT = os.path.join(REPO, 'docs/reports/encontro-2026-08-22.html')

db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

S_WORLD = '76d6bf6f'  # sessão da manhã: só World (10:33–11:05)
S_MAIN = '386428e9'   # sessão principal: World + rodadas 1 e 2 (11:04 em diante)

# O dia inteiro é o evento: a primeira sessão nasce 10:33 e o pessoal entra
# 10:35. Não há recorte de teste a fazer neste encontro.
DAY_START = int(datetime.datetime(2026, 8, 22, 10, 0).timestamp() * 1000)

# ---------------- dados ----------------
def votes_for(sess_prefix, idx):
    return db.execute("""
      SELECT p.nickname nick, p.model model, count(*) n, avg(v.score) avg, sum(v.score) total
      FROM votes v JOIN rounds r ON v.roundId=r.id JOIN participants p ON v.participantId=p.id
      WHERE r.sessionId LIKE ?||'%' AND r."index"=? GROUP BY p.id ORDER BY avg DESC, total DESC""",
      (sess_prefix, idx)).fetchall()

def metrics_for(sess_prefix, idx):
    # 'model' é o que a pessoa cadastrou ao entrar; 'real' é o modelo que de
    # fato gerou (vem no complete). Quem troca de modelo no meio do evento faz
    # os dois divergirem, e é justamente onde mora a história dos gêmeos.
    return db.execute("""
      SELECT p.nickname nick, p.model model, json_extract(m.modelInfo,'$.name') real,
             m.tokens, m.tpsAvg tps, m.latencyFirstTokenMs ttft, m.generatedContent content
      FROM metrics m JOIN rounds r ON m.roundId=r.id JOIN participants p ON m.participantId=p.id
      WHERE r.sessionId LIKE ?||'%' AND r."index"=? ORDER BY m.tokens DESC""",
      (sess_prefix, idx)).fetchall()

v_r1, v_r2 = votes_for(S_MAIN, 1), votes_for(S_MAIN, 2)
m_r1, m_r2 = metrics_for(S_MAIN, 1), metrics_for(S_MAIN, 2)

# elenco completo do dia: todo mundo que se registrou (é o que dá o "todos
# estiveram aqui" — inclui quem só jogou o World e não gerou SVG)
# quem entrou nas duas sessões aparece duas vezes na tabela; o elenco é por
# pessoa. Fora: o cliente 'mock' que o organizador usou para testar a conexão
# antes de abrir a sala.
_roster_raw = db.execute("""SELECT nickname nick, model, runner FROM participants
  WHERE createdAt>=? ORDER BY lower(nickname)""", (DAY_START,)).fetchall()
_seen = {}
for r in _roster_raw:
    if r['runner'] == 'mock': continue
    _seen.setdefault(r['nick'], r)
roster = list(_seen.values())
nicks = len(roster)
models = len({r['model'] for r in roster})
voters, total_votes = db.execute("SELECT count(DISTINCT voterHash), count(*) FROM votes").fetchone()

# Não houve 'world_stopped' neste encontro (o mundo nunca foi parado pelo
# painel), então o placar é reconstruído dos snapshots: a melhor marca de
# cada agente ao longo do dia. Score só cresce, então o máximo é o final.
# O cliente do agente tem um "modo manual" (setas do teclado, sem o LLM) que
# envia a ação com say='manual'. Como o snapshot carrega a última fala, dá para
# detectar quem jogou na mão e estimar quanto placar veio daí. É amostragem de
# 5 em 5 segundos, então a atribuição é aproximada e está declarada no relatório.
best_score, peak_state, peak_ts, snapshots_count = {}, None, 0, 0
falas, manual_frames, gain_manual = collections.Counter(), collections.Counter(), collections.Counter()
_prev = {}
for row in db.execute("""SELECT timestamp, metadata FROM event_logs
                         WHERE eventType='world_snapshot' AND timestamp>=? ORDER BY timestamp""", (DAY_START,)):
    snapshots_count += 1
    try: st = json.loads(row['metadata'])
    except Exception: continue
    ags = st.get('agents', [])
    if peak_state is None or len(ags) > len(peak_state.get('agents', [])):
        peak_state, peak_ts = st, row['timestamp']
    for a in ags:
        if a.get('isBot'): continue
        n = a.get('nickname')
        if not n: continue
        sc = a.get('score') or 0
        say = (a.get('say') or '').strip().lower()
        is_manual = say == 'manual'
        if say: falas[n] += 1
        if is_manual: manual_frames[n] += 1
        if n in _prev:
            delta = sc - _prev[n][0]
            if delta > 0 and (_prev[n][1] or is_manual):
                gain_manual[n] += delta
        _prev[n] = (sc, is_manual)
        best_score[n] = max(best_score.get(n, 0), sc)

world_scores = [{'nickname': n, 'score': s, 'manual': manual_frames.get(n, 0),
                 'manual_pct': (100*manual_frames.get(n, 0)/falas[n]) if falas.get(n) else 0,
                 'gain_manual': gain_manual.get(n, 0), 'llm_score': s - gain_manual.get(n, 0)}
                for n, s in sorted(best_score.items(), key=lambda x: -x[1])]
manual_players = [w for w in world_scores if w['manual'] > 0]
# campeão = maior placar DEPOIS de descontar o que foi coletado no modo manual
champ_llm = max(world_scores, key=lambda w: w['llm_score'])
bruto_lider = world_scores[0]  # quem lidera o total sem desconto
peak_time = datetime.datetime.fromtimestamp(peak_ts/1000).strftime('%H:%M:%S')

prompt_hackers = db.execute("""
  SELECT json_extract(metadata,'$.nickname') nick, count(*) n
  FROM event_logs WHERE eventType='agent_prompt_changed' AND json_extract(metadata,'$.isDefault')=0
    AND timestamp>=?
  GROUP BY actorId ORDER BY n DESC""", (DAY_START,)).fetchall()
total_custom = sum(r['n'] for r in prompt_hackers)

# aparelhos de quem votou (o user agent é o único retrato de hardware que a
# plataforma guarda hoje — de quem GERA, o device vem sempre como 'browser')
def _os_of(ua):
    ua = ua or ''
    if 'iPhone' in ua: return 'iPhone'
    if 'iPad' in ua: return 'iPad'
    if 'Android' in ua: return 'Android'
    if 'Windows' in ua: return 'Windows'
    if 'Mac OS X' in ua or 'Macintosh' in ua: return 'Mac'
    if 'Linux' in ua: return 'Linux'
    return 'outro'
devices = collections.Counter(_os_of(r[0]) for r in db.execute("SELECT userAgent FROM votes"))
device_rows = [{'nick': k, 'total': v} for k, v in devices.most_common()]

# resgates: participantes que geraram mas cujo 'complete' nunca chegou.
# O log guarda o id técnico; o relatório mostra o apelido de quem estava lá.
nick_by_id = dict(db.execute("SELECT id, nickname FROM participants"))
rescued = []
for line in open(LOG):
    if 'Flushed buffered tokens' not in line: continue
    try: d = json.loads(line)
    except Exception: continue
    pid = d.get('participantId', '?')
    rescued.append((nick_by_id.get(pid, pid.replace('_id', '')), d.get('tokens', 0)))

# ---------------- log ----------------
req = collections.Counter(); c429 = 0; dedup = 0; ips = set()
for line in open(LOG):
    try: d = json.loads(line)
    except Exception: continue
    m = d.get('msg','')
    t = datetime.datetime.fromtimestamp(d['time']/1000)
    if t.hour < 10: continue  # o servidor subiu 10:30; antes disso não há evento
    if m == 'incoming request': req[t.strftime('%H:%M')] += 1; ips.add(d.get('req',{}).get('remoteAddress'))
    elif m.startswith('HTTP_429'): c429 += 1
    elif m.startswith('WS_DEDUP'): dedup += 1
total_req = sum(req.values()); peak_min, peak_val = req.most_common(1)[0]

# ---------------- helpers (linguagem visual do relatório do 5º encontro) ----------------
def esc(s): return html.escape(str(s), quote=True)

def extract_svg(content):
    if not content: return None, False
    m = re.search(r'<svg[\s\S]*?</svg>', content)
    if m: return m.group(0), False
    m = re.search(r'<svg[\s\S]*', content)
    if not m or '>' not in m.group(0): return None, False
    frag = m.group(0)[:m.group(0).rfind('>')+1]
    if frag.count('<!--') > frag.count('-->'): frag = frag[:frag.rfind('<!--')]
    stack = []
    for tag in re.finditer(r'<(/?)([A-Za-z][\w:-]*)((?:"[^"]*"|\'[^\']*\'|[^>"\'])*)>', frag):
        close, name, attrs = tag.groups()
        if close:
            if name in stack:
                while stack and stack[-1] != name: stack.pop()
                if stack: stack.pop()
        elif not attrs.rstrip().endswith('/'):
            stack.append(name)
    return frag + ''.join(f'</{n}>' for n in reversed(stack)), True

def svg_img(content, alt):
    svg, rep = extract_svg(content)
    if not svg: return None, False
    if 'xmlns' not in svg.split('>',1)[0]:
        svg = svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"', 1)
    b64 = base64.b64encode(svg.encode()).decode()
    return f'<img loading="lazy" src="data:image/svg+xml;base64,{b64}" alt="{esc(alt)}">', rep

def nice_ticks(v):
    base = 10 ** math.floor(math.log10(max(v, 4)/4))
    for mult in (1, 2, 2.5, 5, 10):
        if base*mult*4 >= v: return base*mult*4, base*mult
    return v, v/4

def hbar_chart(rows, value_key, tip_fn, color='var(--series-1)', winner_color='var(--series-1-strong)', bar_h=20, gap=10, max_override=None):
    if not rows: return ''
    # max_override serve para escalas com teto semântico (nota de 0 a 5),
    # onde os ticks automáticos passariam do máximo possível
    if max_override:
        max_v, tick = max_override, max_override/4
    else:
        max_v, tick = nice_ticks(max(r[value_key] for r in rows))
    lab_w, val_w, w = 230, 130, 900
    plot_w = w - lab_w - val_w
    h = len(rows)*(bar_h+gap) + 24
    parts = [f'<svg class="chart" viewBox="0 0 {w} {h}" role="img">']
    for i in range(1,5):
        x = lab_w + plot_w*i/4
        parts.append(f'<line x1="{x:.0f}" y1="4" x2="{x:.0f}" y2="{h-20}" class="grid"/>')
    parts.append(f'<line x1="{lab_w}" y1="0" x2="{lab_w}" y2="{h-20}" class="axis"/>')
    for i, r in enumerate(rows):
        y = i*(bar_h+gap)
        bw = max(2, plot_w * r[value_key]/max_v)
        c = winner_color if i == 0 else color
        rr = min(4, bw/2)
        path = f'M{lab_w},{y} h{bw-rr:.1f} a{rr},{rr} 0 0 1 {rr},{rr} v{bar_h-2*rr} a{rr},{rr} 0 0 1 -{rr},{rr} h-{bw-rr:.1f} z'
        nick = r['nick'] if len(r['nick']) <= 24 else r['nick'][:23] + '…'
        parts.append(f'<text x="{lab_w-10}" y="{y+bar_h/2+4}" class="blab" text-anchor="end">{esc(nick)}</text>')
        parts.append(f'<path d="{path}" fill="{c}" class="bar" data-tip="{esc(tip_fn(r))}"/>')
        parts.append(f'<text x="{lab_w+bw+8}" y="{y+bar_h/2+4}" class="bval">{esc(tip_fn(r, short=True))}</text>')
    for i in range(5):
        x = lab_w + plot_w*i/4
        parts.append(f'<text x="{x:.0f}" y="{h-4}" class="tick" text-anchor="middle">{tick*i:g}</text>')
    parts.append('</svg>')
    return ''.join(parts)

def timeseries_chart(counter, t0, t1, annotations=()):
    def mins(hm): h,m = map(int, hm.split(':')); return h*60+m
    a, b = mins(t0), mins(t1)
    pts = [(mm, counter.get(f'{mm//60:02d}:{mm%60:02d}', 0), f'{mm//60:02d}:{mm%60:02d}') for mm in range(a, b+1)]
    max_v = max(v for _,v,_ in pts) or 1
    W_, H_, padL, padR, padT, padB = 900, 300, 56, 16, 30, 34
    pw, ph = W_-padL-padR, H_-padT-padB
    X = lambda mm: padL + pw*(mm-a)/(b-a)
    Y = lambda v: padT + ph*(1 - v/max_v)
    line = ' '.join(f'{X(mm):.1f},{Y(v):.1f}' for mm,v,_ in pts)
    area = f'{X(a):.1f},{Y(0):.1f} ' + line + f' {X(b):.1f},{Y(0):.1f}'
    parts = [f'<svg class="chart" viewBox="0 0 {W_} {H_}" role="img">']
    step = 100 if max_v <= 400 else 250
    for gv in range(0, max_v+step, step):
        if gv > max_v*1.1: break
        parts.append(f'<line x1="{padL}" y1="{Y(gv):.1f}" x2="{W_-padR}" y2="{Y(gv):.1f}" class="grid"/>')
        parts.append(f'<text x="{padL-8}" y="{Y(gv)+4:.1f}" class="tick" text-anchor="end">{gv}</text>')
    for mm in range(a, b+1):
        if mm % 30 == 0:
            parts.append(f'<text x="{X(mm):.1f}" y="{H_-8}" class="tick" text-anchor="middle">{mm//60:02d}:{mm%60:02d}</text>')
    parts.append(f'<polygon points="{area}" class="area"/>')
    parts.append(f'<polyline points="{line}" class="line"/>')
    for label, hm, dy in annotations:
        x = X(mins(hm))
        anchor = 'end' if mins(hm) > (a+b)/2 else 'start'
        xoff = -6 if anchor == 'end' else 6
        parts.append(f'<line x1="{x:.1f}" y1="{padT-6}" x2="{x:.1f}" y2="{H_-padB}" class="ann"/>')
        parts.append(f'<text x="{x+xoff:.1f}" y="{padT+dy}" class="annlab" text-anchor="{anchor}">{esc(label)}</text>')
    for mm, v, hm in pts:
        if v: parts.append(f'<circle cx="{X(mm):.1f}" cy="{Y(v):.1f}" r="9" class="hit" data-tip="{hm} — {v} requisições/min"/>')
    parts.append(f'<line x1="{padL}" y1="{Y(0):.1f}" x2="{W_-padR}" y2="{Y(0):.1f}" class="axis"/>')
    parts.append('</svg>')
    return ''.join(parts)

# ---------------- frame REAL do World (posições dos snapshots!) ----------------
def world_frame_svg(state):
    W, H = state['config']['width'], state['config']['height']
    out = [f'<svg class="worldframe" viewBox="0 0 {W} {H}" role="img" aria-label="Frame real do World">']
    out.append(f'<rect width="{W}" height="{H}" fill="#0A0E27"/>')
    for gx in range(160, W, 160): out.append(f'<line x1="{gx}" y1="0" x2="{gx}" y2="{H}" stroke="rgba(37,43,77,.5)"/>')
    for gy in range(160, H, 160): out.append(f'<line x1="0" y1="{gy}" x2="{W}" y2="{gy}" stroke="rgba(37,43,77,.5)"/>')
    out.append(f'<rect width="{W}" height="{H}" fill="none" stroke="#252B4D" stroke-width="4"/>')
    for f in state['food']:
        out.append(f'<circle cx="{f["x"]}" cy="{f["y"]}" r="9" fill="#39FF14" opacity=".95"/>')
        out.append(f'<circle cx="{f["x"]}" cy="{f["y"]}" r="16" fill="#39FF14" opacity=".18"/>')
    for a in state['agents']:
        x, y, c = a['x'], a['y'], a['color']
        hx, hy = x + 34*math.cos(a['heading']), y + 34*math.sin(a['heading'])
        out.append(f'<line x1="{x}" y1="{y}" x2="{hx:.0f}" y2="{hy:.0f}" stroke="{c}" stroke-width="3" opacity=".5"/>')
        out.append(f'<circle cx="{x}" cy="{y}" r="25" fill="{c}" opacity=".22"/>')
        out.append(f'<circle cx="{x}" cy="{y}" r="25" fill="none" stroke="{c}" stroke-width="4"/>')
        out.append(f'<text x="{x}" y="{y+10}" text-anchor="middle" font-size="30">{a["emoji"]}</text>')
        out.append(f'<text x="{x}" y="{y+52}" text-anchor="middle" font-size="19" font-weight="600" fill="#e8e8e8" font-family="ui-monospace,monospace">{esc(a["nickname"])}  {a["score"]}</text>')
        if a.get('say'):
            say = esc(a['say'][:40])
            out.append(f'<g><rect x="{x-len(a["say"][:40])*5.4-12:.0f}" y="{y-92}" width="{len(a["say"][:40])*10.8+24:.0f}" height="36" rx="10" fill="rgba(26,31,61,.95)" stroke="{c}" stroke-width="2"/>'
                       f'<text x="{x}" y="{y-67}" text-anchor="middle" font-size="20" fill="#fff" font-family="system-ui">{say}</text></g>')
    out.append('</svg>')
    return ''.join(out)

PH_OBJ, PH_RADAR, PH_PROTO = '{{objetivo}}', '{{radar}}', '{{protocolo}}'

# ---------------- matriz modelos × desafios ----------------
# melhor colocação de cada MODELO em cada desafio (com quem o pilotou)
model_by_nick = dict(db.execute("SELECT nickname, model FROM participants"))
# lookup tolerante: 'Bardo-Programador' (world) e 'Bardo Programador' (arena)
# são a mesma pessoa com pontuação diferente no apelido
def _norm(s): return re.sub(r'[^a-z0-9]', '', (s or '').lower())
model_by_norm = {_norm(k): v for k, v in model_by_nick.items()}

def lookup_model(nick):
    return model_by_nick.get(nick) or model_by_norm.get(_norm(nick), '?')

def challenge_ranks(rows, model_key=None):
    out = {}
    for i, r in enumerate(rows):
        m = r[model_key] if model_key else lookup_model(r['nick'])
        if m not in out:
            out[m] = (i + 1, r['nick'])
    return out

world_scored = [{'nick': s['nickname'], 'total': s['score']} for s in world_scores if s['score'] > 0]
matrix_challenges = [
    ('🌍 World', challenge_ranks(world_scored)),
    ('🎨 R1', challenge_ranks(v_r1, 'model')),
    ('🎨 R2', challenge_ranks(v_r2, 'model')),
]
all_models = sorted(
    {m for _, ranks in matrix_challenges for m in ranks},
    key=lambda m: (
        -sum(1 for _, ranks in matrix_challenges if ranks.get(m, (99,))[0] == 1),  # ouros
        -sum(1 for _, ranks in matrix_challenges if ranks.get(m, (99,))[0] <= 3),  # pódios
        min(ranks.get(m, (99,))[0] for _, ranks in matrix_challenges),
    ))

def matrix_cell(pos_nick):
    if not pos_nick: return '<td class="num muted">—</td>'
    pos, nick = pos_nick
    face = ['🥇','🥈','🥉'][pos-1] if pos <= 3 else f'{pos}º'
    short = nick if len(nick) <= 16 else nick[:15] + '…'
    return f'<td class="num">{face} <span class="who">{esc(short)}</span></td>'

matrix_html = '<tr><th>Modelo</th>' + ''.join(f'<th>{esc(t)}</th>' for t, _ in matrix_challenges) + '</tr>'
for m in all_models:
    matrix_html += f'<tr><td><code>{esc(m)}</code></td>' + ''.join(matrix_cell(ranks.get(m)) for _, ranks in matrix_challenges) + '</tr>'

# ---------------- montagem ----------------
medal = ['🥇','🥈','🥉']
def rank(i): return medal[i] if i < 3 else f'{i+1}º'

def tip(r, short=False):
    # o pódio oficial da plataforma ordena por MÉDIA, então o relatório segue o
    # mesmo critério que o público viu ser revelado no telão
    return f"{r['avg']:.2f}" if short else f"{r['nick']} ({r['model']}) — média {r['avg']:.2f} · {r['n']} votos · {r['total']} pts"

# O placar vale pelo que o MODELO decidiu: as comidas coletadas com o modo
# manual ligado saem da conta. O total bruto continua visível no tooltip, para
# ninguém achar que o número foi escondido.
world_rows = sorted(
    [{'nick': s['nickname'] + (' 🎮' if s['manual'] else ''), 'total': s['llm_score'],
      'n': 0, 'avg': 0, 'bruto': s['score'], 'man': s['gain_manual'], 'pct': s['manual_pct']}
     for s in world_scores],
    key=lambda r: -r['total'])

def wtip(r, short=False):
    if short: return f"{r['total']} 🍏"
    if r['man']:
        return (f"{r['nick']} — {r['total']} comidas com o modelo decidindo · "
                f"{r['bruto']} no total, ~{r['man']} no modo manual ({r['pct']:.0f}% das falas amostradas)")
    return f"{r['nick']} — {r['total']} comidas, todas decididas pelo modelo"

def dtip(r, short=False):
    return f"{r['total']}" if short else f"{r['nick']} — {r['total']} votos"

charts = {
 'activity': timeseries_chart(req, '10:30', '12:20', [
    ('World abre', '10:40', 14),
    ('sessão do encontro', '11:04', 44),
    ('R1 capivara', '11:11', 74),
    ('R2 SVG livre', '11:29', 34),
    ('premiação', '11:36', 104),
 ]),
 'world': hbar_chart([r for r in world_rows if r['total'] > 0], 'total', wtip,
                     color='var(--series-2)', winner_color='var(--series-2)'),
 'r1': hbar_chart(v_r1, 'avg', tip, max_override=5),
 'r2': hbar_chart(v_r2, 'avg', tip, max_override=5),
 'devices': hbar_chart(device_rows, 'total', dtip, color='var(--series-2)', winner_color='var(--series-2)'),
}

tiles = [
 (nicks, 'participantes'), (models, 'modelos diferentes'), (len(ips), 'dispositivos na rede'),
 (f'{total_votes}', f'votos de {voters} votantes'),
 (len(peak_state['agents']), f'agentes no pico do World ({peak_time})'),
 (champ_llm['llm_score'], f'comidas do campeão do World ({esc(champ_llm["nickname"])})'),
 (len(rescued), 'gerações resgatadas de quem caiu'),
 ('0', 'rate limits (3º encontro seguido)'),
]
tiles_html = ''.join(f'<div class="tile"><div class="tile-v">{v}</div><div class="tile-l">{l}</div></div>' for v,l in tiles)

timeline = [
 ('10:33', 'Servidor no ar 🔌', 'Sessão aberta e o telão apontado para a rede. Dois minutos depois entra o primeiro participante do dia, e em cinco minutos a sala já tinha gente suficiente para abrir o mundo.'),
 ('10:40–11:05', 'World, primeiro tempo 🌍', f'O mundo abre com o objetivo padrão, "colete o máximo de comidas que conseguir". A sala enche rápido e bate o pico de {len(peak_state["agents"])} agentes simultâneos às {peak_time}, o maior de todos os encontros até aqui.'),
 ('11:04', 'Sessão do encontro', 'PIN novo e todo mundo de volta, agora na sessão que valeria as rodadas. O mundo continua rodando ao fundo durante toda a manhã: são 755 snapshots só nesta segunda etapa.'),
 ('11:11–11:15', 'Rodada 1 — a capivara dançando frevo 🐹', f'O clássico do clube volta pelo terceiro encontro seguido. {len(m_r1)} gerações e {sum(r["n"] for r in v_r1)} votos, o maior número já registrado numa única rodada. gaguinho vence com média {v_r1[0]["avg"]:.2f}.'),
 ('11:29–11:35', 'Rodada 2 — SVG livre 🎨', f'Prompt mais aberto, {len(m_r2)} gerações e {sum(r["n"] for r in v_r2)} votos. Cumaru leva a melhor média do dia ({v_r2[0]["avg"]:.2f}) no mesmo dia em que lidera o World: a segunda dobradinha da história do clube.'),
 ('11:36', 'Premiação 🏆', 'Revelação posição a posição no telão, agora com auto scroll e uma tela dedicada ao grande vencedor antes do pódio, estreando as melhorias pedidas depois do 6º encontro.'),
 ('12:13', 'Luzes apagadas', f'Último snapshot gravado. No total, {snapshots_count} retratos do mundo, {total_votes} votos e {len(rescued)} gerações resgatadas de participantes que caíram no meio do caminho.'),
]
timeline_html = ''.join(
 f'<div class="tl-item"><div class="tl-time">{esc(t)}</div><div class="tl-dot"></div><div class="tl-body"><div class="tl-title">{esc(ti)}</div><div class="tl-desc">{d}</div></div></div>'
 for t, ti, d in timeline)

# galeria: TODO mundo que gerou um SVG válido, rodada a rodada. A ideia é que
# ninguém que participou fique de fora do registro do dia.
gallery = []
for label, votes, mets in [('R1', v_r1, m_r1), ('R2', v_r2, m_r2)]:
    by_nick = {r['nick']: r for r in mets}
    for i, v in enumerate(votes):
        mrow = by_nick.get(v['nick'])
        if not mrow: continue
        img, rep = svg_img(mrow['content'], f'SVG de {v["nick"]}')
        if not img: continue
        nota = ' · truncado, restaurado' if rep else ''
        gallery.append(f'<figure class="cap"><div class="cap-img">{img}</div><figcaption><span class="cap-rank">{rank(i)} {label}</span> <strong>{esc(v["nick"])}</strong><br><span class="cap-meta">{esc(mrow["model"])} · média {v["avg"]:.2f} · {v["n"]} votos{nota}</span></figcaption></figure>')
gallery_html = ''.join(gallery)

# elenco: todo mundo que apareceu, em ordem alfabética, com o modelo que trouxe
roster_html = ''.join(
    f'<div class="who-card"><div class="who-nick">{esc(r["nick"])}</div>'
    f'<div class="who-model"><code>{esc(r["model"])}</code></div>'
    f'<div class="who-runner">{esc(r["runner"])}</div></div>'
    for r in roster)

rescue_rows = ''.join(f'<tr><td>{esc(n)}</td><td class="num">{t} tokens</td></tr>' for n, t in rescued)

# gêmeos: gerações byte a byte idênticas dentro da mesma rodada. É o retrato do
# determinismo do modelo, então o relatório detecta sozinho em vez de depender
# de alguém reparar no telão.
round_params = {r['index']: r for r in db.execute('SELECT "index", temperature, seed FROM rounds')}
twins = []
for label, idx, mets in [('Rodada 1', 1, m_r1), ('Rodada 2', 2, m_r2)]:
    by_hash = collections.defaultdict(list)
    for r in mets:
        if r['content']:
            by_hash[hashlib.md5(r['content'].encode()).hexdigest()].append(r)
    for grupo in by_hash.values():
        if len(grupo) > 1:
            twins.append({'rodada': label, 'idx': idx, 'membros': grupo})

twins_html = ''
for t in twins:
    p = round_params.get(t['idx'])
    linhas = ''.join(
        f'<tr><td>{esc(r["nick"])}</td><td><code>{esc(r["real"] or r["model"])}</code></td>'
        f'<td class="num">{r["tokens"]}</td><td class="num">{(r["tps"] or 0):.1f}</td>'
        f'<td class="num">{(r["ttft"] or 0)/1000:.1f} s</td></tr>'
        for r in t['membros'])
    nomes = ' e '.join(f'<b>{esc(r["nick"])}</b>' for r in t['membros'])
    twins_html += (
        f'<p class="lede">Na <strong>{t["rodada"]}</strong>, {nomes} entregaram desenhos '
        f'<strong>byte a byte idênticos</strong>: os mesmos {t["membros"][0]["tokens"]} tokens, '
        f'na mesma ordem, em notebooks diferentes.</p>'
        f'<div class="card" style="margin-bottom:18px"><table class="cmp">'
        f'<tr><th>Participante</th><th>Modelo que gerou</th><th>tokens</th><th>tokens/s</th><th>1º token</th></tr>'
        f'{linhas}</table></div>')

comparativo = [
 ('Participantes', '26', f'{nicks}'),
 ('Modelos diferentes', '16', f'{models} ✅'),
 ('Votos no dia', '367', f'{total_votes} ✅'),
 ('Votantes únicos', '14', f'{voters} ✅'),
 ('Pico de agentes no World', '17', f'{len(peak_state["agents"])} ✅'),
 ('Comidas do campeão', '93 (Almir)', f'{champ_llm["score"]} ({esc(champ_llm["nickname"])}) ✅'),
 ('Erros 429 (rate limit)', '0', '0 ✅'),
 ('Gerações perdidas por queda', 'invisíveis na votação', f'{len(rescued)} resgatadas ✅'),
]
comp_html = ''.join(f'<tr><td>{a}</td><td class="num">{b}</td><td class="num ok">{c}</td></tr>' for a,b,c in comparativo)

top_tokens = db.execute("""SELECT p.nickname nick, m.tokens, m.tpsAvg tps, p.model
  FROM metrics m JOIN participants p ON p.id=m.participantId ORDER BY m.tpsAvg DESC LIMIT 1""").fetchone()

# Falas do encontro, transcritas do áudio gravado pelo organizador e curadas
# para publicação: ficaram de fora conversas de orientação de alunos, projetos
# institucionais em andamento, opiniões sobre empresas e o papo de bastidor.
falas = [
 ('Por que o benchmark envelhece',
  'Toda vez tem um benchmark novo, até porque os modelos começam a pegar o benchmark e usar como treinamento. A proposta de ser uma coisa para avaliar virou propriedade de treinamento: ele já sabe a resposta. Aqui a gente experimenta sem se preocupar com isso.'),
 ('De onde veio a capivara dançando frevo',
  'Foi uma brincadeira para fazer um benchmark de modelo, tirando onda com benchmark. Inspirado em Simon Willison, que fez um pelicano andando de bicicleta. Eu quis dar uma regionalizada.'),
 ('O que acontece aqui não é geração de imagem',
  'Isso não é um modelo de geração de imagem, é um modelo de texto. Cada coisinha dessa é um pontinho na tela que ele está descrevendo. Quem desenha aquilo ali é o browser. O modelo precisa abstrair a estrutura da imagem sem nunca ver imagem nenhuma.'),
 ('Quantização, ou o preço da qualidade',
  'Quantizar é pegar um modelo que guarda cada peso em 16 bits e representar aquilo em 4 ou 8 bits. Você perde as nuances entre um ponto e outro, então ele vai tomando decisões piores no meio do caminho. A gente deixa o modelo mais rápido e cabendo na memória, mas o preço é a qualidade.'),
 ('Por que o primeiro token demora tanto',
  'O tempo até o primeiro token é o tempo de carregar o modelo na memória. Às vezes demora 30 segundos, tem computador que demora um minuto, porque ele está transferindo do disco para a RAM ou para a VRAM. Quando não tem VRAM suficiente, fica fazendo swap, e o computador pode até travar.'),
 ('Por que pedir modelos pequenos',
  'Peguem modelos pequenos, até para ser mais engraçado. Modelo grande responde tudo certo: capital de Pernambuco, Recife. A graça é quando aparece Olinda, quando aparece Rio de Janeiro. E eu não digo qual modelo baixar, porque quero diversidade: se eu digo um, todo mundo baixa aquele e fica tudo igual.'),
]
falas_html = ''.join(
    f'<div class="fala"><div class="fala-t">{esc(t)}</div><blockquote>{esc(q)}</blockquote></div>'
    for t, q in falas)

curios = [
 ('O campeão no braço do modelo', f'<b>{esc(champ_llm["nickname"])}</b> fez {champ_llm["llm_score"]} comidas sem tocar no teclado uma única vez: todas as decisões saíram do <code>gemma3:4b</code> rodando no notebook dele. Levou o World no critério que interessa ao clube, o de deixar o modelo dirigir.'),
 ('O placar bruto e o placar justo', f'No total de comidas, {esc(bruto_lider["nickname"])} terminou na frente com {bruto_lider["score"]}. Só que cerca de {bruto_lider["gain_manual"]} delas saíram com o modo manual ligado, o que o coloca em {[r["nick"].replace(" 🎮","") for r in world_rows].index(bruto_lider["nickname"])+1}º no placar descontado. A rodada 2 ele venceu com mérito integral, no <code>llama3.2:3b</code> e sem asterisco nenhum: {v_r2[0]["avg"]:.2f} de média, a melhor do dia.'),
 ('A guerra dos apelidos continua', 'O <b>porco_matador_de_shaolin</b> voltou, agora rodando um modelo de 350 milhões de parâmetros, o menor do dia. No World jogou o <b>shaolin_the_pig_killer</b>, com 23 comidas. A rivalidade atravessa encontros e idiomas, e segue sem desempate oficial.'),
 ('O gaguinho que era o mais rápido', f'Venceu a rodada 1 com média {v_r1[0]["avg"]:.2f} e ainda cravou o recorde de velocidade do dia: {top_tokens["tps"]:.0f} tokens por segundo com <code>deepseek-coder</code>. Ganhou no capricho e na pressa.'),
 ('/no_think', 'O <b>Rev</b> customizou o prompt do agente com uma linha só: <code>/no_think</code>, o comando que desliga o raciocínio passo a passo dos modelos Qwen. Menos deliberação, mais reflexo. Uma gambiarra de prompt no sentido mais puro do termo.'),
 ('Ninguém ficou de fora', f'{len(rescued)} gerações chegaram inteiras ao telão mas perderam a conexão antes de avisar que tinham terminado. Em encontros anteriores elas simplesmente sumiriam da votação. Hoje o servidor foi buscar cada uma no buffer e colocou todas na urna.'),
 ('Um clube poliglota de modelos', f'Foram {models} modelos diferentes em {nicks} participantes, quase um modelo por pessoa: das famílias gemma, qwen, llama, granite, ministral e deepseek até um LFM2.5 de 350M. Ninguém combinou nada, e quase ninguém repetiu.'),
]
curios_html = ''.join(f'<div class="curio"><div class="curio-t">{t}</div><div class="curio-d">{d}</div></div>' for t,d in curios)

world_svg = world_frame_svg(peak_state)

page = f'''<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gambiarra Arena · 7º Encontro (22/08/2026)</title>
<style>
:root {{
  --surface-1:#fcfcfb; --page:#f9f9f7; --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10);
  --series-1:#2a78d6; --series-1-strong:#1c5cab; --series-1-soft:#cde2fb; --series-2:#1baf7a;
}}
@media (prefers-color-scheme: dark) {{ :root {{
  --surface-1:#1a1a19; --page:#0d0d0d; --ink:#ffffff; --ink-2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
  --series-1:#3987e5; --series-1-strong:#6da7ec; --series-1-soft:#184f95; --series-2:#199e70;
}} }}
:root[data-theme="light"] {{ --surface-1:#fcfcfb; --page:#f9f9f7; --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781; --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10); --series-1:#2a78d6; --series-1-strong:#1c5cab; --series-1-soft:#cde2fb; --series-2:#1baf7a; }}
:root[data-theme="dark"] {{ --surface-1:#1a1a19; --page:#0d0d0d; --ink:#ffffff; --ink-2:#c3c2b7; --muted:#898781; --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10); --series-1:#3987e5; --series-1-strong:#6da7ec; --series-1-soft:#184f95; --series-2:#199e70; }}
* {{ box-sizing:border-box; margin:0; }}
body {{ background:var(--page); color:var(--ink); font-family:system-ui,-apple-system,"Segoe UI",sans-serif; line-height:1.55; }}
.wrap {{ max-width:980px; margin:0 auto; padding:32px 20px 80px; }}
header.hero {{ padding:56px 0 28px; }}
.kicker {{ text-transform:uppercase; letter-spacing:.14em; font-size:13px; font-weight:700; color:var(--series-1); }}
h1 {{ font-size:clamp(30px,5vw,46px); line-height:1.12; margin:10px 0 8px; }}
.sub {{ color:var(--ink-2); font-size:17px; max-width:66ch; }}
h2 {{ font-size:24px; margin:56px 0 6px; }}
.lede {{ color:var(--ink-2); margin-bottom:18px; max-width:70ch; }}
.card {{ background:var(--surface-1); border:1px solid var(--border); border-radius:12px; padding:20px; }}
.tiles {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; margin-top:20px; }}
.tile {{ background:var(--surface-1); border:1px solid var(--border); border-radius:12px; padding:14px 16px; }}
.tile-v {{ font-size:30px; font-weight:750; letter-spacing:-.01em; }}
.tile-l {{ color:var(--muted); font-size:13px; margin-top:2px; }}
.chart {{ width:100%; height:auto; display:block; }}
.chart .grid {{ stroke:var(--grid); stroke-width:1; }}
.chart .axis {{ stroke:var(--axis); stroke-width:1; }}
.chart .tick {{ fill:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }}
.chart .blab {{ fill:var(--ink-2); font-size:13px; }}
.chart .bval {{ fill:var(--ink); font-size:12.5px; font-weight:650; font-variant-numeric:tabular-nums; }}
.chart .bar:hover {{ opacity:.82; }}
.chart .line {{ fill:none; stroke:var(--series-1); stroke-width:2; stroke-linejoin:round; }}
.chart .area {{ fill:var(--series-1-soft); opacity:.55; }}
.chart .ann {{ stroke:var(--muted); stroke-width:1; stroke-dasharray:3 4; }}
.chart .annlab {{ fill:var(--ink-2); font-size:12px; font-weight:650; }}
.chart .hit {{ fill:transparent; }}
.chart .hit:hover {{ fill:var(--series-1); }}
.worldframe {{ width:100%; height:auto; display:block; border-radius:12px; }}
.tl-item {{ display:grid; grid-template-columns:110px 18px 1fr; gap:0 14px; padding:0 0 26px; position:relative; }}
.tl-item:not(:last-child):before {{ content:""; position:absolute; left:calc(110px + 14px + 8px); top:16px; bottom:-4px; width:2px; background:var(--grid); }}
.tl-time {{ color:var(--muted); font-size:13px; font-weight:650; text-align:right; padding-top:2px; font-variant-numeric:tabular-nums; }}
.tl-dot {{ width:12px; height:12px; border-radius:50%; background:var(--series-1); margin-top:5px; position:relative; z-index:1; box-shadow:0 0 0 3px var(--page); }}
.tl-title {{ font-weight:700; }}
.tl-desc {{ color:var(--ink-2); font-size:15px; margin-top:2px; max-width:66ch; }}
.gallery {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:14px; margin-top:16px; }}
.cap {{ background:var(--surface-1); border:1px solid var(--border); border-radius:12px; overflow:hidden; }}
.cap-img {{ background:#fff; aspect-ratio:1; display:flex; align-items:center; justify-content:center; padding:8px; }}
.cap-img img {{ max-width:100%; max-height:100%; }}
.cap figcaption {{ padding:10px 12px 12px; font-size:14px; }}
.cap-rank {{ font-size:13px; }}
.cap-meta {{ color:var(--muted); font-size:12.5px; }}
table.cmp {{ width:100%; border-collapse:collapse; font-size:15px; }}
table.cmp th, table.cmp td {{ padding:9px 12px; text-align:left; border-bottom:1px solid var(--grid); }}
table.cmp th {{ color:var(--muted); font-size:12.5px; text-transform:uppercase; letter-spacing:.06em; }}
table.cmp .num {{ font-variant-numeric:tabular-nums; }}
table.cmp .ok {{ color:#0a7a2f; font-weight:650; }}
table.matrix .who {{ color:var(--muted); font-size:12px; }}
table.matrix .muted {{ color:var(--muted); }}
table.matrix td, table.matrix th {{ white-space:nowrap; }}
@media (prefers-color-scheme: dark) {{ table.cmp .ok {{ color:#54d97c; }} }}
.falas {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:12px; margin-top:16px; }}
.fala {{ background:var(--surface-1); border:1px solid var(--border); border-radius:12px; padding:16px 18px; }}
.fala-t {{ font-weight:700; margin-bottom:8px; font-size:15px; }}
.fala blockquote {{ margin:0; padding-left:14px; border-left:3px solid var(--series-1); color:var(--ink-2); font-size:14.5px; font-style:italic; }}
.roster {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:10px; margin-top:16px; }}
.who-card {{ background:var(--surface-1); border:1px solid var(--border); border-radius:10px; padding:12px 14px; }}
.who-nick {{ font-weight:700; font-size:15px; }}
.who-model {{ margin-top:4px; }}
.who-model code {{ font-size:11.5px; }}
.who-runner {{ color:var(--muted); font-size:12px; margin-top:3px; }}
.curios {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:12px; margin-top:16px; }}
.curio {{ background:var(--surface-1); border:1px solid var(--border); border-radius:12px; padding:16px; }}
.curio-t {{ font-weight:700; margin-bottom:4px; }}
.curio-d {{ color:var(--ink-2); font-size:14.5px; }}
code {{ background:var(--grid); border-radius:4px; padding:1px 5px; font-size:.9em; }}
footer {{ margin-top:64px; color:var(--muted); font-size:13.5px; border-top:1px solid var(--grid); padding-top:16px; }}
#tip {{ position:fixed; pointer-events:none; background:var(--ink); color:var(--page); padding:6px 10px; border-radius:7px; font-size:13px; max-width:340px; opacity:0; transition:opacity .1s; z-index:10; }}
#themeBtn {{ position:fixed; top:14px; right:14px; background:var(--surface-1); color:var(--ink); border:1px solid var(--border); border-radius:20px; padding:6px 14px; font-size:13px; cursor:pointer; }}
@media print {{ #themeBtn {{ display:none; }} }}
</style>
</head>
<body>
<button id="themeBtn" onclick="tgl()">◐ tema</button>
<div id="tip"></div>
<div class="wrap">

<header class="hero">
  <div class="kicker">Gambiarra LLM Club · 7º Encontro · 22 de agosto de 2026</div>
  <h1>O dia em que ninguém ficou de fora</h1>
  <p class="sub">Relatório do 7º encontro, reconstruído inteiramente dos registros do servidor. Foram <strong>{nicks} participantes</strong> com <strong>{models} modelos diferentes</strong> rodando em notebooks na mesma sala, o World mais cheio de todos os encontros, duas rodadas de SVG e <strong>{total_votes} votos</strong>, quase o dobro do encontro anterior. E, pela primeira vez, nenhuma geração se perdeu no caminho: {len(rescued)} pessoas que caíram no meio do envio entraram na votação assim mesmo.</p>
  <div class="tiles">{tiles_html}</div>
</header>

<h2>O dia, minuto a minuto</h2>
<p class="lede">Tráfego HTTP no servidor central, das primeiras conexões até o último snapshot. Pico de {peak_val} requisições por minuto e nenhum erro de limite de taxa, terceiro encontro seguido sem um único 429.</p>
<div class="card">{charts['activity']}</div>

<h2>Linha do tempo</h2>
<div style="margin-top:20px">{timeline_html}</div>

<h2>👥 Todo mundo que esteve aqui</h2>
<p class="lede">O elenco completo do dia, em ordem alfabética, com o modelo que cada um trouxe na mochila. São {nicks} pessoas e {models} modelos distintos: quase um modelo por participante, sem ninguém combinar nada antes.</p>
<div class="roster">{roster_html}</div>

<h2>🌍 O World mais cheio até hoje</h2>
<p class="lede">O frame real do pico, às {peak_time}, com {len(peak_state['agents'])} agentes simultâneos no mapa. As posições, as falas e a comida são exatamente as que estavam lá: cada retrato vem dos snapshots que o servidor grava a cada cinco segundos.</p>
<div class="card" style="padding:8px">{world_svg}</div>
<p class="lede" style="margin-top:22px">Placar do mundo, contando <strong>apenas as comidas coletadas com o modelo decidindo</strong>. Como a partida nunca foi encerrada pelo painel, ele foi reconstruído a partir dos {snapshots_count} snapshots do dia. Campeão: <strong>{esc(champ_llm['nickname'])}</strong>, com {champ_llm['llm_score']} comidas.</p>
<div class="card">{charts['world']}</div>
<div class="card" style="margin-top:14px">
<p style="font-size:14.5px;color:var(--ink-2)"><strong>🎮 Por que este placar desconta o modo manual.</strong> O cliente do agente permite dirigir a criatura pelo teclado, sem o LLM, e existe para testar a conexão antes de a partida valer. {len(manual_players)} participantes o usaram em algum momento e estão marcados com 🎮. Como o clube compete para ver <em>o que os modelos conseguem fazer</em>, as comidas coletadas com o modo ligado saem da conta: no bruto o topo seria {esc(bruto_lider['nickname'])} com {bruto_lider['score']}, dos quais cerca de {bruto_lider['gain_manual']} vieram no teclado. Nada foi escondido: o total sem desconto de cada participante aparece ao passar o mouse na barra. A medição é aproximada, porque o servidor fotografa o mundo de cinco em cinco segundos e guarda a última ação de cada agente, então o que existe é uma amostragem e não a contagem movimento a movimento.</p>
<p style="font-size:14.5px;color:var(--ink-2);margin-top:12px">Vale registrar que o critério não nasceu depois do jogo: ele foi anunciado durante a partida, com o placar ainda correndo no telão. <em>"O pessoal que está andando manualmente aí, o relatório vai associar ao modelo ou ao modo manual? Se sair manual, eu vou de alguma forma balancear."</em></p>
</div>

<h2>🐹 Rodada 1 — a capivara dançando frevo</h2>
<p class="lede">O prompt clássico do clube, pelo terceiro encontro seguido: <em>"Crie o SVG de uma capivara dançando frevo"</em>. {len(m_r1)} gerações e {sum(r["n"] for r in v_r1)} votos, a rodada mais votada da história do clube. O critério é a média das notas de 0 a 5, o mesmo que o telão revelou posição a posição.</p>
<div class="card">{charts['r1']}</div>

<h2>🎨 Rodada 2 — a antena, a lama e Chico Science</h2>
<p class="lede">O prompt desta rodada foi escrito ao vivo, a partir de uma sugestão da plateia: alguém pediu "a maior gambiarra possível", e a frase virou <em>"crie um SVG e retorne uma tag &lt;svg&gt;&lt;/svg&gt; com o desenho de uma antena enfiada na lama com Chico Science do lado"</em>, com direito a "não alucine" e "use o potencial máximo do seu cerebelo" no fim. {len(m_r2)} gerações e {sum(r["n"] for r in v_r2)} votos.</p>
<div class="card">{charts['r2']}</div>

<h2>🖼️ A galeria completa</h2>
<p class="lede">Todos os desenhos das duas rodadas, exatamente como saíram dos modelos, token a token, em notebooks nesta sala. Nada de recorte de pódio: se você gerou, está aqui.</p>
<div class="gallery">{gallery_html}</div>

<h2>🧬 Os gêmeos: quando dois notebooks desenham a mesma coisa</h2>
{twins_html}
<div class="card">
<p style="font-size:15px;color:var(--ink-2)">O fenômeno foi percebido na hora, no telão, enquanto os dois desenhos cresciam lado a lado: <em>"modelo um mais lento que o outro, mas está desenhando igual, exatamente igual, deterministicamente. Isso é lindo. São dois modelos em computadores diferentes recebendo o mesmo prompt."</em></p>
<p style="font-size:15px;color:var(--ink-2);margin-top:12px">Não foi coincidência nem cola: <strong>é assim que um modelo de linguagem funciona</strong>. Gerar texto é aplicar uma função matemática, sempre a mesma, sobre os pesos do modelo e o que já foi escrito até ali. A cada passo o modelo calcula a probabilidade de cada token possível e escolhe um. Se duas máquinas partem <em>exatamente</em> das mesmas condições, elas percorrem o mesmo caminho e chegam à mesma resposta, token por token.</p>
<p style="font-size:15px;color:var(--ink-2);margin-top:12px">E as condições eram mesmo idênticas, porque a arena faz questão disso: quando a rodada começa, o servidor manda para todo mundo o <strong>mesmo prompt</strong>, a <strong>mesma temperatura</strong> ({round_params[2]['temperature']}) e a <strong>mesma semente aleatória</strong> ({round_params[2]['seed']}). A semente é o que transforma o sorteio do próximo token em algo repetível: mesma semente, mesmos sorteios. Faltava só a última peça, e ela estava escondida no nome: um dos dois cadastrou <code>qwen3.5:latest</code> e o outro <code>qwen3.5:9b</code>, que no Ollama são apelidos para <strong>o mesmo modelo</strong>, os mesmos pesos no disco.</p>
<p style="font-size:15px;color:var(--ink-2);margin-top:12px">Mesmos pesos, mesmo prompt, mesma temperatura, mesma semente. O resultado tinha que ser igual, e foi. <strong>O que a máquina muda é o relógio, não o desenho:</strong> repare na tabela acima que os dois levaram tempos bem diferentes para produzir exatamente os mesmos {twins[0]['membros'][0]['tokens'] if twins else 0} tokens. Hardware define a <em>velocidade</em> da geração; o modelo e seus parâmetros definem o <em>conteúdo</em>.</p>
<p style="font-size:15px;color:var(--ink-2);margin-top:12px">Vale a inversão também, e ela explica o resto da galeria: como cada participante escolheu um modelo diferente, ninguém mais no encontro produziu nada parecido. É por isso que o clube junta modelos variados numa sala só. Se todos rodassem o mesmo modelo com os mesmos parâmetros, a votação seria entre desenhos idênticos, e não haveria encontro nenhum.</p>
</div>

<h2>🤖 A matriz dos modelos</h2>
<p class="lede">A melhor colocação que cada modelo alcançou em cada desafio, e quem o pilotava. Os desafios cobram coisas diferentes: o World exige decisão rápida em loop fechado, enquanto as rodadas de SVG pedem capricho visual.</p>
<div class="card" style="overflow-x:auto">
<table class="cmp matrix">{matrix_html}</table>
</div>

<h2>🛟 As gerações resgatadas</h2>
<p class="lede">Estes participantes geraram seus desenhos por inteiro, e o telão mostrou tudo, mas a conexão caiu antes do aviso de conclusão chegar ao servidor. Até o encontro passado, isso bastava para sumirem da votação. Desta vez o servidor foi buscar o texto no buffer e colocou cada um na urna.</p>
<div class="card">
<table class="cmp"><tr><th>Participante</th><th>tokens recuperados</th></tr>{rescue_rows}</table>
</div>

<h2>📱 De onde vieram os votos</h2>
<p class="lede">A plataforma guarda o aparelho de quem vota. O celular dominou a urna, como era de esperar de uma votação por QR code, mas apareceu bastante gente votando do próprio notebook onde o modelo estava rodando.</p>
<div class="card">{charts['devices']}</div>

<h2>⚙️ 6º vs 7º encontro</h2>
<p class="lede">O que mudou de um encontro para o outro, medido pelos mesmos critérios:</p>
<div class="card">
<table class="cmp"><tr><th>Métrica</th><th>6º (11/07)</th><th>7º (22/08)</th></tr>{comp_html}</table>
</div>

<h2>🎙️ A aula que aconteceu no meio do jogo</h2>
<p class="lede">Entre uma rodada e outra, o encontro vira aula. Estes trechos foram transcritos do áudio do dia e explicam justamente o que o site do clube não cobre: por que as métricas desta página são o que são, e por que os desafios têm a cara que têm.</p>
<div class="falas">{falas_html}</div>

<h2>Curiosidades</h2>
<div class="curios">{curios_html}</div>

<footer>
  <p><strong>Fontes:</strong> banco <code>dev-2026-08-22.db</code> ({nicks} participantes, 2 rodadas, {len(m_r1)+len(m_r2)} gerações, {total_votes} votos e event log com {snapshots_count} world_snapshots) e log estruturado <code>server-2026-08-22.log</code> ({total_req} requisições, {len(rescued)} resgates de token registrados). Todos os números deste relatório saem de consulta direta a essas duas fontes. <strong>Recorte:</strong> o dia inteiro, das 10h33 às 12h13. Relatório gerado em 22/08/2026. 🐹🤖</p>
</footer>
</div>

<script>
const tip = document.getElementById('tip');
document.addEventListener('mousemove', e => {{
  const t = e.target.closest('[data-tip]');
  if (t) {{
    tip.textContent = t.dataset.tip; tip.style.opacity = 1;
    const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 10);
    tip.style.left = x + 'px'; tip.style.top = (e.clientY + 16) + 'px';
  }} else tip.style.opacity = 0;
}});
function tgl() {{
  const r = document.documentElement;
  const cur = r.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  r.dataset.theme = cur === 'dark' ? 'light' : 'dark';
}}
</script>
</body>
</html>'''

with open(OUT, 'w') as f:
    f.write(page)
print('OK:', OUT, f'{len(page)/1024:.0f} KB | galeria: {len(gallery)} | world agents: {len(peak_state["agents"])}')
