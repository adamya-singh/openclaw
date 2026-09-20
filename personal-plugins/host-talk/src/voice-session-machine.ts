// Pure conversation state machine: (state, event) -> (state, effects). The service executes
// effects; nothing here touches audio, timers, or the Gateway, so every path is unit-testable.
import type { ToneName } from "./tone-synth.ts";
import { classifySpokenIntent } from "./voice-phrases.ts";

export type VoiceMode = "one-shot" | "live";

export type WakeOutcome =
  | "answered"
  | "no-speech"
  | "ended-by-phrase"
  | "idle-timeout"
  | "session-create-failed"
  | "session-lost"
  | "worker-failed";

export type TurnPhase =
  | "awaiting-user" // mic streams to the relay
  | "thinking" // user turn ended; model or agent consult is working
  | "assistant-speaking" // half-duplex: mic is not forwarded while we play audio
  | "ending"; // end phrase heard; let the assistant's goodbye finish

export type HostTalkState =
  | { kind: "listening" }
  | { kind: "opening" }
  | { kind: "conversing"; mode: VoiceMode; phase: TurnPhase; answered: boolean };

export type HostTalkEvent =
  | { type: "wake" }
  | { type: "session-ready" }
  | { type: "session-failed" }
  | { type: "session-lost" }
  | { type: "worker-failed" }
  | { type: "user-speech" }
  | { type: "user-transcript"; text: string }
  | { type: "assistant-audio" }
  | { type: "reply-finished" } // provider done + playback drained + no consult in flight
  | { type: "timer" };

export type HostTalkEffect =
  | { type: "tone"; tone: ToneName }
  | { type: "open-session" }
  | { type: "close-session" }
  | { type: "cancel-output" }
  | { type: "stream-mic"; on: boolean; flushPreroll?: boolean }
  | { type: "timer"; ms: number | undefined }
  | { type: "outcome"; outcome: WakeOutcome };

export const HOST_TALK_TIMEOUTS_MS = {
  opening: 20_000,
  // One-shot waits this long for a first question, and for a follow-up after each answer.
  oneShotSilence: 7_000,
  // Live mode ends by voice; this only stops an abandoned session from streaming the room.
  liveSilence: 120_000,
  ending: 8_000,
  // Outlasts the 120 s agent-consult deadline; a turn still open after this is hung.
  turnWatchdog: 180_000,
} as const;

type Step = { state: HostTalkState; effects: HostTalkEffect[] };

const LISTENING: HostTalkState = { kind: "listening" };

function finish(outcome: WakeOutcome, options: { closeSession: boolean }): Step {
  const failed =
    outcome === "session-create-failed" ||
    outcome === "session-lost" ||
    outcome === "worker-failed";
  return {
    state: LISTENING,
    effects: [
      { type: "stream-mic", on: false },
      { type: "timer", ms: undefined },
      ...(options.closeSession ? [{ type: "close-session" } as const] : []),
      { type: "tone", tone: failed ? "error" : "end" },
      { type: "outcome", outcome },
    ],
  };
}

function silenceTimeout(mode: VoiceMode): number {
  return mode === "live" ? HOST_TALK_TIMEOUTS_MS.liveSilence : HOST_TALK_TIMEOUTS_MS.oneShotSilence;
}

function awaitUser(mode: VoiceMode, answered: boolean, flushPreroll = false): Step {
  return {
    state: { kind: "conversing", mode, phase: "awaiting-user", answered },
    effects: [
      { type: "stream-mic", on: true, ...(flushPreroll ? { flushPreroll: true } : {}) },
      { type: "timer", ms: silenceTimeout(mode) },
    ],
  };
}

export function reduceHostTalk(state: HostTalkState, event: HostTalkEvent): Step {
  if (event.type === "worker-failed") {
    return state.kind === "listening"
      ? { state, effects: [] }
      : finish("worker-failed", { closeSession: state.kind === "conversing" });
  }

  if (state.kind === "listening") {
    if (event.type !== "wake") {
      return { state, effects: [] };
    }
    return {
      state: { kind: "opening" },
      effects: [
        { type: "tone", tone: "wake" },
        { type: "open-session" },
        { type: "timer", ms: HOST_TALK_TIMEOUTS_MS.opening },
      ],
    };
  }

  if (state.kind === "opening") {
    switch (event.type) {
      case "session-ready":
        // The wake utterance often already contains the question: replay it to the relay.
        return awaitUser("one-shot", false, true);
      case "session-failed":
      case "session-lost":
        return finish("session-create-failed", { closeSession: false });
      case "timer":
        return finish("session-create-failed", { closeSession: true });
      default:
        return { state, effects: [] };
    }
  }

  const { mode, phase, answered } = state;
  switch (event.type) {
    case "session-lost":
    case "session-failed":
      return finish("session-lost", { closeSession: false });
    case "wake": {
      // Half-duplex leaves no other way to interrupt: the wake word is the barge-in.
      if (phase !== "assistant-speaking") {
        return { state, effects: [] };
      }
      const resumed = awaitUser(mode, answered);
      return { state: resumed.state, effects: [{ type: "cancel-output" }, ...resumed.effects] };
    }
    case "user-speech":
      // Speech keeps the session open while the provider is still finalizing the transcript.
      return phase === "awaiting-user"
        ? { state, effects: [{ type: "timer", ms: silenceTimeout(mode) }] }
        : { state, effects: [] };
    case "user-transcript": {
      if (phase === "ending") {
        return { state, effects: [] };
      }
      const intent = classifySpokenIntent(event.text);
      if (intent === "end") {
        return {
          state: { kind: "conversing", mode, phase: "ending", answered },
          effects: [
            { type: "stream-mic", on: false },
            { type: "timer", ms: HOST_TALK_TIMEOUTS_MS.ending },
          ],
        };
      }
      return {
        state: {
          kind: "conversing",
          mode: intent === "go-live" ? "live" : mode,
          phase: "thinking",
          answered,
        },
        effects: [{ type: "timer", ms: HOST_TALK_TIMEOUTS_MS.turnWatchdog }],
      };
    }
    case "assistant-audio":
      if (phase === "ending" || phase === "assistant-speaking") {
        return { state, effects: [] };
      }
      return {
        state: { kind: "conversing", mode, phase: "assistant-speaking", answered },
        effects: [
          { type: "stream-mic", on: false },
          { type: "timer", ms: HOST_TALK_TIMEOUTS_MS.turnWatchdog },
        ],
      };
    case "reply-finished":
      if (phase === "ending") {
        return finish("ended-by-phrase", { closeSession: true });
      }
      return phase === "awaiting-user" ? { state, effects: [] } : awaitUser(mode, true);
    case "timer":
      if (phase === "ending") {
        return finish("ended-by-phrase", { closeSession: true });
      }
      if (phase !== "awaiting-user") {
        return finish("session-lost", { closeSession: true });
      }
      if (mode === "live") {
        return finish("idle-timeout", { closeSession: true });
      }
      return finish(answered ? "answered" : "no-speech", { closeSession: true });
    default:
      return { state, effects: [] };
  }
}
