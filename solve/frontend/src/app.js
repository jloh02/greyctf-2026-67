import {
  FAST_HAND_LANDMARKER_OPTIONS,
  GestureInterpreter,
  handAnchorPoint,
  handHeight,
  orderedHands,
  screenSideIndex,
} from "./gesture.js";
import {
  GAME_CONSTANTS,
  WIN_SCORE,
  applyFlap as applyCoreFlap,
  createGameState,
  stepGameState,
} from "/shared/game-core.js";
import { buildSolveTrace } from "/shared/flap-solver.js";

const TRACE_STORAGE_KEY = "solve-lab:last-trace";
const RECORD_HANDS_ONLY = true;
const MAX_LOG_EVENTS = 120;
const MAX_RENDER_DT_SECONDS = 0.05;
const TRACE_MIN_HAND_SAMPLES = 30;
const TRACE_MIN_DURATION_MS = 1500;
const PING_INTERVAL_MS = 2000;
const SYNC_SMOOTHING = 0.2;
const HAND_ANCHOR_MARKER_RADIUS = 12;
const HAND_SIDE_GUIDE_TOP = 10;
const HAND_SIDE_GUIDE_HEIGHT = 24;
const HAND_OVERLAY_STYLES = [
  { anchor: "#ff3b5c" },
  { anchor: "#42ff87" },
];
const SPRITE_SIZE = 16;
const PIPE_SPRITES = {
  body: { x: 0, y: 0, width: SPRITE_SIZE, height: SPRITE_SIZE },
  topHead: { x: 16, y: 0, width: SPRITE_SIZE, height: SPRITE_SIZE },
  bottomHead: { x: 32, y: 0, width: SPRITE_SIZE, height: SPRITE_SIZE },
};
const BIRD_SPRITE_START_X = 48;
const BIRD_FRAMES = {
  up: 1,
  neutral: 2,
  down: 0,
};

const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

const targetInput = document.querySelector("#targetInput");
const connectButton = document.querySelector("#connectButton");
const restartButton = document.querySelector("#restartButton");
const cameraButton = document.querySelector("#cameraButton");
const stopScriptButton = document.querySelector("#stopScriptButton");
const runSussyButton = document.querySelector("#runSussyButton");
const runGoodButton = document.querySelector("#runGoodButton");
const runSolvePackButton = document.querySelector("#runSolvePackButton");
const runPipeSolverButton = document.querySelector("#runPipeSolverButton");
const exportTraceButton = document.querySelector("#exportTraceButton");
const importTraceButton = document.querySelector("#importTraceButton");
const importTraceInput = document.querySelector("#importTraceInput");
const clearLogButton = document.querySelector("#clearLogButton");
const video = document.querySelector("#cameraPreview");
const handOverlay = document.querySelector("#handOverlay");
const handCtx = handOverlay.getContext("2d");
const statusText = document.querySelector("#status");
const scoreText = document.querySelector("#score");
const bestText = document.querySelector("#best");
const modeText = document.querySelector("#mode");
const flagBanner = document.querySelector("#flagBanner");
const flagText = document.querySelector("#flagText");
const gestureStateText = document.querySelector("#gestureState");
const flapPulseText = document.querySelector("#flapPulse");
const leftMeter = document.querySelector("#leftMeter");
const rightMeter = document.querySelector("#rightMeter");
const socketStateText = document.querySelector("#socketState");
const debugSocketStateText = document.querySelector("#debugSocketState");
const scriptStateText = document.querySelector("#scriptState");
const traceStateText = document.querySelector("#traceState");
const traceSummaryText = document.querySelector("#traceSummary");
const eventLog = document.querySelector("#eventLog");

const atlas = new Image();
let atlasCanvas = null;
atlas.addEventListener("load", prepareAtlasTransparency);

let configResponse = null;
let constants = { ...GAME_CONSTANTS };

let config = {
  space67Keyboard: false,
  clientSim: true,
  winScore: WIN_SCORE,
  verifyScoreThreshold: 50,
};

let state = createGameState();
let sessionMeta = {
  best: 0,
  won: false,
  flag: "",
};
let finishSubmitted = false;
let verificationPending = false;
let lastDrawAt = performance.now();

const localGesture = new GestureInterpreter({
  onFlap: () => applyLocalFlap(),
  onTelemetry: (telemetry) => {
    state.gesture = telemetry;
  },
});

let socket = null;
let debugSocket = null;
let connected = false;
let debugConnected = false;
let cameraStarting = false;
let mediaPipeReady = false;
let visionLoopStarted = false;
let handLandmarker = null;
let lastVideoTime = -1;
let sentFlaps = 0;
let sentHandSamples = 0;
let mode = "Connecting";
let pingTimer = null;
let syncState = {
  rttMs: 0,
  clockOffsetMs: 0,
};
let scriptController = null;
let trace = loadTrace();
let currentRecording = createEmptyTrace();
let proxyEvents = [];

const queryBackend = new URLSearchParams(window.location.search).get("backend");

boot();

async function boot() {
  configResponse = await loadConfig();
  targetInput.value = normalizeTargetUrl(queryBackend || configResponse.defaultTarget);
  atlas.src = configResponse.assetPath || "/shared-assets/flappy_atlas.png";
  restoreTraceState();
  connectSockets();
  requestAnimationFrame(draw);
  applyInputMode();
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) {
      throw new Error(`unexpected status ${response.status}`);
    }
    return await response.json();
  } catch {
    return {
      defaultTarget: "ws://127.0.0.1:8787/ws",
      assetPath: "/shared-assets/flappy_atlas.png",
    };
  }
}

function connectSockets() {
  connectGameSocket();
  connectDebugSocket();
}

