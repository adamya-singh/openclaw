import assert from "node:assert/strict";
import { test } from "node:test";
import { classifySpokenIntent } from "./voice-phrases.ts";
import {
  reduceHostTalk,
  type HostTalkEffect,
  type HostTalkEvent,
  type HostTalkState,
} from "./voice-session-machine.ts";

function run(events: HostTalkEvent[], start: HostTalkState = { kind: "listening" }) {
  let state = start;
  const effects: HostTalkEffect[] = [];
  for (const event of events) {
    const step = reduceHostTalk(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return {
    state,
    effects,
    outcomes: effects.filter((e) => e.type === "outcome").map((e) => e.outcome),
  };
}

const say = (text: string): HostTalkEvent => ({ type: "user-transcript", text });
const ask: HostTalkEvent[] = [{ type: "wake" }, { type: "session-ready" }];
const answer: HostTalkEvent[] = [{ type: "assistant-audio" }, { type: "reply-finished" }];

test("spoken intents", () => {
  assert.equal(classifySpokenIntent("Okay, that's all. Thanks!"), "end");
  assert.equal(classifySpokenIntent("Hey, let’s talk for a bit"), "go-live");
  assert.equal(classifySpokenIntent("let's talk later, goodbye"), "end");
  assert.equal(classifySpokenIntent("what does goodbyes mean in chess talk"), "none");
});

test("one-shot: question, answer, then silence returns to listening as answered", () => {
  const { state, effects, outcomes } = run([
    ...ask,
    say("what time is it"),
    ...answer,
    { type: "timer" },
  ]);
  assert.deepEqual(state, { kind: "listening" });
  assert.deepEqual(outcomes, ["answered"]);
  assert.deepEqual(effects[0], { type: "tone", tone: "wake" });
  assert.ok(
    effects.some((e) => e.type === "stream-mic" && e.on && e.flushPreroll),
    "pre-roll replayed",
  );
  assert.ok(effects.some((e) => e.type === "close-session"));
});

test("one-shot: a follow-up inside the window continues the exchange", () => {
  const { state } = run([
    ...ask,
    say("set a timer"),
    ...answer,
    { type: "user-speech" },
    say("ten minutes"),
  ]);
  assert.equal(state.kind === "conversing" && state.phase, "thinking");
});

test("one-shot with no question ends as no-speech", () => {
  assert.deepEqual(run([...ask, { type: "timer" }]).outcomes, ["no-speech"]);
});

test("live mode survives the follow-up window and ends only by phrase", () => {
  const live = run([...ask, say("hey let's talk"), ...answer]);
  assert.deepEqual(live.state, {
    kind: "conversing",
    mode: "live",
    phase: "awaiting-user",
    answered: true,
  });
  const silence = live.effects.filter((e) => e.type === "timer").at(-1);
  assert.deepEqual(silence, { type: "timer", ms: 120_000 });

  const ended = run([say("okay goodbye"), ...answer], live.state);
  assert.deepEqual(ended.state, { kind: "listening" });
  assert.deepEqual(ended.outcomes, ["ended-by-phrase"]);
  assert.deepEqual(
    ended.effects.filter((e) => e.type === "tone"),
    [{ type: "tone", tone: "end" }],
  );
});

test("half-duplex: mic stops while the assistant speaks; the wake word barges in", () => {
  const speaking = run([...ask, say("tell me a story"), { type: "assistant-audio" }]);
  assert.deepEqual(speaking.effects.filter((e) => e.type === "stream-mic").at(-1), {
    type: "stream-mic",
    on: false,
  });
  const barged = run([{ type: "wake" }], speaking.state);
  assert.deepEqual(barged.effects[0], { type: "cancel-output" });
  assert.equal(barged.state.kind === "conversing" && barged.state.phase, "awaiting-user");
});

test("a hung turn is ended by the watchdog instead of holding the session open", () => {
  const { state, outcomes } = run([...ask, say("do something slow"), { type: "timer" }]);
  assert.deepEqual(state, { kind: "listening" });
  assert.deepEqual(outcomes, ["session-lost"]);
});

test("failures always end audibly with an error tone and a recorded outcome", () => {
  const cases: Array<[string, HostTalkEvent[], string]> = [
    ["create failed", [{ type: "wake" }, { type: "session-failed" }], "session-create-failed"],
    ["create timed out", [{ type: "wake" }, { type: "timer" }], "session-create-failed"],
    ["lost mid-turn", [...ask, say("hi"), { type: "session-lost" }], "session-lost"],
    ["worker died", [...ask, { type: "worker-failed" }], "worker-failed"],
  ];
  for (const [name, events, outcome] of cases) {
    const { state, effects, outcomes } = run(events);
    assert.deepEqual(state, { kind: "listening" }, name);
    assert.deepEqual(outcomes, [outcome], name);
    assert.ok(
      effects.some((e) => e.type === "tone" && e.tone === "error"),
      name,
    );
  }
});

test("invariant: every wake ends in exactly one outcome and one closing tone", () => {
  const alphabet: HostTalkEvent[] = [
    { type: "wake" },
    { type: "session-ready" },
    { type: "session-failed" },
    { type: "session-lost" },
    { type: "worker-failed" },
    { type: "user-speech" },
    say("what's the weather"),
    say("let's talk"),
    say("goodbye"),
    { type: "assistant-audio" },
    { type: "reply-finished" },
    { type: "timer" },
  ];
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let trial = 0; trial < 300; trial += 1) {
    let state: HostTalkState = { kind: "listening" };
    let wakes = 0,
      outcomes = 0,
      closingTones = 0;
    const events = Array.from({ length: 40 }, () => alphabet[next() % alphabet.length]!);
    // Drain: timers alone must always bring any state back to listening.
    for (const event of [
      ...events,
      ...Array<HostTalkEvent>(4).fill({ type: "timer" }),
      { type: "reply-finished" } as const,
      { type: "timer" } as const,
      { type: "timer" } as const,
    ]) {
      const wasListening = state.kind === "listening";
      const step = reduceHostTalk(state, event);
      if (wasListening && step.state.kind !== "listening") wakes += 1;
      outcomes += step.effects.filter((e) => e.type === "outcome").length;
      closingTones += step.effects.filter((e) => e.type === "tone" && e.tone !== "wake").length;
      state = step.state;
    }
    assert.deepEqual(state, { kind: "listening" }, `trial ${trial}`);
    assert.equal(outcomes, wakes, `trial ${trial} outcomes`);
    assert.equal(closingTones, wakes, `trial ${trial} tones`);
  }
});
