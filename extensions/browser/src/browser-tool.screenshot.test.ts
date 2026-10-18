import { describe, expect, it, vi } from "vitest";

const browserScreenshotAction = vi.hoisted(() => vi.fn());

// Keep the real param readers; isolate only browser I/O.
vi.mock("./browser-tool.runtime.js", async () => {
  const { readStringParam } = await vi.importActual<
    typeof import("openclaw/plugin-sdk/param-readers")
  >("openclaw/plugin-sdk/param-readers");
  return { browserScreenshotAction, readStringParam };
});

const { executeScreenshotAction } = await import("./browser-tool.screenshot.js");

describe("browser screenshot action", () => {
  it("rejects a path instead of reporting a file it never writes", async () => {
    await expect(
      executeScreenshotAction({
        input: { action: "screenshot", targetId: "tab-1", path: "/workspace/problem.png" },
        proxyRequest: null,
        onTabActivity: () => {},
      }),
    ).rejects.toThrow("path is not supported for action=screenshot");
    expect(browserScreenshotAction).not.toHaveBeenCalled();
  });
});
