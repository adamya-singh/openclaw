import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendContextWarning,
  decideContextWarning,
  resolveContextWarningSettings,
} from "./context-warning.ts";
import register from "./index.ts";

const settings = { thresholdTokens: 100_000, channels: ["telegram"] };

test("settings fall back to defaults for missing or invalid config", () => {
  assert.deepEqual(resolveContextWarningSettings(undefined), settings);
  assert.deepEqual(
    resolveContextWarningSettings({ thresholdTokens: "many", channels: "telegram" }),
    settings,
  );
  assert.deepEqual(
    resolveContextWarningSettings({ thresholdTokens: 50_000.9, channels: ["telegram", "discord"] }),
    { thresholdTokens: 50_000, channels: ["telegram", "discord"] },
  );
});

test("decision table", () => {
  const base = { kind: "final", channel: "telegram", sessionKey: "agent:main:main" };
  const cases: Array<[string, Parameters<typeof decideContextWarning>[0], string]> = [
    ["over threshold warns", { ...base, contextUsedTokens: 100_001 }, "warn-if-first"],
    ["at threshold re-arms", { ...base, contextUsedTokens: 100_000 }, "rearm"],
    ["under threshold re-arms", { ...base, contextUsedTokens: 12_000 }, "rearm"],
    ["streamed block is ignored", { ...base, kind: "block", contextUsedTokens: 500_000 }, "ignore"],
    [
      "other channel is ignored",
      { ...base, channel: "discord", contextUsedTokens: 500_000 },
      "ignore",
    ],
    ["replay without usage is ignored", { ...base }, "ignore"],
    [
      "missing session is ignored",
      { ...base, sessionKey: undefined, contextUsedTokens: 500_000 },
      "ignore",
    ],
  ];
  for (const [name, event, expected] of cases) {
    assert.equal(decideContextWarning(event, settings).action, expected, name);
  }
});

test("warning keeps the reply, its other fields, and existing presentation blocks", () => {
  const out = appendContextWarning(
    {
      text: "Here is your answer.",
      mediaUrl: "https://example.com/a.png",
      presentation: { blocks: [{ type: "text", text: "existing" }] },
    },
    123_456,
    100_000,
  );

  assert.match(out.text ?? "", /^Here is your answer\.\n\n⚠️ Context warning: .*123k.*100k/s);
  assert.equal(out.mediaUrl, "https://example.com/a.png");
  assert.equal(out.presentation?.blocks?.length, 2);
  assert.deepEqual(out.presentation?.blocks?.[1], {
    type: "buttons",
    buttons: [
      { label: "Reset context", style: "danger", action: { type: "command", command: "/reset" } },
      {
        label: "Compact context",
        style: "primary",
        action: { type: "command", command: "/compact" },
      },
    ],
  });
});

function createFakeApi(options: { failStore?: boolean } = {}) {
  const warned = new Set<string>();
  let handler: ((event: never) => Promise<{ payload: { text?: string } } | undefined>) | undefined;
  const warnings: string[] = [];
  const api = {
    pluginConfig: {},
    logger: { warn: (message: string) => warnings.push(message) },
    runtime: {
      state: {
        openKeyedStore: () => ({
          registerIfAbsent: async (key: string) => {
            if (options.failStore) {
              throw new Error("sqlite unavailable");
            }
            if (warned.has(key)) {
              return false;
            }
            warned.add(key);
            return true;
          },
          delete: async (key: string) => warned.delete(key),
        }),
      },
    },
    on: (_hook: string, registered: typeof handler) => {
      handler = registered;
    },
  };
  register(api as never);
  const send = (contextUsedTokens: number) =>
    handler!({
      payload: { text: "reply" },
      kind: "final",
      channel: "telegram",
      sessionKey: "agent:main:main",
      usageState: { contextUsedTokens },
    } as never);
  return { send, warnings };
}

test("warns once per overflow and again only after the context shrinks", async () => {
  const { send } = createFakeApi();

  assert.match((await send(150_000))?.payload.text ?? "", /Context warning/);
  assert.equal(await send(160_000), undefined, "second turn over the limit stays quiet");
  assert.equal(await send(20_000), undefined, "compacted turn re-arms silently");
  assert.match((await send(110_000))?.payload.text ?? "", /Context warning/);
});

test("a failing state store never blocks the reply", async () => {
  const { send, warnings } = createFakeApi({ failStore: true });

  assert.equal(await send(150_000), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /context-warning: skipped/);
});