function connectGameSocket() {
  stopPingLoop();
  if (socket) {
    socket.close();
  }

  const target = normalizeTargetUrl(targetInput.value || configResponse.defaultTarget);
  targetInput.value = target;
  socket = new WebSocket(proxySocketUrl(target));
  statusText.textContent = `Connecting to ${target} via proxy.`;
  mode = "Connecting";
  socketStateText.textContent = "connecting";

  socket.addEventListener("open", () => {
    connected = true;
    socketStateText.textContent = "online";
    startPingLoop();
    if (!cameraStarting) {
      statusText.textContent = mediaPipeReady ? "Camera tracking active through proxy." : "Proxy connected.";
    }
    mode = mediaPipeReady ? "Tracking" : "Online";
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "welcome") {
      constants = { ...GAME_CONSTANTS, ...(message.constants || {}) };
      config = { ...config, ...(message.config || {}) };
      canvas.width = constants.width;
      canvas.height = constants.height;
      resetLocalRun();
      applyInputMode();
      return;
    }
    if (message.type === "state") {
      if (!config.clientSim) {
        applyServerState(message.state);
      }
      return;
    }
    if (message.type === "verified") {
      applyVerifiedResult(message);
      return;
    }
    if (message.type === "pong") {
      handlePong(message);
    }
  });

  socket.addEventListener("close", (event) => {
    connected = false;
    socketStateText.textContent = `closed (${event.code})`;
    stopPingLoop();
    if (!event.wasClean || event.reason) {
      statusText.textContent = event.reason
        ? `Proxy/game socket closed: ${event.reason}`
        : `Proxy/game socket closed with code ${event.code}.`;
    } else {
      statusText.textContent = "Proxy/game socket closed.";
    }
    mode = "Offline";
  });

  socket.addEventListener("error", () => {
    connected = false;
    socketStateText.textContent = "error";
    mode = "Offline";
    statusText.textContent = "Proxy/game socket failed.";
  });
}

function connectDebugSocket() {
  if (debugSocket) {
    debugSocket.close();
  }

  debugSocket = new WebSocket(debugSocketUrl());
  debugSocketStateText.textContent = "connecting";

  debugSocket.addEventListener("open", () => {
    debugConnected = true;
    debugSocketStateText.textContent = "online";
  });

  debugSocket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "debug-welcome") {
      return;
    }
    pushProxyEvent(message);
  });

  debugSocket.addEventListener("close", () => {
    debugConnected = false;
    debugSocketStateText.textContent = "closed";
    window.setTimeout(connectDebugSocket, 800);
  });

  debugSocket.addEventListener("error", () => {
    debugConnected = false;
    debugSocketStateText.textContent = "error";
  });
}

function proxySocketUrl(target) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${window.location.host}/ws`);
  url.searchParams.set("target", normalizeTargetUrl(target));
  return url.toString();
}

function debugSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/debug-ws`;
}

function startPingLoop() {
  stopPingLoop();
  sendPing();
  pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
}

function stopPingLoop() {
  if (pingTimer !== null) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function sendPing() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({ type: "ping", clientTime: Date.now() }));
}

function handlePong(message) {
  if (!Number.isFinite(message.clientTime) || !Number.isFinite(message.serverRecv) || !Number.isFinite(message.serverTime)) {
    return;
  }

  const clientReceived = Date.now();
  const rttSample = clientReceived - message.clientTime;
  const offsetSample = (message.serverRecv - message.clientTime + message.serverTime - clientReceived) / 2;

  syncState.rttMs = smoothSample(syncState.rttMs, rttSample);
  syncState.clockOffsetMs = smoothSample(syncState.clockOffsetMs, offsetSample);
  sendControlMessage({
    type: "sync",
    rttMs: Math.round(syncState.rttMs),
    clockOffsetMs: Math.round(syncState.clockOffsetMs),
  });
}

function smoothSample(previous, sample) {
  if (!previous) {
    return sample;
  }
  return previous * (1 - SYNC_SMOOTHING) + sample * SYNC_SMOOTHING;
}

function sendControlMessage(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

function outboundPayload(message, { traceAtMs } = {}) {
  const payload = {
    ...message,
    clientTime: Date.now(),
  };
  if (Number.isFinite(traceAtMs)) {
    payload.traceAtMs = traceAtMs;
  } else if (currentRecording.startedAt !== null) {
    payload.traceAtMs = Date.now() - currentRecording.startedAt;
  }
  return payload;
}

function sendTrackedMessage(message, { record = true, traceAtMs } = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  socket.send(JSON.stringify(outboundPayload(message, { traceAtMs })));
  if (record) {
    recordTraceEvent(message);
  }
  return true;
}

function recordTraceEvent(message) {
  if (
    scriptController ||
    message.type === "ping" ||
    message.type === "sync" ||
    (RECORD_HANDS_ONLY && message.type === "flap")
  ) {
    return;
  }

  if (currentRecording.startedAt === null) {
    currentRecording.startedAt = Date.now();
  }

  const payload = structuredClone(message);
  delete payload.clientTime;
  currentRecording.events.push({
    atMs: Date.now() - currentRecording.startedAt,
    message: payload,
  });

  if (payload.type === "hands") {
    currentRecording.handSamples += 1;
  } else if (payload.type === "flap") {
    currentRecording.flaps += 1;
  }

  updateTraceSummary(currentRecording);
}

function maybeFinalizeRecording() {
  if (scriptController || currentRecording.events.length === 0) {
    return;
  }

  if (state.gameOver || sessionMeta.won) {
    if (!isRecordingWorthSaving(currentRecording)) {
      const handSamples = countHandSamples(currentRecording);
      statusText.textContent =
        `Run too short to save (${handSamples} hand samples). ` +
        "Play a little longer — brief tracking dropouts in the trace are fine.";
      currentRecording = createEmptyTrace();
      restoreTraceState();
      return;
    }

    currentRecording.completedAt = new Date().toISOString();
    currentRecording.result = sessionMeta.won ? "won" : "game-over";
    currentRecording.score = state.score;
    trace = currentRecording;
    saveTrace(trace);
    currentRecording = createEmptyTrace();
    restoreTraceState();
    statusText.textContent = `Saved trace with ${trace.events.length} events. You can export or replay it.`;
  }
}

function countHandSamples(recording) {
  if (!recording?.events) {
    return 0;
  }

  return recording.events.filter((event) => event.message.type === "hands").length;
}

function countDualHandSamples(recording) {
  if (!recording?.events) {
    return 0;
  }

  return recording.events.filter(
    (event) =>
      event.message.type === "hands" &&
      Number.isFinite(event.message.leftY) &&
      Number.isFinite(event.message.rightY),
  ).length;
}

function summarizeRecording(recording) {
  if (!recording?.events?.length) {
    return null;
  }

  return {
    handSamples: countHandSamples(recording),
    dualHands: countDualHandSamples(recording),
    durationMs: recording.events.at(-1)?.atMs || 0,
    flaps: recording.flaps || countTraceType(recording, "flap"),
    events: recording.events.length,
  };
}

function isRecordingWorthSaving(recording) {
  const summary = summarizeRecording(recording);
  if (!summary) {
    return false;
  }

  if (summary.flaps > 0) {
    return true;
  }

  return summary.handSamples >= TRACE_MIN_HAND_SAMPLES && summary.durationMs >= TRACE_MIN_DURATION_MS;
}

function traceForExport() {
  const live = currentRecording.events.length > 0 ? snapshotRecording(currentRecording, "exported-live") : null;
  const saved = trace?.events?.length ? trace : null;

  if (live && isRecordingWorthSaving(currentRecording)) {
    return live;
  }

  if (saved) {
    return saved;
  }

  if (live) {
    return live;
  }

  return null;
}

function snapshotRecording(recording, result = recording.result) {
  return {
    ...recording,
    completedAt: recording.completedAt || new Date().toISOString(),
    result,
  };
}

function createEmptyTrace() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    target: normalizeTargetUrl(targetInput?.value || configResponse?.defaultTarget || "ws://127.0.0.1:8787/ws"),
    startedAt: null,
    completedAt: null,
    result: "in-progress",
    score: 0,
    handSamples: 0,
    flaps: 0,
    events: [],
  };
}

