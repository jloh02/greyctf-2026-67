/**
 * 67 Flight backend — WebSocket game service.
 *
 * Default mode (CLIENT_SIM=true): the browser runs physics locally for smooth play.
 * The server only records input events (`restart`, `hands`, `flap`) and does not
 * broadcast live state. When a run ends with score > VERIFY_SCORE_THRESHOLD (50),
 * the client sends `{ type: "finish", score }` and the server replays the log through
 * shared/game-core.js plus gesture + anti-cheat heuristics. The flag is granted when
 * replay score >= WIN_SCORE and the claim matches.
 *
 * Anti-cheat heuristics run only while replay/live score is above VERIFY_SCORE_THRESHOLD.
 *
 * Set CLIENT_SIM=false to restore the older server-authoritative loop (60 TPS sim,
 * 30 FPS state snapshots) for debugging or tooling.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import {
  GAME_CONSTANTS,
  WIN_SCORE,
  applyFlap as applyCoreFlap,
  createGameState,
  stepGameState,
} from "../shared/game-core.js";

const PORT = Number(process.env.PORT || "8787");
const HOST = process.env.HOST || "127.0.0.1";
const SPACE_67_KEYBOARD = parseBoolean(process.env.SPACE_67_KEYBOARD, false);
const DISABLE_ANTI_CHEAT = parseBoolean(process.env.DISABLE_ANTI_CHEAT, false);
const FINAL_FLAG = process.env.FINAL_FLAG || process.env.FLAG || "";
const DIAGNOSTIC_PAGE = parseBoolean(process.env.DIAGNOSTIC_PAGE, false);
const FRONTEND_ROOT = resolve(process.cwd(), "frontend");
const SHARED_ROOT = resolve(process.cwd(), "shared");
const FIXTURES_ROOT = resolve(process.cwd(), "scripts/fixtures");
const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".ico", "image/x-icon"],
]);

const GAME_WIDTH = GAME_CONSTANTS.width;
const GAME_HEIGHT = GAME_CONSTANTS.height;
const BIRD_X = GAME_CONSTANTS.birdX;
const BIRD_RADIUS = GAME_CONSTANTS.birdRadius;
const FLOOR_Y = GAME_CONSTANTS.floorY;
const TICK_SECONDS = 1 / 60;
const TICK_MS = TICK_SECONDS * 1000;
const STATE_SEND_MS = 1000 / 30;
const MAX_LAG_COMPENSATION_MS = 200;
const MAX_GESTURE_REPLAY_MS = 420;
const HISTORY_CAPACITY = 16;
const HAND_SAMPLE_HISTORY_CAPACITY = 96;
const CLIENT_SIM = parseBoolean(process.env.CLIENT_SIM, true);
// Runs with claimed score above this value are replay-verified on `finish`.
const VERIFY_SCORE_THRESHOLD = Number(process.env.VERIFY_SCORE_THRESHOLD || "50");
const FLAG_SCORE_HINT = `psss... hearsay the score you need to hit is ${WIN_SCORE}!`;
const GESTURE_CONFIG = {
  crossThreshold: 0.08,
  minCrossesPerFlap: 2,
  trackingGraceMs: 420,
  anchorSmoothing: 0.45,
  fastAnchorSmoothing: 0.72,
  fastMovementThreshold: 0.075,
  jumpDebounceMs: 150,
  levelResetMs: 360,
};
const ANTI_CHEAT = {
  maxFlapsPerSecond: 8,
  scoreDecayPerSecond: 40,
  blockScore: 150,
  cadenceAudit: {
    minSamples: 12,
    minMeanMs: 88,
    maxStdDevMs: 2,
    maxCv: 0.015,
    score: 35,
    cooldownMs: 2500,
  },
  gestureLeadup: {
    windowMs: 420,
    minSamples: 3,
    maxSampleGapMs: 280,
    missingEvidenceScore: 15,
    cooldownMs: 2000,
  },
  repeatedAmplitude: {
    minSamples: 10,
    minMean: 0.18,
    maxCv: 0.1,
    score: 16,
    cooldownMs: 2000,
  },
  jitterBurst: {
    minSamples: 10,
    maxSpanMs: 20,
    minMean: 0.18,
    score: 160,
    cooldownMs: 1500,
  },
  constantVelocity: {
    minSamples: 10,
    minAbsVelocity: 0.0012,
    maxCv: 0.15,
    minDirectionChanges: 4,
    score: 14,
    cooldownMs: 2000,
  },
  frozenHands: {
    windowMs: 900,
    minSamples: 20,
    minSpanMs: 450,
    maxRange: 1e-5,
    score: 18,
    cooldownMs: 2500,
  },
};

const sockets = new Set();

const server = createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(400).end("Bad request");
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/api/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        sockets: sockets.size,
        space67Keyboard: SPACE_67_KEYBOARD,
        antiCheatEnabled: !DISABLE_ANTI_CHEAT,
        diagnosticPage: DIAGNOSTIC_PAGE,
        clientSim: CLIENT_SIM,
        winScore: WIN_SCORE,
        verifyScoreThreshold: VERIFY_SCORE_THRESHOLD,
      }),
    );
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  await serveFrontend(url.pathname, response);
});

async function serveFrontend(pathname, response) {
  const requestedPath = resolveStaticPath(pathname);
  if (!requestedPath) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }

  try {
    const fileStat = await stat(requestedPath);
    if (!fileStat.isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }

    response.writeHead(200, {
      "content-type": MIME_TYPES.get(extname(requestedPath)) || "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(requestedPath).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  }
}

function resolveStaticPath(pathname) {
  if (pathname.startsWith("/shared/")) {
    const sharedRelativePath = normalize(decodeURIComponent(pathname.slice("/shared/".length))).replace(
      /^(\.\.(\/|\\|$))+/,
      "",
    );
    const sharedAbsolutePath = resolve(join(SHARED_ROOT, sharedRelativePath));
    if (!sharedAbsolutePath.startsWith(SHARED_ROOT)) {
      return null;
    }
    return sharedAbsolutePath;
  }

  if (pathname.startsWith("/fixtures/")) {
    const fixturesRelativePath = normalize(decodeURIComponent(pathname.slice("/fixtures/".length))).replace(
      /^(\.\.(\/|\\|$))+/,
      "",
    );
    const fixturesAbsolutePath = resolve(join(FIXTURES_ROOT, fixturesRelativePath));
    if (!fixturesAbsolutePath.startsWith(FIXTURES_ROOT)) {
      return null;
    }
    return fixturesAbsolutePath;
  }

  let requestedPath = pathname;
  if (requestedPath === "/") {
    requestedPath = "/index.html";
  } else if ((requestedPath === "/diagnostics" || requestedPath === "/diagnostics/") && DIAGNOSTIC_PAGE) {
    requestedPath = "/diagnostics.html";
  } else if (requestedPath === "/diagnostics" || requestedPath === "/diagnostics/" || requestedPath === "/diagnostics.html") {
    return null;
  }

  const normalized = normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.(\/|\\|$))+/, "");
  const absolutePath = resolve(join(FRONTEND_ROOT, normalized));
  if (!absolutePath.startsWith(FRONTEND_ROOT)) {
    return null;
  }

  return absolutePath;
}

server.on("upgrade", (request, socket) => {
  if (request.url && new URL(request.url, `http://${request.headers.host}`).pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (!key || request.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }

  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );

  const client = new GameSocket(socket);
  sockets.add(client);
});

server.listen(PORT, HOST, () => {
  console.log(`67 Flight backend listening on http://${HOST}:${PORT}`);
  console.log(`SPACE_67_KEYBOARD=${SPACE_67_KEYBOARD}`);
  console.log(`DISABLE_ANTI_CHEAT=${DISABLE_ANTI_CHEAT}`);
  console.log(`CLIENT_SIM=${CLIENT_SIM}`);
  console.log(`WIN_SCORE=${WIN_SCORE}`);
  console.log(`VERIFY_SCORE_THRESHOLD=${VERIFY_SCORE_THRESHOLD}`);
  console.log(`DIAGNOSTIC_PAGE=${DIAGNOSTIC_PAGE}${DIAGNOSTIC_PAGE ? " (/diagnostics enabled)" : ""}`);
});

setInterval(() => {
  const now = performance.now();
  for (const client of sockets) {
    client.tick(TICK_SECONDS, now);
  }
}, TICK_SECONDS * 1000);

class GameSocket {
  constructor(socket) {
    this.id = randomUUID();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.lastStateSent = 0;
    this.sessionStartWall = Date.now();
    this.sessionStartPerf = performance.now();
    this.rttMs = 0;
    this.oneWayLagMs = 0;
    this.clockOffsetMs = 0;
    this.game = new GameSession(this.id);
    this.clientSim = CLIENT_SIM;
    this.runLog = [];
    this.runStartPerf = performance.now();

    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("close", () => this.close());
    socket.on("error", () => this.close());

    this.send({
      type: "welcome",
      id: this.id,
      constants: {
        ...GAME_CONSTANTS,
      },
      config: {
        space67Keyboard: SPACE_67_KEYBOARD,
        antiCheatEnabled: !DISABLE_ANTI_CHEAT,
        clientSim: CLIENT_SIM,
        winScore: WIN_SCORE,
        verifyScoreThreshold: VERIFY_SCORE_THRESHOLD,
        gesture: GESTURE_CONFIG,
      },
      session: {
        best: this.game.best,
      },
    });
    if (this.clientSim) {
      this.beginRunLog();
      this.game.log("Client-sim session started. Inputs are logged for replay verification.", "info");
    } else {
      this.game.log("Server-authoritative room started.", "info");
      this.sendState(performance.now(), true);
    }
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const frame = parseFrame(this.buffer);
      if (!frame) {
        return;
      }
      this.buffer = this.buffer.subarray(frame.bytes);

      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode === 0x9) {
        this.writeFrame(frame.payload, 0xA);
        continue;
      }
      if (frame.opcode !== 0x1) {
        continue;
      }

      try {
        const message = JSON.parse(frame.payload.toString("utf8"));
        this.handleMessage(message);
      } catch {
        this.game.log("Malformed client message ignored.", "warn");
      }
    }
  }

  handleMessage(message) {
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "ping") {
      this.handlePing(message);
      return;
    }

    if (message.type === "sync") {
      this.updateLatency(message);
      return;
    }

    if (message.type === "flap") {
      if (this.clientSim) {
        this.recordRunEvent(message);
        return;
      }
      const actionTime = this.clientPerfTime(message.clientTime);
      this.game.flap(message.source === "gesture" ? "67 gesture" : "manual input", actionTime);
      this.sendState(performance.now(), true);
      if (this.game.disconnectReason) {
        this.close(1008, this.game.disconnectReason);
      }
      return;
    }

    if (message.type === "hands") {
      if (this.clientSim) {
        this.recordRunEvent(message);
        return;
      }
      const sampleTime = this.clientPerfTime(message.clientTime);
      const triggered = this.game.processHandSample(message, sampleTime);
      if (triggered) {
        this.sendState(performance.now(), true);
        if (this.game.disconnectReason) {
          this.close(1008, this.game.disconnectReason);
        }
      }
      return;
    }

    if (message.type === "restart") {
      this.game.reset();
      if (this.clientSim) {
        this.beginRunLog();
        this.game.log("Run reset by client.", "info");
        return;
      }
      this.game.log("Run reset by client.", "info");
      this.sendState(performance.now(), true);
      return;
    }

    if (message.type === "finish") {
      this.handleFinish(message);
    }
  }

  beginRunLog() {
    this.runStartPerf = performance.now();
    this.runLog = [{ type: "restart", atMs: 0 }];
  }

  /** Append a replayable input event while CLIENT_SIM is active. */
  recordRunEvent(message) {
    const atMs = Number.isFinite(message.traceAtMs)
      ? clamp(message.traceAtMs, 0, 600000)
      : performance.now() - this.runStartPerf;
    const entry = { type: message.type, atMs };
    if (message.type === "hands") {
      entry.leftY = message.leftY;
      entry.rightY = message.rightY;
      entry.handCount = message.handCount;
    } else if (message.type === "flap") {
      entry.source = message.source;
    }
    this.runLog.push(entry);
  }

  /** Replay the session log when claimed score exceeds VERIFY_SCORE_THRESHOLD. */
  handleFinish(message) {
    const claimedScore = clampInteger(message.score, 0, WIN_SCORE);
    if (claimedScore <= VERIFY_SCORE_THRESHOLD) {
      this.send({
        type: "verified",
        valid: true,
        verified: false,
        score: claimedScore,
        claimedScore,
        won: claimedScore >= WIN_SCORE,
        flag: "",
        message: "",
        antiCheat: GameSession.disabledAntiCheatSnapshot(),
      });
      return;
    }

    const result = GameSession.verifyRecordedRun(this.runLog, claimedScore);
    if (result.valid) {
      this.game.best = Math.max(this.game.best, result.score);
    }

    if (result.blocked) {
      this.close(1008, result.message);
      return;
    }

    this.send({
      type: "verified",
      verified: true,
      valid: result.valid,
      score: result.score,
      claimedScore,
      won: result.won,
      flag: result.flag,
      message: result.message,
      hint: FLAG_SCORE_HINT,
      antiCheat: result.antiCheat,
    });
  }

  handlePing(message) {
    const serverRecv = Date.now();
    this.send({
      type: "pong",
      clientTime: message.clientTime,
      serverRecv,
      serverTime: Date.now(),
    });
  }

  updateLatency(message) {
    if (Number.isFinite(message.rttMs)) {
      this.rttMs = clamp(message.rttMs, 0, 2000);
      this.oneWayLagMs = Math.min(this.rttMs / 2, MAX_LAG_COMPENSATION_MS);
    }

    if (Number.isFinite(message.clockOffsetMs)) {
      this.clockOffsetMs = clamp(message.clockOffsetMs, -5000, 5000);
    }
  }

  clientPerfTime(clientTime) {
    const now = performance.now();
    if (!Number.isFinite(clientTime)) {
      return now - this.oneWayLagMs;
    }

    if (this.rttMs === 0) {
      return now;
    }

    const clientAsServerWall = clientTime + this.clockOffsetMs;
    const elapsedWall = clientAsServerWall - this.sessionStartWall;
    return this.sessionStartPerf + elapsedWall - this.oneWayLagMs;
  }

  tick(dt, now) {
    if (this.closed || this.clientSim) {
      return;
    }
    this.game.tick(dt, now);
    if (now - this.lastStateSent >= STATE_SEND_MS) {
      this.sendState(now);
    }
  }

  sendState(now, force = false) {
    if (!force && now - this.lastStateSent < STATE_SEND_MS) {
      return;
    }
    this.lastStateSent = now;
    this.send({ type: "state", state: this.game.snapshot(), serverTime: Date.now() });
  }

  send(message) {
    if (this.closed) {
      return;
    }
    this.writeFrame(Buffer.from(JSON.stringify(message), "utf8"));
  }

  writeFrame(payload, opcode = 0x1) {
    if (this.closed) {
      return;
    }

    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(code = 1000, reason = "closed") {
    if (this.closed) {
      return;
    }
    sockets.delete(this);

    if (!this.socket.destroyed) {
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2);
      this.writeFrame(payload, 0x8);
      this.socket.end();
    }
    this.closed = true;
  }
}

