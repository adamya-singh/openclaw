import { describe, expect, it, vi } from "vitest";
import { createTalkRealtimeRunControlOwner } from "./realtime-run-control.js";

function createOwner(supportsToolCalls?: boolean) {
  const prepare = vi.fn(() => async () => ({ ok: true }) as never);
  const owner = createTalkRealtimeRunControlOwner({
    controlSource: "transcript",
    supportsToolCalls,
    hasActiveRun: () => true,
    prepare,
    speak: vi.fn(),
    warn: vi.fn(),
  });
  return { owner, prepare };
}

describe("realtime Talk transcript run control", () => {
  it("leaves spoken steering to a tool-calling provider's control tool", () => {
    const { owner, prepare } = createOwner(true);
    expect(owner.handleSpoken("Actually, wait, check New York instead.")).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("steers from the transcript when the provider cannot call tools", () => {
    const { owner, prepare } = createOwner(false);
    expect(owner.handleSpoken("Actually, wait, check New York instead.")).toBe(true);
    expect(prepare).toHaveBeenCalledWith({
      text: "Actually, wait, check New York instead.",
      mode: "steer",
    });
  });

  it("still cancels from the transcript for a tool-calling provider", () => {
    const { owner, prepare } = createOwner(true);
    expect(owner.handleSpoken("cancel that")).toBe(true);
    expect(prepare).toHaveBeenCalledWith({ text: "cancel that", mode: "cancel" });
  });
});