function restoreTraceState() {
  if (trace && !isRecordingWorthSaving(trace)) {
    trace = null;
    window.localStorage.removeItem(TRACE_STORAGE_KEY);
  }

  traceStateText.textContent = trace ? `${trace.events.length} events` : "none";
  updateTraceSummary(trace);
}

function updateTraceSummary(activeTrace, { live = false } = {}) {
  if (!activeTrace || activeTrace.events.length === 0) {
    if (!live && currentRecording.events.length > 0) {
      updateTraceSummary(currentRecording, { live: true });
      return;
    }

    traceSummaryText.textContent =
      "No trace yet. Camera records every hand frame — brief null leftY/rightY dropouts are normal.";
    traceStateText.textContent = "none";
    return;
  }

  traceStateText.textContent = `${activeTrace.events.length} events`;
  const durationMs = activeTrace.events.at(-1)?.atMs || 0;
  const summary = summarizeRecording(activeTrace);
  const prefix = live ? "Recording now: " : "Saved trace: ";
  traceSummaryText.textContent =
    `${prefix}` +
    `${summary.handSamples} hand samples (${summary.dualHands} with both Y), ` +
    `${summary.flaps} flaps, ` +
    `${(durationMs / 1000).toFixed(2)}s, ` +
    `score ${activeTrace.score ?? 0}, ` +
    `${activeTrace.result || "saved"}`;
}

function countTraceType(activeTrace, type) {
  return activeTrace.events.filter((event) => event.message.type === type).length;
}