class GameSession {
  constructor(playerId) {
    this.playerId = playerId;
    this.best = 0;
    this.gesture = new ServerGestureInterpreter({
      onFlap: (time) => {
        if (this.verifyReplay) {
          return;
        }
        this.flap("67 gesture", time);
      },
      config: GESTURE_CONFIG,
    });
    this.history = [];
    this.reset();
  }

  reset() {
    Object.assign(this, createGameState());
    this.disconnectReason = "";
    this.flapTimes = [];
    this.acceptedFlapCount = 0;
    this.handSamples = [];
    this.activeRawHands = [];
    this.antiCheatScore = 0;
    this.antiCheatLastUpdateAt = performance.now();
    this.antiCheatCooldowns = {};
    this.lastSuspicionDetail = "";
    this.lastSuspicionAt = 0;
    this.lastSuspicionKey = "";
    if (!this.verifyReplay) {
      this.claimedScore = 0;
    }
    this.history = [];
    this.replaying = false;
    this.gesture.reset();
  }

  antiCheatApplies() {
    if (DISABLE_ANTI_CHEAT || SPACE_67_KEYBOARD) {
      return false;
    }

    return this.score > VERIFY_SCORE_THRESHOLD;
  }

  flap(source, actionTimeMs = performance.now()) {
    if (this.verifyReplay) {
      const verdict = this.auditFlap(source, actionTimeMs);
      if (verdict.blocked) {
        this.gameOver = true;
        this.disconnectReason = verdict.message;
        return;
      }
      if (verdict.message) {
        this.log(verdict.message, verdict.level);
      }
      applyCoreFlap(this, GAME_CONSTANTS);
      this.flapTimes.push(actionTimeMs);
      this.flapTimes = this.flapTimes.slice(-12);
      this.acceptedFlapCount += 1;
      return;
    }

    let preservedHandSamples = null;
    if (this.gameOver) {
      preservedHandSamples = this.handSamples.map((sample) => ({ ...sample }));
      this.reset();
      if (source === "67 gesture" && preservedHandSamples.length > 0) {
        this.handSamples = preservedHandSamples;
      }
      this.log("Run restarted by flap.", "info");
    }

    const now = performance.now();
    const maxReplayMs = source === "67 gesture" ? MAX_GESTURE_REPLAY_MS : MAX_LAG_COMPENSATION_MS;
    const effectiveTime = clamp(
      Number.isFinite(actionTimeMs) ? actionTimeMs : now,
      now - maxReplayMs,
      now,
    );

    if (effectiveTime < now - 1) {
      this.replayTo(effectiveTime, () => this.applyFlapEffect(source, effectiveTime), now);
      return;
    }

    this.applyFlapEffect(source, effectiveTime);
  }

