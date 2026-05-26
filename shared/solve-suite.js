/**
 * Tiered solve methods for the solve lab and CLI harness.
 * Each mode documents what works locally vs on server verify.
 */
import { WIN_SCORE } from "./game-core.js";
import {
  buildAltitudeHoldTrace,
  buildNoCollisionPipesFrameTrace,
  buildNoCollisionPipesTrace,
  localSimOptionsForMode,
} from "./altitude-hold.js";
import {
  buildExact67GestureTrace,
  buildSolveTrace,
  replayScoreFromTimedEvents,
} from "./flap-solver.js";
import { buildGestureSolvePack } from "./gesture-solve.js";
import { normalizeTraceEvents } from "./frontend-client.js";

export { localSimOptionsForMode };

export const SOLVE_TIERS = [
  {
    tier: 1,
    title: "Empty / fictitious claim",
    description:
      "Restart only, then finish with score 67. Proves server replay rejects empty logs.",
  },
  {
    tier: 2,
    title: "No collisions (local only)",
    description:
      "Pass through pipes and/or frame locally; altitude hold keeps bird in band. Server verify still uses real physics.",
  },
  {
    tier: 3,
    title: "Mechanical pipe probes",
    description:
      "Deterministic gap bot variants. Manual variants finish locally then fail verification; exact 67 bursts exercise anti-cheat jitter checks.",
  },
  {
    tier: 4,
    title: "Recorded gesture replay",
    description:
      "Record one stable -> 67 -> stable clip, then replay it forward at varied speeds for each jump.",
  },
];

export const SOLVE_MODES = [
  {
    id: "empty-claim",
    tier: 1,
    label: "Empty claim → finish 67",
    verifyExpected: "fail",
    buildTrace: () => buildEmptyClaimTrace(),
  },
  {
    id: "no-collision-pipes",
    tier: 2,
    label: "No pipe collision + altitude hold (frame kills)",
    verifyExpected: "fail",
    buildTrace: (options) => buildNoCollisionPipesTrace(options),
    stepOptions: { skipCollisions: true, skipBounds: false, passPipeGap: false },
  },
  {
    id: "no-collision-pipes-frame",
    tier: 2,
    label: "No pipe/frame collision (god mode)",
    verifyExpected: "fail",
    buildTrace: (options) => buildNoCollisionPipesFrameTrace(options),
    stepOptions: { skipCollisions: true, skipBounds: true },
  },
  {
    id: "mechanical-greedy",
    tier: 3,
    label: "Mechanical — greedy gaps",
    verifyExpected: "fail",
    buildTrace: (options) =>
      buildSolveTrace({
        motion: options.motion || "camouflage",
        strategy: "greedy",
        ...options,
      }),
  },
  {
    id: "mechanical-sussy",
    tier: 3,
    label: "Mechanical — hand-pulse flaps",
    verifyExpected: "fail",
    buildTrace: (options) =>
      buildSolveTrace({
        motion: "sussy",
        strategy: "greedy",
        ...options,
      }),
  },
  {
    id: "mechanical-straight-jitter",
    tier: 3,
    label: "Mechanical — straight jitter",
    verifyExpected: "fail",
    buildTrace: (options) =>
      buildSolveTrace({
        motion: "straight-jitter",
        strategy: "greedy",
        ...options,
      }),
  },
  {
    id: "mechanical-exact-67",
    tier: 3,
    label: "Mechanical — exact 67 jitter burst",
    verifyExpected: "fail",
    buildTrace: (options) => buildExact67GestureTrace(options),
  },
  {
    id: "recorded-gesture-replay",
    tier: 4,
    label: "Recorded 67 gesture replay",
    verifyExpected: "pass",
    needsTrace: true,
  },
];

export function getSolveMode(modeId) {
  const mode = SOLVE_MODES.find((entry) => entry.id === modeId);
  if (!mode) {
    throw new Error(`Unknown solve mode: ${modeId}`);
  }
  return mode;
}

/** Tier 2 uses local god-mode physics; server verify always uses real collisions. */
export function isTier2LocalOnlyMode(modeId) {
  return getSolveMode(modeId).tier === 2;
}

export function listSolveModesByTier() {
  return SOLVE_TIERS.map((tier) => ({
    ...tier,
    modes: SOLVE_MODES.filter((mode) => mode.tier === tier.tier),
  }));
}

