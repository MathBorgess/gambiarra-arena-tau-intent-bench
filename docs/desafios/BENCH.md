# Modo Bench — tau-intent contra LLMs locais (A/B/C)

> **O que é:** um modo da arena em que, em vez de pedir uma resposta de texto,
> um **agente de código autônomo** (o `tau`, via runner Python
> `tau-intent bench`) trabalha contra o LLM local do participante, numa cadeia de
> tarefas de um mini-repositório Python. O dono escolhe, **no painel de
> controle, quais braços (A/B/C) cada participante roda**, acompanha o
> progresso ao vivo no telão e termina com todos os registros e os bundles de
> evolução do repositório (um commit por tarefa, por braço) para o TG.
>
> **Segue a [RECEITA-B](RECEITA-B-novo-modo-de-interacao.md)** (gabarito:
> World). O contrato compartilhado entre as três equipes (runner, arena,
> conjunto de tarefas) é [`docs/BENCH-V0-CONTRACT.md`](../BENCH-V0-CONTRACT.md);
> esta página é a **§1 (contrato do modo, Etapa 1 da receita)** e o **§2
> (runbook do dono)**.
>
> **V0.2 (2026-10-01): participantes são *backends de modelo*.** O participante
> só baixa o modelo e liga o Ollama; **o runner (`tau-intent bench`), o agente, os
> workspaces e o oráculo rodam na máquina do dono da arena**, um processo por
> participante, que chama o Ollama dele pela rede local. O protocolo WebSocket
> runner↔arena (§1) **não mudou**: o runner se registra com
> `participant_id = backend_id`. Contrato: [`docs/BENCH-V0.2-REMOTE-BACKENDS.md`](../BENCH-V0.2-REMOTE-BACKENDS.md).
> O §0 abaixo (participante) e o §2 (runbook) já refletem isso; as menções a
> "cada máquina roda o runner" no resto do texto valem para a V0 (runner local).
>
> **V0 é instrumentação, não coleta medida.** Tudo que sai daqui carrega
> `"draft": true` e **não é resultado do TG** até o congelamento G2. O servidor
> **guarda o que recebe** (JSON cru) e **nunca recalcula desfechos**.

---

## 0. O que o participante faz (V0.2: as duas linhas)

```bash
ollama pull <modelo>
OLLAMA_HOST=0.0.0.0:11434 OLLAMA_ORIGINS='*' ollama serve
```

Depois abre `http://<ip-da-arena>:3000/bench-join` (o painel mostra o endereço e um
QR code), escolhe o modelo, digita um apelido e, se quiser, declara chip / RAM / GPU.
A página diz se a arena alcançou o Ollama; se não, mostra o conserto exato
(`OLLAMA_HOST`, firewall) por sistema (macOS / Linux / Windows). Deixe o notebook
**ligado e na tomada**. Nada mais, e nada nosso roda na máquina do participante.

> Aviso de consentimento: `OLLAMA_HOST=0.0.0.0` expõe a API do Ollama, **sem
> autenticação**, à rede local durante o evento. Encerre o `ollama serve` depois.

### 0.1 Backends (HTTP)

| Método | Caminho | Quem | Para quê |
|---|---|---|---|
| GET | `/bench-join` | participante | página estática (como `/agent`), isenta de rate limit |
| POST | `/bench/backends` `{nickname, model, port?, declared_hardware?, browser?}` | participante | registra/atualiza o Ollama de **quem chama**. O host é o endereço remoto da requisição, nunca o corpo. Testa `/api/version`, `POST /api/show`, `/api/tags` (3 s cada, sem proxy) |
| GET | `/bench/backends[/:id]` | dono / orquestrador / página | lista; `provider_url` só para requisições de loopback |
| POST | `/bench/backends/:id/probe` | participante, dono | testa de novo (corpo vazio, ou `{}` com `Content-Type: application/json`) |
| POST | `/bench/backends/:id` `{enabled}` | dono | liga/desliga: o orquestrador não sobe runner para backend desligado |

- Chave do backend: `(host, port, modelo)`; reenviar da mesma máquina **atualiza** o
  registro (mesmo `backend_id`, `b-<apelido>-<hex6>`). `llama3` e `llama3:latest` são o mesmo modelo.
