// Forked audio worker: owns the microphone, the speaker, and the native wake-word engine, so a
// native crash or leak can never take down the Gateway process that also serves chat channels.
// Plain .mjs on purpose: it runs in a forked plain-Node process, outside the plugin loader, and
// Node refuses to strip TypeScript for files staged under node_modules.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { encodeUnigramPhrase, loadUnigramPieces } from "./src/unigram-tokenizer.mjs";

/** @typedef {import("./src/worker-protocol.ts").WorkerInbound} WorkerInbound */
/** @typedef {import("./src/worker-protocol.ts").WorkerOutbound} WorkerOutbound */
/** @typedef {import("./src/worker-protocol.ts").WakeEngineConfig} WakeEngineConfig */

const CAPTURE_RATE_HZ = 48_000;
const RELAY_RATE_HZ = 24_000;
const WAKE_RATE_HZ = 16_000;
// The codec emits a DC settle transient for about a second after a capture stream starts.
const CAPTURE_SETTLE_BYTES = CAPTURE_RATE_HZ * 2;
// Covers "hey openclaw, <question>" spoken while the relay session is still connecting.
const PREROLL_BYTES = RELAY_RATE_HZ * 2 * 3;
// Laptop mics carry most of their noise as rumble below the speech band; a one-pole high-pass
// lifts SNR for both the wake engine and the provider's end-of-speech detection.
const HIGH_PASS_HZ = 150;
const HIGH_PASS_ALPHA = 1 / (1 + (2 * Math.PI * HIGH_PASS_HZ) / CAPTURE_RATE_HZ);
// pw-play buffers ahead of the speaker; drained means "heard", not merely "written".
const PLAYBACK_LATENCY_MS = 250;
const RECORD_RESTART_LIMIT = 5;

/** @param {WorkerOutbound} message */
function send(message) {
  process.send?.(message);
}

function fatal(reason, detail) {
  send({ t: "fatal", reason, detail });
  process.exit(1);
}

/** @param {WakeEngineConfig} config */
function createWakeDetector(config) {
  const find = (prefix) => {
    const files = fs.existsSync(config.modelDir) ? fs.readdirSync(config.modelDir) : [];
    const match =
      files.find((f) => f.startsWith(prefix) && f.endsWith(".int8.onnx")) ??
      files.find((f) => f.startsWith(prefix) && f.endsWith(".onnx"));
    if (!match) {
      fatal("model-missing", `no ${prefix}*.onnx in ${config.modelDir}`);
    }
    return path.join(config.modelDir, match);
  };
  const encoder = find("encoder");
  const decoder = find("decoder");
  const joiner = find("joiner");

  let sherpa;
  try {
    sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
  } catch (error) {
    fatal("sherpa-missing", String(error));
  }

  const pieces = loadUnigramPieces(path.join(config.modelDir, "bpe.model"));
  const phrases = [];
  const skipped = [];
  const lines = [];
  for (const phrase of config.phrases) {
    const tokens = encodeUnigramPhrase(pieces, phrase);
    if (!tokens) {
      skipped.push(phrase);
      continue;
    }
    phrases.push(phrase);
    lines.push(`${tokens.join(" ")} @${phrase.trim().replace(/\s+/g, "_")}`);
  }
  if (lines.length === 0) {
    fatal("wake-init-failed", "no wake phrase could be tokenized for this model");
  }
  const keywordsFile = path.join(os.tmpdir(), `host-talk-keywords-${process.pid}.txt`);
  fs.writeFileSync(keywordsFile, `${lines.join("\n")}\n`);

  let spotter;
  let stream;
  try {
    spotter = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: WAKE_RATE_HZ, featureDim: 80 },
      modelConfig: {
        transducer: { encoder, decoder, joiner },
        tokens: path.join(config.modelDir, "tokens.txt"),
        numThreads: 1,
        provider: "cpu",
        debug: 0,
      },
      keywordsFile,
      keywordsThreshold: config.threshold,
      keywordsScore: config.score,
    });
    stream = spotter.createStream();
  } catch (error) {
    fatal("wake-init-failed", String(error));
  }
  return {
    phrases,
    skipped,
    detector: {
      /** @param {Float32Array} samples16k */
      feed(samples16k) {
        stream.acceptWaveform({ sampleRate: WAKE_RATE_HZ, samples: samples16k });
        let hit;
        while (spotter.isReady(stream)) {
          spotter.decode(stream);
          const keyword = spotter.getResult(stream).keyword;
          if (keyword) {
            hit = keyword.replace(/_/g, " ");
            spotter.reset(stream);
          }
        }
        return hit;
      },
    },
  };
}

let detector;
let streaming = false;
let preroll = Buffer.alloc(0);
let captureCarry = Buffer.alloc(0);
let settleRemaining = CAPTURE_SETTLE_BYTES;
let highPassPrevIn = 0;
let highPassPrevOut = 0;
let recorder;
let recordRestarts = 0;
let player;
let playbackEndsAt = 0;
let shuttingDown = false;