  applyFlapEffect(source, auditTime) {
    const verdict = this.auditFlap(source, auditTime);
    if (verdict.blocked) {
      this.gameOver = true;
      this.disconnectReason = verdict.message;
      this.log(verdict.message, "danger");
      return;
    }

    if (verdict.message) {
      this.log(verdict.message, verdict.level);
    }

    applyCoreFlap(this, GAME_CONSTANTS);
    this.flapTimes.push(auditTime);
    this.flapTimes = this.flapTimes.slice(-12);
    this.acceptedFlapCount += 1;
    this.log(`Accepted flap from ${source}.`, "info");
  }

  processHandSample(message, sampleTime = performance.now()) {
    const sample = {
      leftY: normalizedOrNull(message.leftY),
      rightY: normalizedOrNull(message.rightY),
      handCount: clampInteger(message.handCount, 0, 2),
    };
    const telemetry = this.gesture.process(sample, sampleTime);
    this.recordHandSampleFromTelemetry(telemetry, sampleTime);

    if (
      sample.handCount >= 2 &&
      sample.leftY !== null &&
      sample.rightY !== null &&
      telemetry.tracking === "active"
    ) {
      this.recordActiveRawHandSample(sample.leftY, sample.rightY, sampleTime);
      const verdict = this.auditFrozenHands(sampleTime);
      if (verdict?.blocked) {
        this.gameOver = true;
        this.disconnectReason = verdict.message;
      } else if (verdict?.message) {
        this.log(verdict.message, verdict.level ?? "warn");
      }
    }

    return telemetry.triggered;
  }