- `problems[].code`: `unreachable` (conexão recusada: Ollama preso ao localhost),
  `timeout` (firewall / outra rede), `model_missing`; cada um traz `fix` (texto para o participante).
- Rate limit: 30 escritas/min por IP não-local nas rotas POST (cada uma dispara 3 sondagens); máx. 16 backends por máquina.
- **Privacidade:** o IP fica só na tabela `bench_backends` (precisa do `provider_url`).
  Exportações (`/export-bench.jsonl`, `/export-events.csv`, `/export-all.json`),
  snapshots e metadados do event log (`bench_backend_registered|probed|toggled`)
  levam **`host_sha256`** (sha256 hex do host, sem porta, IPv4-mapeado normalizado).
  Atenção: IPv4 de LAN tem pouca entropia, então o hash **pseudonimiza, não
  anonimiza**. E uma **cópia do banco** (`server/prisma/*.db`) contém `bench_backends.host`:
  apague/zere essa coluna antes de compartilhar a cópia.
- Só chamadas de **loopback** (a máquina do dono, o orquestrador) recebem
  `provider_url`; qualquer outra, inclusive via o servidor de dev do telão (`:5173`,
  marcado com `x-bench-via-telao`), recebe `provider_url: null`.
- `x-bench-dev-host`: só vale com `BENCH_DEV=1` (simulador). Fora disso é ignorado.

---

## 1. Contrato do modo (Etapa 1 da RECEITA-B)

### 1.1 Como o participante ENTRA

Depois do `register` normal (PIN; `runner: "tau-intent"`, `model: <id do modelo>`),
o runner envia **`bench_join`**:

```json
{"type":"bench_join","participant_id":"…","runner_version":"…","tau_intent_sha":"…","task_set_sha":"…",
 "model":{"id":"…","digest":"sha256:…|null","runner_kind":"ollama|lmstudio|llamacpp|other"},
 "hardware":{"os":"…","chip":"…","ram_gb":16,"accel":"cuda|metal|cpu|other"}}
```

`participant_id` tem de ser o mesmo do `register`. O servidor guarda o join
(aparece no painel com modelo, hardware e os hashes `tau_intent_sha` /
`task_set_sha`) e registra `bench_joined`. **Nesta V0 o servidor não recusa join
por divergência de hash** (a recusa é do congelamento G2); ele só **mostra** o
hash para o dono conferir se todo mundo tem o mesmo conjunto de tarefas.

### 1.2 O que o servidor envia e quando

**`bench_assign`** — quando o dono dá `start` ou (re)atribui aquele
participante com o bench rodando:

```json
{"type":"bench_assign","cell_id":"…","mode":"qualification|bench","arms":["B","A","C"],
 "seed":7,"k_max":6,"deadline_s":600,"max_productive_turns":8}
```

- `arms` é a lista **ordenada** escolhida pelo dono. Padrão: os três braços, em
  ordem **sorteada com `seed`** (a semente fica gravada por célula). O runner
  roda exatamente esses braços, **intercalados por índice de tarefa**
  (k=1 em cada braço na ordem dada, depois k=2, …).
- `mode: "qualification"` roda **só a Q0, no braço A, no máximo 2 tentativas**
  (no `bench_assign` de qualificação o servidor sempre manda `arms: ["A"]`, para
  não haver dúvida; a lista planejada para o bench continua guardada).
- Um `bench_assign` novo para uma célula em curso é **recusado pelo runner**
  (`bench_error`); o dono precisa dar `stop` antes. O servidor também responde
  `409` a uma reatribuição enquanto a célula do participante está ativa.
- `cell_id` é gerado pelo servidor (`[A-Za-z0-9_-]`, seguro para nome de
  arquivo) e é único por (participante, rodada).

**`bench_stop`** — `{"type":"bench_stop","cell_id":"…"}`. O runner termina o
(braço, tarefa) corrente e marca os restantes como `terminated_by:"stopped"`,
**nunca começa um novo**, e sobe o bundle.

### 1.3 O que o participante responde

```json
{"type":"bench_progress","cell_id":"…","arm_id":"A|B|C|Q","task_index":1,"phase":"start|turn|oracle|done","turn":3,"tokens_in":1200,"tokens_out":340}
{"type":"bench_record","cell_id":"…","record":{ …gambiarra-coleta-2, contrato §4… }}
{"type":"bench_cell_done","cell_id":"…","records":18,"manifest_sha256":"…","truncated":false}
{"type":"bench_error","cell_id":"…","code":"…","message":"…"}
```

