import { getChannelPlugin } from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { deliveryContextFromSession } from "../utils/delivery-context.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { buildOutboundSessionContext } from "./outbound/session-context.js";

export const CONTEXT_BLOAT_WARNING_PROMPT_TOKEN_THRESHOLD = 100_000;

type ContextBloatWarningParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  entry: SessionEntry;
  promptTokens?: number;
};

const log = createSubsystemLogger("context-bloat-warning");
let deliverRuntimePromise: Promise<typeof import("./outbound/deliver-runtime.js")> | null = null;

function loadDeliverRuntime() {
  deliverRuntimePromise ??= import("./outbound/deliver-runtime.js");
  return deliverRuntimePromise;
}

export function exceedsContextBloatWarningThreshold(promptTokens?: number): promptTokens is number {
  return (
    typeof promptTokens === "number" &&
    Number.isFinite(promptTokens) &&
    promptTokens > CONTEXT_BLOAT_WARNING_PROMPT_TOKEN_THRESHOLD
  );
}

function buildWarningText(promptTokens: number, hasButtons: boolean): string {
  const count = Math.round(promptTokens).toLocaleString("en-US");
  const fallback = hasButtons
    ? ""
    : " Type /reset to clear context or /compact to summarize and reduce it.";
  return (
    `Context warning: this session is using ${count} prompt tokens per model call, ` +
    `above the 100k threshold. Large context can substantially increase API cost. ` +
    `Reset context clears conversation history; Compact context summarizes and reduces it.` +
    fallback
  );
}

export async function deliverContextBloatWarning(params: ContextBloatWarningParams): Promise<void> {
  if (!exceedsContextBloatWarningThreshold(params.promptTokens)) {
    return;
  }
  try {
    const target = deliveryContextFromSession(params.entry);
    const channel = target?.channel ? normalizeMessageChannel(target.channel) : undefined;
    if (channel !== "telegram" || !target?.to) {
      return;
    }
    const channelData =
      getChannelPlugin("telegram")?.commands?.buildContextBloatWarningChannelData?.({
        cfg: params.cfg,
        to: target.to,
        accountId: target.accountId,
      }) ?? undefined;
    const text = buildWarningText(params.promptTokens, Boolean(channelData));
    const { deliverOutboundPayloads } = await loadDeliverRuntime();
    await deliverOutboundPayloads({
      cfg: params.cfg,
      channel: "telegram",
      to: target.to,
      accountId: target.accountId,
      threadId: target.threadId,
      payloads: [{ text, ...(channelData ? { channelData } : {}) }],
      session: buildOutboundSessionContext({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
      }),
    });
  } catch (err) {
    log.warn(`Failed to deliver context bloat warning: ${String(err)}`);
  }
}
