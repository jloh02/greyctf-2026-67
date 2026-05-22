const canvas = document.querySelector("#game");
const ctx = canvas.getContext("2d");
const cameraButton = document.querySelector("#cameraButton");
const flapButton = document.querySelector("#flapButton");
const restartButton = document.querySelector("#restartButton");
const video = document.querySelector("#cameraPreview");
const handOverlay = document.querySelector("#handOverlay");
const handCtx = handOverlay.getContext("2d");
const statusText = document.querySelector("#status");
const scoreText = document.querySelector("#score");
const bestText = document.querySelector("#best");
const modeText = document.querySelector("#mode");
const gestureStateText = document.querySelector("#gestureState");
const flapPulseText = document.querySelector("#flapPulse");
const leftMeter = document.querySelector("#leftMeter");
const rightMeter = document.querySelector("#rightMeter");

const HAND_CROSS_THRESHOLD = 0.02;
const MIN_CROSSES_PER_FLAP = 2;
const HAND_TRACKING_GRACE_MS = 240;
const HAND_ANCHOR_SMOOTHING = 0.35;
const HAND_ANCHOR_MARKER_RADIUS = 12;
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
const atlas = new Image();
let atlasCanvas = null;
atlas.addEventListener("load", prepareAtlasTransparency);
atlas.src = "./public/assets/flappy_atlas.png";

let constants = {
  width: 960,
  height: 540,
  birdX: 240,
  pipeWidth: 74,
  pipeGap: 168,
  floorY: 492,
};

let config = {
  space67Keyboard: false,
};

let state = {
  birdY: 230,
  velocity: 0,
  score: 0,
  best: 0,
  elapsed: 0,
  gameOver: false,
  shadowbanned: false,
  awaitingStart: true,
  pipes: [],
};

let socket = null;
let connected = false;
let cameraStarting = false;
let mediaPipeReady = false;
let visionLoopStarted = false;
let handLandmarker = null;
let lastVideoTime = -1;
let sentFlaps = 0;
let mode = "Connecting";
let synthetic67LeftHigh = false;

class GestureInterpreter {
  constructor(onFlap) {
    this.previousState = "NEUTRAL";
    this.pendingCross = false;
    this.crossCount = 0;
    this.lastSeenAt = 0;
    this.smoothedAnchors = [null, null];
    this.onFlap = onFlap;
  }

  process(hands, now = performance.now()) {
    if (hands.length < 2) {
      this.holdOrReset(now);
      return;
    }

    const leftAnchor = this.smoothAnchor(0, handAnchorPoint(hands[0]));
    const rightAnchor = this.smoothAnchor(1, handAnchorPoint(hands[1]));
    if (!leftAnchor || !rightAnchor) {
      this.holdOrReset(now);
      return;
    }
    this.lastSeenAt = now;

    const leftY = leftAnchor.y;
    const rightY = rightAnchor.y;
    leftMeter.value = 1 - leftY;
    rightMeter.value = 1 - rightY;

    const delta = leftY - rightY;
    if (Math.abs(delta) < HAND_CROSS_THRESHOLD) {
      this.pendingCross = true;
      gestureStateText.textContent = `CROSSING ${this.crossCount}/${MIN_CROSSES_PER_FLAP}`;
      return;
    }

    const currentState = delta < 0 ? "LEFT_HIGH" : "RIGHT_HIGH";
    if (
      this.pendingCross &&
      this.previousState !== "NEUTRAL" &&
      currentState !== this.previousState
    ) {
      this.crossCount += 1;
      if (this.crossCount >= MIN_CROSSES_PER_FLAP) {
        this.onFlap("gesture");
        this.crossCount = 0;
      }
    }
    this.pendingCross = false;
    gestureStateText.textContent = `${currentState} ${this.crossCount}/${MIN_CROSSES_PER_FLAP}`;

    this.previousState = currentState;
  }

  smoothAnchor(index, anchor) {
    if (!anchor) {
      return null;
    }

    const previous = this.smoothedAnchors[index];
    if (!previous) {
      this.smoothedAnchors[index] = anchor;
      return anchor;
    }

    const smoothed = {
      x: previous.x + (anchor.x - previous.x) * HAND_ANCHOR_SMOOTHING,
      y: previous.y + (anchor.y - previous.y) * HAND_ANCHOR_SMOOTHING,
      z: previous.z + (anchor.z - previous.z) * HAND_ANCHOR_SMOOTHING,
    };
    this.smoothedAnchors[index] = smoothed;
    return smoothed;
  }

  holdOrReset(now) {
    if (now - this.lastSeenAt <= HAND_TRACKING_GRACE_MS) {
      gestureStateText.textContent = "TRACKING HOLD";
      return;
    }

    this.previousState = "NEUTRAL";
    this.pendingCross = false;
    this.crossCount = 0;
    this.smoothedAnchors = [null, null];
    gestureStateText.textContent = "NEUTRAL";
  }
}

