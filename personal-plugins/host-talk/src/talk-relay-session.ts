// One Gateway-relay realtime Talk session. Ported from the Control UI relay client contract
// (ui/src/pages/chat/talk/gateway-relay.ts + shared.ts): the relay owns the provider socket, but
// the CLIENT runs agent consults (toolCall -> talk.client.toolCall -> chat final -> tool result).

export type GatewayLink = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  onEvent(listener: (event: { event: string; payload?: unknown }) => void): () => void;
};

export type TalkRelayCallbacks = {
  onReady(): void;
  onAudio(pcm24k: Buffer): void;
  /** Provider cleared its output (barge-in or cancel): drop queued playback now. */
  onClear(): void;
  /** Ack only after local playback drains past this chunk, or the provider over-runs us. */
  onMark(markName: string): void;
  /**
   * The provider is transcribing user speech right now. Mic energy is not used for this:
   * a noisy microphone sits above any fixed threshold and would hold sessions open forever.
   */
  onUserSpeech(): void;
  onUserTranscript(text: string): void;
  /** Provider finished the reply and no agent consult is in flight. Playback may still drain. */
  onReplyIdle(): void;
  onLost(reason: string): void;
};

const CONSULT_TOOL = "openclaw_agent_consult";
const CONTROL_TOOL = "openclaw_agent_control";
const CONSULT_TIMEOUT_MS = 120_000;
// Matches the Control UI: past this many unanswered appends the link is saturated, and fresh
// microphone audio is worth more than a growing backlog.
const MAX_IN_FLIGHT_APPENDS = 8;

