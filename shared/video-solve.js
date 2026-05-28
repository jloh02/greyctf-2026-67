import { WIN_SCORE } from "./game-core.js";
import {
  SAMPLE_INTERVAL_MS,
  replayScoreFromTimedEvents,
  simulateWinningRun,
} from "./flap-solver.js";
import { normalizeTraceEvents } from "./frontend-client.js";
import {
  simulateGestureFlaps,
} from "./gesture-solve.js";

const DEFAULT_SPEED_PATTERN = [2.85, 3.05, 3.22, 2.96, 3.14, 2.9, 3.28];
const DEFAULT_STABLE_SAMPLE_INTERVAL_MS = SAMPLE_INTERVAL_MS;
const DEFAULT_VIDEO_FRAME_INTERVAL_MS = 120;
const DEFAULT_PRE_TRIGGER_HOLD_MS = 620;
const DEFAULT_POST_TRIGGER_HOLD_MS = 320;
const DEFAULT_START_DELAY_MS = 900;
const DEFAULT_FINAL_TAIL_MS = 1600;
const DEFAULT_STABLE = { leftY: 0.47, rightY: 0.48, handCount: 2 };

export function buildVideoSolvePlan({
  clipTrace,
  targetScore = WIN_SCORE,
  overshoot = 1,
  maxSimMs = 130000,
  strategy = "lookahead",
  directionPattern = "pingpong",
  speedPattern = DEFAULT_SPEED_PATTERN,
  sampleIntervalMs = DEFAULT_STABLE_SAMPLE_INTERVAL_MS,
  videoFrameIntervalMs = DEFAULT_VIDEO_FRAME_INTERVAL_MS,
  startDelayMs = DEFAULT_START_DELAY_MS,
  finalTailMs = DEFAULT_FINAL_TAIL_MS,
  preTriggerHoldMs = DEFAULT_PRE_TRIGGER_HOLD_MS,
  postTriggerHoldMs = DEFAULT_POST_TRIGGER_HOLD_MS,
} = {}) {
  if (!clipTrace) {
    throw new Error("A cropped stable -> 67 -> stable recording trace is required.");
  }

  const source = prepareSourceGestureClip(normalizeTraceEvents(clipTrace.events || clipTrace), {
    preTriggerHoldMs,
    postTriggerHoldMs,
  });
  const planned = simulateWinningRun({
    targetScore: targetScore + overshoot,
    maxSimMs,
    motion: "camouflage",
    strategy,
  });

  if (planned.state.score < targetScore + overshoot) {
    throw new Error(
      `Jump planner stopped at score ${planned.state.score}; expected at least ${targetScore + overshoot}.`,
    );
  }

  const desiredFlaps = planned.flapSchedule.map((entry) => entry.atMs + startDelayMs);
  const totalDurationMs = planned.simMs + startDelayMs + finalTailMs;
  const windows = buildGestureWindows({
    source,
    desiredFlaps,
    directionPattern,
    speedPattern,
    totalDurationMs,
  });
  const events = buildTimelineEvents({
    source,
    windows,
    totalDurationMs,
    intervalMs: sampleIntervalMs,
  });
  const frames = buildTimelineFrames({
    source,
    windows,
    totalDurationMs,
    intervalMs: videoFrameIntervalMs,
  });
  const derivedFlaps = simulateGestureFlaps(events);
  const replayScore = replayScoreFromTimedEvents(
    derivedFlaps.map((flap) => ({
      atMs: flap.triggerAtMs,
      message: { type: "flap", source: "gesture" },
    })),
  );
  const replay = {
    score: replayScore,
    gameOver: replayScore < targetScore,
    flaps: derivedFlaps,
  };

  return {
    trace: buildTraceDocument(events, {
      result: replay.score >= targetScore ? "video-solve" : "video-solve-miss",
      score: replay.score,
      claimScore: targetScore,
    }),
    replay,
    planned,
    source,
    desiredFlaps,
    videoSolve: {
      version: 1,
      directionPattern,
      speedPattern,
      sourceDurationMs: source.durationMs,
      totalDurationMs,
      sampleIntervalMs,
      videoFrameIntervalMs,
      windows,
      frames,
    },
  };
}