  recordHandSampleFromTelemetry(telemetry, now) {
    let leftHeight = telemetry.leftHeight;
    let rightHeight = telemetry.rightHeight;
    let delta = telemetry.delta;

    if (!Number.isFinite(delta) && Number.isFinite(leftHeight) && Number.isFinite(rightHeight)) {
      delta = leftHeight - rightHeight;
    }

    if (
      !Number.isFinite(leftHeight) ||
      !Number.isFinite(rightHeight) ||
      !Number.isFinite(delta)
    ) {
      leftHeight = this.gesture.heights[0];
      rightHeight = this.gesture.heights[1];
      if (Number.isFinite(leftHeight) && Number.isFinite(rightHeight)) {
        delta = leftHeight - rightHeight;
      } else {
        return;
      }
    }

    this.handSamples.push({
      t: now,
      leftHeight,
      rightHeight,
      delta,
    });
    if (this.handSamples.length > HAND_SAMPLE_HISTORY_CAPACITY) {
      this.handSamples.shift();
    }
  }

  recordActiveRawHandSample(leftY, rightY, now) {
    this.activeRawHands.push({ t: now, leftY, rightY });
    const windowStart = now - ANTI_CHEAT.frozenHands.windowMs;
    while (this.activeRawHands.length > 0 && this.activeRawHands[0].t < windowStart) {
      this.activeRawHands.shift();
    }
  }

  auditFrozenHands(now) {
    if (!this.antiCheatApplies()) {
      return null;
    }

    this.decayAntiCheatScore(now);

    const windowStart = now - ANTI_CHEAT.frozenHands.windowMs;
    const recent = this.activeRawHands.filter((sample) => sample.t >= windowStart);
    if (recent.length < ANTI_CHEAT.frozenHands.minSamples) {
      return null;
    }

    const spanMs = recent.at(-1).t - recent[0].t;
    if (spanMs < ANTI_CHEAT.frozenHands.minSpanMs) {
      return null;
    }

    const leftValues = recent.map((sample) => sample.leftY);
    const rightValues = recent.map((sample) => sample.rightY);
    const leftRange = Math.max(...leftValues) - Math.min(...leftValues);
    const rightRange = Math.max(...rightValues) - Math.min(...rightValues);
    if (
      leftRange <= ANTI_CHEAT.frozenHands.maxRange &&
      rightRange <= ANTI_CHEAT.frozenHands.maxRange
    ) {
      return this.addSuspicion(
        ANTI_CHEAT.frozenHands.score,
        "frozen",
        "dual-hand tracking stayed perfectly still for too long.",
        now,
        ANTI_CHEAT.frozenHands.cooldownMs,
      );
    }

    return null;
  }

  recordHistory(now) {
    if (this.replaying) {
      return;
    }

    this.history.push(this.captureSnapshot(now));
    if (this.history.length > HISTORY_CAPACITY) {
      this.history.shift();
    }
  }

  captureSnapshot(now) {
    return {
      t: now,
      birdY: this.birdY,
      velocity: this.velocity,
      elapsed: this.elapsed,
      spawnTimer: this.spawnTimer,
      score: this.score,
      best: this.best,
      gameOver: this.gameOver,
      awaitingStart: this.awaitingStart,
      flapTimes: [...this.flapTimes],
      handSamples: this.handSamples.map((sample) => ({ ...sample })),
      antiCheatScore: this.antiCheatScore,
      antiCheatLastUpdateAt: this.antiCheatLastUpdateAt,
      antiCheatCooldowns: { ...this.antiCheatCooldowns },
      nextPipeId: this.nextPipeId,
      pipes: this.pipes.map((pipe) => ({ ...pipe })),
    };
  }

