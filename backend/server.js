import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const PORT = Number(process.env.PORT || "8787");
const HOST = process.env.HOST || "127.0.0.1";
const SPACE_67_KEYBOARD = parseBoolean(process.env.SPACE_67_KEYBOARD, false);
const FINAL_FLAG = process.env.FINAL_FLAG || process.env.FLAG || "";
const DIAGNOSTIC_PAGE = parseBoolean(process.env.DIAGNOSTIC_PAGE, false);
const FRONTEND_ROOT = resolve(process.cwd(), "frontend");
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

const GAME_WIDTH = 960;
const GAME_HEIGHT = 540;
const BIRD_X = 240;
const BIRD_RADIUS = 18;
const GRAVITY = 1180;
const FLAP_IMPULSE = -405;
const PIPE_SPEED = 255;
const PIPE_WIDTH = 74;
const PIPE_GAP = 168;
const PIPE_INTERVAL = 1.42;
const PIPE_SPAWN_X = GAME_WIDTH + 80;
const INITIAL_PIPE_X = GAME_WIDTH + 260;
const PIPE_SPACING = PIPE_SPEED * PIPE_INTERVAL;
const FLOOR_Y = GAME_HEIGHT - 48;
const TICK_SECONDS = 1 / 60;
const TICK_MS = TICK_SECONDS * 1000;
const STATE_SEND_MS = 1000 / 30;
const MAX_LAG_COMPENSATION_MS = 200;
const HISTORY_CAPACITY = 16;
const WIN_SCORE = 100;
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

const sockets = new Set();

const server = createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(400).end("Bad request");
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/api/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, sockets: sockets.size }));
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
  const requestedPath = resolveFrontendPath(pathname);
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

