/**
 * Deterministic flappy solver using the same pipe RNG as shared/game-core.js.
 * Precomputes manual flap times from simulated physics + gap targeting.
 */
import {
  GAME_CONSTANTS,
  WIN_SCORE,
  applyFlap,
  createGameState,
  stepGameState,
} from "./game-core.js";

export const SAMPLE_INTERVAL_MS = 1000 / 60;
export const TICK_SECONDS = 1 / 60;
export const MIN_FLAP_INTERVAL_MS = 300;

export function gapCenterY(pipe, constants = GAME_CONSTANTS) {
  return pipe.gapY + constants.pipeGap * 0.5;
}

/** Pipes the bird is approaching (deterministic from current sim state). */
export function upcomingPipe(state, constants = GAME_CONSTANTS, lookaheadX = 240) {
  const birdX = constants.birdX;
  return (
    state.pipes
      .filter((pipe) => pipe.x + constants.pipeWidth > birdX - 5 && pipe.x < birdX + lookaheadX)
      .sort((left, right) => left.x - right.x)[0] || null
  );
}

/** Heuristic flap decision from bird Y, velocity, and next gap. */
export function shouldFlap(state, constants = GAME_CONSTANTS) {
  if (state.awaitingStart || state.gameOver) {
    return false;
  }

  const target = upcomingPipe(state, constants);
  if (!target) {
    return state.birdY > constants.floorY - 150;
  }

  const center = gapCenterY(target, constants);
  if (state.birdY < center - 35) {
    return false;
  }

  return state.birdY > center + 25;
}

export function camouflageHandMessage(elapsedMs, options = {}) {
  const midY = options.midY ?? 0.46;
  const wiggle = (options.wiggle ?? 0.018) * Math.sin(elapsedMs / (options.wigglePeriodMs ?? 240));
  const leftY = clamp(midY + wiggle, 0.12, 0.88);
  const rightY = clamp(midY - wiggle * 0.85, 0.12, 0.88);
  return {
    type: "hands",
    leftY,
    rightY,
    handCount: 2,
  };
}

export function sussyHandMessage(elapsedMs, options = {}) {
  const periodMs = options.periodMs ?? 240;
  const amplitude = options.amplitude ?? 0.19;
  const centerHeight = options.centerHeight ?? 0.57;
  const phase = ((elapsedMs % periodMs) / periodMs) * 2;
  const triangle = phase < 1 ? phase * 2 - 1 : 3 - phase * 2;
  const offset = amplitude * triangle;
  const leftHeight = clamp(centerHeight + offset, 0.08, 0.92);
  const rightHeight = clamp(centerHeight - offset, 0.08, 0.92);
  return {
    type: "hands",
    leftY: 1 - leftHeight,
    rightY: 1 - rightHeight,
    handCount: 2,
  };
}

function handMessageAt(elapsedMs, motion, loopDurationMs) {
  if (motion === "sussy") {
    return sussyHandMessage(elapsedMs);
  }
  return camouflageHandMessage(elapsedMs, { wigglePeriodMs: loopDurationMs / 2 });
}

/**
 * Forward-simulate: record hands + manual flaps until targetScore or game over.
 * Returns events sorted by atMs and final state (pipes/score are deterministic).
 */
export function simulateWinningRun({
  targetScore = WIN_SCORE,
  maxSimMs = 130000,
  motion = "camouflage",
  loopDurationMs = 240,
  flapJitterMs = 80,
  seed = 67,
} = {}) {
  const constants = GAME_CONSTANTS;
  const state = createGameState();
  const events = [];
  let simMs = 0;
  let lastFlapAt = -Infinity;
  let flapIndex = 0;
  const flapSchedule = [];

  events.push({ atMs: 0, message: { type: "flap", source: "manual" } });
  applyFlap(state, constants);
  lastFlapAt = 0;
  flapSchedule.push({ atMs: 0, birdY: state.birdY, score: state.score });

  const random = seededRandom(seed);

  while (!state.gameOver && state.score < targetScore && simMs < maxSimMs) {
    events.push({
      atMs: simMs,
      message: handMessageAt(simMs, motion, loopDurationMs),
    });

    const flapGap = MIN_FLAP_INTERVAL_MS + (random() - 0.5) * flapJitterMs;
    if (shouldFlap(state, constants) && simMs - lastFlapAt >= flapGap) {
      events.push({
        atMs: simMs,
        message: { type: "flap", source: "manual" },
      });
      applyFlap(state, constants);
      lastFlapAt = simMs;
      flapIndex += 1;
      const pipe = upcomingPipe(state, constants);
      flapSchedule.push({
        atMs: simMs,
        birdY: state.birdY,
        score: state.score,
        gapY: pipe?.gapY ?? null,
        gapCenter: pipe ? gapCenterY(pipe, constants) : null,
      });
    }

    stepGameState(state, TICK_SECONDS, constants);
    simMs += SAMPLE_INTERVAL_MS;
  }

  return {
    state,
    events: events.sort((left, right) => left.atMs - right.atMs),
    simMs,
    flapSchedule,
    pipes: state.pipes.map((pipe) => ({ ...pipe })),
  };
}

/** Replay-style score check (flaps only, matches server verify physics). */
export function replayScoreFromFlapEvents(events, constants = GAME_CONSTANTS) {
  const state = createGameState();
  const tickMs = TICK_SECONDS * 1000;
  let simMs = 0;
  const sorted = [...events].sort((left, right) => left.atMs - right.atMs);

  applyFlap(state, constants);

  for (const event of sorted) {
    if (event.message?.type !== "flap" && event.type !== "flap") {
      continue;
    }

    const atMs = event.atMs;
    while (simMs + tickMs <= atMs && !state.gameOver) {
      if (!state.awaitingStart) {
        stepGameState(state, TICK_SECONDS, constants);
      }
      simMs += tickMs;
    }

    const remainingMs = atMs - simMs;
    if (remainingMs > 0.5 && !state.gameOver && !state.awaitingStart) {
      stepGameState(state, remainingMs / 1000, constants);
      simMs = atMs;
    }

    applyFlap(state, constants);
  }

  return state.score;
}

export function buildSolveTrace(options = {}) {
  const targetScore = options.targetScore ?? WIN_SCORE;
  const overshoot = options.overshoot ?? 1;
  const buildTarget = targetScore + overshoot;
  const result = simulateWinningRun({
    ...options,
    targetScore: buildTarget,
  });
  const replayScore = replayScoreFromFlapEvents(result.events);

  return {
    events: result.events,
    score: result.state.score,
    claimScore: targetScore,
    replayScore,
    flapSchedule: result.flapSchedule,
    simMs: result.simMs,
    won: result.state.score >= targetScore,
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
