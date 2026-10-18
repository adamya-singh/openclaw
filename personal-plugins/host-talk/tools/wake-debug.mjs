#!/usr/bin/env node
// Voice benchmark + diagnostic: what does the wake recognizer hear from YOUR voice on a given mic?
// Usage: node personal-plugins/host-talk/tools/wake-debug.mjs [--target <source node name>] [--seconds 40]
// Same capture path as audio-worker.mjs (48 kHz capture, 150 Hz high-pass, 16 kHz recognizer).
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { findWakePhrase } from "../src/wake-phrase-match.mjs";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const target = arg("--target", undefined);
const seconds = Number(arg("--seconds", 40));
const phrases = [arg("--phrase", "hey openclaw")];
const QUIET_S = 4;
const modelDir = path.join(os.homedir(), ".openclaw/tools/host-talk/models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17");
const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
const find = (prefix) => path.join(modelDir, fs.readdirSync(modelDir).find((f) => f.startsWith(prefix) && f.endsWith(".int8.onnx")));
const recognizer = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { transducer: { encoder: find("encoder"), decoder: find("decoder"), joiner: find("joiner") }, tokens: path.join(modelDir, "tokens.txt"), numThreads: 1, provider: "cpu", debug: 0 },
  decodingMethod: "modified_beam_search", maxActivePaths: 4, enableEndpoint: true,
  rule1MinTrailingSilence: 1.2, rule2MinTrailingSilence: 0.9, rule3MinUtteranceLength: 12,
});
const stream = recognizer.createStream();
const alpha = 1 / (1 + (2 * Math.PI * 150) / 48000);
let prevIn = 0, prevOut = 0, carry = Buffer.alloc(0), skip = 96000, started = 0, lastText = "", wakes = 0, misses = 0;
let win = 0, winN = 0, segLoudest = 0; const ambientWindows = []; const utteranceLevels = []; const recorded = [];
const stamp = () => `[${((Date.now() - started) / 1000).toFixed(1)}s]`;
console.log(`Mic: ${target ?? "(system default)"}\nStay QUIET for ${QUIET_S} seconds...`);
const rec = spawn("pw-record", [...(target ? ["--target", target] : []), "--rate", "48000", "--channels", "1", "--format", "s16", "-"], { stdio: ["ignore", "pipe", "ignore"] });
let announced = false;
rec.stdout.on("data", (chunk) => {
  if (skip > 0) { const d = Math.min(skip, chunk.length); skip -= d; chunk = chunk.subarray(d); if (!chunk.length) return; }
  if (!started) started = Date.now();
  const quiet = Date.now() - started < QUIET_S * 1000;
  if (!quiet && !announced) { announced = true; console.log(`\nNOW say "${phrases[0]}" 5 times from where you normally are, ~4 seconds apart.\n`); }
  const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk; const frames = Math.floor(buf.length / 6); carry = Buffer.from(buf.subarray(frames * 6));
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { let acc = 0; for (let i = 0; i < 3; i++) { const x = buf.readInt16LE(f * 6 + i * 2); prevOut = alpha * (prevOut + x - prevIn); prevIn = x; acc += prevOut; } const v = acc / 3; out[f] = v / 32768; win += v * v; winN++; if (winN === 1600) { const rms = Math.sqrt(win / winN); if (quiet) ambientWindows.push(rms); else segLoudest = Math.max(segLoudest, rms); win = 0; winN = 0; } }
  recorded.push(Buffer.from(Int16Array.from(out, (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32768)))).buffer));
  if (quiet) return;
  stream.acceptWaveform({ sampleRate: 16000, samples: out });
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const text = recognizer.getResult(stream).text.trim();
  const closeSegment = (label) => { console.log(`${stamp()} ${label}  heard: "${text}"  (loudest ${Math.round(segLoudest)})`); utteranceLevels.push(segLoudest); recognizer.reset(stream); lastText = ""; segLoudest = 0; };
  if (findWakePhrase(text, phrases)) { wakes++; closeSegment("WAKE     "); return; }
  if (recognizer.isEndpoint(stream)) { if (text) { misses++; closeSegment("no match "); } else { recognizer.reset(stream); segLoudest = 0; } } else lastText = text;
});
setTimeout(() => {
  rec.kill("SIGTERM");
  if (lastText) console.log(`${stamp()} (unfinished) heard: "${lastText}"`);
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  const ambient = median(ambientWindows); const voice = median(utteranceLevels);
  console.log(`\nRESULT mic=${target ?? "default"} wakes=${wakes} otherUtterances=${misses} roomNoiseRms=${Math.round(ambient)} voiceRms=${Math.round(voice)} snrDb=${voice ? (20 * Math.log10(voice / Math.max(1, ambient))).toFixed(1) : "n/a"}`);
  console.log("(good: snr above ~20 dB and 4-5 wakes)");
  // Kept locally so recognizers can be compared offline on the real voice; never uploaded.
  const pcm = Buffer.concat(recorded); const dir = path.join(os.homedir(), ".openclaw/tools/host-talk/recordings"); fs.mkdirSync(dir, { recursive: true });
  const h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  const file = path.join(dir, `wake-debug-${(target ?? "default").replace(/[^a-zA-Z0-9]+/g, "-").slice(-24)}-${Date.now()}.wav`); fs.writeFileSync(file, Buffer.concat([h, pcm])); console.log("saved recording:", file);
  process.exit(0);
}, (seconds + 2) * 1000);