function loadTrace() {
  try {
    const raw = window.localStorage.getItem(TRACE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    return isTrace(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveTrace(nextTrace) {
  if (!nextTrace) {
    window.localStorage.removeItem(TRACE_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(TRACE_STORAGE_KEY, JSON.stringify(nextTrace));
}

function isTrace(value) {
  return value && Array.isArray(value.events);
}

function resetLocalRun() {
  state = createGameState({}, constants);
  finishSubmitted = false;
  verificationPending = false;
  sessionMeta.won = false;
  sessionMeta.flag = "";
  localGesture.reset();
}

function restartRun({ clearRecording = true } = {}) {
  sentFlaps = 0;
  sentHandSamples = 0;
  flapPulseText.textContent = "0 samples";
  resetLocalRun();

  if (clearRecording && !scriptController) {
    currentRecording = createEmptyTrace();
    updateTraceSummary(currentRecording);
  }

  sendTrackedMessage({ type: "restart" }, { record: !scriptController });
}

function applyLocalFlap() {
  if (state.gameOver) {
    restartRun({ clearRecording: false });
  }
  applyCoreFlap(state, constants);
}

function sendFlap(source = "gesture", { record = true } = {}) {
  applyLocalFlap();
  const sent = sendTrackedMessage({ type: "flap", source, clientTime: Date.now() }, { record });
  if (!sent) {
    statusText.textContent = "Flap ignored while socket is offline.";
    return;
  }

  sentFlaps += 1;
  flapPulseText.textContent = `${sentHandSamples} samples / ${sentFlaps} flaps`;
  mode = config.space67Keyboard ? "Keyboard" : mediaPipeReady ? "Tracking" : "Online";
}

function applyServerState(serverState) {
  state = createGameState(
    {
      birdY: serverState.birdY,
      velocity: serverState.velocity,
      score: serverState.score,
      elapsed: serverState.elapsed,
      spawnTimer: serverState.spawnTimer,
      gameOver: serverState.gameOver,
      awaitingStart: serverState.awaitingStart,
      nextPipeId: serverState.nextPipeId,
      pipes: serverState.pipes || [],
    },
    constants,
  );
  sessionMeta.best = Math.max(sessionMeta.best, serverState.best ?? 0);
  sessionMeta.won = Boolean(serverState.won);
  sessionMeta.flag = serverState.flag || "";
}

function advanceLocalSimulation(dt) {
  if (!state.awaitingStart && !state.gameOver) {
    stepGameState(state, dt, constants);
  }
}

function targetWinScore() {
  return constants.winScore ?? config.winScore ?? WIN_SCORE;
}

function verifyScoreThreshold() {
  return config.verifyScoreThreshold ?? 50;
}

function scoreNeedsVerification(score) {
  return config.clientSim !== false && score > verifyScoreThreshold();
}

function checkRunFinished() {
  if (!state.gameOver || finishSubmitted) {
    return;
  }

  finishSubmitted = true;
  sessionMeta.best = Math.max(sessionMeta.best, state.score);
  maybeFinalizeRecording();

  if (state.score >= targetWinScore()) {
    sessionMeta.won = true;
    updateFlagBanner();
  }

  if (!scoreNeedsVerification(state.score)) {
    return;
  }

  submitRunForVerification(state.score);
}

function submitRunForVerification(score) {
  if (!connected || socket.readyState !== WebSocket.OPEN) {
    statusText.textContent = "Cannot verify run while server is offline.";
    return;
  }

  verificationPending = true;
  statusText.textContent = `Verifying run (score ${score})...`;
  sendControlMessage({
    type: "finish",
    score,
    clientTime: Date.now(),
  });
}

function applyVerifiedResult(message) {
  verificationPending = false;
  if (message.valid && message.won) {
    sessionMeta.won = true;
    sessionMeta.flag = message.flag || "";
    statusText.textContent = "Verified win.";
  } else if (message.blocked || message.antiCheat?.level === "blocked") {
    statusText.textContent = message.message || "Verification blocked.";
  } else {
    statusText.textContent = message.message || `Verify failed (score ${message.score}).`;
  }
  updateFlagBanner();
}

function draw() {
  const now = performance.now();
  const dt = Math.min(MAX_RENDER_DT_SECONDS, Math.max(0, (now - lastDrawAt) / 1000));
  lastDrawAt = now;
  advanceLocalSimulation(dt);
  checkRunFinished();

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, constants.width, constants.height);
  drawSky();
  drawPipes();
  drawFloor();
  drawBird();
  drawOverlay();

  scoreText.textContent = String(state.score);
  bestText.textContent = String(Math.max(sessionMeta.best, state.score));
  modeText.textContent = mode;
  gestureStateText.textContent = state.gesture?.status || "NEUTRAL";
  updateFlagBanner();

  requestAnimationFrame(draw);
}

function updateFlagBanner() {
  if (!sessionMeta.won) {
    flagBanner.hidden = true;
    flagText.textContent = "";
    return;
  }

  flagBanner.hidden = false;
  flagText.textContent = sessionMeta.flag || "Flag not configured.";
}

function drawSky() {
  const gradient = ctx.createLinearGradient(0, 0, 0, constants.floorY);
  gradient.addColorStop(0, "#78dcf6");
  gradient.addColorStop(0.68, "#5dc7e3");
  gradient.addColorStop(1, "#4ab2d1");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, constants.width, constants.floorY);

  drawCloud(120 - ((state.elapsed * 18) % 1120), 82, 1.1);
  drawCloud(560 - ((state.elapsed * 12) % 1120), 148, 0.85);
  drawCloud(880 - ((state.elapsed * 16) % 1120), 62, 0.7);

  ctx.fillStyle = "#8bd05a";
  for (let x = -80 + ((state.elapsed * 28) % 160); x < constants.width + 120; x += 160) {
    ctx.beginPath();
    ctx.arc(x, constants.floorY - 34, 72, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = "#73bf48";
  }
}

function drawPipes() {
  for (const pipe of state.pipes) {
    const topHeight = pipe.gapY;
    const bottomY = pipe.gapY + constants.pipeGap;
    drawPipe(pipe.x, 0, topHeight, true);
    drawPipe(pipe.x, bottomY, constants.floorY - bottomY, false);
  }
}

function drawFloor() {
  ctx.fillStyle = "#d9a447";
  ctx.fillRect(0, constants.floorY, constants.width, constants.height - constants.floorY);
  ctx.fillStyle = "#f3d269";
  ctx.fillRect(0, constants.floorY, constants.width, 12);
  ctx.fillStyle = "#8b6a2e";
  for (let x = -32 + ((state.elapsed * 255) % 32); x < constants.width; x += 32) {
    ctx.fillRect(x, constants.floorY + 12, 16, 16);
    ctx.fillRect(x + 16, constants.floorY + 28, 16, 16);
  }
}

function drawBird() {
  const tilt = clamp(state.velocity / 520, -0.55, 0.8);
  ctx.save();
  ctx.translate(constants.birdX, state.birdY);
  ctx.rotate(tilt);
  const frame = birdSpriteFrame();
  if (atlas.complete && atlas.naturalWidth > 0) {
    ctx.drawImage(
      spriteSource(),
      BIRD_SPRITE_START_X + frame * SPRITE_SIZE + 0.5,
      0.5,
      SPRITE_SIZE - 1,
      SPRITE_SIZE - 1,
      -28,
      -28,
      56,
      56,
    );
  } else {
    ctx.fillStyle = "#f2d047";
    ctx.beginPath();
    ctx.ellipse(0, 0, 22, 17, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function birdSpriteFrame() {
  if (state.gameOver) {
    return BIRD_FRAMES.neutral;
  }

  if (state.velocity < 0) {
    return BIRD_FRAMES.down;
  }
  return BIRD_FRAMES.up;
}

function drawPipe(x, y, height, inverted) {
  const capHeight = 38;
  const bodyX = x + 5;
  const bodyWidth = constants.pipeWidth - 10;
  const headFrame = inverted ? PIPE_SPRITES.topHead : PIPE_SPRITES.bottomHead;
  const headY = inverted ? y + height - capHeight : y;
  const bodyStartY = inverted ? y : y + capHeight;
  const bodyEndY = inverted ? headY : y + height;

  if (atlas.complete && atlas.naturalWidth > 0) {
    const sprites = spriteSource();
    const bodyHeight = Math.max(0, bodyEndY - bodyStartY);
    if (bodyHeight > 0) {
      ctx.drawImage(
        sprites,
        PIPE_SPRITES.body.x + 3,
        PIPE_SPRITES.body.y,
        PIPE_SPRITES.body.width - 6,
        PIPE_SPRITES.body.height,
        bodyX,
        bodyStartY,
        bodyWidth,
        bodyHeight,
      );
    }
    ctx.drawImage(
      sprites,
      headFrame.x,
      headFrame.y,
      headFrame.width,
      headFrame.height,
      x - 5,
      headY,
      constants.pipeWidth + 10,
      capHeight,
    );
    return;
  }

  ctx.fillStyle = "#5ec247";
  ctx.fillRect(bodyX, bodyStartY, bodyWidth, Math.max(0, bodyEndY - bodyStartY));
  ctx.fillStyle = "#78d957";
  ctx.fillRect(x - 5, headY, constants.pipeWidth + 10, capHeight);
}

function drawCloud(x, y, scale) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(255, 255, 255, 0.94)";
  ctx.beginPath();
  ctx.arc(0, 18, 22, Math.PI, 0);
  ctx.arc(26, 8, 28, Math.PI, 0);
  ctx.arc(58, 18, 22, Math.PI, 0);
  ctx.rect(-22, 18, 102, 24);
  ctx.fill();
  ctx.fillStyle = "rgba(228, 247, 255, 0.9)";
  ctx.fillRect(-18, 34, 94, 8);
  ctx.restore();
}

function drawOverlay() {
  if (state.awaitingStart) {
    drawMessage("Ready", readySubtitle());
    return;
  }

  if (state.gameOver) {
    drawMessage("Grounded", "Press Restart or replay another trace.");
  }
}

function readySubtitle() {
  if (!connected) {
    return "Connect the proxy socket to play.";
  }
  if (scriptController) {
    return `Running ${scriptController.name}.`;
  }
  if (config.space67Keyboard) {
    return "Press Space to send a synthetic flap.";
  }
  if (cameraStarting) {
    return "Allow camera access to capture a human trace.";
  }
  if (mediaPipeReady) {
    return "Manual play is recording trace data for later replay.";
  }
  return "Start the camera or run a solve script.";
}

function drawMessage(title, subtitle) {
  ctx.fillStyle = "rgba(100, 74, 24, 0.22)";
  ctx.fillRect(0, 0, constants.width, constants.height);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.font = "900 48px Avenir Next, Segoe UI, sans-serif";
  ctx.lineWidth = 8;
  ctx.strokeStyle = "#5b4a27";
  ctx.strokeText(title, constants.width / 2, constants.height / 2 - 20);
  ctx.fillText(title, constants.width / 2, constants.height / 2 - 20);
  ctx.fillStyle = "#5b4a27";
  ctx.font = "700 18px Avenir Next, Segoe UI, sans-serif";
  ctx.fillText(subtitle, constants.width / 2, constants.height / 2 + 22);
  ctx.textAlign = "start";
}

function cameraModeEnabled() {
  return !config.space67Keyboard;
}

function applyInputMode() {
  if (!cameraModeEnabled()) {
    stopCameraTracking();
    localGesture.reset();
    cameraButton.disabled = true;
    if (connected) {
      statusText.textContent = "Proxy connected. Keyboard mode active.";
    } else {
      statusText.textContent = "Keyboard mode active (camera disabled).";
    }
    mode = connected ? "Keyboard" : "Offline";
    return;
  }

  cameraButton.disabled = false;
  if (!mediaPipeReady && !cameraStarting) {
    startCamera();
  } else if (mediaPipeReady) {
    statusText.textContent = connected
      ? "Camera tracking active through proxy."
      : "Camera active. Proxy offline.";
    mode = "Tracking";
  }
}

async function createHandLandmarker() {
  const { FilesetResolver, HandLandmarker } = await import(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18",
  );
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm",
  );
  const modelAssetPath =
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

  let lastError = null;
  for (const delegate of ["GPU", "CPU"]) {
    try {
      return await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath, delegate },
        ...FAST_HAND_LANDMARKER_OPTIONS,
      });
    } catch (error) {
      lastError = error;
      console.warn(`Hand landmarker (${delegate}) failed:`, error);
    }
  }

  throw lastError ?? new Error("Could not initialize hand landmarker.");
}

async function startCamera() {
  stopScript();
  if (!cameraModeEnabled()) {
    statusText.textContent = "Camera input is disabled while backend keyboard mode is on.";
    return;
  }

  if (cameraStarting || mediaPipeReady) {
    return;
  }

  if (!window.isSecureContext) {
    statusText.textContent =
      "Camera requires a secure context — open http://127.0.0.1:4180 (not file://).";
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    statusText.textContent = "Camera API is not available in this browser.";
    return;
  }

  try {
    cameraStarting = true;
    cameraButton.disabled = true;
    statusText.textContent = "Requesting camera access…";

    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 360 },
        frameRate: { ideal: 30 },
        facingMode: "user",
      },
      audio: false,
    });

    try {
      await video.play();
    } catch (playError) {
      console.warn("video.play() blocked:", playError);
      statusText.textContent = "Camera preview ready — click Camera if the feed stays black.";
    }

    statusText.textContent = "Loading hand model…";
    handLandmarker = await createHandLandmarker();

    mediaPipeReady = true;
    cameraStarting = false;
    cameraButton.disabled = false;
    mode = "Tracking";
    statusText.textContent = connected
      ? "Camera tracking active through proxy."
      : "Camera active. Proxy offline — samples queue when connected.";

    if (!visionLoopStarted) {
      visionLoopStarted = true;
      requestAnimationFrame(trackHands);
    }
  } catch (error) {
    cameraStarting = false;
    mediaPipeReady = false;
    cameraButton.disabled = false;
    stopCameraTracking();
    statusText.textContent = `Camera unavailable: ${error.message}`;
    console.error("startCamera failed:", error);
  }
}

