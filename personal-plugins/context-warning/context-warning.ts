// Pure decision + payload logic for the context warning; index.ts owns the OpenClaw wiring.

export const DEFAULT_THRESHOLD_TOKENS = 100_000;
export const DEFAULT_CHANNELS: readonly string[] = ["telegram"];

export type ContextWarningSettings = {
  thresholdTokens: number;
  channels: readonly string[];
};

type PresentationBlock = { type: string; [key: string]: unknown };

// Only the reply-payload fields this plugin reads or writes; everything else passes through.
export type WarnablePayload = {
  text?: string;
  presentation?: { blocks?: PresentationBlock[]; [key: string]: unknown };
  [key: string]: unknown;
};

export type ContextWarningEvent = {
  kind: string;
  channel?: string;
  sessionKey?: string;
  contextUsedTokens?: number;
};

export type ContextWarningDecision =
  | { action: "ignore" }
  | { action: "rearm"; sessionKey: string }
  | { action: "warn-if-first"; sessionKey: string; usedTokens: number };

export function resolveContextWarningSettings(
  pluginConfig: Record<string, unknown> | undefined,
): ContextWarningSettings {
  const threshold = pluginConfig?.thresholdTokens;
  const channels = pluginConfig?.channels;
  return {
    thresholdTokens:
      typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 1000
        ? Math.floor(threshold)
        : DEFAULT_THRESHOLD_TOKENS,
    channels:
      Array.isArray(channels) && channels.every((entry) => typeof entry === "string")
        ? channels
        : DEFAULT_CHANNELS,
  };
}

// Only the final reply of a turn carries the warning: tool/block payloads stream mid-turn,
// and durable replays arrive without usage, so they must never warn or re-arm.
export function decideContextWarning(
  event: ContextWarningEvent,
  settings: ContextWarningSettings,
): ContextWarningDecision {
  if (event.kind !== "final" || !event.sessionKey || event.contextUsedTokens === undefined) {
    return { action: "ignore" };
  }
  if (!event.channel || !settings.channels.includes(event.channel)) {
    return { action: "ignore" };
  }
  if (event.contextUsedTokens <= settings.thresholdTokens) {
    // Back under the limit (after /compact or /reset): allow the next overflow to warn again.
    return { action: "rearm", sessionKey: event.sessionKey };
  }
  return {
    action: "warn-if-first",
    sessionKey: event.sessionKey,
    usedTokens: event.contextUsedTokens,
  };
}

function formatThousands(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

export function buildContextWarningText(usedTokens: number, thresholdTokens: number): string {
  return (
    `⚠️ Context warning: this chat now sends about ${formatThousands(usedTokens)} tokens of ` +
    `context with every model call (over your ${formatThousands(thresholdTokens)} limit), so each ` +
    `reply costs more. Reset context (/reset) clears the conversation history; ` +
    `Compact context (/compact) summarizes it.`
  );
}

export function appendContextWarning<T extends WarnablePayload>(
  payload: T,
  usedTokens: number,
  thresholdTokens: number,
): T {
  const warning = buildContextWarningText(usedTokens, thresholdTokens);
  const text = payload.text?.trim() ? `${payload.text}\n\n${warning}` : warning;
  const buttons: PresentationBlock = {
    type: "buttons",
    buttons: [
      { label: "Reset context", style: "danger", action: { type: "command", command: "/reset" } },
      {
        label: "Compact context",
        style: "primary",
        action: { type: "command", command: "/compact" },
      },
    ],
  };
  return {
    ...payload,
    text,
    presentation: {
      ...payload.presentation,
      blocks: [...(payload.presentation?.blocks ?? []), buttons],
    },
  };
}
