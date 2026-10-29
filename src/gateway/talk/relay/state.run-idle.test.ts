import { afterEach, describe, expect, it } from "vitest";
import {
  deleteRelayAgentRun,
  relaySessions,
  type RelaySession,
  waitForRelayAgentRunsIdle,
} from "./state.js";

function createRelay(): RelaySession {
  // Only the fields run-idle tracking reads; the rest of the relay is irrelevant here.
  const session = {
    id: "relay-idle",
    activeAgentRuns: new Map([["run-1", { runId: "run-1", sessionKey: "main" }]]),
    activeAgentToolCalls: new Map(),
    context: { chatAbortControllers: new Map([["run-1", {}]]) },
  } as unknown as RelaySession;
  relaySessions.set(session.id, session);
  return session;
}

describe("relay agent run idle wait", () => {
  afterEach(() => relaySessions.clear());

  it("holds until the relay's last agent run is released", async () => {
    const session = createRelay();
    let settled = false;
    const waiting = waitForRelayAgentRunsIdle(session, 60_000).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    deleteRelayAgentRun(session, "run-1");
    await waiting;
    expect(settled).toBe(true);
  });

  it("returns at once when no run is active", async () => {
    const session = createRelay();
    deleteRelayAgentRun(session, "run-1");
    await expect(waitForRelayAgentRunsIdle(session, 60_000)).resolves.toBeUndefined();
  });
});
