import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { HostTalkService } from "./host-talk-service.ts";
import type { GatewayLink } from "./talk-relay-session.ts";
import type { WorkerInbound } from "./worker-protocol.ts";

function createHarness(options: { failCreate?: boolean } = {}) {
  const listeners = new Set<(event: { event: string; payload?: unknown }) => void>();
  const requests: Array<{ method: string; params: any }> = [];
  const worker: WorkerInbound[] = [];
  const link: GatewayLink = {
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "talk.session.create") {
        if (options.failCreate) throw new Error("Realtime voice provider is not configured");
        return { sessionId: "relay-1" } as never;
      }
      return {} as never;
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const service = new HostTalkService({
    link,
    sessionKey: "agent:main:host-talk:test",
    sendToWorker: (message) => {
      worker.push(message);
      // The fake worker reports playback drained immediately.
      if (message.t === "drain")
        queueMicrotask(() => service.handleWorkerMessage({ t: "drained", id: message.id }));
    },
    log: () => {},
  });
  const relay = (payload: Record<string, unknown>) =>
    listeners.forEach((l) =>
      l({ event: "talk.event", payload: { relaySessionId: "relay-1", ...payload } }),
    );
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const methods = () => requests.map((r) => r.method);
  return { service, worker, requests, relay, flush, methods };
}

test("full one-shot cycle: wake, pre-roll, question, answer, silence, back to listening", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const h = createHarness();
    h.service.handleWorkerMessage({ t: "pcm", pcm24k: Buffer.alloc(960) });
    assert.deepEqual(h.methods(), [], "no mic audio reaches the Gateway before a wake");

    h.service.handleWorkerMessage({ t: "wake", phrase: "hey openclaw" });
    await h.flush();
    assert.equal(h.worker[0]?.t, "play", "wake chime plays first");
    assert.equal(h.requests[0]?.method, "talk.session.create");
    assert.equal(h.requests[0]?.params.sessionKey, "agent:main:host-talk:test");

    h.relay({ type: "ready" });
    assert.deepEqual(h.worker.at(-1), { t: "stream", on: true, flushPreroll: true });
    h.service.handleWorkerMessage({ t: "pcm", pcm24k: Buffer.alloc(960) });
    assert.equal(h.methods().at(-1), "talk.session.appendAudio");

    h.relay({ type: "transcript", role: "user", text: "what time is it", final: true });
    h.relay({ type: "audio", audioBase64: Buffer.alloc(4800).toString("base64") });
    assert.ok(
      h.worker.some((m) => m.t === "stream" && !m.on),
      "mic stops while the assistant speaks",
    );
    h.relay({ type: "mark", markName: "m1" });
    h.relay({ type: "audioDone" });
    await h.flush();
    assert.ok(
      h.methods().includes("talk.session.acknowledgeMark"),
      "mark acked after playback drained",
    );
    assert.deepEqual(h.service.snapshot().state, {
      kind: "conversing",
      mode: "one-shot",
      phase: "awaiting-user",
      answered: true,
    });

    mock.timers.tick(7_000);
    await h.flush();
    assert.deepEqual(h.service.snapshot().state, { kind: "listening" });
    assert.equal(h.service.snapshot().lastOutcome?.outcome, "answered");
    assert.equal(h.methods().at(-1), "talk.session.close");
    assert.deepEqual(h.worker.filter((m) => m.t === "stream").at(-1), {
      t: "stream",
      on: false,
      flushPreroll: undefined,
    });
  } finally {
    mock.timers.reset();
  }
});

test("a session that cannot start ends with an error tone and returns to listening", async () => {
  const h = createHarness({ failCreate: true });
  h.service.handleWorkerMessage({ t: "wake", phrase: "openclaw" });
  await h.flush();
  assert.deepEqual(h.service.snapshot().state, { kind: "listening" });
  assert.equal(h.service.snapshot().lastOutcome?.outcome, "session-create-failed");
  assert.equal(h.worker.filter((m) => m.t === "play").length, 2, "wake chime then error tone");
});

test("events from a closed session cannot drive the next conversation", async () => {
  const h = createHarness();
  h.service.handleWorkerMessage({ t: "wake", phrase: "openclaw" });
  await h.flush();
  h.relay({ type: "ready" });
  h.relay({ type: "close", reason: "error" });
  assert.equal(h.service.snapshot().lastOutcome?.outcome, "session-lost");
  h.relay({ type: "audio", audioBase64: Buffer.alloc(480).toString("base64") });
  assert.deepEqual(h.service.snapshot().state, { kind: "listening" });
});