export function prepareSourceGestureClip(
  events,
  {
    preTriggerHoldMs = DEFAULT_PRE_TRIGGER_HOLD_MS,
    postTriggerHoldMs = DEFAULT_POST_TRIGGER_HOLD_MS,
  } = {},
) {
  const source = extractHandSamples(events);
  const durationMs = source.at(-1)?.atMs ?? 0;
  if (durationMs <= 0) {
    throw new Error("Cropped recording duration must be greater than 0.");
  }

  const sourceFlaps = simulateGestureFlaps(source);
  if (sourceFlaps.length !== 1) {
    throw new Error(
      `Cropped recording must produce exactly one 67 gesture flap; observed ${sourceFlaps.length}.`,
    );
  }

  const triggerAtMs = sourceFlaps[0].triggerAtMs;
  const forward = prepareDirectionalClip(source, {
    direction: "forward",
    durationMs,
    preTriggerHoldMs,
    postTriggerHoldMs,
  });
  const reverse = prepareDirectionalClip(source, {
    direction: "reverse",
    durationMs,
    preTriggerHoldMs,
    postTriggerHoldMs,
  });

  return {
    events: source,
    durationMs,
    triggerAtMs,
    stableRanges: stableRangesForSource(durationMs, triggerAtMs, {
      preTriggerHoldMs,
      postTriggerHoldMs,
    }),
    directions: {
      forward,
      reverse,
    },
  };
}

export function sourceSampleAt(source, sourceAtMs) {
  const events = source.events || source;
  if (!events.length) {
    return { type: "hands", ...DEFAULT_STABLE };
  }

  if (sourceAtMs <= events[0].atMs) {
    return cloneHandMessage(events[0].message);
  }

  for (let index = 0; index < events.length - 1; index += 1) {
    const left = events[index];
    const right = events[index + 1];
    if (sourceAtMs >= left.atMs && sourceAtMs <= right.atMs) {
      const span = Math.max(1, right.atMs - left.atMs);
      const t = clamp((sourceAtMs - left.atMs) / span, 0, 1);
      return {
        type: "hands",
        leftY: lerp(left.message.leftY, right.message.leftY, t),
        rightY: lerp(left.message.rightY, right.message.rightY, t),
        handCount: Math.max(left.message.handCount ?? 0, right.message.handCount ?? 0, 2),
      };
    }
  }

  return cloneHandMessage(events.at(-1).message);
}

export function sampleVideoSolveAt(videoSolve, source, atMs) {
  const windows = videoSolve?.windows || [];
  const window = windows.find(
    (entry) => atMs >= entry.startAtMs && atMs <= entry.endAtMs,
  );
  const sourceAtMs = window
    ? sourceAtMsForWindow(window, atMs)
    : stableSourceAt(source, atMs);
  const sample = sourceSampleAt(source, sourceAtMs);
  return {
    atMs: Math.round(atMs),
    sourceAtMs,
    sample,
  };
}

function buildGestureWindows({
  source,
  desiredFlaps,
  directionPattern,
  speedPattern,
  totalDurationMs,
}) {
  return desiredFlaps.map((flapAtMs, index) => {
    const direction = directionForIndex(index, directionPattern);
    const clip = source.directions[direction];
    const speed = speedForJump(index, speedPattern);
    const durationMs = clip.durationMs / speed;
    const triggerAtMs = clip.triggerAtMs / speed;
    const startAtMs = Math.max(0, flapAtMs - triggerAtMs);
    const endAtMs = Math.min(totalDurationMs, startAtMs + durationMs);
    return {
      index,
      direction,
      speed,
      flapAtMs: Math.round(flapAtMs),
      startAtMs: Math.round(startAtMs),
      endAtMs: Math.round(endAtMs),
      triggerAtMs: Math.round(startAtMs + triggerAtMs),
      sourceStartAtMs: clip.sourceStartAtMs,
      sourceEndAtMs: clip.sourceEndAtMs,
      clipDurationMs: clip.durationMs,
    };
  });
}

