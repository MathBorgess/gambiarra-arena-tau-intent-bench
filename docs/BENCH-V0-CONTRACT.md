# Bench V0 — shared contract (tau-intent runner × Gambiarra Arena × task set)

2026-10-01. Owner of this file: the orchestrating session. Three teams implement against it in parallel:

| Team | Repo | Builds |
|---|---|---|
| runner | `MathBorgess/tau-intent` | `tau-intent bench`: runs the real tau agent against the participant's local model, arms A/B/C, oracle, records, artifact bundle |
| arena | fork of `gambiarraclub/gambiarra-arena` | `bench` mode: owner assigns arms per participant, live progress on the telão, stores records and artifacts, exports |
| taskset | `MathBorgess/mathai-harness` | mini Python repo + chain of K dependent tasks + hidden tests + reference states + qualification task Q0 |

Design rationale (Portuguese, vault): `wiki/projects/harness-tau/2026-10-01-desenho-bench-gambiarra.md`. Experimental contract is still the preregistration + MAT-237; the 2026-10 amendment is a **draft**. **V0 is instrumentation, not measured collection**: nothing it produces is a TG result until G2.

**V0 goal (owner, 2026-10-01):** models run on participants' machines; the owner decides from the arena control panel which arm(s) each participant runs; the owner ends up with the evolution data of the mini repository (per arm, per task) for the TG.

Change this contract only through the orchestrator. If something here is impossible, stop and report; do not silently diverge.

---

## 1. Task set format — `tg-taskset-1`

A directory (shipped in `mathai-harness`, path `taskset/`), consumed read-only by the runner.

```
taskset/
  taskset.json
  seed/                     # initial repository contents (no .git)
  tasks/01/statement.md     # what the agent sees
  tasks/01/tests/test_*.py  # hidden oracle tests for task 1 (never copied into the agent workspace)
  tasks/02/...
  reference/01/             # full tree of the reference solution AFTER task 1 (cumulative)
  reference/02/...
  qualification/seed/  qualification/statement.md  qualification/tests/test_*.py  qualification/reference/
```

`taskset.json`:

```json
{
  "schema": "tg-taskset-1",
  "id": "<slug>",
  "version": "0.1.0",
  "language": "python",
  "python": ">=3.10",
  "seed": "seed",
  "test_runner": ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider"],
  "tasks": [
    {"index": 1, "id": "<slug>", "statement": "tasks/01/statement.md", "tests": "tasks/01/tests", "depends_on": []},
    {"index": 2, "id": "<slug>", "statement": "tasks/02/statement.md", "tests": "tasks/02/tests", "depends_on": [1]}
  ],
  "qualification": {"seed": "qualification/seed", "statement": "qualification/statement.md", "tests": "qualification/tests"}
}
```

Rules:
- K = 6 tasks for the measured design; V0 may ship fewer, but `index` is 1..K, contiguous.
- Runtime dependencies of the seed and of the tests: **stdlib + pytest only**.
- **Oracle for task k** = run `test_runner` against the workspace with the hidden tests of tasks 1..k (regression included) copied into a fresh temporary directory **outside** the workspace, with the workspace root on `sys.path` (`PYTHONPATH=<workspace>`). Exit code 0 = pass. Per-test results are recorded.
- `task_hash(k)` = sha256 over `statement` bytes + every file under `tests` (sorted by relative POSIX path; each entry = path + NUL + bytes). `task_set_sha` = sha256 over every file under `taskset/` (same encoding). The task-set repo ships a script that prints both; the runner recomputes them, never trusts a stored value.
- Sanity (the task-set repo tests this in CI): `reference/k` passes the oracle of task k; `seed` fails the oracle of task 1; `reference/k-1` fails the oracle of task k (the task is not already solved).

## 2. Runner CLI

```
tau-intent bench \
  --server ws://<arena-ip>:3000/ws --pin <PIN> \
  --participant-id <id> --nickname <name> \
  --provider-url http://localhost:11434/v1 --model <model-id> [--runner-kind ollama|lmstudio|llamacpp] \
  --taskset <path> --out <dir>
tau-intent bench --offline --arms A,B,C --seed 7 ...   # no server: owner's own rehearsal (E0)
```

- One model per invocation (one **cell** = machine × model).
- Talks to the model only through an OpenAI-compatible `/v1/chat/completions` endpoint, `temperature=0`, `seed` in the request body.
- Works with no network beyond the local model endpoint and the arena on the LAN.

## 3. Arena protocol (WebSocket `/ws` + HTTP), additive to the existing one

Runner → server (after the existing `register`, with `runner: "tau-intent"` and `model: <model-id>`):

```json
{"type":"bench_join","participant_id":"…","runner_version":"…","tau_intent_sha":"…","task_set_sha":"…",
 "model":{"id":"…","digest":"sha256:…|null","runner_kind":"ollama|lmstudio|llamacpp|other"},
 "hardware":{"os":"…","chip":"…","ram_gb":16,"accel":"cuda|metal|cpu|other"}}
```

Server → runner (sent when the owner starts the bench or (re)assigns this participant):

```json
{"type":"bench_assign","cell_id":"…","mode":"qualification|bench","arms":["B","A","C"],
 "seed":7,"k_max":6,"deadline_s":600,"max_productive_turns":8}
```

- `arms` is the **ordered** list the owner chose for this participant (default: all three, order shuffled with `seed`). The runner runs exactly these arms, interleaved by task index: k=1 for each arm in order, then k=2, …
- `mode:"qualification"` runs only Q0 in arm A, at most 2 attempts.
- A new `bench_assign` for a running cell is refused by the runner (it replies `bench_error`); the owner must `stop` first.

Runner → server:

