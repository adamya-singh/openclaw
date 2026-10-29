import { describe, expect, it, vi } from "vitest";
import {
  createTalkRealtimeRunControlOwner,
  isRealtimeVoiceAbortAll,
} from "./realtime-run-control.js";

function createOwner(supportsToolCalls?: boolean, hasActiveRun = true) {
  const prepare = vi.fn(() => async () => ({ ok: true }) as never);
  const owner = createTalkRealtimeRunControlOwner({
    controlSource: "transcript",
    supportsToolCalls,
    supportsAbortAll: true,
    hasActiveRun: () => hasActiveRun,
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

  it.each(["Abort.", "abort abort", "Okay, abort everything you're doing", "wait, ABORT"])(
    "treats %j as the stop-everything word",
    (text) => {
      expect(isRealtimeVoiceAbortAll(text)).toBe(true);
    },
  );

  it.each(["don't abort it", "do not abort", "about the board", "aborted mission files"])(
    "does not treat %j as the stop-everything word",
    (text) => {
      expect(isRealtimeVoiceAbortAll(text)).toBe(false);
    },
  );

  it("stops all chat work on abort even when no voice run is active", () => {
    const { owner, prepare } = createOwner(true, false);
    expect(owner.handleSpoken("abort")).toBe(true);
    expect(prepare).toHaveBeenCalledWith({ text: "abort", mode: "cancel", stopAll: true });
  });
});
