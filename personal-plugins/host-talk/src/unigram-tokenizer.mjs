// Sentencepiece UNIGRAM encoder for sherpa-onnx keyword files. The KWS model ships a
// "bpe.model" that is really a unigram model, and the Node addon only accepts pre-tokenized
// keywords, so wake phrases (which change at runtime) must be tokenized here.
// Verified against all tokenizations shipped with sherpa-onnx-kws-zipformer-gigaspeech-3.3M.
// Plain .mjs: the forked audio worker imports this outside the plugin loader.
import fs from "node:fs";

function readVarint(buf, start) {
  let result = 0n;
  let shift = 0n;
  let pos = start;
  for (;;) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) {
      return [Number(result), pos];
    }
    shift += 7n;
  }
}

function* readFields(buf) {
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 0) {
      let value;
      [value, pos] = readVarint(buf, pos);
      yield { field, wire, value };
    } else if (wire === 2) {
      let length;
      [length, pos] = readVarint(buf, pos);
      yield { field, wire, value: buf.subarray(pos, pos + length) };
      pos += length;
    } else if (wire === 5) {
      yield { field, wire, value: buf.readFloatLE(pos) };
      pos += 4;
    } else if (wire === 1) {
      pos += 8;
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
}

/**
 * Reads NORMAL pieces and their log-probability scores from a sentencepiece ModelProto.
 * @param {string} modelPath
 * @returns {Map<string, number>}
 */
export function loadUnigramPieces(modelPath) {
  const pieces = new Map();
  for (const top of readFields(fs.readFileSync(modelPath))) {
    if (top.field !== 1 || top.wire !== 2) {
      continue;
    }
    let piece = "";
    let score = 0;
    let type = 1;
    for (const inner of readFields(top.value)) {
      if (inner.field === 1) piece = inner.value.toString("utf8");
      else if (inner.field === 2) score = inner.value;
      else if (inner.field === 3) type = inner.value;
    }
    if (type === 1) {
      pieces.set(piece, score);
    }
  }
  return pieces;
}

const WORD_BOUNDARY = "▁";

/**
 * Viterbi best segmentation; undefined when the phrase has characters outside the vocabulary.
 * @param {Map<string, number>} pieces
 * @param {string} phrase
 * @returns {string[] | undefined}
 */
export function encodeUnigramPhrase(pieces, phrase) {
  const normalized = phrase.trim().toUpperCase().replace(/\s+/g, WORD_BOUNDARY);
  if (!normalized) {
    return undefined;
  }
  const chars = [...(WORD_BOUNDARY + normalized)];
  const best = Array(chars.length + 1).fill(-Infinity);
  const back = Array(chars.length + 1).fill(-1);
  best[0] = 0;
  for (let end = 1; end <= chars.length; end += 1) {
    for (let start = Math.max(0, end - 16); start < end; start += 1) {
      const score = pieces.get(chars.slice(start, end).join(""));
      if (score === undefined || best[start] === -Infinity) {
        continue;
      }
      if (best[start] + score > best[end]) {
        best[end] = best[start] + score;
        back[end] = start;
      }
    }
  }
  if (best[chars.length] === -Infinity) {
    return undefined;
  }
  const tokens = [];
  for (let end = chars.length; end > 0; end = back[end]) {
    tokens.unshift(chars.slice(back[end], end).join(""));
  }
  return tokens;
}