function buildTimelineEvents({ source, windows, totalDurationMs, intervalMs }) {
  const events = [];
  for (let atMs = 0; atMs <= totalDurationMs; atMs += intervalMs) {
    const entry = timelineEntryAt(source, windows, atMs);
    events.push({
      atMs: Math.round(atMs),
      message: entry.sample,
    });
  }

  for (const window of windows) {
    for (let atMs = window.startAtMs; atMs <= window.endAtMs; atMs += intervalMs) {
      const entry = timelineEntryAt(source, windows, atMs, window);
      events.push({
        atMs: Math.round(atMs),
        message: entry.sample,
      });
    }
    const triggerEntry = timelineEntryAt(source, windows, window.triggerAtMs, window);
    events.push({
      atMs: Math.round(window.triggerAtMs),
      message: triggerEntry.sample,
    });
  }

  const finalEntry = timelineEntryAt(source, windows, totalDurationMs);
  events.push({
    atMs: Math.round(totalDurationMs),
    message: finalEntry.sample,
  });

  return dedupeEvents(events);
}

function buildTimelineFrames({ source, windows, totalDurationMs, intervalMs }) {
  const frames = [];
  let sequence = 1;
  for (let atMs = 0; atMs <= totalDurationMs; atMs += intervalMs) {
    const entry = timelineEntryAt(source, windows, atMs);
    frames.push({
      sequence,
      atMs: Math.round(atMs),
      sourceAtMs: Math.round(entry.sourceAtMs),
      leftY: entry.sample.leftY,
      rightY: entry.sample.rightY,
      handCount: entry.sample.handCount ?? 2,
      windowIndex: entry.window?.index ?? null,
      direction: entry.window?.direction || "stable",
    });
    sequence += 1;
  }
  return frames;
}

function timelineEntryAt(source, windows, atMs, forcedWindow = null) {
  const window = forcedWindow || windows.find(
    (entry) => atMs >= entry.startAtMs && atMs <= entry.endAtMs,
  );
  const sourceAtMs = window
    ? sourceAtMsForWindow(window, atMs)
    : stableSourceAt(source, atMs);
  return {
    sourceAtMs,
    sample: sourceSampleAt(source, sourceAtMs),
    window,
  };
}

function sourceAtMsForWindow(window, atMs) {
  const clipAtMs = clamp((atMs - window.startAtMs) * window.speed, 0, window.clipDurationMs);
  if (window.direction === "reverse") {
    return clamp(window.sourceEndAtMs - clipAtMs, window.sourceStartAtMs, window.sourceEndAtMs);
  }
  return clamp(window.sourceStartAtMs + clipAtMs, window.sourceStartAtMs, window.sourceEndAtMs);
}

function stableSourceAt(source, atMs) {
  const ranges = source.stableRanges?.length
    ? source.stableRanges
    : [{ startAtMs: 0, endAtMs: source.durationMs }];
  const totalStableMs = ranges.reduce(
    (sum, range) => sum + Math.max(0, range.endAtMs - range.startAtMs),
    0,
  );
  if (totalStableMs <= 1) {
    return clamp(source.triggerAtMs - DEFAULT_PRE_TRIGGER_HOLD_MS, 0, source.durationMs);
  }

  let offset = positiveModulo(atMs * 0.72, totalStableMs);
  for (const range of ranges) {
    const span = Math.max(0, range.endAtMs - range.startAtMs);
    if (offset <= span) {
      return range.startAtMs + offset;
    }
    offset -= span;
  }

  return ranges.at(-1).endAtMs;
}

