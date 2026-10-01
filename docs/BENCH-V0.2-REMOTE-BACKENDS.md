# Bench V0.2 — participants are model backends; everything else runs on the orchestrator

2026-10-01. Owner of this file: the orchestrating session. **Amends `docs/BENCH-V0-CONTRACT.md`**; everything there still holds unless this file says otherwise (task-set format §1, record §4, bundle §5, arena WS protocol §3 between runner and arena).

## 0. Owner decision (2026-10-01)

> Participants only download the model and run Ollama. The whole harness — tau-intent, the agent loop, the workspaces, the oracle, the arena — runs on the machine of whoever runs the Arena. Participants' machines are **model backends**. `mathai-harness` contains everything, including pinned references to tau-intent and to the arena bench, so the orchestrator only executes.

Consequences:
- The runner no longer runs on the participant's machine. The orchestrator spawns **one `tau-intent bench` process per backend**, locally, connected to the local arena. Each process calls the participant's Ollama over the LAN (`http://<participant-ip>:11434/v1`).
- The arena WS protocol of V0 is unchanged. The "participant" seen by the arena is the orchestrator's runner process, with `participant_id = backend_id`.
- The agent's `bash` tool and every workspace now live on the **orchestrator's** machine. Participants run no code from us. The isolation risk moves to the owner: run the orchestrator in a disposable user, VM or container.
- Hardware can no longer be detected by the runner. It is **declared** by the participant on the join page and enriched with Ollama facts (`/api/version`, `/api/show`, `/api/tags`, `/api/ps`).

## 1. What a participant does (the whole list)

```bash
ollama pull <model>
OLLAMA_HOST=0.0.0.0:11434 OLLAMA_ORIGINS='*' ollama serve
```

1. Open `http://<arena-ip>:3000/bench-join` in the browser.
2. The page lists the local Ollama models (via the browser, hence `OLLAMA_ORIGINS`).
3. Pick one, type a nickname, optionally declare chip / RAM / GPU, and submit.
4. The page shows whether the arena could reach your Ollama. If not, it shows the exact fix (firewall, `OLLAMA_HOST`).
5. Leave the laptop on and plugged in. Nothing else.

Security note for the consent text: `OLLAMA_HOST=0.0.0.0` exposes the Ollama API, which has no authentication, to the LAN for the duration of the event. Stop `ollama serve` afterwards.

## 2. Arena additions (fork `MathBorgess/gambiarra-arena-tau-intent-bench`)

### Join page
`GET /bench-join` is a static page served by the server on :3000, like `/agent`.

### `POST /bench/backends`
Request body:
```json
{"nickname":"…","model":"qwen2.5-coder:7b","port":11434,
 "declared_hardware":{"chip":"…|null","ram_gb":16,"accel":"cuda|metal|cpu|other|null"},
 "browser":{"user_agent":"…","cores":8,"device_memory_gb":8}}
```

The server:
- takes the host from the request's remote address, never from the body;
- probes, with a ~3 s timeout each, `http://host:port/api/version`, `POST /api/show {model}` (→ `details.family`, `parameter_size`, `quantization_level`), and `/api/tags` (→ `digest` of that model);
- upserts a backend keyed by (host, port, model).

Response:
```json
{"backend_id":"b-<slug>-<hex6>","reachable":true,"ollama_version":"…","model":{"id":"…","digest":"sha256:…","details":{…}},
 "problems":[{"code":"unreachable|model_missing|timeout","fix":"…"}]}
```

### Other routes and panel
- `GET /bench/backends` (orchestrator and control panel): every backend with `provider_url = http://host:port/v1`, probe result, last probe time, runner status (whether a runner with `participant_id = backend_id` is connected) and `enabled`.
- `POST /bench/backends/:id/probe` re-probes. `POST /bench/backends/:id` `{enabled:false}` lets the owner exclude a backend.
- Control panel: a **Backends** table above the runners table.
- A backend's host is stored, but exports carry only `sha256(host)`. Participants' LAN IPs never leave the arena DB.

