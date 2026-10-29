import { formatErrorMessage as formatError } from "../../infra/errors.js";
import { BoundedSerialQueue } from "../../shared/bounded-serial-queue.js";
import { REALTIME_VOICE_AGENT_CONTROL_FAILURE_MESSAGE } from "../../talk/agent-run-control-shared.js";
import {
  buildRealtimeVoiceAgentControlSpeechMessage,
  resolveRealtimeVoiceAgentControlIntent,
  type RealtimeVoiceAgentControlResult,
} from "../../talk/agent-run-control.js";

const REALTIME_CONTROL_MAX_PENDING = 8;
// "Abort" anywhere in an utterance is the spoken kill switch for the chat's agent work;
// a negation ("don't abort") keeps the work running.
const ABORT_WORD = /\babort\b/;
const NEGATED_ABORT = /\b(?:don'?t|do not|not|never|no need to)\s+abort\b/;

/** True when spoken text uses the magic word that stops all of the chat's agent work. */
export function isRealtimeVoiceAbortAll(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[‘’ʼ]/g, "'");
  return ABORT_WORD.test(normalized) && !NEGATED_ABORT.test(normalized);
}

export function createRealtimeControlQueue(): BoundedSerialQueue {
  return new BoundedSerialQueue({
    maxPendingCount: REALTIME_CONTROL_MAX_PENDING,
    maxPendingWeight: REALTIME_CONTROL_MAX_PENDING,
  });
}

export function createTalkRealtimeRunControlOwner(params: {
  controlSource?: "delegation" | "transcript";
  supportsToolCalls?: boolean;
  /** The owner can stop every run and subagent in the chat when the user says "abort". */
  supportsAbortAll?: boolean;
  hasActiveRun: () => boolean;
  prepare: (args: unknown) => () => Promise<RealtimeVoiceAgentControlResult>;
  speak: (message: string) => void;
  warn: (message: string) => void;
}) {
  const queue = createRealtimeControlQueue();
  const enqueue = (
    args: unknown,
    options: {
      ready?: () => Promise<void>;
      onResult?: (result: RealtimeVoiceAgentControlResult) => void | Promise<void>;
      onError?: (error: unknown) => void | Promise<void>;
    } = {},
  ): boolean => {
    // Capture the owner (including absence) before any FIFO/readiness wait.
    let execute: () => Promise<RealtimeVoiceAgentControlResult>;
    try {
      execute = params.prepare(args);
    } catch (error) {
      execute = async () => {
        throw error;
      };
    }
    const admission = queue.enqueue(
      async () => {
        let result: RealtimeVoiceAgentControlResult;
        try {
          await options.ready?.();
          result = await execute();
        } catch (error) {
          if (!options.onError) {
            throw error;
          }
          await options.onError(error);
          return;
        }
        // Reply failures are transport failures, not another execution failure to answer twice.
        await options.onResult?.(result);
      },
      { sealOnOverflow: false },
    );
    if (!admission.accepted) {
      params.warn(`realtime Talk control queue rejected work: ${admission.reason}`);
      return false;
    }
    void admission.completion.catch((error: unknown) => {
      params.warn(`realtime Talk control failed: ${formatError(error)}`);
    });
    return true;
  };
  const handleInput = (
    text: string,
    respond: (message: string) => void,
    ready?: () => Promise<void>,
  ): "control" | "consult" => {
    const reply = (message: string) =>
      respond(buildRealtimeVoiceAgentControlSpeechMessage(message));
    if (params.supportsAbortAll && isRealtimeVoiceAbortAll(text)) {
      if (
        !enqueue(
          { text, mode: "cancel", stopAll: true },
          {
            ready,
            onResult: (result) => {
              if (result.speak && !result.suppress && result.message.trim()) {
                reply(result.message);
              }
            },
            onError: () => reply(REALTIME_VOICE_AGENT_CONTROL_FAILURE_MESSAGE),
          },
        )
      ) {
        reply("OpenClaw's voice control queue is full. Please try again.");
      }
      return "control";
    }
    const intent = resolveRealtimeVoiceAgentControlIntent({ text });
    const intrinsic = intent.mode === "status" || intent.mode === "cancel";
    const allowIdle = params.controlSource === "delegation" || params.supportsToolCalls === false;
    // A tool-calling transcript provider steers through openclaw_agent_control with the
    // caller's request authority; a transcript-side steer would only duplicate it.
    const providerSteers =
      params.controlSource === "transcript" && params.supportsToolCalls !== false && !intrinsic;
    if (
      !intent.shouldAutoControl ||
      providerSteers ||
      (!params.hasActiveRun() && !(allowIdle && intrinsic))
    ) {
      return "consult";
    }
    if (
      !enqueue(
        { text, mode: intent.mode },
        {
          ready,
          onResult: (result) => {
            if (result.speak && !result.suppress && result.message.trim()) {
              reply(result.message);
            }
          },
          onError: () => reply(REALTIME_VOICE_AGENT_CONTROL_FAILURE_MESSAGE),
        },
      )
    ) {
      reply(
        "OpenClaw's voice control queue is full. Please try again after the pending controls finish.",
      );
    }
    return "control";
  };
  return {
    enqueue,
    handleDelegationInput: params.controlSource === "delegation" ? handleInput : undefined,
    handleSpoken: (text: string, ready?: () => Promise<void>): boolean =>
      params.controlSource !== "delegation" && handleInput(text, params.speak, ready) === "control",
    close: () => {
      queue.seal();
      return queue.flush();
    },
  };
}