```json
{"type":"bench_progress","cell_id":"…","arm_id":"A|B|C|Q","task_index":1,"phase":"start|turn|oracle|done","turn":3,"tokens_in":1200,"tokens_out":340}
{"type":"bench_record","cell_id":"…","record":{ …§4… }}
{"type":"bench_cell_done","cell_id":"…","records":18,"manifest_sha256":"…","truncated":false}
{"type":"bench_error","cell_id":"…","code":"…","message":"…"}
```

Server → runner: `{"type":"bench_stop","cell_id":"…"}` — the runner finishes the current (arm, task) as `terminated_by:"stopped"` for the remaining ones, never starts a new one, then uploads.

HTTP (arena server):

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/bench/assign` `{participant_id, arms, mode}` | owner (control) | assign arms; stored, sent as `bench_assign` on start or immediately if bench running |
| POST | `/bench/start` · `/bench/stop` | owner | start/stop the bench for the active session |
| GET | `/bench/state` | telão/control | participants, assignments, progress, counts |
| POST | `/bench/artifacts/:cellId` (body `application/gzip`, ≤ 200 MB) | runner | upload the cell bundle (§5); stored under `server/data/bench/<session>/<cellId>.tar.gz` with its sha256 |
| GET | `/export-bench.jsonl` | owner | one record per line, as received |
| GET | `/bench/artifacts` | owner | list of stored bundles with sha256 |

The server **stores records as received** (raw JSON) plus indexed columns; it never recomputes outcomes. Event log entries: `bench_started`, `bench_assigned`, `bench_joined`, `bench_record`, `bench_cell_done`, `bench_stopped`, `bench_artifacts_uploaded`.

## 4. Record — `gambiarra-coleta-2` (V0 draft)

One record per (cell, arm, task). Qualification attempts use `arm_id:"Q"`, `harness_id:"tau"`, `task_index:0` and are never mixed with arm A.

```json
{
  "schema_version": "gambiarra-coleta-2",
  "draft": true,
  "cell_id": "…", "participant_id": "…", "session_pin_hash": null,
  "arm_id": "A|B|C|Q", "harness_id": "tau|tau_intent|tau_intent_llm_rescue",
  "task_set_sha": "…", "task_index": 1, "task_id": "…", "task_hash": "…",
  "model": {"id": "…", "digest": null, "runner_kind": "ollama"},
  "hardware": {"os": "…", "chip": "…", "ram_gb": 16, "accel": "metal"},
  "arm_order": ["B","A","C"], "seed": 7,
  "mechanism": {"tau_intent_sha": "…", "tau_ai_version": "0.4.7", "config_sha256": "…", "flags": {"capture":true,"gate":true,"project":true,"serve":true,"llm_rescue":false}},
  "oracle": {"pass": true, "passed": 12, "failed": 0, "errors": 0, "duration_s": 3.1, "per_test": [{"nodeid":"…","outcome":"passed"}]},
  "evolution": {"commit_before": "…", "commit_after": "…", "files_changed": 3, "insertions": 40, "deletions": 5, "edit_size": 45, "untracked_created": ["pkg/new.py"]},
  "tokens": {"in": 0, "out": 0, "rescue_in": 0, "rescue_out": 0, "source": "provider_usage|missing", "cost_usd": 0},
  "turns": [{"turn_index": 1, "kind": "productive|block|rescue", "tokens_in": 0, "tokens_out": 0, "tool_calls": 2}],
  "mechanism_telemetry": {"verdict": "PASSA", "productive_turns": 4, "block_turns": 1, "bloco_vazio": false, "tokens_served": 210, "nao_avaliaveis": [], "servidas": []},
  "terminated_by": "completed|teto_turnos|deadline|stopped|error",
  "started_at": "ISO-8601", "ended_at": "ISO-8601",
  "artifacts": {"bundle": "<cellId>.tar.gz", "paths": {"transcript": "arms/B/task-01/transcript.jsonl", "diff": "arms/B/task-01/diff.patch", "manifest": "arms/B/task-01/manifest.json"}}
}
```

Constraints (validated by the runner before sending, by the arena on receipt, and by the vault check later):
- `arm_id`/`harness_id` bijection: A↔`tau`, B↔`tau_intent`, C↔`tau_intent_llm_rescue`, Q↔`tau`.
- Arm A: `flags` all false, no intent lines written, `block_turns == 0`.
- `tokens.source == "missing"` when the endpoint did not return usage; never estimate.
- `cost_usd == 0`.
- I-2: any ratio with an empty denominator is `null`, never 0 or 1.

## 5. Evolution data and bundle

Per cell, the runner keeps under `--out/<cellId>/`:

```
records.jsonl
cell.json                       # bench_assign + bench_join payloads, hashes, timings
arms/<A|B|C>/repo.bundle        # `git bundle create … --all` of the arm workspace: one commit per task
arms/<arm>/task-0k/transcript.jsonl  diff.patch  manifest.json  oracle.json
arms/<B|C>/intents.jsonl        # the intent log as published (append-only)
qualification/…
```

- Each arm workspace is a git repo initialised from `seed/` (commit `seed`), with **one commit per task** after the agent finishes (`task-0k`, including untracked files the agent created), whether or not the oracle passed. That commit series **is** the evolution data of the mini repo.
- The bundle is uploaded at `bench_cell_done`, and on `bench_stop`. If the upload fails, it stays on disk and the runner prints the path.

## 6. What V0 does not do

- No G2 freeze, no Holm, no claims. Records carry `"draft": true`.
- No sandboxing guarantee beyond a temporary workspace directory (container isolation is an open owner decision).
- No upstream PR is opened by the teams; the arena work goes to the owner's fork.