## 3. Runner additions (tau-intent)

- `--hardware-source declared|local` (default `local`, V0 behaviour). `declared` never reads the orchestrator's hardware. `--chip/--ram-gb/--accel` become the declared values (null allowed). The record carries `hardware.source`.
- `--backend-id <id>` is stored in the record as `backend.backend_id`.
- With `--runner-kind ollama`, the runner reads `/api/version`, `/api/show` and `/api/tags` from the provider origin once per cell. In the record:
  - `model.details` holds `{family, parameter_size, quantization_level}`;
  - `backend.ollama_version` holds the version;
  - `model.digest` is filled when it was not passed.
- The record gains `backend: {backend_id, transport:"lan", provider_host_sha256, ollama_version}`. The raw host never enters the record.
- Several runner processes run **concurrently on one machine**. No shared temp paths, no shared git config, no global state. Each `--out` is distinct.
- A connection error to the backend is an infrastructure failure: `terminated_by:"error"`, `error.kind:"backend_unreachable"`. It is never silently retried mid-task, because retries would change the treatment.

## 4. Orchestrator (this repo, `mathai-harness`)

Layout:
```
vendor/tau-intent/                 git submodule, pinned SHA (MathBorgess/tau-intent)
vendor/gambiarra-arena/            git submodule, pinned SHA (MathBorgess/gambiarra-arena-tau-intent-bench)
taskset/                           tg-taskset-1 (already here)
src/mathai_harness/orchestrator/   the one entry point
data/<session>/                    everything the event produces (git-ignored)
```

One command family. Python ≥ 3.12 for the orchestrator; the `piso` module keeps its stdlib/3.8 promise.

```
python -m mathai_harness.orchestrator doctor   # submodules at pinned SHAs, python3.12, node/pnpm, pytest, ports free, task_set_sha
python -m mathai_harness.orchestrator setup    # venv .venv-bench with vendor/tau-intent[bench]; pnpm install + build of the arena
python -m mathai_harness.orchestrator up       # arena (DATABASE_URL under data/<session>/), create/attach session, print join URL + PIN,
                                               # then supervise: one runner per enabled reachable backend
python -m mathai_harness.orchestrator status   # backends, runners, cells, records
python -m mathai_harness.orchestrator export   # export-bench.jsonl, artifacts, event log, DB copy, freeze manifest → data/<session>/export/
python -m mathai_harness.orchestrator down
```

Behaviour of `up`:
- Poll `GET /bench/backends` every few seconds. For each backend that is enabled, reachable and has no live runner, spawn:
  ```
  tau-intent bench --server ws://127.0.0.1:3000/ws --pin <PIN>
    --participant-id <backend_id> --nickname <nickname> --backend-id <backend_id>
    --provider-url <provider_url> --model <model> --runner-kind ollama
    --hardware-source declared [--chip … --ram-gb … --accel …]
    --taskset taskset --out data/<session>/runs/<backend_id>
  ```
- Restart a crashed runner with backoff. The runner re-registers; the arena keeps the live cell.
- Log every spawn and exit to `data/<session>/orchestrator.log`.
- `--max-concurrent N` limits how many runners execute at once (the oracle and git run on the orchestrator's CPU). Above the limit, backends wait in a queue, in join order.
- The owner still assigns arms, runs the Tool Call Challenge and starts or stops the bench **in the arena control panel**. The orchestrator never decides arms.

`export` writes `data/<session>/export/freeze.json`:
- submodule SHAs, `tau_intent_sha` reported by runners, `task_set_sha`, arena git SHA, orchestrator git SHA;
- list of backends (hashed hosts) and of artifacts with sha256.

This file is what G2 will freeze and what the TG chapter cites.

## 5. What V0.2 still does not do

- No measured collection: records keep `"draft": true` until G2.
- No container for the orchestrator's agent workspaces (recommended, owner decision).
- No authentication on Ollama, and no TLS on the LAN.