- `bench_progress`: só alimenta o telão (não é gravado como dado; o estado
  completo vai para o snapshot, §1.6). Tolera-se enviar a cada turno.
- `bench_record`: **um por (célula, braço, tarefa)**; tentativas de qualificação
  usam `arm_id:"Q"`, `harness_id:"tau"`, `task_index:0`. O servidor valida as
  restrições do §4 do contrato (bijeção braço↔harness, Q↔tau, `cost_usd == 0`,
  braço A/Q sem flags nem turnos de bloqueio, `tokens.source` ∈
  `provider_usage|missing`) e **grava o JSON como veio**. Registro inválido é
  rejeitado com `{"type":"error","code":"bench_record_rejected",…}` e **não**
  é gravado — o runner mantém o JSONL local de qualquer forma.
- `bench_cell_done`: fim da célula (ou do truncamento, `truncated:true`).
- Bundle de artefatos: `POST /bench/artifacts/:cellId` (HTTP, §1.4).

### 1.4 HTTP

| Método | Caminho | Quem | Para quê |
|---|---|---|---|
| POST | `/bench/assign` `{participant_id, arms?, mode?, seed?, k_max?, deadline_s?, max_productive_turns?}` | dono | atribui braços; guarda, e envia já se o bench estiver rodando |
| POST | `/bench/start` `{mode?, only_qualified?, participant_ids?}` · `/bench/stop` `{participant_id?}` | dono | inicia/para o bench da sessão ativa |
| GET | `/bench/state` | telão/controle | participantes, atribuições, progresso, contagens |
| POST | `/bench/artifacts/:cellId` (`application/gzip`, ≤ 200 MB) | runner | sobe o bundle da célula; guardado em `server/data/bench/<sessão>/<cellId>.tar.gz` com sha256 |
| GET | `/bench/artifacts` · `/bench/artifacts/:cellId` | dono | lista (com sha256) / baixa o bundle |
| GET | `/export-bench.jsonl` | dono | um registro por linha, como recebido |

### 1.5 O que o telão recebe

`bench_state` (WebSocket, depois de `telao_register` com `view:"bench"` ou
`"bench-control"`), com no máximo ~4 mensagens por segundo: lista de
participantes (runner, modelo, hardware, conectado), atribuição corrente
(células, braços, modo, semente), **grade participante × braço × índice de
tarefa** (fase, resultado do oráculo, medidor de tokens) e, para a rodada de
qualificação, o placar do "Tool Call Challenge".

### 1.6 Início/fim e o que fica gravado

- Início/fim: `POST /bench/start|stop` pelo painel `/bench-control`.
  `stop` **não mata** execução em curso: manda `bench_stop` e aguarda o
  `bench_cell_done` (marca truncamento).
- Event log (`event_logs`): `bench_started`, `bench_assigned`, `bench_joined`,
  `bench_record`, `bench_cell_done`, `bench_stopped`,
  `bench_artifacts_uploaded` **e `bench_snapshot` a cada 5 s com o estado
  completo** (lição de 23/05 da receita; também `bench_error` para erros
  informados pelo runner).
- Tabelas: `bench_assignments` (uma linha por célula, com ordem de braços e
  semente), `bench_records` (JSON cru + colunas indexadas) e `bench_artifacts`
  (caminho, sha256, bytes).

---

## 2. Runbook do dono

> Passo a passo para o dia do ensaio (E0) ou do encontro. Todos os comandos
> rodam na **máquina do dono**, na raiz do repositório. **Nunca** teste em cima
> do banco de um encontro: para ensaios use `DATABASE_URL="file:/tmp/teste.db"`.

### 2.0 Antes de tudo (V0.2)

- **O que roda onde.** Participante: só `ollama pull` + `ollama serve` aberto à rede (§0).
  Máquina do dono: a arena, o orquestrador e **todos os runners** (um `tau-intent bench`
  por backend). O agente, o `bash` do agente e os workspaces ficam na máquina do dono:
  rode o orquestrador num **usuário descartável, VM ou container** (decisão do dono; a V0.2
  ainda não containeriza).