function stopCameraTracking() {
  if (video.srcObject) {
    for (const track of video.srcObject.getTracks()) {
      track.stop();
    }
    video.srcObject = null;
  }
  handLandmarker = null;
  mediaPipeReady = false;
  cameraStarting = false;
  visionLoopStarted = false;
  lastVideoTime = -1;
  leftMeter.value = 0.5;
  rightMeter.value = 0.5;
  gestureStateText.textContent = "NEUTRAL";
  cameraButton.disabled = false;
}

function trackHands() {
  if (mediaPipeReady && handLandmarker && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = handLandmarker.detectForVideo(video, performance.now());
      const hands = orderedHands(result);
      const now = performance.now();
      localGesture.process(hands, now);
      const sample = handSample(hands);
      sendHandSample(sample, { record: true });
      updateHandMeters(sample);
      drawHandOverlay(hands);
      if (hands.length < 2) {
        statusText.textContent = "Show both hands.";
      } else {
        statusText.textContent = "Camera tracking active through proxy.";
      }
    }
  }
  requestAnimationFrame(trackHands);
}

function handSample(hands) {
  const sample = {
    leftY: null,
    rightY: null,
    handCount: Math.min(hands.length, 2),
  };

  hands.slice(0, 2).forEach((hand, index) => {
    const anchor = handAnchorPoint(hand);
    if (!anchor) {
      return;
    }
    const side = hands.length >= 2 ? index : screenSideIndex(anchor);
    if (side === 0) {
      sample.leftY = anchor.y;
    } else {
      sample.rightY = anchor.y;
    }
  });

  return sample;
}