function handleCapture(chunk) {
  if (settleRemaining > 0) {
    const skip = Math.min(settleRemaining, chunk.length);
    settleRemaining -= skip;
    chunk = chunk.subarray(skip);
    if (chunk.length === 0) {
      return;
    }
  }
  // Frames of 6 input samples (12 bytes) decimate exactly to 2 wake + 3 relay samples.
  const buf = captureCarry.length ? Buffer.concat([captureCarry, chunk]) : chunk;
  const frames = Math.floor(buf.length / 12);
  captureCarry = Buffer.from(buf.subarray(frames * 12));
  if (frames === 0) {
    return;
  }
  const wake = new Float32Array(frames * 2);
  const relay = Buffer.alloc(frames * 3 * 2);
  for (let f = 0; f < frames; f += 1) {
    const s = [];
    for (let i = 0; i < 6; i += 1) {
      const input = buf.readInt16LE(f * 12 + i * 2);
      highPassPrevOut = HIGH_PASS_ALPHA * (highPassPrevOut + input - highPassPrevIn);
      highPassPrevIn = input;
      s.push(highPassPrevOut);
    }
    wake[f * 2] = (s[0] + s[1] + s[2]) / 3 / 32768;
    wake[f * 2 + 1] = (s[3] + s[4] + s[5]) / 3 / 32768;
    for (let i = 0; i < 3; i += 1) {
      const v = Math.round((s[i * 2] + s[i * 2 + 1]) / 2);
      relay.writeInt16LE(Math.max(-32768, Math.min(32767, v)), (f * 3 + i) * 2);
    }
  }

  const phrase = detector?.feed(wake);
  if (phrase) {
    send({ t: "wake", phrase });
  }

  if (streaming) {
    send({ t: "pcm", pcm24k: relay });
    return;
  }
  // Privacy: outside an active session, audio only ever lives in this ring buffer.
  preroll = Buffer.concat([preroll, relay]);
  if (preroll.length > PREROLL_BYTES) {
    preroll = Buffer.from(preroll.subarray(preroll.length - PREROLL_BYTES));
  }
}

function startRecorder() {
  settleRemaining = CAPTURE_SETTLE_BYTES;
  captureCarry = Buffer.alloc(0);
  const child = spawn(
    "pw-record",
    ["--rate", String(CAPTURE_RATE_HZ), "--channels", "1", "--format", "s16", "-"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  recorder = child;
  child.stdout.on("data", handleCapture);
  child.on("error", (error) => fatal("record-failed", String(error)));
  child.on("exit", (code) => {
    if (shuttingDown) {
      return;
    }
    recordRestarts += 1;
    if (recordRestarts > RECORD_RESTART_LIMIT) {
      fatal("record-failed", `pw-record kept exiting (last code ${code})`);
    }
    setTimeout(startRecorder, 1000 * recordRestarts);
  });
}

function ensurePlayer() {
  if (player && player.exitCode === null && !player.killed) {
    return player;
  }
  const child = spawn(
    "pw-play",
    ["--rate", String(RELAY_RATE_HZ), "--channels", "1", "--format", "s16", "-"],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  child.on("error", (error) => fatal("play-failed", String(error)));
  child.stdin.on("error", () => {});
  player = child;
  return child;
}

function play(pcm24k) {
  ensurePlayer().stdin.write(pcm24k);
  const durationMs = (pcm24k.length / 2 / RELAY_RATE_HZ) * 1000;
  playbackEndsAt = Math.max(playbackEndsAt, Date.now()) + durationMs;
}

function clearPlayback() {
  // Killing the player is the only way to drop audio pw-play has already buffered.
  player?.kill("SIGKILL");
  player = undefined;
  playbackEndsAt = 0;
}

function shutdown() {
  shuttingDown = true;
  recorder?.kill("SIGTERM");
  player?.kill("SIGTERM");
  process.exit(0);
}

process.on("message", (/** @type {WorkerInbound} */ message) => {
  switch (message.t) {
    case "configure": {
      const wake = createWakeDetector(message.wake);
      detector = wake.detector;
      if (!recorder) {
        startRecorder();
      }
      send({ t: "ready", phrases: wake.phrases, skippedPhrases: wake.skipped });
      return;
    }
    case "stream":
      streaming = message.on;
      if (message.on && message.flushPreroll && preroll.length > 0) {
        send({ t: "pcm", pcm24k: preroll });
      }
      preroll = Buffer.alloc(0);
      return;
    case "play":
      play(Buffer.from(message.pcm24k));
      return;
    case "clear":
      clearPlayback();
      return;
    case "drain": {
      const waitMs = Math.max(0, playbackEndsAt - Date.now()) + PLAYBACK_LATENCY_MS;
      setTimeout(() => send({ t: "drained", id: message.id }), waitMs);
      return;
    }
    case "shutdown":
      shutdown();
  }
});

process.on("disconnect", shutdown);

setInterval(() => send({ t: "heartbeat", rssBytes: process.memoryUsage().rss }), 5000).unref();
// Keep the event loop alive while idle; the recorder and IPC channel also hold it open.
setInterval(() => {}, 60_000);