function resolveFrontendPath(pathname) {
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
        width: GAME_WIDTH,
        height: GAME_HEIGHT,
        birdX: BIRD_X,
        pipeWidth: PIPE_WIDTH,
        pipeGap: PIPE_GAP,
        floorY: FLOOR_Y,
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
    this.send({ type: "state", state: this.game.snapshot() });
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
    this.birdY = 230;
    this.velocity = 0;
    this.score = 0;
    this.elapsed = 0;
    this.spawnTimer = 0;
    this.gameOver = false;
    this.shadowbanned = false;
    this.awaitingStart = true;
    this.disconnectReason = "";
    this.flapTimes = [];
    this.history = [];
    this.replaying = false;
    this.gesture.reset();
    this.pipes = [];
    this.nextPipeId = 1;
    this.seedPipes();
  }

  seedPipes() {
    for (let i = 0; i < 4; i += 1) {
      this.spawnPipe(INITIAL_PIPE_X + i * PIPE_SPACING);
    }
  }

  canSpawnPipe() {
    if (this.pipes.length === 0) {
      return true;
    }

    const rightmostPipeX = this.pipes.reduce((rightmostX, pipe) => Math.max(rightmostX, pipe.x), -Infinity);
    return rightmostPipeX <= PIPE_SPAWN_X - PIPE_SPACING;
  }

  spawnPipe(x = PIPE_SPAWN_X) {
    const wave = Math.sin((this.elapsed + this.nextPipeId) * 1.37);
    const jitter = Math.sin(this.elapsed * 2.9 + this.nextPipeId * 6.1) * 58;
    const gapY = clamp(190 + wave * 88 + jitter, 128, FLOOR_Y - PIPE_GAP - 44);
    this.pipes.push({
      id: this.nextPipeId,
      x,
      gapY,
      scored: false,
      appearedAt: performance.now(),
    });
    this.nextPipeId += 1;
  }

  flap(source, actionTimeMs = performance.now()) {
    if (this.gameOver) {
      this.reset();
      this.log("Run restarted by flap.", "info");
    }

    const now = performance.now();
    const effectiveTime = clamp(
      Number.isFinite(actionTimeMs) ? actionTimeMs : now,
      now - MAX_LAG_COMPENSATION_MS,
      now,
    );

    if (effectiveTime < now - 1) {
      this.replayTo(effectiveTime, () => this.applyFlapEffect(source, effectiveTime), now);
      return;
    }

    this.applyFlapEffect(source, effectiveTime);
  }

  applyFlapEffect(source, auditTime) {
    const verdict = this.auditFlap(auditTime);
    if (verdict.blocked) {
      this.gameOver = true;
      this.disconnectReason = verdict.message;
      this.log(verdict.message, "danger");
      return;
    }

    if (verdict.message) {
      this.log(verdict.message, verdict.level);
    }

    this.awaitingStart = false;
    this.velocity = FLAP_IMPULSE;
    this.flapTimes.push(auditTime);
    this.flapTimes = this.flapTimes.slice(-12);
    this.log(`Accepted flap from ${source}.`, "info");
  }

  processHandSample(message, sampleTime = performance.now()) {
    const telemetry = this.gesture.process(
      {
        leftY: normalizedOrNull(message.leftY),
        rightY: normalizedOrNull(message.rightY),
        handCount: clampInteger(message.handCount, 0, 2),
      },
      sampleTime,
    );
    return telemetry.triggered;
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
      shadowbanned: this.shadowbanned,
      awaitingStart: this.awaitingStart,
      flapTimes: [...this.flapTimes],
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
    this.shadowbanned = snapshot.shadowbanned;
    this.awaitingStart = snapshot.awaitingStart;
    this.flapTimes = [...snapshot.flapTimes];
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

  auditFlap(now) {
    const recent = this.flapTimes.filter((time) => now - time < 1000);
    if (recent.length >= 6) {
      return {
        blocked: true,
        message: "Disconnected: biological speed limit exceeded.",
      };
    }

    if (this.flapTimes.length >= 10) {
      const sample = [...this.flapTimes.slice(-9), now];
      const deltas = sample.slice(1).map((time, index) => time - sample[index]);
      if (standardDeviation(deltas) < 2) {
        return {
          blocked: true,
          message: "Disconnected: perfect timing quantization detected.",
        };
      }
    }

    const freshPipe = this.pipes.find(
      (pipe) => pipe.x > BIRD_X && pipe.x < BIRD_X + 220 && now - pipe.appearedAt < 100,
    );
    if (freshPipe) {
      this.shadowbanned = true;
      return {
        blocked: false,
        level: "warn",
        message: "Reaction audit marked this run for delayed failure.",
      };
    }

    return { blocked: false };
  }

  tick(dt, now) {
    if (this.gameOver || this.awaitingStart) {
      return;
    }

    this.elapsed += dt;
    this.velocity += GRAVITY * dt;
    this.birdY += this.velocity * dt;
    this.spawnTimer += dt;

    if (this.spawnTimer >= PIPE_INTERVAL && this.canSpawnPipe()) {
      this.spawnTimer = 0;
      this.spawnPipe();
    }

    for (const pipe of this.pipes) {
      pipe.x -= PIPE_SPEED * dt;
      if (!pipe.scored && pipe.x + PIPE_WIDTH < BIRD_X) {
        pipe.scored = true;
        this.score += 1;
        this.best = Math.max(this.best, this.score);
      }
    }

    this.pipes = this.pipes.filter((pipe) => pipe.x + PIPE_WIDTH > -24);

    if (this.birdY < BIRD_RADIUS || this.birdY > FLOOR_Y - BIRD_RADIUS || this.collidesWithPipe()) {
      this.gameOver = true;
      this.log(this.shadowbanned ? "Run terminated by delayed authority verdict." : "Collision.", "danger");
    }

    this.recordHistory(now);
  }

  collidesWithPipe() {
    return this.pipes.some((pipe) => {
      const withinX = BIRD_X + BIRD_RADIUS > pipe.x && BIRD_X - BIRD_RADIUS < pipe.x + PIPE_WIDTH;
      const inGap = this.birdY - BIRD_RADIUS > pipe.gapY && this.birdY + BIRD_RADIUS < pipe.gapY + PIPE_GAP;
      return withinX && !inGap;
    });
  }

  snapshot() {
    return {
      birdY: this.birdY,
      velocity: this.velocity,
      score: this.score,
      best: this.best,
      won: this.score >= WIN_SCORE,
      flag: this.score >= WIN_SCORE ? FINAL_FLAG : "",
      elapsed: this.elapsed,
      gameOver: this.gameOver,
      shadowbanned: this.shadowbanned,
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
      }
      const levelElapsedMs = now - this.levelEnteredAt;
      if (levelElapsedMs > this.config.levelResetMs) {
        this.previousState = "NEUTRAL";
        this.crossedLevelBand = false;
        this.crossCount = 0;
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
      }

      if (this.crossCount >= this.config.minCrossesPerFlap) {
        this.onFlap(now);
        this.lastJumpAt = now;
        this.crossCount = 0;
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
