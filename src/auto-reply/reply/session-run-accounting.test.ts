import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  persistSessionUsageUpdate: vi.fn(),
}));

vi.mock("./session-usage.js", () => ({
  persistSessionUsageUpdate: mocks.persistSessionUsageUpdate,
}));

const { persistRunSessionUsage } = await import("./session-run-accounting.js");

describe("persistRunSessionUsage context warning candidate", () => {
  beforeEach(() => {
    mocks.persistSessionUsageUpdate.mockReset().mockResolvedValue({
      sessionId: "session-1",
      updatedAt: 1,
    });
  });

  it("returns the fresh prompt snapshot and persisted entry for deferred delivery", async () => {
    const cfg = {} as never;
    const candidate = await persistRunSessionUsage({
      cfg,
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:main:main",
      promptTokens: 100_001,
    });

    expect(candidate).toEqual({
      entry: { sessionId: "session-1", updatedAt: 1 },
      promptTokens: 100_001,
    });
  });

  it("falls back to fresh last-call usage when promptTokens is omitted", async () => {
    const candidate = await persistRunSessionUsage({
      cfg: {} as never,
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:main:main",
      lastCallUsage: { input: 40_000, cacheRead: 60_001 },
    });

    expect(candidate).toEqual(expect.objectContaining({ promptTokens: 100_001 }));
  });
});
