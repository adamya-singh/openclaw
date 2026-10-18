#!/usr/bin/env node
// Repeatable microphone benchmark for host-talk. Plays fixed "hey openclaw" clips through the
// default speaker and measures what a given PipeWire source delivers to the wake recognizer.
// Usage: node personal-plugins/host-talk/tools/mic-benchmark.mjs [--target <source node name>]
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { findWakePhrase } from "../src/wake-phrase-match.mjs";

const targetIndex = process.argv.indexOf("--target");
const target = targetIndex > 0 ? process.argv[targetIndex + 1] : undefined;
const tools = path.join(os.homedir(), ".openclaw/tools/host-talk");
const modelDir = path.join(tools, "models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17");
const clips = fs.readdirSync(path.join(tools, "test-clips")).filter((f) => f.endsWith(".wav")).sort().map((f) => path.join(tools, "test-clips", f));
const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
const find = (p) => path.join(modelDir, fs.readdirSync(modelDir).find((f) => f.startsWith(p) && f.endsWith(".int8.onnx")));
const recognizer = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { transducer: { encoder: find("encoder"), decoder: find("decoder"), joiner: find("joiner") }, tokens: path.join(modelDir, "tokens.txt"), numThreads: 1, provider: "cpu", debug: 0 },
  decodingMethod: "modified_beam_search", maxActivePaths: 4, enableEndpoint: true,
  rule1MinTrailingSilence: 1.2, rule2MinTrailingSilence: 0.9, rule3MinUtteranceLength: 12,
});
const stream = recognizer.createStream();
const alpha = 1 / (1 + (2 * Math.PI * 150) / 48000);
let prevIn = 0, prevOut = 0, carry = Buffer.alloc(0), skip = 96000;
let phase = "settle"; const windows = { ambient: [], speech: [] }; let win = 0, winN = 0; const heard = []; let wakes = 0;
const rec = spawn("pw-record", [...(target ? ["--target", target] : []), "--rate", "48000", "--channels", "1", "--format", "s16", "-"], { stdio: ["ignore", "pipe", "ignore"] });
rec.stdout.on("data", (chunk) => {
  if (skip > 0) { const d = Math.min(skip, chunk.length); skip -= d; chunk = chunk.subarray(d); if (!chunk.length) return; if (skip === 0) phase = "ambient"; }
  const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk; const frames = Math.floor(buf.length / 6); carry = Buffer.from(buf.subarray(frames * 6));
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) { let acc = 0; for (let i = 0; i < 3; i++) { const x = buf.readInt16LE(f * 6 + i * 2); prevOut = alpha * (prevOut + x - prevIn); prevIn = x; acc += prevOut; } const v = acc / 3; out[f] = v / 32768; win += v * v; winN++; if (winN === 1600) { (windows[phase] ?? []).push(Math.sqrt(win / winN)); win = 0; winN = 0; } }
  if (phase !== "speech") return;
  stream.acceptWaveform({ sampleRate: 16000, samples: out });
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const text = recognizer.getResult(stream).text.trim();
  if (findWakePhrase(text, ["hey openclaw"])) { wakes++; heard.push(`WAKE<${text}>`); recognizer.reset(stream); }
  else if (recognizer.isEndpoint(stream)) { if (text) heard.push(text); recognizer.reset(stream); }
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const playClip = (file) => new Promise((r) => spawn("pw-play", [file], { stdio: "ignore" }).on("exit", r));
await wait(2000 + 4000); // settle + 4 s ambient
phase = "speech";
for (const clip of clips) { await playClip(clip); await wait(2500); }
rec.kill("SIGTERM");
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const ambient = median(windows.ambient); const loud = [...windows.speech].sort((x, y) => y - x); const speech = loud[Math.floor(loud.length * 0.1)] ?? 0;
console.log(JSON.stringify({ source: target ?? "(default)", ambientRms: Math.round(ambient), speechRms: Math.round(speech), snrDb: Number((20 * Math.log10(speech / Math.max(1, ambient))).toFixed(1)), wakes: `${wakes} of 5 expected`, heard }, null, 1));
process.exit(0);
