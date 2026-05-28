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
import {
  createTraceReplayer,
  finishMessage,
  flapMessage,
  handsMessage,
  restartMessage,
  toSocketPayload,
} from "/shared/frontend-client.js";
import { createAltitudeHoldController } from "/shared/altitude-hold.js";
import { mockHandsFromSample } from "/shared/gesture-loop.js";
import {
  SOLVE_MODES,
  buildSuiteTrace,
  listSolveModesByTier,
  localSimOptionsForMode,
} from "/shared/solve-suite.js";
import { buildVideoSolvePlan } from "/shared/video-solve.js";

const TRACE_STORAGE_KEY = "solve-lab:last-trace";
const MAX_RENDER_DT_SECONDS = 0.05;
const TRACE_MIN_HAND_SAMPLES = 30;
const TRACE_MIN_DURATION_MS = 1500;
const CAPTURE_COUNTDOWN_MS = 3000;
const CAPTURE_HOLD_MS = 2600;
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
const solveSuiteSelect = document.querySelector("#solveSuiteSelect");
const solveSuiteDescription = document.querySelector("#solveSuiteDescription");
const solveSuiteResult = document.querySelector("#solveSuiteResult");
const runSolveSuiteButton = document.querySelector("#runSolveSuiteButton");
const exportTraceButton = document.querySelector("#exportTraceButton");
const importTraceButton = document.querySelector("#importTraceButton");
const importTraceInput = document.querySelector("#importTraceInput");
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
const scriptStateText = document.querySelector("#scriptState");
const traceStateText = document.querySelector("#traceState");
const traceSummaryText = document.querySelector("#traceSummary");
const importVideoButton = document.querySelector("#importVideoButton");
const videoSolverInput = document.querySelector("#videoSolverInput");
const cropStartInput = document.querySelector("#cropStartInput");
const cropEndInput = document.querySelector("#cropEndInput");
const markCropStartButton = document.querySelector("#markCropStartButton");
const markCropEndButton = document.querySelector("#markCropEndButton");
const extractVideoClipButton = document.querySelector("#extractVideoClipButton");
const buildVideoSolverButton = document.querySelector("#buildVideoSolverButton");
const runVideoSolverButton = document.querySelector("#runVideoSolverButton");
const solverPreview = document.querySelector("#solverPreview");
const solverPreviewCtx = solverPreview?.getContext("2d");
const videoSolverState = document.querySelector("#videoSolverState");

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
  videoVerify: {
    mode: "required",
    minFrames: 80,
    minValidFrames: 70,
    minAverageFps: 4,
  },
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
  onFlap: () => handleGestureFlap(),
  onTelemetry: (telemetry) => {
    state.gesture = telemetry;
  },
});

let socket = null;
let connected = false;
let cameraStarting = false;
let mediaPipeReady = false;
let visionLoopStarted = false;
let handLandmarker = null;
let lastVideoTime = -1;
let sentFlaps = 0;
let sentHandSamples = 0;
let sentVideoFrames = 0;
let lastVideoFrameSentAt = -Infinity;
let latestHandSample = { leftY: null, rightY: null, handCount: 0 };
let snapshotChallengeCount = 0;
let snapshotAcceptedCount = 0;
let mode = "Connecting";
let pingTimer = null;
let syncState = {
  rttMs: 0,
  clockOffsetMs: 0,
};
let scriptController = null;
let localSimOptions = null;
let trace = loadTrace();
let currentRecording = createEmptyTrace();
let guidedCapture = createGuidedCaptureState();
let videoSolverSource = createVideoSolverSourceState();
let videoSolveBuild = null;
let latestVideoSolverFrame = null;
const videoSolveRenderCanvas = document.createElement("canvas");
const videoSolveRenderCtx = videoSolveRenderCanvas.getContext("2d");

