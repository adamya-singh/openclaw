import { describe, expect, it } from "vitest";
import { shouldRetryBrowserStartGatewayError } from "./browser-cli-manage.js";

describe("shouldRetryBrowserStartGatewayError", () => {
  it.each([
    "gateway closed (1006 abnormal closure (no close frame)): no close reason",
    "connect ECONNREFUSED 127.0.0.1:18789",
    "TypeError: fetch failed",
  ])("retries browser start for transient gateway startup error: %s", (message) => {
    expect(shouldRetryBrowserStartGatewayError(new Error(message))).toBe(true);
  });

  it("does not retry browser start for unrelated errors", () => {
    expect(shouldRetryBrowserStartGatewayError(new Error("gateway closed (1008): unauthorized"))).toBe(
      false,
    );
  });
});
