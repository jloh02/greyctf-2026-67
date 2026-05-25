import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import {
  GAME_CONSTANTS,
  applyFlap as applyCoreFlap,
  createGameState,
  stepGameState,
} from "../shared/game-core.js";

const PORT = Number(process.env.PORT || "8787");
const HOST = process.env.HOST || "127.0.0.1";
const SPACE_67_KEYBOARD = parseBoolean(process.env.SPACE_67_KEYBOARD, false);
const FINAL_FLAG = process.env.FINAL_FLAG || process.env.FLAG || "";
const DIAGNOSTIC_PAGE = parseBoolean(process.env.DIAGNOSTIC_PAGE, false);
const FRONTEND_ROOT = resolve(process.cwd(), "frontend");
const SHARED_ROOT = resolve(process.cwd(), "shared");
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
const WIN_SCORE = GAME_CONSTANTS.winScore;
const GESTURE_CONFIG = {
  crossThreshold: 0.1,
  minCrossesPerFlap: 2,
  trackingGraceMs: 420,
  anchorSmoothing: 0.45,
  fastAnchorSmoothing: 0.72,
  fastMovementThreshold: 0.075,
  jumpDebounceMs: 300,
  levelResetMs: 360,
};
const ANTI_CHEAT = {
  maxFlapsPerSecond: 6,
  scoreDecayPerSecond: 22,
  blockScore: 100,
  cadenceAudit: {
    minSamples: 10,
    minMeanMs: 90,
    maxStdDevMs: 3,
    maxCv: 0.025,
    score: 55,
    cooldownMs: 1800,
  },
  gestureLeadup: {
    windowMs: 420,
    minSamples: 8,
    maxSampleGapMs: 140,
    missingEvidenceScore: 45,
    cooldownMs: 1000,
  },
  repeatedAmplitude: {
    minSamples: 8,
    minMean: 0.18,
    maxCv: 0.12,
    score: 24,
    cooldownMs: 1400,
  },
  constantVelocity: {
    minSamples: 8,
    minAbsVelocity: 0.0012,
    maxCv: 0.2,
    minDirectionChanges: 3,
    score: 22,
    cooldownMs: 1400,
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
    response.end(JSON.stringify({ ok: true, sockets: sockets.size, space67Keyboard: SPACE_67_KEYBOARD }));
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
        gesture: GESTURE_CONFIG,
      },
    });
    this.game.log("Server-authoritative room started.", "info");
    this.sendState(performance.now(), true);
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
      const actionTime = this.clientPerfTime(message.clientTime);
      this.game.flap(message.source === "gesture" ? "67 gesture" : "manual input", actionTime);
      this.sendState(performance.now(), true);
      if (this.game.disconnectReason) {
        this.close(1008, this.game.disconnectReason);
      }
      return;
    }

    if (message.type === "hands") {
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
      this.game.log("Run reset by client.", "info");
      this.sendState(performance.now(), true);
    }
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
    if (this.closed) {
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
      onFlap: (time) => this.flap("67 gesture", time),
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
    this.antiCheatScore = 0;
    this.antiCheatLastUpdateAt = performance.now();
    this.antiCheatCooldowns = {};
    this.history = [];
    this.replaying = false;
    this.gesture.reset();
  }

  flap(source, actionTimeMs = performance.now()) {
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
    this.recordHandSample(sample, sampleTime);
    const telemetry = this.gesture.process(sample, sampleTime);
    return telemetry.triggered;
  }

  recordHandSample(sample, now) {
    if (sample.handCount < 2 || sample.leftY === null || sample.rightY === null) {
      return;
    }

    const leftHeight = handHeight(sample.leftY);
    const rightHeight = handHeight(sample.rightY);
    this.handSamples.push({
      t: now,
      leftHeight,
      rightHeight,
      delta: leftHeight - rightHeight,
    });
    if (this.handSamples.length > HAND_SAMPLE_HISTORY_CAPACITY) {
      this.handSamples.shift();
    }
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
    if (SPACE_67_KEYBOARD) {
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
    this.log(`Anti-cheat suspicion +${score}: ${detail} (score=${this.antiCheatScore.toFixed(1)}).`, "warn");
    if (this.antiCheatScore >= ANTI_CHEAT.blockScore) {
      return {
        blocked: true,
        message: "Disconnected: anti-cheat heuristics flagged scripted inputs.",
      };
    }
    return null;
  }

  auditGestureLeadup(now) {
    const windowStart = now - ANTI_CHEAT.gestureLeadup.windowMs;
    const recent = this.handSamples.filter((sample) => sample.t >= windowStart && sample.t <= now);
    const lastSample = recent.at(-1);

    if (
      recent.length < ANTI_CHEAT.gestureLeadup.minSamples ||
      !lastSample ||
      now - lastSample.t > ANTI_CHEAT.gestureLeadup.maxSampleGapMs
    ) {
      return this.addSuspicion(
        ANTI_CHEAT.gestureLeadup.missingEvidenceScore,
        "leadup",
        "gesture flap arrived with sparse recent hand-motion evidence.",
        now,
        ANTI_CHEAT.gestureLeadup.cooldownMs,
      );
    }

    const excursionAmplitudes = recent
      .map((sample) => Math.abs(sample.delta))
      .filter((amplitude) => amplitude >= GESTURE_CONFIG.crossThreshold * 1.25);
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