/** Minimal run log: restart implied, no inputs. */
export function buildEmptyClaimTrace(targetScore = WIN_SCORE) {
  return {
    events: [],
    score: 0,
    claimScore: targetScore,
    replayScore: 0,
    localOnly: false,
    note: "Server replay scores 0; valid=false for claim 67.",
  };
}

export function reverseTraceEvents(events) {
  const sorted = [...events]
    .filter((event) => event.message?.type !== "restart")
    .sort((left, right) => left.atMs - right.atMs);
  const durationMs = sorted.at(-1)?.atMs || 0;

  return sorted
    .map((event) => ({
      atMs: Math.max(0, durationMs - event.atMs),
      message: structuredClone(event.message),
    }))
    .sort((left, right) => left.atMs - right.atMs);
}

export function prepareReplayTrace(trace, direction = "forward") {
  const events = normalizeTraceEvents(trace.events || trace);
  const prepared =
    direction === "reverse" ? reverseTraceEvents(events) : events;
  const flaps = prepared.filter((event) => event.message.type === "flap").length;
  const manualFlaps = prepared.filter(
    (event) => event.message.type === "flap" && event.message.source !== "gesture",
  ).length;

  return {
    events: prepared,
    score: trace.score ?? 0,
    claimScore: trace.claimScore ?? trace.score ?? WIN_SCORE,
    replayScore: replayScoreFromTimedEvents(prepared),
    direction,
    note:
      direction === "reverse"
        ? "Time-reversed flaps break physics — useful negative test."
        : manualFlaps > 0
          ? "Forward replay contains explicit manual flaps; backend rejects those for camera-gesture verification."
          : flaps > 0
            ? "Forward replay uses speed-varied hand leadup plus explicit gesture flap events."
          : "Forward hand-only replay; backend derives flaps from recorded 67 gestures.",
  };
}

export function buildSuiteTrace(modeId, options = {}) {
  const mode = getSolveMode(modeId);

  if (mode.id === "recorded-gesture-replay") {
    if (!options.trace) {
      throw new Error(`${mode.id} requires a loaded trace.`);
    }
    const existing = prepareReplayTrace(options.trace, "forward");
    if (existing.events.filter((event) => event.message.type === "flap").length > 1) {
      return {
        mode,
        ...existing,
        note: "Forward playback of a prebuilt recorded gesture replay.",
      };
    }

    const built = buildGestureSolvePack({
      loopTrace: options.trace.events || options.trace,
      targetScore: options.targetScore ?? WIN_SCORE,
      overshoot: 0,
      reverse: false,
      strategy: options.strategy || "lookahead",
    });
    return {
      mode,
      ...built.trace,
      events: normalizeTraceEvents(built.trace.events || []),
      replayScore: built.replay.score,
      clip: built.clip,
      speedPattern: built.speedPattern,
      note:
        `Generated from one forward human 67 clip ` +
        `(${built.clip.durationMs.toFixed(0)}ms, trigger ${built.clip.triggerAtMs.toFixed(0)}ms) ` +
        `and speed-varied per jump.`,
    };
  }

  if (!mode.buildTrace) {
    throw new Error(`Mode ${modeId} has no trace builder.`);
  }

  const built = mode.buildTrace(options);
  return {
    mode,
    ...built,
    events: normalizeTraceEvents(built.events || []),
    note:
      built.note ||
      (mode.id === "mechanical-straight-jitter"
        ? "Straight up/down hand jitter provides visible hand packets but no 67 evidence; explicit manual flaps are rejected by verification."
        : mode.tier === 3
        ? "Mechanical trace finishes locally with explicit manual flap events; backend verification rejects those for camera-gesture runs."
        : ""),
  };
}

export function summarizeSuiteResult(mode, built, verified = null) {
  return {
    mode: mode.id,
    tier: mode.tier,
    verifyExpected: mode.verifyExpected,
    localScore: built.score,
    replayScore: built.replayScore ?? null,
    claimScore: built.claimScore,
    events: built.events?.length ?? 0,
    verified: verified?.verified ?? null,
    valid: verified?.valid ?? null,
    serverScore: verified?.score ?? null,
    message: verified?.message || built.note || "",
  };
}
