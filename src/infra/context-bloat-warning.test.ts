import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliveryContextFromSession: vi.fn(),
  normalizeMessageChannel: vi.fn((channel: string) => channel),
  getChannelPlugin: vi.fn(),
  deliverOutboundPayloads: vi.fn(async (_params: unknown) => []),
}));

vi.mock("../utils/delivery-context.js", () => ({
  deliveryContextFromSession: mocks.deliveryContextFromSession,
}));
vi.mock("../utils/message-channel.js", () => ({
  normalizeMessageChannel: mocks.normalizeMessageChannel,
}));
vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: mocks.getChannelPlugin,
}));
vi.mock("./outbound/deliver-runtime.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

const { deliverContextBloatWarning, exceedsContextBloatWarningThreshold } =
  await import("./context-bloat-warning.js");

function createParams(promptTokens: number) {
  return {
    cfg: {} as never,
    sessionKey: "agent:main:telegram:direct:12345",
    entry: { sessionId: "session-1", updatedAt: 1 } as never,
    promptTokens,
  };
}

describe("deliverContextBloatWarning", () => {
  beforeEach(() => {
    mocks.deliveryContextFromSession.mockReset().mockReturnValue({
      channel: "telegram",
      to: "12345",
      accountId: "alerts",
      threadId: 99,
    });
    mocks.normalizeMessageChannel.mockClear();
    mocks.getChannelPlugin.mockReset().mockReturnValue({
      commands: {
        buildContextBloatWarningChannelData: vi.fn(() => ({
          telegram: { buttons: [[{ text: "Reset context", callback_data: "tgcmd:/reset" }]] },
        })),
      },
    });
    mocks.deliverOutboundPayloads.mockReset().mockResolvedValue([]);
  });

  it("uses a strict 100k threshold", () => {
    expect(exceedsContextBloatWarningThreshold(100_000)).toBe(false);
    expect(exceedsContextBloatWarningThreshold(100_001)).toBe(true);
  });

  it("delivers an out-of-band Telegram warning with channel action data", async () => {
    await deliverContextBloatWarning(createParams(100_001));

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "12345",
        accountId: "alerts",
        threadId: 99,
        payloads: [
          expect.objectContaining({
            text: expect.stringContaining("100,001 prompt tokens"),
            channelData: expect.objectContaining({ telegram: expect.any(Object) }),
          }),
        ],
      }),
    );
    const deliveredParams = mocks.deliverOutboundPayloads.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(deliveredParams).not.toHaveProperty("mirror");
  });

  it("falls back to command instructions when Telegram buttons are unavailable", async () => {
    mocks.getChannelPlugin.mockReturnValueOnce({
      commands: { buildContextBloatWarningChannelData: vi.fn(() => null) },
    });

    await deliverContextBloatWarning(createParams(150_000));

    const deliveredParams = mocks.deliverOutboundPayloads.mock.calls[0]?.[0] as {
      payloads: Array<{ text?: string; channelData?: Record<string, unknown> }>;
    };
    const payload = deliveredParams.payloads[0];
    expect(payload).not.toHaveProperty("channelData");
    expect(payload.text).toContain("/reset");
    expect(payload.text).toContain("/compact");
  });

  it("does not deliver at threshold or without a remembered Telegram route", async () => {
    await deliverContextBloatWarning(createParams(100_000));
    mocks.deliveryContextFromSession.mockReturnValueOnce({ channel: "slack", to: "room-1" });
    await deliverContextBloatWarning(createParams(120_000));

    expect(mocks.deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("does not reject the run when warning delivery fails", async () => {
    mocks.deliverOutboundPayloads.mockRejectedValueOnce(new Error("send failed"));

    await expect(deliverContextBloatWarning(createParams(120_000))).resolves.toBeUndefined();
  });
});