function sendHandSample(sample, { record = true, traceAtMs } = {}) {
  const sent = sendTrackedMessage(
    {
      type: "hands",
      leftY: sample.leftY,
      rightY: sample.rightY,
      handCount: sample.handCount,
    },
    { record, traceAtMs },
  );

  if (!sent) {
    return;
  }

  sentHandSamples += 1;
  flapPulseText.textContent = `${sentHandSamples} samples / ${sentFlaps} flaps`;
}

function updateHandMeters(sample) {
  if (sample.leftY !== null) {
    leftMeter.value = handHeight({ y: sample.leftY });
  }
  if (sample.rightY !== null) {
    rightMeter.value = handHeight({ y: sample.rightY });
  }
}

function drawHandOverlay(hands) {
  const overlaySize = resizeHandOverlay();
  handCtx.clearRect(0, 0, overlaySize.width, overlaySize.height);
  drawHandSideGuide(handCtx, overlaySize);

  hands.slice(0, 2).forEach((hand, index) => {
    const anchor = handAnchorPoint(hand);
    if (!anchor) {
      return;
    }
    const side = hands.length >= 2 ? index : screenSideIndex(anchor);
    drawHandAnchorMarker(anchor, side, overlaySize);
  });
}

function drawSampleOverlay(sample) {
  const overlaySize = resizeHandOverlay();
  handCtx.clearRect(0, 0, overlaySize.width, overlaySize.height);
  drawHandSideGuide(handCtx, overlaySize);

  const sideSamples = [
    { side: 0, y: sample.leftY },
    { side: 1, y: sample.rightY },
  ];

  for (const { side, y } of sideSamples) {
    if (!Number.isFinite(y)) {
      continue;
    }
    drawHandAnchorMarker({ x: side === 0 ? 0.75 : 0.25, y }, side, overlaySize);
  }
}

function drawHandAnchorMarker(anchor, side, overlaySize) {
  const style = HAND_OVERLAY_STYLES[side] || HAND_OVERLAY_STYLES[0];
  const anchorPoint = landmarkToPreviewPoint(anchor, overlaySize);

  handCtx.save();
  handCtx.shadowColor = "rgba(0, 0, 0, 0.72)";
  handCtx.shadowBlur = 5;

  handCtx.beginPath();
  handCtx.arc(anchorPoint.x, anchorPoint.y, HAND_ANCHOR_MARKER_RADIUS, 0, Math.PI * 2);
  handCtx.fillStyle = style.anchor;
  handCtx.fill();
  handCtx.lineWidth = 3;
  handCtx.strokeStyle = "#ffffff";
  handCtx.stroke();

  handCtx.beginPath();
  handCtx.moveTo(anchorPoint.x - HAND_ANCHOR_MARKER_RADIUS - 8, anchorPoint.y);
  handCtx.lineTo(anchorPoint.x + HAND_ANCHOR_MARKER_RADIUS + 8, anchorPoint.y);
  handCtx.moveTo(anchorPoint.x, anchorPoint.y - HAND_ANCHOR_MARKER_RADIUS - 8);
  handCtx.lineTo(anchorPoint.x, anchorPoint.y + HAND_ANCHOR_MARKER_RADIUS + 8);
  handCtx.lineWidth = 3;
  handCtx.strokeStyle = style.anchor;
  handCtx.stroke();

  handCtx.beginPath();
  handCtx.arc(anchorPoint.x, anchorPoint.y, HAND_ANCHOR_MARKER_RADIUS + 10, 0, Math.PI * 2);
  handCtx.lineWidth = 2;
  handCtx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  handCtx.stroke();

  handCtx.restore();
}

function drawHandSideGuide(ctx, overlaySize) {
  const middleX = overlaySize.width / 2;
  const top = HAND_SIDE_GUIDE_TOP;
  const bottom = top + HAND_SIDE_GUIDE_HEIGHT;
  const leftColor = HAND_OVERLAY_STYLES[0].anchor;
  const rightColor = HAND_OVERLAY_STYLES[1].anchor;
  const leftLabelX = middleX / 2;
  const rightLabelX = middleX + middleX / 2;

  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.65)";
  ctx.shadowBlur = 4;
  ctx.globalAlpha = 0.92;
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.beginPath();
  ctx.moveTo(middleX, 0);
  ctx.lineTo(middleX, overlaySize.height);
  ctx.stroke();

  drawSideBracket(ctx, leftLabelX, top, bottom, leftColor, "left");
  drawSideBracket(ctx, rightLabelX, top, bottom, rightColor, "right");

  ctx.beginPath();
  ctx.moveTo(Math.max(18, leftLabelX - 42), top + HAND_SIDE_GUIDE_HEIGHT / 2);
  ctx.lineTo(middleX - 10, top + HAND_SIDE_GUIDE_HEIGHT / 2);
  ctx.moveTo(middleX + 10, top + HAND_SIDE_GUIDE_HEIGHT / 2);
  ctx.lineTo(Math.min(overlaySize.width - 18, rightLabelX + 42), top + HAND_SIDE_GUIDE_HEIGHT / 2);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.font = "800 13px Avenir Next, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("L", leftLabelX, bottom + 12);
  ctx.fillText("R", rightLabelX, bottom + 12);
  ctx.restore();
}

function drawSideBracket(ctx, centerX, top, bottom, color, direction) {
  const pointX = direction === "left" ? centerX - 18 : centerX + 18;
  const innerX = direction === "left" ? centerX - 4 : centerX + 4;

  ctx.beginPath();
  ctx.moveTo(pointX, top + HAND_SIDE_GUIDE_HEIGHT / 2);
  ctx.lineTo(innerX, top);
  ctx.lineTo(innerX, bottom);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.stroke();
}

function resizeHandOverlay() {
  const rect = handOverlay.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const pixelRatio = window.devicePixelRatio || 1;
  const canvasWidth = Math.round(width * pixelRatio);
  const canvasHeight = Math.round(height * pixelRatio);
  if (handOverlay.width !== canvasWidth || handOverlay.height !== canvasHeight) {
    handOverlay.width = canvasWidth;
    handOverlay.height = canvasHeight;
  }
  handCtx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  return { width, height };
}