  restoreSnapshot(snapshot) {
    this.birdY = snapshot.birdY;
    this.velocity = snapshot.velocity;
    this.elapsed = snapshot.elapsed;
    this.spawnTimer = snapshot.spawnTimer;
    this.score = snapshot.score;
    this.best = snapshot.best;
    this.gameOver = snapshot.gameOver;
    this.awaitingStart = snapshot.awaitingStart;
    this.flapTimes = [...snapshot.flapTimes];
    this.handSamples = snapshot.handSamples.map((sample) => ({ ...sample }));
    this.antiCheatScore = snapshot.antiCheatScore;
    this.antiCheatLastUpdateAt = snapshot.antiCheatLastUpdateAt;
    this.antiCheatCooldowns = { ...snapshot.antiCheatCooldowns };
    this.nextPipeId = snapshot.nextPipeId;
    this.pipes = snapshot.pipes.map((pipe) => ({ ...pipe }));
  }

  findSnapshotAtOrBefore(targetMs) {
    let best = null;
    for (const snapshot of this.history) {
      if (snapshot.t <= targetMs && (!best || snapshot.t > best.t)) {
        best = snapshot;
      }
    }
    return best;
  }

  replayTo(targetMs, applyAction, endMs) {
    const snapshot = this.findSnapshotAtOrBefore(targetMs);
    if (!snapshot) {
      applyAction();
      return;
    }

    this.replaying = true;
    try {
      this.restoreSnapshot(snapshot);
      let t = snapshot.t;

      while (t + TICK_MS <= targetMs && !this.gameOver) {
        this.tick(TICK_SECONDS, t + TICK_MS);
        t += TICK_MS;
      }

      if (!this.gameOver) {
        applyAction();
      }

      while (t + TICK_MS <= endMs && !this.gameOver) {
        this.tick(TICK_SECONDS, t + TICK_MS);
        t += TICK_MS;
      }

      const remainingMs = endMs - t;
      if (remainingMs > 0.5 && !this.gameOver) {
        this.tick(remainingMs / 1000, endMs);
      }
    } finally {
      this.replaying = false;
      this.history = [];
    }
  }

  auditFlap(source, now) {
    if (this.verifyReplay && source !== "67 gesture") {
      return {
        blocked: true,
        message:
          "Verification failed: explicit manual flaps are not valid camera-gesture evidence.",
      };
    }

    if (!this.antiCheatApplies()) {
      return { blocked: false };
    }

    this.decayAntiCheatScore(now);

    const recent = this.flapTimes.filter((time) => now - time < 1000);
    if (recent.length >= ANTI_CHEAT.maxFlapsPerSecond) {
      return {
        blocked: true,
        message: "Disconnected: biological speed limit exceeded.",
      };
    }

    if (this.flapTimes.length >= ANTI_CHEAT.cadenceAudit.minSamples) {
      const sample = [...this.flapTimes.slice(-9), now];
      const deltas = sample.slice(1).map((time, index) => time - sample[index]);
      const meanDelta = average(deltas);
      const deviation = standardDeviation(deltas);
      const coefficient = coefficientOfVariation(deltas);
      if (
        meanDelta >= ANTI_CHEAT.cadenceAudit.minMeanMs &&
        deviation <= ANTI_CHEAT.cadenceAudit.maxStdDevMs &&
        coefficient <= ANTI_CHEAT.cadenceAudit.maxCv
      ) {
        const verdict = this.addSuspicion(
          ANTI_CHEAT.cadenceAudit.score,
          "cadence",
          "perfect timing quantization detected.",
          now,
          ANTI_CHEAT.cadenceAudit.cooldownMs,
        );
        if (verdict) {
          return verdict;
        }
      }
    }

    if (source === "67 gesture") {
      const verdict = this.auditGestureLeadup(now);
      if (verdict) {
        return verdict;
      }
    }

    return { blocked: false };
  }

  decayAntiCheatScore(now) {
    if (!Number.isFinite(this.antiCheatLastUpdateAt)) {
      this.antiCheatLastUpdateAt = now;
      return;
    }

    const elapsedMs = Math.max(0, now - this.antiCheatLastUpdateAt);
    this.antiCheatLastUpdateAt = now;
    const decay = (elapsedMs / 1000) * ANTI_CHEAT.scoreDecayPerSecond;
    this.antiCheatScore = Math.max(0, this.antiCheatScore - decay);
  }

  addSuspicion(score, key, detail, now, cooldownMs) {
    const lastHit = this.antiCheatCooldowns[key] ?? -Infinity;
    if (now - lastHit < cooldownMs) {
      return null;
    }

    this.antiCheatCooldowns[key] = now;
    this.antiCheatScore += score;
    this.lastSuspicionDetail = detail;
    this.lastSuspicionAt = now;
    this.lastSuspicionKey = key;
    this.log(`Anti-cheat suspicion +${score}: ${detail} (score=${this.antiCheatScore.toFixed(1)}).`, "warn");
    if (this.antiCheatScore >= ANTI_CHEAT.blockScore) {
      return {
        blocked: true,
        message: "Disconnected: anti-cheat heuristics flagged scripted inputs.",
      };
    }
    return {
      blocked: false,
      warned: true,
      level: "warn",
      message: `Suspicious input detected: ${detail}`,
    };
  }

  static disabledAntiCheatSnapshot() {
    return {
      enabled: false,
      score: 0,
      blockScore: ANTI_CHEAT.blockScore,
      level: "disabled",
      message: "",
      lastHeuristic: "",
    };
  }

  antiCheatSnapshot() {
    if (DISABLE_ANTI_CHEAT) {
      return GameSession.disabledAntiCheatSnapshot();
    }

    if (!this.antiCheatApplies()) {
      return GameSession.disabledAntiCheatSnapshot();
    }

    const score = this.antiCheatScore;
    const blockScore = ANTI_CHEAT.blockScore;
    let level = "none";
    if (this.disconnectReason) {
      level = "blocked";
    } else if (score >= blockScore * 0.7) {
      level = "critical";
    } else if (score >= blockScore * 0.25) {
      level = "warning";
    }

    return {
      enabled: true,
      score: Math.round(score * 10) / 10,
      blockScore,
      level,
      message: this.disconnectReason || (score > 0 ? this.lastSuspicionDetail : "") || "",
      lastHeuristic: this.lastSuspicionKey || "",
    };
  }