- **Mesmo `taskset/` para todos**: agora é o do `mathai-harness`, então o `task_set_sha`
  é igual por construção; o painel ainda avisa em amarelo se aparecer mais de um valor.
- Rede: um AP bom (sem isolamento de clientes; senão o Ollama do participante fica
  inalcançável) e a arena documenta o colapso perto de 20–30 clientes ([LIMITS.md](../../LIMITS.md)).
  Cada runner usa **1 conexão WebSocket** (do 127.0.0.1) e a carga de LLM vai pela LAN.
- Hardware **declarado** pelo participante (+ fatos do Ollama: versão, família, tamanho, quantização, digest);
  a arena não consegue ler o hardware da máquina dele.

### 2.1 Subir

Pelo `mathai-harness` (o repositório do orquestrador, que fixa as versões do tau-intent e desta arena):

```bash
python -m mathai_harness.orchestrator doctor   # versões, portas, python/node/pnpm
python -m mathai_harness.orchestrator setup    # venv do tau-intent, pnpm install + build da arena
python -m mathai_harness.orchestrator up       # sobe ESTA arena (banco em data/<sessão>/), cria a sessão,
                                               # imprime URL de entrada + PIN e supervisiona os runners
```

`up` consulta `GET /bench/backends` a cada poucos segundos e sobe um runner por backend
**ligado, alcançável e sem runner vivo** (`participant_id = backend_id`). Quem decide braços, roda a
qualificação e inicia/para o bench continua sendo **você, no painel** (§2.3–2.5).

Só a arena, sem orquestrador (ensaio com o simulador, ou para depurar):

```bash
BENCH_DEV=1 pnpm event   # BENCH_DEV=1 só para o simulador (§2.8); omita no evento real
```

O banner mostra as URLs. As tabelas `bench_*` (inclusive `bench_backends`) são criadas pelo
`db push`. Abra:

| O quê | URL |
|---|---|
| Painel do dono | `http://localhost:5173/bench-control` (tabela **Backends** acima dos runners, URL de entrada e QR code) |
| Entrada dos participantes | `http://<ip-da-arena>:3000/bench-join` |
| Telão (projetor) | `http://localhost:5173/bench` (escolhe sozinho: qualificação → Tool Call Challenge, bench → grade) |
| Forçar uma visão | `/bench?view=challenge` · `/bench?view=grid` · `/bench-challenge` |

### 2.2 Sessão, backends e runners

1. No painel, a sessão (PIN) já existe se você usou `up`; senão, **Criar sessão**.
2. Mostre o QR / URL de entrada. Cada participante registra o modelo; na tabela **Backends** aparecem
   apelido, modelo (família · tamanho · quantização), digest, versão do Ollama, alcançável ou o
   problema (`unreachable` / `timeout` / `model_missing`), última checagem e o estado do runner
   (aguardando / conectado / rodando célula). **↻ testar** refaz a sondagem; o interruptor
   **Ligado** exclui um backend (o orquestrador não sobe, nem reinicia, runner para ele).
3. Quando o orquestrador sobe o runner, a linha aparece também na tabela **Runners**
   (modelo, hardware declarado, hashes, braços). Todo runner entra com o plano padrão:
   os três braços, ordem sorteada pela semente da célula.
4. Backend perdido no meio da célula: o runner manda um `bench_error` e fecha a célula
   truncada (`bench_cell_done` com `truncated:true` + bundle); o painel marca "⚠ backend perdido".
   O erro nunca é repetido em silêncio no meio de uma tarefa (repetir mudaria o tratamento).
5. Sem Python nem Ollama à mão? Ensaie tudo com o simulador (§2.8).

### 2.3 Atribuir braços (a decisão é sua)

Na coluna **Braços da próxima célula** marque A/B/C por participante e ajuste a
**ordem** com ◀ ▶ → **Aplicar**. Atalhos: *Definir para todos* → *Aplicar a
todos*; *Padrão (sorteio)* volta aos três braços em ordem sorteada.

- O que você escolhe é a **próxima** célula; uma célula em curso nunca é
  alterada (o runner recusaria um segundo `bench_assign`). Para mudar uma
  célula em curso: `⏹ parar` (só aquela máquina) e depois atribuir de novo.
- A ordem e a semente ficam gravadas por célula (`bench_assignments`) e no
  event log (`bench_assigned`), com a origem (`owner` ou `default_shuffled`).

