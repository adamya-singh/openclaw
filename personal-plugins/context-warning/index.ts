import {
  appendContextWarning,
  decideContextWarning,
  resolveContextWarningSettings,
  type WarnablePayload,
} from "./context-warning.ts";

// Minimal local view of the OpenClaw plugin API (path-loaded plugins stay dependency-free).
type WarnedRecord = { warnedAtTokens: number; warnedAtMs: number };

type WarnedStore = {
  registerIfAbsent(key: string, value: WarnedRecord): Promise<boolean>;
  delete(key: string): Promise<boolean>;
};

type ReplyPayloadSendingEvent = {
  payload: WarnablePayload;
  kind: string;
  channel?: string;
  sessionKey?: string;
  usageState?: { contextUsedTokens?: number };
};

type OpenClawPluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger?: { warn?: (message: string) => void; debug?: (message: string) => void };
  runtime: {
    state: {
      openKeyedStore: <T>(options: { namespace: string; maxEntries: number }) => {
        registerIfAbsent(key: string, value: T): Promise<boolean>;
        delete(key: string): Promise<boolean>;
      };
    };
  };
  on: (
    hook: "reply_payload_sending",
    handler: (event: ReplyPayloadSendingEvent) => Promise<{ payload: WarnablePayload } | undefined>,
  ) => void;
};

export default function register(api: OpenClawPluginApi) {
  const settings = resolveContextWarningSettings(api.pluginConfig);
  let store: WarnedStore | undefined;
  // Opened on first use: the state DB may not be ready while plugins register.
  const openStore = (): WarnedStore =>
    (store ??= api.runtime.state.openKeyedStore<WarnedRecord>({
      namespace: "context-warning",
      maxEntries: 1000,
    }));

  api.on("reply_payload_sending", async (event) => {
    const decision = decideContextWarning(
      {
        kind: event.kind,
        channel: event.channel,
        sessionKey: event.sessionKey,
        contextUsedTokens: event.usageState?.contextUsedTokens,
      },
      settings,
    );
    if (decision.action === "ignore") {
      return undefined;
    }
    try {
      if (decision.action === "rearm") {
        await openStore().delete(decision.sessionKey);
        return undefined;
      }
      const isFirstWarning = await openStore().registerIfAbsent(decision.sessionKey, {
        warnedAtTokens: decision.usedTokens,
        warnedAtMs: Date.now(),
      });
      if (!isFirstWarning) {
        return undefined;
      }
      return {
        payload: appendContextWarning(event.payload, decision.usedTokens, settings.thresholdTokens),
      };
    } catch (error) {
      // A warning must never block the reply itself: log and send the payload unchanged.
      api.logger?.warn?.(`context-warning: skipped (${String(error)})`);
      return undefined;
    }
  });
  api.logger?.debug?.(
    `context-warning: threshold ${settings.thresholdTokens} tokens on ${settings.channels.join(", ")}`,
  );
}
