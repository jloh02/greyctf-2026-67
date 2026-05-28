#!/usr/bin/env node
/**
 * Build a hand-only video solve plan from a cropped stable -> 67 -> stable trace.
 *
 * Usage:
 *   node scripts/build-video-solve.mjs scripts/fixtures/video-clip.json -o scripts/fixtures/video-solve-pack.json
 */
import { WIN_SCORE } from "../shared/game-core.js";
import { buildVideoSolvePlan } from "../shared/video-solve.js";
import {
  loadTrace,
  parseArgs,
  summarizeTrace,
  writeTrace,
} from "./lib/trace-utils.mjs";

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const input = positional[0] || flags.tile || "scripts/fixtures/loop.json";
  const output = flags.output || "scripts/fixtures/video-solve-pack.json";
  const targetScore = Number(process.env.SOLVE_TARGET_SCORE || WIN_SCORE);
  const overshoot = Number(process.env.SOLVE_OVERSHOOT ?? "1");
  const strategy = flags.strategy || process.env.SOLVE_STRATEGY || "lookahead";

  const clipTrace = loadTrace(input);
  const built = buildVideoSolvePlan({
    clipTrace,
    targetScore,
    overshoot,
    strategy,
    directionPattern: flags.direction || "pingpong",
  });
  const trace = {
    ...built.trace,
    videoSolve: built.videoSolve,
  };

  writeTrace(output, trace);
  const summary = summarizeTrace(trace);
  console.log(
    `Built ${output}: replay=${built.replay.score}/${targetScore} ` +
      `hands=${summary.handEvents} frames=${built.videoSolve.frames.length} ` +
      `duration=${(summary.durationMs / 1000).toFixed(2)}s direction=${built.videoSolve.directionPattern}`,
  );
  console.log(
    `Source clip: duration=${built.source.durationMs.toFixed(1)}ms ` +
      `trigger=${built.source.triggerAtMs.toFixed(1)}ms ` +
      `gestures=${built.videoSolve.windows.length}`,
  );

  if (built.replay.score < targetScore) {
    console.error("Video solve replay score below claim target; adjust crop, strategy, or speed pattern.");
    process.exitCode = 1;
  }
}

main();