const gestures = new GestureInterpreter(sendFlap);

connect();
requestAnimationFrame(draw);

function connect() {
  socket = new WebSocket(`${backendWebSocketOrigin()}/ws`);
  statusText.textContent = "Connecting to authority server.";
  mode = "Connecting";

  socket.addEventListener("open", () => {
    connected = true;
    if (!cameraStarting) {
      statusText.textContent = mediaPipeReady ? "Camera tracking active." : "Server connected.";
    }
    mode = mediaPipeReady ? "Tracking" : "Online";
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "welcome") {
      constants = message.constants;
      config = message.config || config;
      canvas.width = constants.width;
      canvas.height = constants.height;
      applyInputMode();
      if (!cameraStarting) {
        if (config.space67Keyboard) {
          statusText.textContent = "Server connected. Keyboard mode active.";
        } else if (mediaPipeReady) {
          statusText.textContent = "Camera tracking active.";
        } else {
          statusText.textContent = "Starting camera tracking.";
        }
      }
      return;
    }
    if (message.type === "state") {
      state = message.state;
      return;
    }
  });

  socket.addEventListener("close", () => {
    connected = false;
    mode = "Offline";
    statusText.textContent = "Server disconnected. Restart the Node server and refresh.";
  });

  socket.addEventListener("error", () => {
    connected = false;
    mode = "Offline";
    statusText.textContent = "Server connection failed.";
  });
}

function backendWebSocketOrigin() {
  const configured = new URLSearchParams(window.location.search).get("backend");
  if (configured) {
    return configured.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "");
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const backendPort = window.location.port === "4173" || window.location.port === "80" ? "8787" : window.location.port;
  const host = backendPort ? `${window.location.hostname}:${backendPort}` : window.location.host;
  return `${protocol}//${host}`;
}

function sendFlap(source) {
  if (!connected || socket.readyState !== WebSocket.OPEN) {
    statusText.textContent = "Flap ignored while server is offline.";
    return;
  }

  socket.send(JSON.stringify({ type: "flap", source, clientTime: Date.now() }));
  sentFlaps += 1;
  flapPulseText.textContent = `${sentFlaps} sent`;
  mode = config.space67Keyboard ? "Keyboard" : mediaPipeReady ? "Tracking" : "Online";
}

function sendManualFlap() {
  if (!keyboardModeEnabled()) {
    statusText.textContent = "Manual input is disabled in camera mode.";
    return;
  }
  statusText.textContent = "Use Space in keyboard mode.";
}

function keyboardModeEnabled() {
  return config.space67Keyboard;
}

function cameraModeEnabled() {
  return !config.space67Keyboard;
}

function applyInputMode() {
  cameraButton.disabled = keyboardModeEnabled();
  flapButton.disabled = true;

  if (keyboardModeEnabled()) {
    stopCameraTracking();
    mode = connected ? "Keyboard" : "Offline";
    return;
  }

  if (!mediaPipeReady && !cameraStarting) {
    startCamera();
  }
}

function stopCameraTracking() {
  if (video.srcObject) {
    for (const track of video.srcObject.getTracks()) {
      track.stop();
    }
    video.srcObject = null;
  }
  mediaPipeReady = false;
  cameraStarting = false;
  lastVideoTime = -1;
  leftMeter.value = 0.5;
  rightMeter.value = 0.5;
  gestureStateText.textContent = "NEUTRAL";
}

function restartRun() {
  sentFlaps = 0;
  flapPulseText.textContent = "0 sent";
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "restart" }));
  }
}

function signalSynthetic67() {
  synthetic67LeftHigh = !synthetic67LeftHigh;
  const currentState = synthetic67LeftHigh ? "LEFT_HIGH" : "RIGHT_HIGH";
  gestureStateText.textContent = `DEV ${currentState}`;
  leftMeter.value = synthetic67LeftHigh ? 0.82 : 0.24;
  rightMeter.value = synthetic67LeftHigh ? 0.24 : 0.82;
  sendFlap("gesture");
}

function draw() {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, constants.width, constants.height);
  drawSky();
  drawPipes();
  drawFloor();
  drawBird();
  drawOverlay();

  scoreText.textContent = String(state.score);
  bestText.textContent = String(state.best);
  modeText.textContent = mode;

  requestAnimationFrame(draw);
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
    ctx.drawImage(spriteSource(), BIRD_SPRITE_START_X + frame * SPRITE_SIZE, 0, SPRITE_SIZE, SPRITE_SIZE, -28, -28, 56, 56);
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
      // Use a center crop from the atlas body tile so the shaft stays seamless
      // instead of repeating the rim detail baked into the full 16x16 sprite.
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

