#!/usr/bin/env node
/**
 * Build a hands + manual-flap trace that clears WIN_SCORE locally, for replay verify.
 */
import { WIN_SCORE } from "../shared/game-core.js";
import { buildSolveTrace } from "../shared/flap-solver.js";
import {
  buildTraceDocument,
  extractHandLoop,
  loadTrace,
  normalizeTraceEvents,
  parseArgs,
  scaleTraceEvents,
  summarizeTrace,
  writeTrace,
} from "./lib/trace-utils.mjs";

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const output = flags.output || "scripts/fixtures/solve-pack.json";
  const targetScore = Number(process.env.SOLVE_TARGET_SCORE || WIN_SCORE);
  const overshoot = Number(process.env.SOLVE_OVERSHOOT ?? "1");
  const motion = flags.motion || process.env.SOLVE_MOTION || "camouflage";

  let loopDurationMs = 240;
  if (flags.tile) {
    const loopEvents = extractHandLoop(normalizeTraceEvents(loadTrace(flags.tile)));
    loopDurationMs = Math.max(240, loopEvents.at(-1)?.atMs || 240);
  }

  const built = buildSolveTrace({
    targetScore,
    overshoot,
    maxSimMs: Number(process.env.SOLVE_MAX_MS || "130000"),
    motion,
    loopDurationMs,
  });

  let finalEvents = built.events;
  if (flags.scale && flags.scale !== 1) {
    finalEvents = scaleTraceEvents(finalEvents, flags.scale);
  }

  const trace = buildTraceDocument(finalEvents, {
    result: built.won ? "won" : "game-over",
    score: built.score,
    claimScore: built.claimScore,
  });

  writeTrace(output, trace);
  const summary = summarizeTrace(trace);
  console.log(
    `Built ${output}: score=${built.score}/${targetScore} replay=${built.replayScore} ` +
      `flaps=${summary.flaps} duration=${(summary.durationMs / 1000).toFixed(2)}s motion=${motion}`,
  );
  console.log(`Flap schedule: ${built.flapSchedule.length} jumps (pipe-targeted).`);

  if (built.score < targetScore + overshoot) {
    console.error("Pack did not reach build target in local simulation.");
    process.exitCode = 1;
  }

  if (built.replayScore < targetScore) {
    console.error("Replay-style score below claim target; increase SOLVE_OVERSHOOT.");
    process.exitCode = 1;
  }
}

main();
