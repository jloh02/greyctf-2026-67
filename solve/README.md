# Solve Lab

Local tooling to record gesture clips, build legacy replay traces, replay against the backend, and debug verification behavior without using the production frontend.

## Run

```sh
pnpm start:backend   # terminal 1 — game authority on :8787
pnpm start:solve     # terminal 2 — proxy UI on :4180
```

Open `http://127.0.0.1:4180`. The solve UI proxies WebSocket traffic to the backend (default `ws://127.0.0.1:8787/ws`).

The solve client runs **local physics** (`/shared/game-core.js`), full **GestureInterpreter**, and submits **`finish`** when a run ends above the verify threshold. Camera traces record raw hand anchors by default; smoothing is only for gesture control. High-score backend verification now requires continuous camera frames plus randomized live snapshot challenges, compares server-extracted image landmarks against client telemetry, derives the authoritative replay trace from server-extracted video landmarks, and rejects explicit `flap` packets, including legacy `source: "gesture"` solve packs.

**Camera** starts on page load (no need to wait for the proxy). Open `http://127.0.0.1:4180` — not `file://`. Click **Camera** if the feed stays black after granting permission. MediaPipe falls back from GPU to CPU automatically.

## Script-first replay diagnostics

### 1. Record a stable -> 67 -> stable gesture clip

```sh
pnpm solve:record-loop
# → scripts/fixtures/loop.json
```

For capture experiments, use the solve UI camera recorder or an imported trace with one clean **stable -> 67 -> moving-hold** gesture: hold steady before the 67 motion, complete the 67 crossing, then keep small natural hand motion instead of freezing. The pack builder reverses that clip so each jump has smooth pre-flap hand leadup instead of a visible hand-position jump.

### 2. Build a legacy solve pack (now expected to fail verification)

```sh
pnpm solve:build-pack
# → scripts/fixtures/solve-pack.json (~101s sim time)
```

Uses a gap-following bot locally to choose pipe-safe jump times. The emitted trace uses the reversed gesture clip at varied per-jump speeds (`3.05, 3.28, 3.46, ...`) and sends legacy `source: "gesture"` flaps aligned to those jumps. Production verification rejects those explicit flaps; keep this pack as a regression case for the old trust bug.

### 3. Replay + verify on the backend

```sh
pnpm simulate:trace
# or with faster wall-clock (same sim timeline):
TRACE_SCALE=0.95 pnpm simulate:trace
```

Set `SIMULATE_CLAIMED_SCORE=67` (default). Requires backend running.

### Transform traces

```sh
node scripts/transform-trace.mjs scripts/fixtures/solve-pack.json --hands-only -o out.json
node scripts/transform-trace.mjs in.json --tile scripts/fixtures/loop.json --duration 120000 -o tiled.json
node scripts/transform-trace.mjs in.json --scale 0.95 -o faster.json
```

| Variable | Purpose |
|----------|---------|
| `TRACE_SCALE` | Compress `atMs` during `simulate-hands trace` replay; use only for experiments. High-score verification also checks live-paced wall-clock delivery and live snapshot challenges |
| `SIMULATE_CLAIMED_SCORE` | Score passed to `finish` (default `67`) |
| `VERIFY_SCORE_THRESHOLD` | Minimum claim before replay (default `50`) |
| `SNAPSHOT_LANDMARK_MODE` | `required` by default; use `off` only for local experiments without image landmark enforcement |
| `HAND_LANDMARK_SERVICE_URL` | HTTP endpoint that extracts hand landmarks from snapshot images |
| `VIDEO_VERIFY_MODE` | `required` by default; high-score runs must stream continuous camera frames for server-side landmark replay |
| `SOLVE_MAX_MS` | Max sim time for `build-solve-pack` |
| `SOLVE_OVERSHOOT` | Extra local target score for manual experiments; default solve pack keeps this at `0` |
| `DISABLE_ANTI_CHEAT` | Skip heuristics (dev only) |

All suite modes use the same WebSocket payloads as the **production frontend** (`shared/frontend-client.js`: `hands`, `flap` with `traceAtMs`, `finish`). Open the main game with `?solve=1` to run the suite in-browser.

## Solve suite (tiered)

### Valid vs verified

`valid=true` means the backend replayed the submitted trace, the replay score matched the claimed score, and no verification-only rejection fired. `verified=true` means the trace was both valid and met the 67-point win condition, so this is the only state that can return the flag. A run can finish locally and still be invalid if the server replay disagrees, sees manual flaps, or trips anti-cheat.

Blocked high-score verification failures intentionally return a generic public
message instead of the exact anti-cheat rule. Use backend logs while developing
to inspect the detailed internal reason.

| Tier | Method | Server verify 67? |
|------|--------|-------------------|
| 1 | **Empty claim** — `finish` with 67, no inputs | No (replay score 0) |
| 2a | **No pipe collision + altitude hold** — pass through **all pipe solids**; floor/ceiling still kill | No (server uses real pipe hits) |
| 2b | **No pipe/frame collision** — full local god-mode | No (server uses real physics) |
| 3 | **Mechanical probes** — gap bot + explicit `manual` flaps (`greedy` / hand-pulse / straight jitter) | No (manual flaps are rejected after a local finish) |
| 3b | **Exact 67 jitter burst** — mechanically repeated alternating 67-hand packets at each gesture-source flap | No (server jitter-burst check) |
| 4 | **Recorded gesture replay (legacy)** — one captured stable -> 67 -> moving-hold clip plus explicit gesture flaps | No (missing continuous video, missing live snapshots, and explicit flaps are rejected) |

Invalid paths are intentional diagnostics:

* `empty-claim`: proves a claimed score is not trusted without replay evidence.
* `no-collision-*`: proves local collision patches do not affect server verification.
* `mechanical-greedy` / `mechanical-sussy` / `mechanical-straight-jitter`: prove explicit manual flaps are rejected, even when the local run reaches the score.
* `mechanical-exact-67`: proves identical alternating 67-hand packets are not acceptable gesture evidence; the server jitter-burst check rejects the trace.
* `recorded-gesture-replay`: proves legacy `source: "gesture"` flaps and offline traces are no longer trusted as camera evidence.

```sh
pnpm solve:suite              # local scores per mode
pnpm solve:suite:verify       # also hit backend (needs start:backend)
pnpm solve:suite -- --mode recorded-gesture-replay --verify
```

Rebuild pack with a strategy/motion:

```sh
node scripts/build-solve-pack.mjs --tile scripts/fixtures/loop.json --strategy lookahead
node scripts/build-solve-pack.mjs --manual --motion human   # negative/manual-flap experiment
```

## Solve UI

* **Solve suite** dropdown — all tiered diagnostic methods with a legacy recorded replay path; connect proxy first for verify
* **Recorded 67 gesture replay (legacy)** auto-loads `solve-pack.json` when no trace is imported
* **Camera capture** — MediaPipe waits for two hands, counts down 3-2-1, records one 67-triggered flap, then holds a steady tail

## Trace format

```json
{
  "version": 1,
  "events": [
    { "atMs": 0, "message": { "type": "hands", "leftY": 0.43, "rightY": 0.57, "handCount": 2 } },
    { "atMs": 300, "message": { "type": "flap", "source": "manual" } }
  ]
}
```

Brief `leftY` / `rightY` dropouts in camera traces are fine. Verified camera runs need continuous, live-paced server video frames and valid live snapshot challenge responses; generated packs with explicit `flap` events are intentionally rejected.

## Backend alignment

`CLIENT_SIM=true`: server logs inputs during play. Verification on `finish` when claimed score **> 50**. Flag when replay score **≥ 67** and matches the claim.