### 2.4 Qualificação — o "Tool Call Challenge"

1. Escolha **🛠️ Tool Call Challenge** e **Iniciar qualificação**. Todas as
   máquinas rodam só a **Q0, no braço A, até 2 tentativas**, e o telão mostra o
   placar lúdico (quem passou, tentativas, chamadas de ferramenta, tempo).
2. Regra pré-registrada: a máquina entra no bench **se e só se a Q0 passar no
   oráculo em ≤ 2 tentativas**. O status (`passou Q0` / `não passou Q0` /
   `Q0 interrompido`) é **derivado** pelo servidor dos registros `arm_id:"Q"`
   (nunca é gravado como dado). Reprovadas são **contadas e reportadas** (modelo,
   digest, motivo), nunca descartadas em silêncio.
3. Quando todas as células terminam, a rodada fecha sozinha (`bench_stopped`
   com `reason:"all_done"`).

### 2.5 Bench

1. Revise os braços de cada máquina; escolha **🧪 Bench**.
2. **Só quem passou na qualificação** vem marcado. Desmarque para ensaio (E0),
   ou para rodar uma máquina que você decidiu aceitar apesar do Q0 (decisão sua;
   registre o motivo).
3. **Iniciar bench.** Cada runner roda seus braços **intercalados por tarefa**
   (k=1: braços na ordem escolhida; depois k=2 …) até `k_max` (padrão 6),
   com `deadline_s` (600) por (braço, tarefa) e `max_productive_turns` (8).
4. Acompanhe no telão `/bench`: por participante, uma linha por braço e uma
   casa por tarefa — `t3` turno em curso, `⚖` oráculo rodando, `✓`/`✗`
   resultado do oráculo, selo `D` deadline · `T` teto de turnos · `S` parado ·
   `E` erro — e o medidor de tokens por braço (entrada + saída).
5. **Parar tudo** (ou `⏹ parar` por máquina): cada runner termina o
   (braço, tarefa) atual como `stopped`, sobe o bundle e responde
   `bench_cell_done` com `truncated:true`. Se a máquina já caiu, o servidor
   fecha a célula como `stopped` na hora. A ordem intercalada garante que o
   truncamento corta os três braços no mesmo `k`.
6. Para uma nova rodada, **Iniciar** de novo: nasce uma célula nova (id novo,
   mesmos braços/semente).

### 2.6 O que o servidor grava

| Onde | O quê |
|---|---|
| `bench_records` (SQLite) | cada registro `gambiarra-coleta-2` **como recebido** (`raw`) + colunas: `sessionId, cellId, participantId, armId, taskIndex, oraclePass, tokensIn, tokensOut, terminatedBy, receivedAt`. Reenvio idêntico é ignorado (`(cellId, rawSha256)` único). |
| `bench_assignments` | uma linha por célula: modo, braços (ordem), origem, semente, `k_max`, deadline, status, `bench_join` vigente, resumo do `bench_cell_done`. |
| `bench_artifacts` + disco | bundles em `server/data/bench/<sessão>/<cellId>.tar.gz` com `sha256`/bytes. Reenvio com bytes diferentes **não sobrescreve**: o anterior vira `<cellId>.v<n>.tar.gz`. |
| `event_logs` | `bench_started`, `bench_assigned`, `bench_joined`, `bench_record`, `bench_cell_done`, `bench_stopped`, `bench_artifacts_uploaded`, `bench_error` e **`bench_snapshot` a cada 5 s** (estado completo; linhas da grade como tuplas `[braço, tarefa, fase, turno, tokens_in, tokens_out, oráculo, término]`). |

O servidor **não recalcula nada**: contagens, "passou Q0" e a grade são vistas
derivadas; o dado é o JSON cru.

### 2.7 Exportar e fechar (ritual de [docs/reports](../reports/README.md))

```bash
# Registros, um por linha, como recebidos (sessão ativa; ?session_id=… para outra)
curl -s localhost:3000/export-bench.jsonl > bench.jsonl
# O mesmo com as colunas do servidor (receivedAt, ids) em cada linha
curl -s "localhost:3000/export-bench.jsonl?envelope=1" > bench-envelope.jsonl
# Bundles: lista com sha256 e download
curl -s localhost:3000/bench/artifacts | jq '.artifacts[] | {cell_id, version, latest, sha256, bytes}'
curl -s -o cell.tar.gz localhost:3000/bench/artifacts/<cellId>        # ?version=1 para um anterior
sha256sum cell.tar.gz                                                 # confere com o sha256 listado
# Event log do bench
curl -s localhost:3000/export-events.csv > events.csv
```

