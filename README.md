<!--
Copy this README.md when starting a new challenge.

Required sections are Name, Description, Author, and Flag.

Read the Whale section below if the challenge needs per-team/per-user instances.
-->

# Name
67

# Description

Can you 67 on a merry christmas?

# Author
jloh02

# Flag
`grey{676676767676767_0110_0111_0110_0111_736978736576656E}`

# Challenge

Play flappy bird with 67 hand gestures. Reach a pipe score of **67** on a verified run to receive the flag.

# Game architecture

The browser runs the game simulation locally (`shared/game-core.js`) for responsive play. Raw webcam video never leaves the client; only hand samples and control messages go to the server over WebSocket.

| Phase | Client | Server |
|-------|--------|--------|
| Play | Local physics + rendering | Records `restart`, `hands`, and `flap` events with timestamps |
| End (score ≤ 50) | Shows final score | No replay; lightweight ack |
| End (score > 50) | Sends `{ type: "finish", score }` | Replays the input log, runs anti-cheat, returns `{ type: "verified" }` |

**Scoring**

- Pipe score is shown live on the client.
- **Flag threshold:** `WIN_SCORE` (67) from `shared/game-core.js` — also sent as `constants.winScore` / `config.winScore` in `welcome`.
- **Verification threshold:** scores strictly above `VERIFY_SCORE_THRESHOLD` (default 50). Anti-cheat heuristics apply only above that threshold during replay/live play (cadence, gesture leadup, frozen dual-hand streams, repeated amplitude, constant velocity).

**WebSocket messages (client → server)**

- `restart` — start a new run (clears server input log).
- `hands` — `{ leftY, rightY, handCount, clientTime }` hand-height samples (~60 Hz in camera mode).
- `flap` — keyboard/dev mode explicit flap (`source: "gesture" | "manual"`).
- `finish` — `{ score, clientTime }` after game over when verification is required.

**WebSocket messages (server → client)**

- `welcome` — `constants` (includes `winScore`), `config.winScore`, `config.verifyScoreThreshold`, session best score.
- `verified` — replay outcome, flag (if won), anti-cheat summary.

Set `CLIENT_SIM=false` on the backend to restore the older server-authoritative mode (live 60 TPS sim + 30 FPS state snapshots) for debugging.

# Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLIENT_SIM` | `true` | Log inputs during play; verify on `finish` instead of live authority |
| `VERIFY_SCORE_THRESHOLD` | `50` | Minimum claimed score before server replay |
| `FLAG` / `FINAL_FLAG` | — | Flag string returned when verified score ≥ 67 |
| `DISABLE_ANTI_CHEAT` | `false` | Skip heuristics (dev only) |
| `SPACE_67_KEYBOARD` | `false` | Space bar emits synthetic gesture flaps |
| `DIAGNOSTIC_PAGE` | `false` | Serve `/diagnostics` from the backend |

# Diagnostics

The hand-tracking diagnostic route is disabled by default. Start the frontend
with `DIAGNOSTIC_PAGE=true` to expose `/diagnostics`:

```sh
DIAGNOSTIC_PAGE=true npm run start:frontend
```

Open `http://127.0.0.1:4173/diagnostics` to view live hand-height, delta, threshold,
cross-count, and jump-trigger markers.

For Docker Compose, pass `DIAGNOSTIC_PAGE=true`; Compose forwards it to the
backend container, which serves `/diagnostics` when enabled.

# Local Development

**Single process (backend serves frontend):**

```sh
pnpm start
# or
pnpm start:backend
```

Open `http://127.0.0.1:8787` (set `DIAGNOSTIC_PAGE=true` in the start script for `/diagnostics`).

For the tiered solve suite on the **production UI**, add `?solve=1` (e.g. `http://127.0.0.1:8787?solve=1`) or use the solve lab at `http://127.0.0.1:4180`. Both use `shared/frontend-client.js` for the same `hands` / `flap` / `finish` wire format. Manual-flap mechanical traces are negative tests; the verify-ready solve pack uses a captured stable -> 67 -> stable gesture leadup and `source: "gesture"` jump events.

**Split frontend dev server:**

```sh
pnpm start:backend   # port 8787
pnpm start:frontend  # port 4173, proxies WS to backend
```

**Solve lab** (trace record/replay proxy): see [solve/README.md](solve/README.md).

**CLI simulation:**

```sh
pnpm simulate:sussy
pnpm simulate:human
pnpm simulate:trace
```

Docker local stack: [docker-compose.local.yml](docker-compose.local.yml)

```sh
docker compose -f docker-compose.local.yml up -d backend
```

App: `http://127.0.0.1:8787`

# HTTPS Deployment

The default [docker-compose.yml](/Users/jloh02/Documents/Programming/i26-q/docker-compose.yml)
is the production stack. It adds Nginx in front of the backend for TLS
termination, so a dedicated server can simply run `docker compose up -d`.

Set these environment variables before starting:

```sh
export SERVER_NAME=your-domain.example
export CERTBOT_DOMAIN=$SERVER_NAME
export APP_PORT=36367
```

The production compose file publishes a single host port: `${APP_PORT:-36367}`
on the Nginx TLS listener. The backend is only reachable inside the Docker
network.

Nginx expects host-managed TLS files at:

```sh
/etc/letsencrypt/live/$CERTBOT_DOMAIN/fullchain.pem
/etc/letsencrypt/live/$CERTBOT_DOMAIN/privkey.pem
```

Use DNS-01 or another certificate flow that does not require this compose stack
to publish port 80. After the certificate exists, normal startup is:

```sh
docker compose up -d
```

Nginx terminates TLS and proxies `/`, `/api/`, and `/ws` to the backend. Game traffic uses WebSocket frames (incremental `hands` samples); the `finish` message is small (`score` only). Increasing `client_max_body_size` is only needed if you add HTTP endpoints that accept full trace uploads — see comments in [nginx/default.conf.template](nginx/default.conf.template).