  auditGestureLeadup(now) {
    const recentTrackingMs = now - this.gesture.lastSeenAt;
    const windowStart = now - ANTI_CHEAT.gestureLeadup.windowMs;
    const recent = this.handSamples.filter((sample) => sample.t >= windowStart && sample.t <= now);
    const lastSample = recent.at(-1);
    const motionGapMs = lastSample ? now - lastSample.t : Infinity;
    const hadRecentHandTracking = recentTrackingMs <= GESTURE_CONFIG.trackingGraceMs;
    const sparseSamples =
      recent.length < ANTI_CHEAT.gestureLeadup.minSamples ||
      !lastSample ||
      motionGapMs > ANTI_CHEAT.gestureLeadup.maxSampleGapMs;

    if (sparseSamples && !hadRecentHandTracking) {
      return this.addSuspicion(
        ANTI_CHEAT.gestureLeadup.missingEvidenceScore,
        "leadup",
        "gesture flap arrived with sparse recent hand-motion evidence.",
        now,
        ANTI_CHEAT.gestureLeadup.cooldownMs,
      );
    }

    if (recent.length < 2) {
      return null;
    }

    const excursionAmplitudes = recent
      .map((sample) => Math.abs(sample.delta))
      .filter((amplitude) => amplitude >= GESTURE_CONFIG.crossThreshold * 1.25);
    const excursionSamples = recent.filter(
      (sample) => Math.abs(sample.delta) >= GESTURE_CONFIG.crossThreshold * 1.25,
    );
    if (excursionSamples.length >= ANTI_CHEAT.jitterBurst.minSamples) {
      const spanMs = excursionSamples.at(-1).t - excursionSamples[0].t;
      const meanAmplitude = average(excursionSamples.map((sample) => Math.abs(sample.delta)));
      if (
        spanMs <= ANTI_CHEAT.jitterBurst.maxSpanMs &&
        meanAmplitude >= ANTI_CHEAT.jitterBurst.minMean
      ) {
        const verdict = this.addSuspicion(
          ANTI_CHEAT.jitterBurst.score,
          "jitter",
          "mechanical hand jitter burst before gesture flap.",
          now,
          ANTI_CHEAT.jitterBurst.cooldownMs,
        );
        if (verdict) {
          return verdict;
        }
      }
    }
    if (excursionAmplitudes.length >= ANTI_CHEAT.repeatedAmplitude.minSamples) {
      const meanAmplitude = average(excursionAmplitudes);
      const amplitudeCv = coefficientOfVariation(excursionAmplitudes);
      if (
        meanAmplitude >= ANTI_CHEAT.repeatedAmplitude.minMean &&
        amplitudeCv <= ANTI_CHEAT.repeatedAmplitude.maxCv
      ) {
        const verdict = this.addSuspicion(
          ANTI_CHEAT.repeatedAmplitude.score,
          "amplitude",
          "repeated near-identical gesture amplitudes.",
          now,
          ANTI_CHEAT.repeatedAmplitude.cooldownMs,
        );
        if (verdict) {
          return verdict;
        }
      }
    }

    const velocityFeatures = deltaVelocityFeatures(recent);
    if (
      velocityFeatures.count >= ANTI_CHEAT.constantVelocity.minSamples &&
      velocityFeatures.meanAbs >= ANTI_CHEAT.constantVelocity.minAbsVelocity &&
      velocityFeatures.directionChanges >= ANTI_CHEAT.constantVelocity.minDirectionChanges &&
      velocityFeatures.cv <= ANTI_CHEAT.constantVelocity.maxCv
    ) {
      const verdict = this.addSuspicion(
        ANTI_CHEAT.constantVelocity.score,
        "velocity",
        "hand deltas oscillated at near-constant speed.",
        now,
        ANTI_CHEAT.constantVelocity.cooldownMs,
      );
      if (verdict) {
        return verdict;
      }
    }

    return null;
  }

  tick(dt, now) {
    if (this.gameOver || this.awaitingStart) {
      return;
    }

    const previousScore = this.score;
    const wasGameOver = this.gameOver;
    stepGameState(this, dt, GAME_CONSTANTS);
    if (this.score > previousScore) {
      this.best = Math.max(this.best, this.score);
    }

    if (!wasGameOver && this.gameOver) {
      this.log("Collision.", "danger");
    }

    this.recordHistory(now);
  }
  snapshot() {
    return {
      birdY: this.birdY,
      velocity: this.velocity,
      score: this.score,
      best: this.best,
      won: this.score >= WIN_SCORE,
      flag: this.score >= WIN_SCORE ? FINAL_FLAG : "",
      acceptedFlapCount: this.acceptedFlapCount,
      elapsed: this.elapsed,
      spawnTimer: this.spawnTimer,
      nextPipeId: this.nextPipeId,
      gameOver: this.gameOver,
      awaitingStart: this.awaitingStart,
      gesture: this.gesture.snapshot(),
      antiCheat: this.antiCheatSnapshot(),
      pipes: this.pipes.map((pipe) => ({
        id: pipe.id,
        x: pipe.x,
        gapY: pipe.gapY,
        scored: pipe.scored,
      })),
    };
  }

  log(message, level = "info") {
    console.log(`[${level}] ${this.playerId}: ${message}`);
  }