function landmarkToPreviewPoint(landmark, overlaySize) {
  const { width, height } = overlaySize;
  const videoWidth = video.videoWidth || width;
  const videoHeight = video.videoHeight || height;
  const scale = Math.max(width / videoWidth, height / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  const offsetX = (width - renderedWidth) / 2;
  const offsetY = (height - renderedHeight) / 2;

  return {
    x: width - (offsetX + landmark.x * renderedWidth),
    y: offsetY + landmark.y * renderedHeight,
  };
}

function kickoffLocalRun() {
  applyLocalFlap();
  sendTrackedMessage({ type: "flap", source: "manual" }, { record: false });
}

function startSussyScript() {
  stopCameraTracking();
  stopScript();
  restartRun({ clearRecording: false });
  kickoffLocalRun();

  const controller = {
    name: "sussy motion",
    stopped: false,
    timer: null,
    stop() {
      this.stopped = true;
      if (this.timer) {
        clearTimeout(this.timer);
      }
    },
  };
  scriptController = controller;
  scriptStateText.textContent = controller.name;
  statusText.textContent =
    "Sussy motion only (hands) — trips anti-cheat, does not clear pipes. Use Pipe solver to win.";
  mode = "Script";

  const periodMs = 240;
  const sampleIntervalMs = 1000 / 60;
  const startedAt = performance.now();

  const tick = () => {
    if (controller.stopped) {
      return;
    }

    const elapsed = performance.now() - startedAt;
    const phase = ((elapsed % periodMs) / periodMs) * 2;
    const triangle = phase < 1 ? phase * 2 - 1 : 3 - phase * 2;
    const leftHeight = clamp(0.57 + 0.19 * triangle, 0.08, 0.92);
    const rightHeight = clamp(0.57 - 0.19 * triangle, 0.08, 0.92);
    const sample = {
      leftY: 1 - leftHeight,
      rightY: 1 - rightHeight,
      handCount: 2,
    };

    gestureStateText.textContent = triangle >= 0 ? "SUS LEFT_HIGH" : "SUS RIGHT_HIGH";
    updateHandMeters(sample);
    drawSampleOverlay(sample);
    sendHandSample(sample, { record: false });
    controller.timer = window.setTimeout(tick, sampleIntervalMs);
  };

  controller.timer = window.setTimeout(tick, 120);
}

function playTraceEvents(events, { name, claimScore, onDone } = {}) {
  stopCameraTracking();
  stopScript();
  restartRun({ clearRecording: false });

  const controller = {
    name,
    stopped: false,
    timers: [],
    stop() {
      this.stopped = true;
      for (const timer of this.timers) {
        clearTimeout(timer);
      }
      this.timers = [];
    },
  };
  scriptController = controller;
  scriptStateText.textContent = controller.name;
  mode = "Replay";

  for (const event of events) {
    if (event.message?.type === "restart") {
      continue;
    }

    const timer = window.setTimeout(() => {
      if (controller.stopped) {
        return;
      }
      replayTraceEvent(event);
    }, event.atMs);
    controller.timers.push(timer);
  }

  const lastAtMs = events.at(-1)?.atMs || 0;
  const finalTimer = window.setTimeout(() => {
    if (controller.stopped) {
      return;
    }
    stopScript();
    const resolvedClaim = Number(claimScore ?? state.score);
    if (resolvedClaim > verifyScoreThreshold()) {
      statusText.textContent = `Replay done. Verifying score ${resolvedClaim}…`;
      submitRunForVerification(resolvedClaim);
    } else {
      statusText.textContent = `${name} finished (local score ${state.score}).`;
    }
    onDone?.({ score: state.score, claimScore: resolvedClaim });
  }, lastAtMs + 500);
  controller.timers.push(finalTimer);
}

function startGoodReplay() {
  if (!trace || !trace.events.length) {
    statusText.textContent = "Good replay needs a recorded or imported trace first.";
    return;
  }

  statusText.textContent = "Replaying recorded trace.";
  playTraceEvents(trace.events, {
    name: "good replay",
    claimScore: trace.claimScore ?? trace.score,
  });
}

function startPipeSolverScript() {
  stopCameraTracking();
  stopScript();
  restartRun({ clearRecording: false });
  scriptStateText.textContent = "Computing jumps from deterministic pipe layout…";
  mode = "Script";

  window.setTimeout(() => {
    try {
      const target = targetWinScore();
      const built = buildSolveTrace({
        targetScore: target,
        overshoot: 1,
        motion: "camouflage",
      });

      statusText.textContent =
        `Solver planned ${built.flapSchedule.length} flaps (sim ${built.score}, claim ${built.claimScore}). Replaying…`;

      playTraceEvents(built.events, {
        name: "pipe solver",
        claimScore: built.claimScore,
        onDone: () => {
          console.log("Flap schedule", built.flapSchedule);
        },
      });
    } catch (error) {
      statusText.textContent = `Pipe solver failed: ${error.message}`;
      console.error(error);
    }
  }, 0);
}

function replayTraceEvent(event) {
  const message = event.message ?? event;
  const traceAtMs = event.atMs;

  if (message.type === "hands") {
    const sample = {
      leftY: message.leftY,
      rightY: message.rightY,
      handCount: message.handCount,
    };
    updateHandMeters(sample);
    drawSampleOverlay(sample);
    sendHandSample(sample, { record: false, traceAtMs });
    return;
  }

  if (message.type === "flap") {
    applyLocalFlap();
    sendTrackedMessage(
      { type: "flap", source: message.source || "manual" },
      { record: false, traceAtMs },
    );
    sentFlaps += 1;
    flapPulseText.textContent = `${sentHandSamples} samples / ${sentFlaps} flaps`;
    return;
  }

  sendTrackedMessage(message, { record: false, traceAtMs });
}

async function loadSolvePackTrace() {
  const response = await fetch("/fixtures/solve-pack.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`fixture missing (${response.status}) — run pnpm solve:build-pack`);
  }
  const payload = await response.json();
  if (!isTrace(payload)) {
    throw new Error("solve-pack.json is not a valid trace.");
  }
  trace = snapshotRecording(payload, payload.result || "solve-pack");
  saveTrace(trace);
  restoreTraceState();
  return trace;
}

async function startSolvePackReplay() {
  try {
    await loadSolvePackTrace();
    statusText.textContent = "Loaded solve-pack.json.";
    playTraceEvents(trace.events, {
      name: "solve pack",
      claimScore: trace.claimScore ?? trace.score ?? targetWinScore(),
    });
  } catch (error) {
    statusText.textContent = error.message;
  }
}

function stopScript() {
  if (!scriptController) {
    scriptStateText.textContent = "none";
    return;
  }

  scriptController.stop();
  scriptController = null;
  scriptStateText.textContent = "none";
  if (!mediaPipeReady) {
    gestureStateText.textContent = state.gesture?.status || "NEUTRAL";
  }
}

function exportTrace() {
  const payload = traceForExport();
  if (!payload?.events?.length) {
    statusText.textContent =
      "Nothing to export yet. Start Camera, show both hands, play a run, then export.";
    return;
  }

  const summary = summarizeRecording(payload);
  if (!isRecordingWorthSaving(payload)) {
    statusText.textContent =
      `Trace too short (${summary?.handSamples || 0} hand samples). ` +
      "Play a little longer before exporting.";
    return;
  }

  const blob = new Blob([JSON.stringify(snapshotRecording(payload, payload.result || "exported"), null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `67-trace-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  statusText.textContent =
    `Exported ${payload.events.length} events (${summary.handSamples} hand samples, ${summary.dualHands} with both Y).`;
}

async function importTrace(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  if (!isTrace(parsed)) {
    throw new Error("file does not contain a compatible trace");
  }
  trace = parsed;
  saveTrace(trace);
  restoreTraceState();
}

function pushProxyEvent(event) {
  proxyEvents.unshift(event);
  proxyEvents = proxyEvents.slice(0, MAX_LOG_EVENTS);
  renderProxyEvents();
}

function renderProxyEvents() {
  eventLog.innerHTML = "";
  for (const event of proxyEvents) {
    const item = document.createElement("li");
    const meta = document.createElement("span");
    meta.className = "event-meta";
    meta.textContent = `${event.timestamp} • ${event.sessionId || "session?"}`;
    const kind = document.createElement("span");
    kind.className = "event-kind";
    kind.textContent = event.type;
    const body = document.createElement("code");
    body.textContent = formatProxyEvent(event);
    item.append(meta, kind, body);
    eventLog.append(item);
  }
}

function formatProxyEvent(event) {
  if (event.payload) {
    return JSON.stringify(event.payload);
  }
  if (event.messageType) {
    return event.messageType;
  }
  if (event.text) {
    return event.text;
  }
  if (event.closeCode) {
    return `${event.closeCode} ${event.closeReason || ""}`.trim();
  }
  return event.targetUrl || "";
}

function prepareAtlasTransparency() {
  const prepared = document.createElement("canvas");
  prepared.width = atlas.naturalWidth;
  prepared.height = atlas.naturalHeight;
  const preparedCtx = prepared.getContext("2d", { willReadFrequently: true });
  preparedCtx.imageSmoothingEnabled = false;
  preparedCtx.drawImage(atlas, 0, 0);

  const image = preparedCtx.getImageData(0, 0, prepared.width, prepared.height);
  const visited = new Uint8Array(prepared.width * prepared.height);
  const queue = [];
  for (let x = 0; x < prepared.width; x += 1) {
    queue.push([x, 0], [x, prepared.height - 1]);
  }
  for (let y = 0; y < prepared.height; y += 1) {
    queue.push([0, y], [prepared.width - 1, y]);
  }

  while (queue.length > 0) {
    const [x, y] = queue.pop();
    if (x < 0 || y < 0 || x >= prepared.width || y >= prepared.height) {
      continue;
    }
    const pixelIndex = y * prepared.width + x;
    if (visited[pixelIndex]) {
      continue;
    }
    visited[pixelIndex] = 1;
    const dataIndex = pixelIndex * 4;
    if (!isBackgroundPixel(image.data, dataIndex)) {
      continue;
    }

    image.data[dataIndex + 3] = 0;
    queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  preparedCtx.putImageData(image, 0, 0);
  atlasCanvas = prepared;
}

function spriteSource() {
  return atlasCanvas || atlas;
}

function isBackgroundPixel(data, index) {
  return data[index] > 238 && data[index + 1] > 238 && data[index + 2] > 238 && data[index + 3] > 0;
}

function normalizeTargetUrl(rawTarget) {
  const url = new URL(rawTarget, window.location.origin);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/ws") ? pathname : `${pathname || ""}/ws`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

connectButton.addEventListener("click", () => {
  stopScript();
  connectGameSocket();
});
restartButton.addEventListener("click", () => restartRun({ clearRecording: true }));
cameraButton.addEventListener("click", startCamera);
stopScriptButton.addEventListener("click", () => {
  stopScript();
  statusText.textContent = "Script stopped.";
});
runSussyButton.addEventListener("click", startSussyScript);
runGoodButton.addEventListener("click", startGoodReplay);
if (runPipeSolverButton) {
  runPipeSolverButton.addEventListener("click", startPipeSolverScript);
}
if (runSolvePackButton) {
  runSolvePackButton.addEventListener("click", startSolvePackReplay);
}
exportTraceButton.addEventListener("click", exportTrace);
importTraceButton.addEventListener("click", () => importTraceInput.click());
importTraceInput.addEventListener("change", async () => {
  const [file] = importTraceInput.files || [];
  if (!file) {
    return;
  }
  try {
    await importTrace(file);
    statusText.textContent = `Imported trace ${file.name}.`;
  } catch (error) {
    statusText.textContent = `Trace import failed: ${error.message}`;
  } finally {
    importTraceInput.value = "";
  }
});
clearLogButton.addEventListener("click", () => {
  proxyEvents = [];
  renderProxyEvents();
});

window.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    if (scriptController) {
      return;
    }
    if (config.space67Keyboard) {
      sendFlap("gesture", { record: true });
      statusText.textContent = "Space sent a synthetic gesture flap.";
    } else {
      statusText.textContent = "Keyboard input is disabled in camera mode.";
    }
  }
});
