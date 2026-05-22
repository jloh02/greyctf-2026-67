import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || "8787");
const HOST = process.env.HOST || "127.0.0.1";
const SPACE_67_KEYBOARD = parseBoolean(process.env.SPACE_67_KEYBOARD, false);

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
const FLOOR_Y = GAME_HEIGHT - 48;
const TICK_SECONDS = 1 / 60;
const STATE_SEND_MS = 1000 / 30;

const sockets = new Set();

const server = createServer((request, response) => {
  if (!request.url) {
    response.writeHead(400).end("Bad request");
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, sockets: sockets.size }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "backend websocket service; connect to /ws" }));
});

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

    if (message.type === "flap") {
      this.game.flap(message.source === "gesture" ? "67 gesture" : "manual input");
      this.sendState(performance.now(), true);
      if (this.game.disconnectReason) {
        this.close(1008, this.game.disconnectReason);
      }
      return;
    }

    if (message.type === "restart") {
      this.game.reset();
      this.game.log("Run reset by client.", "info");
      this.sendState(performance.now(), true);
    }
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
    this.pipes = [];
    this.nextPipeId = 1;
    this.seedPipes();
  }

  seedPipes() {
    for (let i = 0; i < 4; i += 1) {
      this.spawnPipe(GAME_WIDTH + 260 + i * 270);
    }
  }

  spawnPipe(x = GAME_WIDTH + 80) {
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

  flap(source) {
    if (this.gameOver) {
      this.reset();
      this.log("Run restarted by flap.", "info");
    }

    const now = performance.now();
    const verdict = this.auditFlap(now);
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
    this.flapTimes.push(now);
    this.flapTimes = this.flapTimes.slice(-12);
    this.log(`Accepted flap from ${source}.`, "info");
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

    if (this.spawnTimer >= PIPE_INTERVAL) {
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
      elapsed: this.elapsed,
      gameOver: this.gameOver,
      shadowbanned: this.shadowbanned,
      awaitingStart: this.awaitingStart,
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

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
