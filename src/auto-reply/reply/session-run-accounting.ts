import {
  derivePromptTokens,
  deriveSessionTotalTokens,
  type NormalizedUsage,
} from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { incrementCompactionCount } from "./session-updates.js";
import { persistSessionUsageUpdate } from "./session-usage.js";

type PersistRunSessionUsageParams = Parameters<typeof persistSessionUsageUpdate>[0];

export type ContextBloatWarningCandidate = {
  entry: SessionEntry;
  promptTokens?: number;
};

type IncrementRunCompactionCountParams = Omit<
  Parameters<typeof incrementCompactionCount>[0],
  "tokensAfter"
> & {
  amount?: number;
  cfg?: OpenClawConfig;
  lastCallUsage?: NormalizedUsage;
  contextTokensUsed?: number;
  newSessionId?: string;
};

export async function persistRunSessionUsage(
  params: PersistRunSessionUsageParams,
): Promise<ContextBloatWarningCandidate | undefined> {
  const entry = await persistSessionUsageUpdate(params);
  if (!entry) {
    return undefined;
  }
  return {
    entry,
    promptTokens: params.promptTokens ?? derivePromptTokens(params.lastCallUsage),
  };
}

export async function incrementRunCompactionCount(
  params: IncrementRunCompactionCountParams,
): Promise<number | undefined> {
  const tokensAfterCompaction = params.lastCallUsage
    ? deriveSessionTotalTokens({
        usage: params.lastCallUsage,
        contextTokens: params.contextTokensUsed,
      })
    : undefined;
  return incrementCompactionCount({
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    cfg: params.cfg,
    amount: params.amount,
    tokensAfter: tokensAfterCompaction,
    newSessionId: params.newSessionId,
  });
}
