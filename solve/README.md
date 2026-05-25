# Solve Lab

Run the solve frontend with:

```sh
node solve/server.js
```

Open:

```sh
http://127.0.0.1:4180
```

Features:

* Proxies browser websocket traffic to the real backend, with a live event log.
* Preserves the normal camera-driven play path so you can record human `hands`/`flap` traffic.
* Includes a deterministic `sussy solve` that should accumulate anti-cheat suspicion quickly.
* Includes a `good solve replay` path that replays a recorded or imported human trace.

Trace notes:

* Manual play through the solve frontend records outbound gameplay messages.
* Once a run ends, the latest trace is stored in browser local storage.
* Export that trace to JSON or import one later to drive the good replay path.
