# Solve Lab

Local tooling to record hand loops, build verify-ready traces, replay against the backend, and debug anti-cheat — without using the production frontend.

## Run

```sh
pnpm start:backend   # terminal 1 — game authority on :8787
pnpm start:solve     # terminal 2 — proxy UI on :4180
```

Open `http://127.0.0.1:4180`. The solve UI proxies WebSocket traffic to the backend (default `ws://127.0.0.1:8787/ws`).

The solve client runs **local physics** (`/shared/game-core.js`), full **GestureInterpreter**, and submits **`finish`** when a run ends above the verify threshold. Traces record **hands only** by default (server derives flaps on replay).

**Camera** starts on page load (no need to wait for the proxy). Open `http://127.0.0.1:4180` — not `file://`. Click **Camera** if the feed stays black after granting permission. MediaPipe falls back from GPU to CPU automatically.

## Script-first solve (recommended for 67)

### 1. Record a seamless hand loop

```sh
pnpm solve:record-loop
# → scripts/fixtures/loop.json (~3.2s, start ≈ end for tiling)
```

### 2. Build a full solve pack (hands + manual flaps, sim-tested to 67)

```sh
pnpm solve:build-pack
# → scripts/fixtures/solve-pack.json (~99s sim time)
```

Uses a gap-following bot locally; tiles your loop as continuous background hand motion.

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
| `TRACE_SCALE` | Compress `atMs` during `simulate-hands trace` replay |
| `SIMULATE_CLAIMED_SCORE` | Score passed to `finish` (default `67`) |
| `VERIFY_SCORE_THRESHOLD` | Minimum claim before replay (default `50`) |
| `SOLVE_MAX_MS` | Max sim time for `build-solve-pack` |
| `DISABLE_ANTI_CHEAT` | Skip heuristics (dev only) |

## Solve UI

* **Proxy + event log** — inspect `hands`, `flap`, `restart`, `finish`
* **Camera play** — MediaPipe + local sim; records hands-only traces
* **Sussy motion** — periodic hands only (anti-cheat bait); starts local run, does not clear pipes
* **Pipe solver** — deterministic pipe RNG + gap-targeted flaps (`shared/flap-solver.js`), verifies 67
* **Good replay** — replays an imported trace
* **Run solve pack** — loads `/fixtures/solve-pack.json` (from `pnpm solve:build-pack`)

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

Brief `leftY` / `rightY` dropouts in camera traces are fine. Prefer **hands-only** for packs built with manual flaps so the server is the single flap authority during gesture-derived runs; packs from `build-solve-pack` include explicit `manual` flaps.

## Backend alignment

`CLIENT_SIM=true`: server logs inputs during play. Verification on `finish` when claimed score **> 50**. Flag when replay score **≥ 67** and matches the claim.
