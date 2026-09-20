// Fuzzy wake-phrase matching over a streaming ASR transcript. A small recognizer spells an
// invented word many ways ("OPEN CLAW", "OPENED CLAW", "OPEN CAR"), so matching is done on the
// space-free text with a bounded edit distance instead of exact words.
// Plain .mjs: the forked audio worker imports this outside the plugin loader.

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

const lettersOnly = (text) => text.toLowerCase().replace(/[^a-z]/g, "");

/**
 * The matchable core of a trigger: "hey openclaw" and "openclaw" both reduce to "openclaw",
 * because the greeting is the part recognizers garble most ("Y", "HAY", "HAIG").
 * @param {string} trigger
 */
export function wakePhraseCore(trigger) {
  return lettersOnly(trigger.trim().replace(/^(hey|hi|ok|okay)\s+/i, ""));
}

/**
 * @param {string} transcript running transcript of the current utterance
 * @param {readonly string[]} triggers configured wake phrases
 * @returns {string | undefined} the trigger that matched
 */
export function findWakePhrase(transcript, triggers) {
  const text = lettersOnly(transcript);
  for (const trigger of triggers) {
    const core = wakePhraseCore(trigger);
    // Short words would match almost anything once edits are allowed.
    if (core.length < 4) {
      continue;
    }
    const maxDistance = Math.floor(core.length / 4);
    // Windows shorter than the phrase minus one letter are prefixes of ordinary words.
    for (let length = core.length - 1; length <= core.length + maxDistance; length += 1) {
      for (let start = 0; start + length <= text.length; start += 1) {
        if (editDistance(text.slice(start, start + length), core) <= maxDistance) {
          return trigger;
        }
      }
    }
  }
  return undefined;
}