  /** Deterministic replay of a client-sim input log for score + anti-cheat validation. */
  static verifyRecordedRun(runLog, claimedScore) {
    const replay = new GameSession("verify");
    replay.reset();
    replay.verifyReplay = true;
    replay.claimedScore = claimedScore;

    const events = [...runLog].sort((left, right) => left.atMs - right.atMs);
    let simMs = 0;

    const advanceTo = (targetMs) => {
      while (simMs + TICK_MS <= targetMs && !replay.gameOver) {
        if (!replay.awaitingStart) {
          replay.tick(TICK_SECONDS, simMs + TICK_MS);
        }
        simMs += TICK_MS;
      }

      const remainingMs = targetMs - simMs;
      if (remainingMs > 0.5 && !replay.gameOver && !replay.awaitingStart) {
        replay.tick(remainingMs / 1000, targetMs);
        simMs = targetMs;
      }
    };

    for (const event of events) {
      if (event.type === "restart") {
        replay.reset();
        simMs = event.atMs;
        continue;
      }

      advanceTo(event.atMs);

      if (event.type === "hands") {
        replay.processHandSample(
          {
            leftY: event.leftY,
            rightY: event.rightY,
            handCount: event.handCount,
          },
          event.atMs,
        );
        continue;
      }

      if (event.type === "flap") {
        replay.flap(event.source === "gesture" ? "67 gesture" : "manual input", event.atMs);
        if (replay.disconnectReason) {
          break;
        }
      }
    }

    const score = replay.score;
    const won = score >= WIN_SCORE;
    const valid = score === claimedScore && !replay.disconnectReason;
    let message = "";
    if (replay.disconnectReason) {
      message = replay.disconnectReason;
    } else if (!valid) {
      message = `Verification failed: replay score ${score} does not match claimed ${claimedScore}.`;
    }

    return {
      valid,
      blocked: replay.disconnectReason.startsWith("Disconnected:"),
      score,
      won,
      flag: won ? FINAL_FLAG : "",
      message,
      antiCheat: replay.antiCheatSnapshot(),
    };
  }
}

class ServerGestureInterpreter {
  constructor({ onFlap = () => {}, config = {} } = {}) {
    this.config = { ...GESTURE_CONFIG, ...config };
    this.onFlap = onFlap;
    this.reset();
  }

  reset() {
    this.previousState = "NEUTRAL";
    this.crossedLevelBand = false;
    this.crossCount = 0;
    this.sequenceStartedAt = null;
    this.lastJumpAt = -Infinity;
    this.lastCrossAt = -Infinity;
    this.levelEnteredAt = null;
    this.lastSeenAt = 0;
    this.heights = [null, null];
    this.heightVelocities = [0, 0];
    this.lastHeightTimes = [null, null];
    this.telemetry = {
      status: "NEUTRAL",
      handCount: 0,
      tracking: "reset",
      delta: null,
      triggered: false,
    };
  }

  process(sample, now = performance.now()) {
    const resolved = this.resolveSample(sample, now);
    if (!resolved) {
      return this.holdOrReset(now, sample.handCount);
    }

    const { leftHeight, rightHeight, tracking } = resolved;
    if (sample.handCount >= 2) {
      this.lastSeenAt = now;
    }

    const delta = leftHeight - rightHeight;
    const currentState = this.deltaState(delta);
    if (currentState === "LEVEL") {
      if (this.levelEnteredAt === null) {
        this.levelEnteredAt = now;
      }
      if (this.previousState !== "NEUTRAL") {
        this.crossedLevelBand = true;
        if (this.crossCount === 0 && this.sequenceStartedAt === null) {
          this.sequenceStartedAt = now;
        }
      }
      const levelElapsedMs = now - this.levelEnteredAt;
      if (levelElapsedMs > this.config.levelResetMs) {
        this.previousState = "NEUTRAL";
        this.crossedLevelBand = false;
        this.crossCount = 0;
        this.sequenceStartedAt = null;
      }
      return this.emit({
        status: `LEVEL ${this.crossCount}/${this.config.minCrossesPerFlap}`,
        handCount: sample.handCount,
        tracking,
        leftHeight,
        rightHeight,
        delta,
        currentState,
        triggered: false,
        levelElapsedMs,
      });
    }

    this.levelEnteredAt = null;
    let triggered = false;
    if (
      this.previousState !== "NEUTRAL" &&
      currentState !== this.previousState &&
      this.crossedLevelBand
    ) {
      this.lastCrossAt = now;
      if (this.jumpDebounceRemaining(now) <= 0) {
        this.crossCount += 1;
      } else {
        this.crossCount = 0;
        this.sequenceStartedAt = null;
      }

      if (this.crossCount >= this.config.minCrossesPerFlap) {
        this.onFlap(this.sequenceStartedAt ?? this.lastCrossAt ?? now);
        this.lastJumpAt = now;
        this.crossCount = 0;
        this.sequenceStartedAt = null;
        triggered = true;
      }
    }
    this.crossedLevelBand = false;
    this.previousState = currentState;

    return this.emit({
      status: `${currentState} ${this.crossCount}/${this.config.minCrossesPerFlap}`,
      handCount: sample.handCount,
      tracking,
      leftHeight,
      rightHeight,
      delta,
      currentState,
      triggered,
    });
  }

  resolveSample(sample, now) {
    if (sample.handCount >= 2 && sample.leftY !== null && sample.rightY !== null) {
      const leftHeight = this.smoothHeight(0, handHeight(sample.leftY), now);
      const rightHeight = this.smoothHeight(1, handHeight(sample.rightY), now);
      return { leftHeight, rightHeight, tracking: "active" };
    }

    if (now - this.lastSeenAt > this.config.trackingGraceMs) {
      return null;
    }

    if (sample.handCount === 0) {
      return this.predictedSample(now, "predicted");
    }

    if (sample.handCount !== 1) {
      return null;
    }

    if (sample.leftY !== null) {
      this.smoothHeight(0, handHeight(sample.leftY), now);
    }
    if (sample.rightY !== null) {
      this.smoothHeight(1, handHeight(sample.rightY), now);
    }

    const leftHeight = sample.leftY !== null ? this.heights[0] : this.predictHeight(0, now);
    const rightHeight = sample.rightY !== null ? this.heights[1] : this.predictHeight(1, now);
    if (leftHeight === null || rightHeight === null) {
      return null;
    }

    return { leftHeight, rightHeight, tracking: "bridged" };
  }

