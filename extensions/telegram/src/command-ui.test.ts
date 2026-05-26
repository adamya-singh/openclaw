import { describe, expect, it } from "vitest";
import {
  buildCommandsPaginationKeyboard,
  buildTelegramContextBloatWarningChannelData,
} from "./command-ui.js";

describe("telegram command ui", () => {
  it("adds agent id to command pagination callback data when provided", () => {
    const keyboard = buildCommandsPaginationKeyboard(2, 3, "agent-main");
    expect(keyboard[0]).toEqual([
      { text: "◀ Prev", callback_data: "commands_page_1:agent-main" },
      { text: "2/3", callback_data: "commands_page_noop:agent-main" },
      { text: "Next ▶", callback_data: "commands_page_3:agent-main" },
    ]);
  });

  it("builds native reset and compact callbacks for permitted inline buttons", () => {
    expect(
      buildTelegramContextBloatWarningChannelData({
        cfg: {
          channels: { telegram: { capabilities: { inlineButtons: "all" } } },
        } as never,
        to: "12345",
      }),
    ).toEqual({
      telegram: {
        buttons: [
          [
            { text: "Reset context", callback_data: "tgcmd:/reset", style: "danger" },
            { text: "Compact context", callback_data: "tgcmd:/compact", style: "primary" },
          ],
        ],
      },
    });
  });

  it("omits buttons when inline button scope excludes the target", () => {
    expect(
      buildTelegramContextBloatWarningChannelData({
        cfg: {
          channels: { telegram: { capabilities: { inlineButtons: "dm" } } },
        } as never,
        to: "-10012345",
      }),
    ).toBeNull();
  });
});