1. **Backup antes de qualquer análise** (regra 1 do ritual): copie
   `server/prisma/<banco-do-dia>.db` **e** `server/data/` (inclui
   `data/bench/` com os bundles e `data/snapshots/`).
2. Consultas de inventário (timestamps são **epoch em ms** — regra 3 do ritual):

```sql
-- registros por braço e resultado do oráculo
SELECT armId, oraclePass, count(*) FROM bench_records
 WHERE sessionId = :sid GROUP BY armId, oraclePass;
-- linha do tempo de uma célula
SELECT datetime(receivedAt/1000,'unixepoch','localtime'), armId, taskIndex, oraclePass, terminatedBy
  FROM bench_records WHERE cellId = :cell ORDER BY receivedAt;
-- reconstruir a grade num instante: o bench_snapshot mais próximo
SELECT datetime(timestamp/1000,'unixepoch','localtime'), metadata FROM event_logs
 WHERE eventType = 'bench_snapshot' ORDER BY timestamp;
```

3. Cada bundle (`.tar.gz`) traz o que o runner guarda por célula
   (contrato §5): `records.jsonl`, `cell.json`, `arms/<A|B|C>/repo.bundle`
   (um commit por tarefa = a **evolução do mini-repositório**), transcrições,
   diffs, `intents.jsonl`. `git clone arms/B/repo.bundle` reconstrói a série de
   commits `task-01…`.
4. **Nada daqui é resultado do TG**: registros são `draft:true` até o G2.

### 2.8 Simulador (sem Python, sem modelo)

```bash
# servidor no ar (pnpm dev / pnpm event) e sessão criada no painel:
pnpm simulate:bench -- --pin <PIN> --runners 6          # runners falsos; você comanda pelo painel
# ou tudo sozinho (cria a sessão, atribui braços, qualificação → bench → resumo):
pnpm simulate:bench -- --auto-owner --runners 6 --tasks 4 --delay-ms 400
```

Opções: `--server ws://host:3000/ws`, `--runners N`, `--tasks K` (limita as
tarefas por célula), `--delay-ms` (duração de cada turno simulado), `--fail-q M`
(a cada M-ésimo runner reprova na Q0; padrão 4), `--prefix` (id dos runners).
Os runners falsos falam exatamente o protocolo do §1, gravam um `tar.gz` pequeno
e o enviam por `POST /bench/artifacts/:cellId` com `x-bench-sha256`.

**Modo backends (V0.2)**, para testar o painel e o orquestrador sem Ollama de verdade.
O servidor precisa de `BENCH_DEV=1` (o endereço remoto de todas as requisições é 127.0.0.1;
o simulador informa o "IP" de cada Ollama falso no cabeçalho `x-bench-dev-host`, só honrado nesse modo):

```bash
BENCH_DEV=1 pnpm event                                      # (ou pnpm dev)
pnpm simulate:bench -- --backends 5                          # 5 Ollamas falsos em 127.0.0.2.. (porta 11500), registrados via POST /bench/backends
pnpm simulate:bench -- --backends 5 --backends-flaky        # o último inalcançável, o penúltimo sem o modelo
pnpm simulate:bench -- --backends 5 --pin <PIN>             # + um runner falso por backend pronto (participant_id = backend_id)
pnpm simulate:bench -- --backends 5 --auto-owner            # fluxo completo + checagem: nenhum IP cru nas exportações
```

`--backend-port` muda a porta. Sem `--pin`/`--auto-owner` o simulador só registra e fica de pé
(para o orquestrador subir os runners dele).

### 2.9 Limites e dicas