type RelayEvent = { relaySessionId?: string; type?: string; [key: string]: unknown };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractChatText(message: unknown): string {
  const record = asRecord(message);
  if (!record) {
    return "";
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  return content
    .map((block) => {
      const entry = asRecord(block);
      return entry?.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .join("")
    .trim();
}

export class TalkRelaySession {
  private sessionId: string | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private inFlightAppends = 0;
  private providerDone = true;
  private readonly consultAborts = new Map<string, AbortController>();
  private readonly link: GatewayLink;
  private readonly sessionKey: string;
  private readonly callbacks: TalkRelayCallbacks;

  // Explicit fields (no parameter properties): this file also runs under Node type stripping.
  constructor(link: GatewayLink, sessionKey: string, callbacks: TalkRelayCallbacks) {
    this.link = link;
    this.sessionKey = sessionKey;
    this.callbacks = callbacks;
  }

  async open(): Promise<void> {
    this.unsubscribe = this.link.onEvent((event) => this.handleGatewayEvent(event));
    const created = await this.link.request<{ sessionId?: string }>("talk.session.create", {
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      sessionKey: this.sessionKey,
    });
    if (!created?.sessionId) {
      throw new Error("talk.session.create returned no sessionId");
    }
    if (this.closed) {
      // close() raced the create: the relay session exists only now, so release it here.
      void this.link
        .request("talk.session.close", { sessionId: created.sessionId })
        .catch(() => {});
      return;
    }
    this.sessionId = created.sessionId;
  }

  appendAudio(pcm24k: Buffer): void {
    if (!this.sessionId || this.closed || this.inFlightAppends >= MAX_IN_FLIGHT_APPENDS) {
      return;
    }
    this.inFlightAppends += 1;
    this.link
      .request("talk.session.appendAudio", {
        sessionId: this.sessionId,
        audioBase64: pcm24k.toString("base64"),
      })
      .catch(() => {})
      .finally(() => {
        this.inFlightAppends -= 1;
      });
  }

  acknowledgeMark(markName: string): void {
    if (this.sessionId && !this.closed) {
      void this.link
        .request("talk.session.acknowledgeMark", { sessionId: this.sessionId, markName })
        .catch(() => {});
    }
  }

  cancelOutput(): void {
    if (this.sessionId && !this.closed) {
      void this.link
        .request("talk.session.cancelOutput", { sessionId: this.sessionId, reason: "barge-in" })
        .catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribe?.();
    for (const abort of this.consultAborts.values()) {
      abort.abort();
    }
    if (this.sessionId) {
      await this.link.request("talk.session.close", { sessionId: this.sessionId }).catch(() => {});
    }
  }

  private handleGatewayEvent(event: { event: string; payload?: unknown }): void {
    if (event.event !== "talk.event" || this.closed) {
      return;
    }
    const relay = asRecord(event.payload) as RelayEvent | undefined;
    if (!relay || !this.sessionId || relay.relaySessionId !== this.sessionId) {
      return;
    }
    switch (relay.type) {
      case "ready":
        this.callbacks.onReady();
        return;
      case "audio":
        if (typeof relay.audioBase64 === "string") {
          this.providerDone = false;
          this.callbacks.onAudio(Buffer.from(relay.audioBase64, "base64"));
        }
        return;
      case "clear":
        this.callbacks.onClear();
        return;
      case "mark":
        if (typeof relay.markName === "string") {
          this.callbacks.onMark(relay.markName);
        }
        return;
      case "transcript":
        if (relay.role !== "user" || typeof relay.text !== "string") {
          return;
        }
        if (relay.final === true) {
          this.providerDone = false;
          this.callbacks.onUserTranscript(relay.text);
        } else {
          this.callbacks.onUserSpeech();
        }
        return;
      case "audioDone":
        this.providerDone = true;
        this.notifyIfIdle();
        return;
      case "toolCall":
        void this.handleToolCall(relay);
        return;
      case "toolCallCancelled":
        if (typeof relay.callId === "string") {
          this.consultAborts.get(relay.callId)?.abort();
        }
        return;
      case "close":
        this.closed = true;
        this.unsubscribe?.();
        this.callbacks.onLost(typeof relay.reason === "string" ? relay.reason : "closed");
        return;
      default:
        // error events are advisory: a fatal one is always followed by close.
        return;
    }
  }

  private notifyIfIdle(): void {
    if (!this.closed && this.providerDone && this.consultAborts.size === 0) {
      this.callbacks.onReplyIdle();
    }
  }

  private async handleToolCall(relay: RelayEvent): Promise<void> {
    const callId = typeof relay.callId === "string" ? relay.callId : undefined;
    const name = typeof relay.name === "string" ? relay.name : undefined;
    if (!callId || !name) {
      return;
    }
    const rawArgs = relay.args ?? relay.arguments ?? {};
    const args = typeof rawArgs === "string" ? safeParse(rawArgs) : rawArgs;
    this.providerDone = false;
    const abort = new AbortController();
    this.consultAborts.set(callId, abort);
    let result: unknown;
    try {
      result =
        name === CONTROL_TOOL
          ? { result: await this.steer(args) }
          : name === CONSULT_TOOL
            ? { result: await this.runConsult(callId, args, abort.signal) }
            : { error: `Tool "${name}" is unavailable in this voice session` };
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    this.consultAborts.delete(callId);
    if (this.closed || !this.sessionId) {
      return;
    }
    await this.link
      .request("talk.session.submitToolResult", { sessionId: this.sessionId, callId, result })
      .catch(() => {});
    // The provider now speaks the result; audioDone for that reply reports idle.
  }

  private steer(args: unknown): Promise<unknown> {
    const record = asRecord(args) ?? {};
    return this.link.request("talk.session.steer", {
      sessionId: this.sessionId,
      sessionKey: this.sessionKey,
      text: typeof record.text === "string" ? record.text : "",
      ...(typeof record.mode === "string" ? { mode: record.mode } : {}),
    });
  }

  private async runConsult(callId: string, args: unknown, signal: AbortSignal): Promise<string> {
    const run = await this.link.request<{
      runId?: string;
      agentId?: string;
      agentSessionKey?: string;
    }>("talk.client.toolCall", {
      sessionKey: this.sessionKey,
      callId,
      name: CONSULT_TOOL,
      args,
      relaySessionId: this.sessionId,
    });
    if (!run?.runId) {
      throw new Error("OpenClaw did not start the agent run");
    }
    const runId = run.runId;
    return await new Promise<string>((resolve, reject) => {
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
        settle();
      };
      const onAbort = () => {
        void this.link
          .request("chat.abort", { sessionKey: run.agentSessionKey, agentId: run.agentId, runId })
          .catch(() => {});
        finish(() => reject(new Error("OpenClaw tool call aborted")));
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error("OpenClaw tool call timed out"))),
        CONSULT_TIMEOUT_MS,
      );
      const unsubscribe = this.link.onEvent((event) => {
        const chat = event.event === "chat" ? asRecord(event.payload) : undefined;
        if (!chat || chat.runId !== runId) {
          return;
        }
        if (chat.state === "final") {
          const text = extractChatText(chat.message) || "OpenClaw finished with no text.";
          finish(() => resolve(text));
        } else if (chat.state === "error" || chat.state === "aborted") {
          const message = typeof chat.errorMessage === "string" ? chat.errorMessage : undefined;
          finish(() => reject(new Error(message ?? `OpenClaw tool call ${String(chat.state)}`)));
        }
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}
