#!/usr/bin/env node
/**
 * Record a short seamless hand loop for tiling into solve packs.
 *
 * Usage:
 *   node scripts/record-loop.mjs [-o scripts/fixtures/loop.json] [--loop-ms 3200]
 */
import { recordHandLoop } from "./lib/hand-samples.mjs";
import { buildTraceDocument, parseArgs, summarizeTrace, writeTrace } from "./lib/trace-utils.mjs";

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const output = flags.output || "scripts/fixtures/loop.json";
  const loopMs = flags.loopMs ?? 3200;
  const events = recordHandLoop(loopMs, {
    seed: flags.seed ?? 42,
    periodMs: flags.period ?? 380,
    amplitude: 0.19,
  });

  const trace = buildTraceDocument(events, { result: "loop", score: 0 });
  writeTrace(output, trace);
  const summary = summarizeTrace(trace);
  console.log(
    `Wrote loop ${output}: ${summary.handEvents} hand samples, ${(summary.durationMs / 1000).toFixed(2)}s`,
  );
}

main();