| Item | Limite / comportamento |
|---|---|
| Mensagem WebSocket | **1 MiB** (`WS_MAX_PAYLOAD`): um `bench_record` com `per_test` enorme pode estourar; o servidor responde `error` e o runner mantém o JSONL local |
| Bundle | **200 MB**, `application/gzip` (também `application/x-gzip`/`octet-stream`), começa com os bytes gzip `1f 8b`; recebido em *stream* (não ocupa memória) |
| Rate limit HTTP | 500 req/min por IP **não-local**; `/bench/artifacts/:cellId` e `/bench-join` são isentos (uploads/retries; página estática). `POST /bench/backends*` tem limite próprio de 30/min por IP não-local. `/bench-control` e o telão chegam como `127.0.0.1` (isento) |
| Ping/pong | o hub derruba conexão sem resposta a ~90 s: o runner **não pode bloquear o event loop** do cliente WebSocket (rode pytest/git em subprocesso/thread) |
| Reconexão do runner | refazer `register` + `bench_join`; a célula em curso continua válida (o servidor reconhece pelo `cell_id`) e **não reenvia** `bench_assign` |
| Restart do servidor | células e registros voltam do banco (`running` volta se havia célula viva); o telão mostra "reconectando" e se recupera sozinho |

Códigos de erro que o runner pode receber (mensagem `error`):
`bench_not_registered`, `bench_participant_mismatch`, `bench_invalid_message`
(com `issues` do Zod), `bench_record_rejected` (com `reason`:
`unknown_cell`, `cell_not_active`, `cell_mismatch`, `participant_mismatch`,
`arm_not_assigned`, `task_out_of_range`, `storage_failed`),
`bench_cell_done_rejected`. Respostas HTTP do upload: `404 unknown_cell`,
`400 not_gzip|empty_body|invalid_cell_id`, `403 participant_mismatch`,
`413 too_large`, `415 unsupported_media_type`, `422 sha256_mismatch`.

---

## 3. Decisões desta implementação (V0)

Tudo aqui é **aditivo** ao contrato §3 de `BENCH-V0-CONTRACT.md`; nada nele foi
alterado.

- `bench_assign` de **qualificação** sempre leva `arms:["A"]` (a lista planejada
  para o bench fica guardada na célula).
- Cada runner conhecido tem sempre uma célula **planejada** (a próxima): é o que
  o dono edita; enviar uma célula cria a seguinte (mesmos braços/semente).
- `POST /bench/assign` aceita também `seed`, `k_max`, `deadline_s`,
  `max_productive_turns` e `arms:null` (volta ao padrão sorteado);
  `POST /bench/start` aceita `mode`, `only_qualified`, `participant_ids`;
  `POST /bench/stop` aceita `participant_id`.
- O servidor **não recusa** `bench_join` por hash divergente (isso é do G2);
  apenas exibe e alerta.
- Rejeita (e não grava) registro que contradiz a atribuição: braço fora da lista
  da célula, `arm_id` ≠ Q em célula de qualificação, `task_index > k_max`,
  `participant_id`/`cell_id` diferentes dos da mensagem.
- Eventos extras no event log além da lista do contrato: `bench_snapshot`
  (exigência da receita) e `bench_error`.
- O status "passou Q0" (`evaluateQualification` em `bench.ts`) é uma visão derivada para o dono e o telão; **não** é
  coluna nem evento.

## 4. Decisões da V0.2 (backends remotos)

- Aditivo ao §3: o protocolo WS não mudou. `bench_join.hardware` ganhou `source` (`declared|local`) e
  `declared {chip, ram_gb, accel}`; `chip`, `ram_gb` e `accel` podem ser `null` (join e registro). O painel
  mostra `hardware.declared` quando `source === "declared"`.
- Campos novos do registro que a arena só guarda (JSON cru): `backend {backend_id, transport, provider_host_sha256, ollama_version}`,
  `model.details`, `error {kind, detail}`, `turns[].latency_ms|ttft_ms`.
- O host do backend vem do endereço TCP do cliente. O `X-Forwarded-For` (Fastify `trustProxy: true`) só
  vale quando o par TCP é loopback (proxy local); de um cliente da LAN ele é ignorado, para ninguém
  mandar a arena sondar outra máquina nem se passar por loopback.
- `bench_error.message` passa por `redactHosts` (IPv4 e hosts de URL não-loopback viram `[host]`) antes
  de ir ao event log e ao painel. O `error.detail` dos **registros** é guardado como recebido: o runner
  não deve colocar o endereço nele.
- Eventos novos no event log: `bench_backend_registered`, `bench_backend_probed`, `bench_backend_toggled`
  (só `host_sha256`).

