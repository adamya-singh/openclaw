import assert from "node:assert/strict";
import { test } from "node:test";
import { TalkRelaySession, type GatewayLink } from "./talk-relay-session.ts";

function createHarness(handlers: Record<string, (params: any) => unknown> = {}) {
  const listeners = new Set<(event: { event: string; payload?: unknown }) => void>();
  const requests: Array<{ method: string; params: any }> = [];
  const link: GatewayLink = {
    request: async (method, params) => {
      requests.push({ method, params });
      const handler = handlers[method];
      if (handler) return (await handler(params)) as never;
      return (method === "talk.session.create" ? { sessionId: "relay-1" } : {}) as never;
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const seen: string[] = [];
  const session = new TalkRelaySession(link, "agent:main:host-talk:test", {
    onReady: () => seen.push("ready"),
    onAudio: (pcm) => seen.push(`audio:${pcm.length}`),
    onClear: () => seen.push("clear"),
    onMark: (mark) => seen.push(`mark:${mark}`),
    onUserSpeech: () => seen.push("speech"),
    onUserTranscript: (text) => seen.push(`user:${text}`),
    onReplyIdle: () => seen.push("idle"),
    onLost: (reason) => seen.push(`lost:${reason}`),
  });
  const emit = (event: string, payload: unknown) => listeners.forEach((l) => l({ event, payload }));
  const relay = (payload: Record<string, unknown>) =>
    emit("talk.event", { relaySessionId: "relay-1", ...payload });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  return { session, requests, seen, emit, relay, settle };
}

test("creates a realtime relay session on its own session key", async () => {
  const h = createHarness();
  await h.session.open();
  assert.deepEqual(h.requests[0], {
    method: "talk.session.create",
    params: {
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      sessionKey: "agent:main:host-talk:test",
    },
  });
});

test("a ready event that outruns the create response is replayed, not dropped", async () => {
  let finishCreate: ((value: unknown) => void) | undefined;
  const h = createHarness({
    "talk.session.create": () => new Promise((resolve) => (finishCreate = resolve)),
  });
  const opening = h.session.open();
  await h.settle();
  h.relay({ type: "ready" });
  h.emit("talk.event", { relaySessionId: "someone-else", type: "ready" });
  assert.deepEqual(h.seen, []);
  finishCreate?.({ sessionId: "relay-1" });
  await opening;
  assert.deepEqual(h.seen, ["ready"]);
});

test("routes relay events and ignores other sessions and non-final transcripts", async () => {
  const h = createHarness();
  await h.session.open();
  h.relay({ type: "ready" });
  h.relay({ type: "audio", audioBase64: Buffer.alloc(480).toString("base64") });
  h.relay({ type: "mark", markName: "m1" });
  h.relay({ type: "transcript", role: "user", text: "partial", final: false });
  h.relay({ type: "transcript", role: "assistant", text: "hi", final: true });
  h.relay({ type: "transcript", role: "user", text: "what time is it", final: true });
  h.emit("talk.event", { relaySessionId: "someone-else", type: "audioDone" });
  h.relay({ type: "audioDone" });
  h.relay({ type: "clear" });
  assert.deepEqual(h.seen, [
    "ready",
    "audio:480",
    "mark:m1",
    "speech",
    "user:what time is it",
    "idle",
    "clear",
  ]);
});

test("runs the agent consult client-side and stays busy until it is submitted", async () => {
  const h = createHarness({
    "talk.client.toolCall": () => ({ runId: "run-1", agentId: "main", agentSessionKey: "k" }),
  });
  await h.session.open();
  h.relay({
    type: "toolCall",
    callId: "c1",
    name: "openclaw_agent_consult",
    args: { question: "weather?" },
  });
  h.relay({ type: "audioDone" }); // the "let me check" filler must NOT count as the reply
  await h.settle();
  assert.ok(!h.seen.includes("idle"), "filler audioDone while consulting is not idle");
  assert.equal(
    h.requests.find((r) => r.method === "talk.client.toolCall")?.params.relaySessionId,
    "relay-1",
  );

  h.emit("chat", { runId: "other-run", state: "final", message: { text: "ignore me" } });
  h.emit("chat", {
    runId: "run-1",
    state: "final",
    message: { content: [{ type: "text", text: "Sunny." }] },
  });
  await h.settle();
  assert.deepEqual(h.requests.find((r) => r.method === "talk.session.submitToolResult")?.params, {
    sessionId: "relay-1",
    callId: "c1",
    result: { result: "Sunny." },
  });
  h.relay({ type: "audioDone" });
  assert.equal(h.seen.at(-1), "idle");
});

test("consult failures and cancellations become tool errors, never a hung turn", async () => {
  const h = createHarness({ "talk.client.toolCall": () => ({ runId: "run-2" }) });
  await h.session.open();
  h.relay({
    type: "toolCall",
    callId: "c2",
    name: "openclaw_agent_consult",
    args: '{"question":"x"}',
  });
  await h.settle();
  h.emit("chat", { runId: "run-2", state: "error", errorMessage: "model overloaded" });
  await h.settle();
  assert.deepEqual(
    h.requests.find((r) => r.method === "talk.session.submitToolResult")?.params.result,
    { error: "model overloaded" },
  );

  h.relay({ type: "toolCall", callId: "c3", name: "openclaw_agent_consult", args: {} });
  await h.settle();
  h.relay({ type: "toolCallCancelled", callId: "c3" });
  await h.settle();
  assert.ok(h.requests.some((r) => r.method === "chat.abort" && r.params.runId === "run-2"));
  assert.deepEqual(
    h.requests.filter((r) => r.method === "talk.session.submitToolResult").at(-1)?.params.result,
    { error: "OpenClaw tool call aborted" },
  );
});

test("control tool steers the active run", async () => {
  const h = createHarness({ "talk.session.steer": () => ({ status: "queued" }) });
  await h.session.open();
  h.relay({
    type: "toolCall",
    callId: "c4",
    name: "openclaw_agent_control",
    args: { text: "cancel that", mode: "cancel" },
  });
  await h.settle();
  assert.deepEqual(h.requests.find((r) => r.method === "talk.session.steer")?.params, {
    sessionId: "relay-1",
    sessionKey: "agent:main:host-talk:test",
    text: "cancel that",
    mode: "cancel",
  });
  assert.deepEqual(
    h.requests.find((r) => r.method === "talk.session.submitToolResult")?.params.result,
    { result: { status: "queued" } },
  );
});

test("drops mic frames when the link is saturated and after close", async () => {
  let release: (() => void) | undefined;
  const h = createHarness({
    "talk.session.appendAudio": () => new Promise<void>((resolve) => (release = resolve)),
  });
  await h.session.open();
  for (let i = 0; i < 20; i += 1) h.session.appendAudio(Buffer.alloc(960));
  assert.equal(h.requests.filter((r) => r.method === "talk.session.appendAudio").length, 8);
  release?.();
  await h.session.close();
  h.session.appendAudio(Buffer.alloc(960));
  assert.equal(h.requests.filter((r) => r.method === "talk.session.appendAudio").length, 8);
  assert.equal(h.requests.at(-1)?.method, "talk.session.close");
});

test("relay close is reported as lost exactly once", async () => {
  const h = createHarness();
  await h.session.open();
  h.relay({ type: "close", reason: "error" });
  h.relay({ type: "close", reason: "error" });
  assert.deepEqual(h.seen, ["lost:error"]);
});