function prepareAtlasTransparency() {
  const prepared = document.createElement("canvas");
  prepared.width = atlas.naturalWidth;
  prepared.height = atlas.naturalHeight;
  const preparedCtx = prepared.getContext("2d", { willReadFrequently: true });
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
    drawMessage("Grounded", state.shadowbanned ? "Input rejected." : "Press Restart or flap again.");
  }
}

function readySubtitle() {
  if (!connected) {
    return "Connect to the server to play.";
  }
  if (keyboardModeEnabled()) {
    return "Press Space to start the run.";
  }
  if (cameraStarting) {
    return "Allow camera access to start.";
  }
  if (mediaPipeReady) {
    return "Use the 67 hand gesture to start the run.";
  }
  return "Starting camera tracking.";
}

function drawMessage(title, subtitle) {
  ctx.fillStyle = "rgba(100, 74, 24, 0.22)";
  ctx.fillRect(0, 0, constants.width, constants.height);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.font = "900 48px Inter, system-ui, sans-serif";
  ctx.lineWidth = 8;
  ctx.strokeStyle = "#5b4a27";
  ctx.strokeText(title, constants.width / 2, constants.height / 2 - 20);
  ctx.fillText(title, constants.width / 2, constants.height / 2 - 20);
  ctx.fillStyle = "#5b4a27";
  ctx.font = "700 18px Inter, system-ui, sans-serif";
  ctx.fillText(subtitle, constants.width / 2, constants.height / 2 + 22);
  ctx.textAlign = "start";
}

async function startCamera() {
  if (!cameraModeEnabled()) {
    statusText.textContent = "Camera is disabled in keyboard mode.";
    return;
  }
  try {
    cameraStarting = true;
    statusText.textContent = "Loading hand model.";
    const { FilesetResolver, HandLandmarker } = await import(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18"
    );
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm",
    );
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 2,
    });

    video.srcObject = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 960 },
        height: { ideal: 540 },
        facingMode: "user",
      },
      audio: false,
    });
    await video.play();
    mediaPipeReady = true;
    cameraStarting = false;
    mode = "Tracking";
    statusText.textContent = connected ? "Camera tracking active." : "Camera ready, server offline.";

    if (!visionLoopStarted) {
      visionLoopStarted = true;
      requestAnimationFrame(trackHands);
    }
  } catch (error) {
    cameraStarting = false;
    mediaPipeReady = false;
    statusText.textContent = `Camera unavailable: ${error.message}`;
  }
}

function trackHands() {
  if (mediaPipeReady && handLandmarker && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = handLandmarker.detectForVideo(video, performance.now());
      const hands = orderedHands(result);
      gestures.process(hands);
      drawHandOverlay(hands);
      if (!result.landmarks || result.landmarks.length < 2) {
        statusText.textContent = "Show both hands.";
      } else {
        statusText.textContent = "Camera tracking active.";
      }
    }
  }
  requestAnimationFrame(trackHands);
}

function drawHandOverlay(hands) {
  const overlaySize = resizeHandOverlay();
  handCtx.clearRect(0, 0, overlaySize.width, overlaySize.height);

  hands.slice(0, 2).forEach((hand, index) => {
    const style = HAND_OVERLAY_STYLES[index] || HAND_OVERLAY_STYLES[0];
    const anchor = handAnchorPoint(hand);
    if (!anchor) {
      return;
    }
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
  });
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

function handAnchorPoint(hand) {
  const landmarks = hand.filter(
    (landmark) => landmark && Number.isFinite(landmark.x) && Number.isFinite(landmark.y),
  );
  if (!landmarks.length) {
    return null;
  }

  return {
    x: median(landmarks.map((landmark) => landmark.x)),
    y: median(landmarks.map((landmark) => landmark.y)),
    z: median(landmarks.map((landmark) => landmark.z || 0)),
  };
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
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

function orderedHands(result) {
  const landmarks = result.landmarks || [];
  if (landmarks.length < 2) {
    return landmarks;
  }

  const hands = landmarks.map((handLandmarks) => ({
    landmarks: handLandmarks,
    anchor: handAnchorPoint(handLandmarks),
  }));

  return hands
    .sort((first, second) => (second.anchor?.x || 0) - (first.anchor?.x || 0))
    .slice(0, 2)
    .map((hand) => hand.landmarks);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

cameraButton.addEventListener("click", startCamera);
flapButton.addEventListener("click", sendManualFlap);
restartButton.addEventListener("click", restartRun);

window.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".controls")) {
    return;
  }
  if (keyboardModeEnabled()) {
    statusText.textContent = "Use Space in keyboard mode.";
    return;
  }
  statusText.textContent = "Pointer input is disabled in camera mode.";
});

window.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    if (keyboardModeEnabled()) {
      signalSynthetic67();
    } else {
      statusText.textContent = "Keyboard input is disabled in camera mode.";
    }
  }
});