const VIDEO_FRAME_INTERVAL_MS = 80;
const VIDEO_FRAME_WIDTH = 360;
const VIDEO_FRAME_QUALITY = 0.58;
const VIDEO_SOLVER_SAMPLE_FPS = 30;
const VIDEO_SOLVER_PREVIEW_WIDTH = 360;
const VIDEO_SOLVER_PREVIEW_QUALITY = 0.6;

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
    if (message.type === "snapshot_challenge") {
      handleSnapshotChallenge(message);
      return;
    }
    if (message.type === "snapshot_result") {
      handleSnapshotResult(message);
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

function proxySocketUrl(target) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${window.location.host}/ws`);
  url.searchParams.set("target", normalizeTargetUrl(target));
  return url.toString();
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

function recordingTraceAtMs() {
  if (currentRecording.startedAt === null) {
    return undefined;
  }
  return Date.now() - currentRecording.startedAt;
}

function sendTrackedMessage(message, { record = true, traceAtMs } = {}) {
  const resolvedTraceAtMs = Number.isFinite(traceAtMs) ? traceAtMs : recordingTraceAtMs();
  if (record) {
    recordTraceEvent(message);
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(toSocketPayload(message, { traceAtMs: resolvedTraceAtMs })));
  return true;
}

function recordTraceEvent(message, { force = false } = {}) {
  if (
    !force &&
    (scriptController ||
      guidedCapture.phase !== "recording" ||
      (message.type !== "hands" && message.type !== "flap"))
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

function createGuidedCaptureState() {
  return {
    phase: "waiting",
    countdownStartedAt: null,
    recordingStartedAt: null,
    flapAtMs: null,
    holdUntil: null,
    completedAt: null,
  };
}

function resetGuidedCapture({ clearRecording = true } = {}) {
  guidedCapture = createGuidedCaptureState();
  localGesture.reset();
  if (clearRecording) {
    currentRecording = createEmptyTrace();
    updateTraceSummary(currentRecording);
  }
}

function hasTwoHands(sample) {
  return (
    sample.handCount >= 2 &&
    Number.isFinite(sample.leftY) &&
    Number.isFinite(sample.rightY)
  );
}

function updateGuidedCapture(sample) {
  if (scriptController || !mediaPipeReady) {
    return false;
  }

  const now = Date.now();
  const ready = hasTwoHands(sample);

  if (guidedCapture.phase === "complete") {
    statusText.textContent = trace?.events?.length
      ? `Saved 67 clip with ${trace.events.length} events.`
      : "Saved 67 clip.";
    return true;
  }

  if (!ready) {
    if (guidedCapture.phase === "countdown") {
      guidedCapture = createGuidedCaptureState();
      localGesture.reset();
    }
    statusText.textContent = "Show both hands.";
    return true;
  }

  if (guidedCapture.phase === "waiting") {
    guidedCapture.phase = "countdown";
    guidedCapture.countdownStartedAt = now;
    localGesture.reset();
  }

  if (guidedCapture.phase === "countdown") {
    const elapsed = now - guidedCapture.countdownStartedAt;
    const remaining = Math.max(1, Math.ceil((CAPTURE_COUNTDOWN_MS - elapsed) / 1000));
    statusText.textContent = elapsed >= CAPTURE_COUNTDOWN_MS
      ? "Recording 67 gesture."
      : `Recording starts in ${remaining}.`;

    if (elapsed >= CAPTURE_COUNTDOWN_MS) {
      startGuidedRecording();
    }
    return true;
  }

  if (guidedCapture.phase === "recording" && guidedCapture.flapAtMs === null) {
    statusText.textContent = "Recording 67 gesture.";
    return true;
  }

  if (guidedCapture.phase === "holding") {
    const remaining = Math.max(0, guidedCapture.holdUntil - now);
    statusText.textContent = `Keep small natural hand motion ${(remaining / 1000).toFixed(1)}s.`;
    if (remaining <= 0) {
      finalizeGuidedCapture();
    }
    return true;
  }

  return false;
}

function startGuidedRecording() {
  guidedCapture.phase = "recording";
  guidedCapture.recordingStartedAt = Date.now();
  currentRecording = createEmptyTrace();
  currentRecording.startedAt = guidedCapture.recordingStartedAt;
  currentRecording.result = "capturing";
  currentRecording.score = 0;
  localGesture.reset();
  updateTraceSummary(currentRecording);
}

function handleGestureFlap() {
  applyLocalFlap();
  if (guidedCapture.phase !== "recording" || guidedCapture.flapAtMs !== null) {
    return;
  }

  guidedCapture.flapAtMs = recordingTraceAtMs() ?? 0;
  guidedCapture.holdUntil = Date.now() + CAPTURE_HOLD_MS;
  guidedCapture.phase = "holding";
  recordTraceEvent(flapMessage("gesture"), { force: true });
}

function finalizeGuidedCapture() {
  if (!currentRecording.events.length || guidedCapture.flapAtMs === null) {
    guidedCapture = createGuidedCaptureState();
    return;
  }

  currentRecording.completedAt = new Date().toISOString();
  currentRecording.result = "gesture-loop";
  currentRecording.score = 0;
  trace = snapshotRecording(currentRecording, "gesture-loop");
  saveTrace(trace);
  currentRecording = createEmptyTrace();
  guidedCapture.phase = "complete";
  guidedCapture.completedAt = Date.now();
  restoreTraceState();
  statusText.textContent = `Saved 67 clip with ${trace.events.length} events.`;
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

function createVideoSolverSourceState() {
  return {
    fileName: "",
    objectUrl: "",
    durationMs: 0,
    cropStartMs: 0,
    cropEndMs: 0,
    trace: null,
    preparedFrames: [],
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
  sentVideoFrames = 0;
  lastVideoFrameSentAt = -Infinity;
  snapshotChallengeCount = 0;
  snapshotAcceptedCount = 0;
  flapPulseText.textContent = "0 samples / 0 frames / 0 flaps";
  resetLocalRun();

  if (clearRecording && !scriptController) {
    resetGuidedCapture({ clearRecording: true });
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
  updateInputCounters();
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
  if (mode === "Replay" && scriptController) {
    return;
  }
  if (!state.awaitingStart && !state.gameOver) {
    stepGameState(state, dt, constants, localSimOptions || undefined);
  }
}

function catchUpSimulationTo(targetMs) {
  const tickSeconds = 1 / 60;
  const maxCatchUpSteps = 6000;
  let steps = 0;
  let simMs = scriptController?.replaySimMs ?? 0;

  while (simMs + tickSeconds * 1000 <= targetMs && !state.gameOver && steps < maxCatchUpSteps) {
    if (!state.awaitingStart) {
      stepGameState(state, tickSeconds, constants, localSimOptions || undefined);
    }
    simMs += tickSeconds * 1000;
    steps += 1;
  }

  if (scriptController) {
    scriptController.replaySimMs = simMs;
  }
}

function maybeScriptAltitudeHold() {
  const hold = scriptController?.altitudeHold;
  if (!hold || state.gameOver) {
    return;
  }

  const now = performance.now();
  if (!hold.shouldFlap(state, now)) {
    return;
  }

  scriptController.holdFlaps = (scriptController.holdFlaps || 0) + 1;
  const elapsed = Math.round(now - (scriptController.startedAt || now));
  applyLocalFlap();
  sendTrackedMessage(flapMessage("manual"), { record: false, traceAtMs: elapsed });
  sentFlaps += 1;
  updateHoldHud(hold);
}

function updateHoldHud(hold) {
  const targetY = hold.resolveTargetY(state);
  const bandHigh = targetY + hold.config.flapBelow;
  const bandLow = targetY - hold.config.tooHigh;
  gestureStateText.textContent = `HOLD y=${Math.round(state.birdY)} band ${Math.round(bandLow)}–${Math.round(bandHigh)}`;
}

function maybeCompleteSuiteHold() {
  if (!scriptController?.claimScore || finishSubmitted || state.gameOver) {
    return;
  }
  if (state.score < targetWinScore()) {
    return;
  }

  const claim = scriptController.claimScore;
  stopScript();
  finishSubmitted = true;
  if (scoreNeedsVerification(claim)) {
    statusText.textContent = `Score ${state.score}. Verifying with server…`;
    submitRunForVerification(claim);
  } else {
    grantLocalWinIfTrusted(state.score);
    statusText.textContent = `Hold run finished at score ${state.score}.`;
  }
}

function startFrameHoldLive({ name, simOptions, claimScore, godMode = false }) {
  stopCameraTracking();
  stopScript();
  restartRun({ clearRecording: false });
  localSimOptions = simOptions;

  const altitudeHold = createAltitudeHoldController({
    respectFrameBounds: !godMode,
    constants,
  });
  altitudeHold.reset();
  applyLocalFlap();
  sendTrackedMessage(flapMessage("manual"), { record: false, traceAtMs: 0 });

  const controller = {
    name,
    claimScore,
    altitudeHold,
    startedAt: performance.now(),
    holdFlaps: 1,
    timer: null,
    stop() {
      this.stopped = true;
      if (this.timer) {
        clearTimeout(this.timer);
      }
      localSimOptions = null;
    },
  };
  scriptController = controller;
  scriptStateText.textContent = name;
  mode = "Hold";
  statusText.textContent = godMode
    ? "God-mode hold: pass pipes + frame."
    : "Frame hold: pass pipes; floor/ceiling kill.";

  const sampleIntervalMs = 1000 / 60;
  const tick = () => {
    if (controller.stopped) {
      return;
    }
    const elapsed = performance.now() - controller.startedAt;
    const sample = {
      leftY: 0.45 + 0.02 * Math.sin(elapsed / 280),
      rightY: 0.55 - 0.02 * Math.sin(elapsed / 280),
      handCount: 2,
    };
    sendHandSample(sample, { record: false, traceAtMs: Math.round(elapsed) });
    updateHandMeters(sample);
    drawSampleOverlay(sample);
    flapPulseText.textContent = `${sentHandSamples} samples / ${sentFlaps} flaps (hold ${controller.holdFlaps})`;
    controller.timer = window.setTimeout(tick, sampleIntervalMs);
  };
  controller.timer = window.setTimeout(tick, 0);
  updateHoldHud(altitudeHold);
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

/** Show the flag banner only when the win does not require server replay. */
function grantLocalWinIfTrusted(score) {
  if (score >= targetWinScore() && !scoreNeedsVerification(score)) {
    sessionMeta.won = true;
    updateFlagBanner();
  }
}

function checkRunFinished() {
  if (!state.gameOver || finishSubmitted) {
    return;
  }

  finishSubmitted = true;
  sessionMeta.best = Math.max(sessionMeta.best, state.score);
  maybeFinalizeRecording();
  grantLocalWinIfTrusted(state.score);

  if (!scoreNeedsVerification(state.score)) {
    return;
  }

  submitRunForVerification(state.score);
}

function submitRunForVerification(score) {
  if (!connected || socket.readyState !== WebSocket.OPEN) {
    const offline = "Cannot verify — game socket offline. Connect proxy first.";
    statusText.textContent = offline;
    appendSolveSuiteResult(offline);
    return;
  }

  finishSubmitted = true;
  verificationPending = true;
  statusText.textContent = `Verifying run (score ${score})...`;
  appendSolveSuiteResult(`Submitting finish (claim ${score})…`);
  sendControlMessage({
    type: "finish",
    score,
    clientTime: Date.now(),
  });
}

function appendSolveSuiteResult(text, { replace = false } = {}) {
  if (!solveSuiteResult) {
    return;
  }
  if (replace) {
    solveSuiteResult.textContent = text;
    return;
  }
  const previous = solveSuiteResult.textContent.trim();
  solveSuiteResult.textContent = previous ? `${previous}\n${text}` : text;
}

function formatVerifiedSummary(message) {
  const lines = [
    "--- Verification ---",
    `valid: ${message.valid}`,
    `verified: ${message.verified ?? "n/a"}`,
    `replay score: ${message.score}`,
    `claimed: ${message.claimedScore ?? "n/a"}`,
    `won: ${message.won ?? false}`,
  ];
  if (message.flag) {
    lines.push(`flag: ${message.flag}`);
  }
  if (message.message) {
    lines.push(`message: ${message.message}`);
  }
  const antiCheat = message.antiCheat;
  if (antiCheat?.message) {
    lines.push(`anti-cheat: ${antiCheat.level} — ${antiCheat.message}`);
  }
  return lines.join("\n");
}

function applyVerifiedResult(message) {
  verificationPending = false;
  appendSolveSuiteResult(formatVerifiedSummary(message));

  if (message.valid && message.won) {
    sessionMeta.won = true;
    sessionMeta.flag = message.flag || "";
    statusText.textContent = "Verified win.";
  } else {
    sessionMeta.won = false;
    sessionMeta.flag = "";
    if (message.blocked || message.antiCheat?.level === "blocked") {
      statusText.textContent = message.message || "Verification blocked.";
    } else {
      statusText.textContent = message.message || `Verify failed (score ${message.score}).`;
    }
  }
  updateFlagBanner();
}

function draw() {
  const now = performance.now();
  const dt = Math.min(MAX_RENDER_DT_SECONDS, Math.max(0, (now - lastDrawAt) / 1000));
  lastDrawAt = now;
  advanceLocalSimulation(dt);
  maybeScriptAltitudeHold();
  maybeCompleteSuiteHold();
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

async function ensureHandLandmarker() {
  if (handLandmarker) {
    return handLandmarker;
  }
  handLandmarker = await createHandLandmarker();
  return handLandmarker;
}

async function startCamera() {
  stopScript();
  resetGuidedCapture({ clearRecording: true });
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
    handLandmarker = await ensureHandLandmarker();

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
      const sample = handSample(hands);
      const captureStatusHandled = updateGuidedCapture(sample);
      if (guidedCapture.phase === "recording" || guidedCapture.phase === "holding") {
        localGesture.process(hands, now);
      }
      sendHandSample(sample, { record: true });
      maybeSendVideoFrame(sample, now);
      updateHandMeters(sample);
      drawHandOverlay(hands);
      if (!captureStatusHandled) {
        statusText.textContent =
          hands.length < 2 ? "Show both hands." : "Camera tracking active through proxy.";
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
  latestHandSample = {
    leftY: sample.leftY,
    rightY: sample.rightY,
    handCount: sample.handCount,
  };

  const sent = sendTrackedMessage(handsMessage(sample), { record, traceAtMs });

  if (!sent) {
    return;
  }

  sentHandSamples += 1;
  updateInputCounters();
}

function maybeSendVideoFrame(sample, now = performance.now()) {
  if (config.videoVerify?.mode === "off") {
    return;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  if (now - lastVideoFrameSentAt < VIDEO_FRAME_INTERVAL_MS) {
    return;
  }
  if (!mediaPipeReady || sample.handCount < 2) {
    return;
  }

  lastVideoFrameSentAt = now;
  const payload = {
    type: "video_frame",
    sequence: sentVideoFrames + 1,
    ...sample,
    clientTime: Date.now(),
    traceAtMs: recordingTraceAtMs(),
  };

  try {
    payload.image = captureCameraSnapshot(VIDEO_FRAME_WIDTH, VIDEO_FRAME_QUALITY);
  } catch (error) {
    payload.image = "";
    payload.error = error.message;
  }

  socket.send(JSON.stringify(payload));
  sentVideoFrames += 1;
  updateInputCounters();
}

function updateInputCounters() {
  flapPulseText.textContent = `${sentHandSamples} samples / ${sentVideoFrames} frames / ${sentFlaps} flaps`;
}

function handleSnapshotChallenge(message) {
  snapshotChallengeCount += 1;
  statusText.textContent = `Snapshot challenge ${snapshotChallengeCount}: keep both hands visible.`;
  sendSnapshotResponse(message);
}

function handleSnapshotResult(message) {
  if (message.accepted) {
    snapshotAcceptedCount += 1;
    statusText.textContent = `Snapshot accepted (${snapshotAcceptedCount}/${snapshotChallengeCount}).`;
    return;
  }

  statusText.textContent = message.message || "Snapshot challenge failed.";
}

function sendSnapshotResponse(challenge) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const payload = {
    type: "snapshot",
    challengeId: challenge.challengeId,
    ...latestHandSample,
    clientTime: Date.now(),
    traceAtMs: recordingTraceAtMs(),
  };

  try {
    payload.image = captureCameraSnapshot();
  } catch (error) {
    payload.image = "";
    payload.error = error.message;
  }

  socket.send(JSON.stringify(payload));
}

function captureCameraSnapshot(targetMaxWidth = 480, quality = 0.68) {
  if (!mediaPipeReady || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    throw new Error("camera frame unavailable");
  }

  const sourceWidth = video.videoWidth || 0;
  const sourceHeight = video.videoHeight || 0;
  if (sourceWidth < 1 || sourceHeight < 1) {
    throw new Error("camera frame has no dimensions");
  }

  const targetWidth = Math.min(targetMaxWidth, sourceWidth);
  const targetHeight = Math.max(1, Math.round((sourceHeight / sourceWidth) * targetWidth));
  const snapshotCanvas = document.createElement("canvas");
  snapshotCanvas.width = targetWidth;
  snapshotCanvas.height = targetHeight;
  const snapshotCtx = snapshotCanvas.getContext("2d");
  snapshotCtx.drawImage(video, 0, 0, targetWidth, targetHeight);
  return snapshotCanvas.toDataURL("image/jpeg", quality);
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

function playTraceEvents(events, { name, claimScore, onDone, simOptions = null } = {}) {
  stopCameraTracking();
  stopScript();
  localSimOptions = simOptions;
  restartRun({ clearRecording: false });

  const controller = {
    name,
    replaySimMs: 0,
    stop() {
      replayer.stop();
      localSimOptions = null;
    },
  };
  scriptController = controller;
  scriptStateText.textContent = name;
  mode = "Replay";

  const replayer = createTraceReplayer(events, {
    onHands: (event) => replayTraceEvent(event),
    onFlap: (event) => replayTraceEvent(event),
    onMessage: (event) => replayTraceEvent(event),
    onComplete: () => {
      scriptController = null;
      scriptStateText.textContent = "none";
      localSimOptions = null;
      const resolvedClaim = Number(claimScore ?? state.score);
      appendSolveSuiteResult(
        `Replay done. Local score ${state.score}. Claim ${resolvedClaim}.`,
      );
      if (finishSubmitted) {
        statusText.textContent = `${name} finished (local score ${state.score}).`;
      } else if (resolvedClaim > verifyScoreThreshold()) {
        statusText.textContent = `Replay done. Verifying score ${resolvedClaim}…`;
        submitRunForVerification(resolvedClaim);
      } else {
        statusText.textContent = `${name} finished (local score ${state.score}).`;
        appendSolveSuiteResult("Skipped verify (claim ≤ threshold).");
      }
      onDone?.({ score: state.score, claimScore: resolvedClaim });
    },
  });
  controller.stop = () => {
    replayer.stop();
    localSimOptions = null;
    scriptController = null;
    scriptStateText.textContent = "none";
  };
}

function populateSolveSuiteSelect() {
  if (!solveSuiteSelect) {
    return;
  }

  solveSuiteSelect.replaceChildren();
  for (const group of listSolveModesByTier()) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = `Tier ${group.tier}: ${group.title}`;
    for (const entry of group.modes) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.label;
      optgroup.appendChild(option);
    }
    solveSuiteSelect.appendChild(optgroup);
  }

  solveSuiteSelect.value = "recorded-gesture-replay";
  updateSolveSuiteDescription();
}

function updateSolveSuiteDescription() {
  if (!solveSuiteSelect || !solveSuiteDescription) {
    return;
  }

  const mode = SOLVE_MODES.find((entry) => entry.id === solveSuiteSelect.value);
  const tier = listSolveModesByTier().find((group) => group.tier === mode?.tier);
  solveSuiteDescription.textContent = mode
    ? `${tier?.description || ""} Expected verify: ${mode.verifyExpected}.`
    : "";
}

function reportSuiteResult(built, { footer = "" } = {}) {
  const durationSec = ((built.events?.at(-1)?.atMs ?? built.simMs ?? 0) / 1000).toFixed(1);
  const lines = [
    `Mode: ${built.mode.label}`,
    `Planned: local=${built.score} replay-flaps=${built.replayScore ?? "n/a"} claim=${built.claimScore}`,
    `Trace: ${built.events?.length ?? 0} events (~${durationSec}s)`,
    built.note ? `Note: ${built.note}` : "",
    footer,
  ].filter(Boolean);

  appendSolveSuiteResult(lines.join("\n"), { replace: true });
  console.log("Solve suite", built);
}

async function runSolveSuiteMode(modeId) {
  stopCameraTracking();
  stopScript();

  try {
    let activeTrace = trace;
    if (modeId === "recorded-gesture-replay" && !activeTrace?.events?.length) {
      statusText.textContent = "No trace loaded — fetching solve-pack.json…";
      activeTrace = await loadSolvePackTrace();
    }

    const built = buildSuiteTrace(modeId, {
      targetScore: targetWinScore(),
      overshoot: 1,
      trace: activeTrace,
    });

    const needsReplay =
      modeId !== "empty-claim" &&
      modeId !== "no-collision-pipes" &&
      modeId !== "no-collision-pipes-frame";

    reportSuiteResult(built, {
      footer: needsReplay
        ? "Replaying to server… verification prints below when done."
        : "",
    });

    if (modeId === "empty-claim") {
      restartRun({ clearRecording: false });
      scriptStateText.textContent = built.mode.label;
      mode = "Suite";
      statusText.textContent =
        "Empty claim: submitting finish 67 with no inputs (expect verify fail).";
      window.setTimeout(() => {
        sendTrackedMessage(restartMessage(), { record: false });
        submitRunForVerification(built.claimScore);
      }, 400);
      return;
    }

    const simOptions = built.stepOptions ?? localSimOptionsForMode(modeId);

    if (modeId === "no-collision-pipes" || modeId === "no-collision-pipes-frame") {
      startFrameHoldLive({
        name: built.mode.label,
        simOptions,
        claimScore: built.claimScore,
        godMode: modeId === "no-collision-pipes-frame",
      });
      return;
    }

    const replayName = `${built.mode.label}${built.direction ? ` (${built.direction})` : ""}`;
    statusText.textContent = `${replayName} — ${built.events.length} events. Replaying…`;

    playTraceEvents(built.events, {
      name: replayName,
      claimScore: built.claimScore,
      simOptions,
      onDone: () => {
        if (built.localOnly) {
          statusText.textContent +=
            " Local god-mode only — server verify should fail.";
        }
      },
    });
  } catch (error) {
    statusText.textContent = error.message;
    if (solveSuiteResult) {
      solveSuiteResult.textContent = error.message;
    }
  }
}

function startSolveSuiteScript() {
  if (!solveSuiteSelect) {
    return;
  }
  void runSolveSuiteMode(solveSuiteSelect.value);
}

function replayTraceEvent(event) {
  const message = event.message ?? event;
  const traceAtMs = event.atMs;
  catchUpSimulationTo(traceAtMs);

  if (message.type === "hands") {
    const sample = {
      leftY: message.leftY,
      rightY: message.rightY,
      handCount: message.handCount,
    };
    updateHandMeters(sample);
    drawSampleOverlay(sample);
    localGesture.process(mockHandsFromSample(sample), performance.now());
    sendHandSample(sample, { record: false, traceAtMs });
    return;
  }

  if (message.type === "flap") {
    applyLocalFlap();
    sendTrackedMessage(flapMessage(message.source || "manual"), {
      record: false,
      traceAtMs,
    });
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
if (runSolveSuiteButton) {
  runSolveSuiteButton.addEventListener("click", startSolveSuiteScript);
}
if (solveSuiteSelect) {
  solveSuiteSelect.addEventListener("change", updateSolveSuiteDescription);
  populateSolveSuiteSelect();
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
