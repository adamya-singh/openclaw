// Spoken control phrases. These are client-side English literals on purpose: the Gateway relay
// fixes the realtime tool list, so the model cannot end or extend the session itself.

const LIVE_PHRASES = [
  "let's talk",
  "lets talk",
  "let us talk",
  "let's chat",
  "lets chat",
  "stay with me",
  "live mode",
  "conversation mode",
];

const END_PHRASES = [
  "goodbye",
  "good bye",
  "bye bye",
  "that's all",
  "thats all",
  "that is all",
  "stop listening",
  "end conversation",
  "end the conversation",
  "we're done",
  "were done",
  "talk to you later",
];

function normalizeSpoken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPhrase(text: string, phrases: readonly string[]): boolean {
  const spoken = ` ${normalizeSpoken(text)} `;
  return phrases.some((phrase) => spoken.includes(` ${phrase} `));
}

export type SpokenIntent = "end" | "go-live" | "none";

// End wins over go-live so "let's talk later, goodbye" closes the session.
export function classifySpokenIntent(text: string): SpokenIntent {
  if (containsPhrase(text, END_PHRASES)) {
    return "end";
  }
  return containsPhrase(text, LIVE_PHRASES) ? "go-live" : "none";
}
