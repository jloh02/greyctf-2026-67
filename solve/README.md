# Solve Lab

Local tooling to record human input traces, replay them against the real backend, and debug anti-cheat behavior.

## Run

```sh
node solve/server.js
# or
pnpm start:solve
```

Open `http://127.0.0.1:4180`.

The solve server proxies browser WebSocket traffic to the game backend (default `ws://127.0.0.1:8787/ws`) and logs every outbound message.

## Features

* **Proxy + event log** — inspect `hands`, `flap`, `restart`, and `finish` traffic in the UI.
* **Manual camera play** — same path as production; records a trace into browser local storage.
* **Sussy solve** — deterministic oscillating hand heights; should accumulate anti-cheat suspicion on replay verify.
* **Good solve replay** — replays an exported/imported human trace, then submits `finish` for server verification.

## Trace format

Traces are JSON objects with an `events` array. Each entry has `atMs` (offset from run start) and `message` (`hands`, `flap`, or `restart`). Brief `leftY` / `rightY` dropouts in camera traces are normal.

* Recording: play through the solve UI with the camera; the latest trace is saved to local storage on game over.
* Export / import: buttons in the solve UI, or use the CLI below.

## CLI replay

Requires the backend running (`pnpm start:backend`).

```sh
pnpm simulate:sussy
pnpm simulate:human
pnpm simulate:trace
# or any exported file:
node scripts/simulate-hands.mjs trace /path/to/67-trace.json
```

After replay, the CLI sends `finish` with `SIMULATE_CLAIMED_SCORE` (default `75` for sussy/trace, `55` for human) so the server replays the session log when the claim is above `VERIFY_SCORE_THRESHOLD` (50).

## Backend alignment

The production backend (`CLIENT_SIM=true` by default) does not simulate physics during play — it only logs inputs. Verification happens on `finish` when the claimed score is **> 50**. The flag requires a verified replay score **≥ 67**.

Useful env vars when testing:

| Variable | Purpose |
|----------|---------|
| `VERIFY_SCORE_THRESHOLD` | Minimum claim before replay (default `50`) |
| `SIMULATE_CLAIMED_SCORE` | Score the CLI passes to `finish` |
| `DISABLE_ANTI_CHEAT` | Skip heuristics (dev only) |
| `TARGET_WS_URL` | Alternate backend WebSocket URL |