function prepareDirectionalClip(
  source,
  { direction, durationMs, preTriggerHoldMs, postTriggerHoldMs },
) {
  const oriented = source
    .map((event) => ({
      atMs: direction === "reverse" ? durationMs - event.atMs : event.atMs,
      sourceAtMs: event.atMs,
      message: cloneHandMessage(event.message),
    }))
    .sort((left, right) => left.atMs - right.atMs);
  const flaps = simulateGestureFlaps(oriented);
  if (flaps.length !== 1) {
    throw new Error(
      `${direction} cropped recording must produce exactly one 67 gesture flap; observed ${flaps.length}.`,
    );
  }

  const triggerAtMs = flaps[0].triggerAtMs;
  const clipStartMs = Math.max(0, triggerAtMs - preTriggerHoldMs);
  const clipEndMs = Math.min(durationMs, triggerAtMs + postTriggerHoldMs);
  const trimmed = oriented
    .filter((event) => event.atMs >= clipStartMs && event.atMs <= clipEndMs)
    .map((event) => ({
      atMs: event.atMs - clipStartMs,
      sourceAtMs: event.sourceAtMs,
      message: cloneHandMessage(event.message),
    }));

  if (!trimmed.length) {
    throw new Error(`${direction} cropped recording has no usable samples after trimming.`);
  }

  const trimmedFlaps = simulateGestureFlaps(trimmed);
  if (trimmedFlaps.length !== 1) {
    throw new Error(
      `${direction} trimmed recording must produce exactly one 67 gesture flap; observed ${trimmedFlaps.length}.`,
    );
  }

  const sourceTimes = trimmed.map((event) => event.sourceAtMs);
  return {
    direction,
    events: trimmed,
    durationMs: trimmed.at(-1)?.atMs ?? clipEndMs - clipStartMs,
    triggerAtMs: trimmedFlaps[0].triggerAtMs,
    sourceStartAtMs: Math.min(...sourceTimes),
    sourceEndAtMs: Math.max(...sourceTimes),
  };
}

function stableRangesForSource(
  durationMs,
  triggerAtMs,
  { preTriggerHoldMs, postTriggerHoldMs },
) {
  const ranges = [];
  const headEnd = Math.max(0, triggerAtMs - preTriggerHoldMs);
  const tailStart = Math.min(durationMs, triggerAtMs + postTriggerHoldMs);
  if (headEnd > 120) {
    ranges.push({ startAtMs: 0, endAtMs: headEnd });
  }
  if (durationMs - tailStart > 120) {
    ranges.push({ startAtMs: tailStart, endAtMs: durationMs });
  }
  if (ranges.length) {
    return ranges;
  }
  return [
    {
      startAtMs: Math.max(0, triggerAtMs - preTriggerHoldMs),
      endAtMs: Math.min(durationMs, triggerAtMs + postTriggerHoldMs),
    },
  ];
}

function extractHandSamples(events) {
  const hands = events
    .filter(
      (event) =>
        event.message?.type === "hands" &&
        Number.isFinite(event.message.leftY) &&
        Number.isFinite(event.message.rightY),
    )
    .map((event) => ({
      atMs: Math.max(0, Number(event.atMs) || 0),
      message: cloneHandMessage(event.message),
    }))
    .sort((left, right) => left.atMs - right.atMs);

  if (!hands.length) {
    throw new Error("Cropped recording has no two-hand samples.");
  }
  return hands;
}

function cloneHandMessage(message) {
  return {
    type: "hands",
    leftY: message.leftY,
    rightY: message.rightY,
    handCount: message.handCount ?? 2,
  };
}

function directionForIndex(index, pattern) {
  if (pattern === "forward") {
    return "forward";
  }
  if (pattern === "reverse") {
    return "reverse";
  }
  return index % 2 === 0 ? "forward" : "reverse";
}

function speedForJump(index, pattern) {
  const speed = Number(pattern[index % pattern.length]);
  if (!Number.isFinite(speed) || speed <= 0) {
    throw new Error(`Invalid video replay speed at index ${index}: ${speed}`);
  }
  return speed;
}

function dedupeEvents(events) {
  const byTime = new Map();
  for (const event of events) {
    byTime.set(event.atMs, event);
  }
  return [...byTime.values()].sort((left, right) => left.atMs - right.atMs);
}

function buildTraceDocument(events, meta = {}) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    target: meta.target || "ws://127.0.0.1:8787/ws",
    startedAt: null,
    completedAt: meta.completedAt || new Date().toISOString(),
    result: meta.result || "video-solve",
    score: meta.score ?? 0,
    claimScore: meta.claimScore ?? meta.score ?? 0,
    handSamples: events.length,
    flaps: 0,
    events,
  };
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function lerp(left, right, t) {
  return left + (right - left) * t;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
