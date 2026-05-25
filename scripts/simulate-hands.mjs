#!/usr/bin/env node
/**
 * CLI harness for the backend WebSocket API.
 *
 * Streams `hands` samples (and optional trace replay), then submits `finish` with
 * SIMULATE_CLAIMED_SCORE when above VERIFY_SCORE_THRESHOLD so the server replays
 * the session log. Useful for anti-cheat regression (sussy) and human traces.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mode = process.argv[2] || "sussy";
const targetUrl =
  mode === "trace"
    ? process.argv[4] || process.env.TARGET_WS_URL || "ws://127.0.0.1:8787/ws"
    : process.argv[3] || process.env.TARGET_WS_URL || "ws://127.0.0.1:8787/ws";
const sampleIntervalMs = 1000 / 60;
const runMs = Number(process.env.SIMULATE_MS || (mode === "sussy" ? 12000 : 18000));

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadTrace(path) {
  const trace = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!trace?.events?.length) {
    throw new Error(`Trace at ${path} has no events.`);
  }
  return trace;
}

function summarizeTrace(trace) {
  const handEvents = trace.events.filter((event) => event.message?.type === "hands");
  const dualHands = handEvents.filter(
    (event) =>
      Number.isFinite(event.message.leftY) && Number.isFinite(event.message.rightY),
  ).length;
  const durationMs = trace.events.at(-1)?.atMs || 0;
  return {
    events: trace.events.length,
    handEvents: handEvents.length,
    dualHands,
    flaps: trace.flaps || trace.events.filter((event) => event.message?.type === "flap").length,
    durationMs,
  };
}

function createSampleGenerator(modeName) {
  if (modeName === "human") {
    let phase = 0;
    let periodMs = 340;
    let amplitude = 0.21;
    let nextPeriodChangeAt = 0;

    return (elapsedMs) => {
      if (elapsedMs >= nextPeriodChangeAt) {
        periodMs = 280 + Math.random() * 180;
        amplitude = 0.17 + Math.random() * 0.07;
        nextPeriodChangeAt = elapsedMs + 900 + Math.random() * 1400;
      }

      phase += sampleIntervalMs / periodMs;
      const triangle = phase % 2 < 1 ? (phase % 1) * 2 - 1 : 3 - (phase % 1) * 2;
      const noise = (Math.random() - 0.5) * 0.035;
      const offset = amplitude * triangle + noise;
      const centerHeight = 0.56 + (Math.random() - 0.5) * 0.02;
      const leftHeight = clamp(centerHeight + offset, 0.08, 0.92);
      const rightHeight = clamp(centerHeight - offset, 0.08, 0.92);
      return {
        leftY: 1 - leftHeight,
        rightY: 1 - rightHeight,
        handCount: 2,
      };
    };
  }

  const periodMs = 180;
  const amplitude = 0.19;
  const centerHeight = 0.57;

  return (elapsedMs) => {
    const phase = ((elapsedMs % periodMs) / periodMs) * 2;
    const triangle = phase < 1 ? phase * 2 - 1 : 3 - phase * 2;
    const offset = amplitude * triangle;
    const leftHeight = clamp(centerHeight + offset, 0.08, 0.92);
    const rightHeight = clamp(centerHeight - offset, 0.08, 0.92);
    return {
      leftY: 1 - leftHeight,
      rightY: 1 - rightHeight,
      handCount: 2,
    };
  };
}

function createSocketMetrics() {
  let acceptedFlaps = 0;
  let lastAntiCheat = null;
  let lastVerified = null;

  return {
    handleMessage(message) {
      if (message.type === "state") {
        const state = message.state;
        if (state.acceptedFlapCount > acceptedFlaps) {
          acceptedFlaps = state.acceptedFlapCount;
          console.log(`Server accepted flap #${acceptedFlaps}`);
        }

        const antiCheat = state.antiCheat;
        if (
          antiCheat &&
          (antiCheat.level !== "none" || antiCheat.message) &&
          JSON.stringify(antiCheat) !== JSON.stringify(lastAntiCheat)
        ) {
          lastAntiCheat = antiCheat;
          console.log(
            `ANTI-CHEAT level=${antiCheat.level} score=${antiCheat.score}/${antiCheat.blockScore} message=${antiCheat.message}`,
          );
        }

        if (state.gameOver && antiCheat?.level === "blocked") {
          console.log(`Run blocked: ${antiCheat.message}`);
        }
        return;
      }

      if (message.type === "verified") {
        lastVerified = message;
        console.log(
          `VERIFIED valid=${message.valid} verified=${message.verified} score=${message.score} claimed=${message.claimedScore} won=${message.won} message=${message.message || ""}`,
        );
        const antiCheat = message.antiCheat;
        if (antiCheat?.message) {
          console.log(
            `ANTI-CHEAT level=${antiCheat.level} score=${antiCheat.score}/${antiCheat.blockScore} message=${antiCheat.message}`,
          );
        }
      }
    },
    getAcceptedFlaps: () => acceptedFlaps,
    getLastVerified: () => lastVerified,
  };
}

async function submitFinish(socket, claimedScore) {
  const threshold = Number(process.env.VERIFY_SCORE_THRESHOLD || "50");
  if (claimedScore <= threshold) {
    return null;
  }

  return await new Promise((resolve) => {
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "verified") {
        socket.removeEventListener("message", onMessage);
        resolve(message);
      }
    };
    socket.addEventListener("message", onMessage);
    socket.send(
      JSON.stringify({
        type: "finish",
        score: claimedScore,
        clientTime: Date.now(),
      }),
    );
    setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      resolve(null);
    }, 5000);
  });
}

async function openSocket(target) {
  const socket = new WebSocket(target);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return socket;
}

async function waitForWelcome(socket) {
  return await new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "welcome") {
        socket.removeEventListener("message", onMessage);
        resolve(message);
      }
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", reject, { once: true });
  });
}

async function replayTrace(trace, socket) {
  const summary = summarizeTrace(trace);
  console.log(
    `Replaying trace: ${summary.events} events, ${summary.handEvents} hand samples (${summary.dualHands} with both Y), ${summary.flaps} flaps, ${(summary.durationMs / 1000).toFixed(2)}s`,
  );

  socket.send(JSON.stringify({ type: "restart" }));

  await new Promise((resolve) => {
    for (const entry of trace.events) {
      if (entry.message?.type === "restart") {
        continue;
      }

      setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }

        socket.send(
          JSON.stringify({
            ...entry.message,
            clientTime: Date.now(),
          }),
        );
      }, entry.atMs);
    }

    setTimeout(resolve, summary.durationMs + 250);
  });
}

async function runSynthetic(modeName, socket, durationMs) {
  const sampleFor = createSampleGenerator(modeName);
  socket.send(JSON.stringify({ type: "restart" }));

  await new Promise((resolve) => {
    let startedAt = Date.now();

    const pump = () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= durationMs || socket.readyState !== WebSocket.OPEN) {
        resolve();
        return;
      }

      const sample = sampleFor(elapsed);
      socket.send(
        JSON.stringify({
          type: "hands",
          leftY: sample.leftY,
          rightY: sample.rightY,
          handCount: sample.handCount,
          clientTime: Date.now(),
        }),
      );

      setTimeout(pump, sampleIntervalMs);
    };

    pump();
  });
}

async function main() {
  const metrics = createSocketMetrics();

  if (mode === "trace") {
    const tracePath = process.argv[3];
    if (!tracePath) {
      throw new Error("Usage: node scripts/simulate-hands.mjs trace /path/to/trace.json [ws://host/ws]");
    }

    const trace = loadTrace(tracePath);
    console.log(`Connecting to ${targetUrl} (trace replay)`);
    const socket = await openSocket(targetUrl);
    socket.addEventListener("message", (event) => {
      metrics.handleMessage(JSON.parse(String(event.data)));
    });

    const welcome = await waitForWelcome(socket);
    console.log(`Connected as ${welcome.id}`);
    await replayTrace(trace, socket);
    const claimedScore = Number(process.env.SIMULATE_CLAIMED_SCORE || "75");
    const verified = await submitFinish(socket, claimedScore);
    console.log(
      `Trace replay finished. acceptedFlaps=${metrics.getAcceptedFlaps()} verified=${verified ? verified.valid : "timeout"}`,
    );
    socket.close();
    return;
  }

  console.log(`Connecting to ${targetUrl} (${mode} simulation for ${runMs}ms)`);
  const socket = await openSocket(targetUrl);
  socket.addEventListener("message", (event) => {
    metrics.handleMessage(JSON.parse(String(event.data)));
  });

  const welcome = await waitForWelcome(socket);
  console.log(`Connected as ${welcome.id}`);
  await runSynthetic(mode, socket, runMs);
  const claimedScore = Number(process.env.SIMULATE_CLAIMED_SCORE || (mode === "sussy" ? "75" : "55"));
  const verified = await submitFinish(socket, claimedScore);
  console.log(
    `Simulation finished. acceptedFlaps=${metrics.getAcceptedFlaps()} verified=${verified ? verified.valid : "timeout"}`,
  );
  socket.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