  predictedSample(now, tracking) {
    const leftHeight = this.predictHeight(0, now);
    const rightHeight = this.predictHeight(1, now);
    if (leftHeight === null || rightHeight === null) {
      return null;
    }

    return { leftHeight, rightHeight, tracking };
  }

  smoothHeight(index, height, now) {
    const previous = this.heights[index];
    if (previous === null) {
      this.heights[index] = height;
      this.heightVelocities[index] = 0;
      this.lastHeightTimes[index] = now;
      return height;
    }

    const movement = Math.abs(height - previous);
    const smoothing =
      movement >= this.config.fastMovementThreshold
        ? Math.max(this.config.anchorSmoothing, this.config.fastAnchorSmoothing)
        : this.config.anchorSmoothing;
    const smoothed = previous + (height - previous) * smoothing;
    const previousTime = this.lastHeightTimes[index];
    const elapsedMs = previousTime === null ? 0 : now - previousTime;
    if (elapsedMs > 0) {
      this.heightVelocities[index] = (smoothed - previous) / elapsedMs;
    }
    this.lastHeightTimes[index] = now;
    this.heights[index] = smoothed;
    return smoothed;
  }

  predictHeight(index, now) {
    const height = this.heights[index];
    const lastHeightTime = this.lastHeightTimes[index];
    if (height === null || lastHeightTime === null) {
      return null;
    }

    const elapsedMs = now - lastHeightTime;
    if (elapsedMs < 0 || elapsedMs > this.config.trackingGraceMs) {
      return null;
    }

    return clamp(height + this.heightVelocities[index] * elapsedMs, 0, 1);
  }

  holdOrReset(now, handCount = 0) {
    if (now - this.lastSeenAt <= this.config.trackingGraceMs) {
      const leftHeight = this.heights[0];
      const rightHeight = this.heights[1];
      if (leftHeight !== null && rightHeight !== null) {
        const delta = leftHeight - rightHeight;
        return this.emit({
          status: "TRACKING HOLD",
          handCount,
          tracking: "hold",
          leftHeight,
          rightHeight,
          delta,
          currentState: this.deltaState(delta),
          triggered: false,
        });
      }

      return this.emit({
        status: "TRACKING HOLD",
        handCount,
        tracking: "hold",
        delta: null,
        triggered: false,
      });
    }

    this.previousState = "NEUTRAL";
    this.crossedLevelBand = false;
    this.crossCount = 0;
    this.sequenceStartedAt = null;
    this.lastJumpAt = -Infinity;
    this.lastCrossAt = -Infinity;
    this.levelEnteredAt = null;
    this.heights = [null, null];
    this.heightVelocities = [0, 0];
    this.lastHeightTimes = [null, null];
    return this.emit({
      status: "NEUTRAL",
      handCount,
      tracking: "missing",
      delta: null,
      triggered: false,
    });
  }

  deltaState(delta) {
    if (delta > this.config.crossThreshold) {
      return "LEFT_HIGH";
    }

    if (delta < -this.config.crossThreshold) {
      return "RIGHT_HIGH";
    }

    return "LEVEL";
  }

  emit(event) {
    this.telemetry = {
      previousState: this.previousState,
      crossedLevelBand: this.crossedLevelBand,
      crossCount: this.crossCount,
      crossThreshold: this.config.crossThreshold,
      minCrossesPerFlap: this.config.minCrossesPerFlap,
      levelResetMs: this.config.levelResetMs,
      jumpDebounceRemainingMs: this.jumpDebounceRemaining(performance.now()),
      ...event,
    };
    return this.telemetry;
  }

  jumpDebounceRemaining(now) {
    return Math.max(0, this.config.jumpDebounceMs - (now - this.lastJumpAt));
  }

  snapshot() {
    return this.telemetry;
  }
}

function parseFrame(buffer) {
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) === 0x80;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Frame too large");
    }
    length = Number(bigLength);
    offset += 8;
  }

  let maskingKey;
  if (masked) {
    if (buffer.length < offset + 4) {
      return null;
    }
    maskingKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) {
    return null;
  }

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked && maskingKey) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= maskingKey[index % 4];
    }
  }

  return {
    opcode,
    payload,
    bytes: offset + length,
  };
}

function standardDeviation(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function coefficientOfVariation(values) {
  const mean = average(values);
  if (mean === 0) {
    return Infinity;
  }
  return standardDeviation(values) / Math.abs(mean);
}

function deltaVelocityFeatures(samples) {
  const velocities = [];
  for (let index = 1; index < samples.length; index += 1) {
    const dt = samples[index].t - samples[index - 1].t;
    if (dt <= 0) {
      continue;
    }
    velocities.push((samples[index].delta - samples[index - 1].delta) / dt);
  }

  const active = velocities.filter((velocity) => Math.abs(velocity) > 0.0004);
  if (active.length === 0) {
    return { count: 0, meanAbs: 0, cv: Infinity, directionChanges: 0 };
  }

  let directionChanges = 0;
  let previousSign = Math.sign(active[0]);
  for (let index = 1; index < active.length; index += 1) {
    const sign = Math.sign(active[index]);
    if (sign !== 0 && previousSign !== 0 && sign !== previousSign) {
      directionChanges += 1;
    }
    if (sign !== 0) {
      previousSign = sign;
    }
  }

  const absVelocities = active.map((velocity) => Math.abs(velocity));
  return {
    count: active.length,
    meanAbs: average(absVelocities),
    cv: coefficientOfVariation(absVelocities),
    directionChanges,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampInteger(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.round(clamp(value, min, max));
}

function normalizedOrNull(value) {
  return Number.isFinite(value) ? clamp(value, 0, 1) : null;
}

function handHeight(y) {
  return 1 - y;
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
