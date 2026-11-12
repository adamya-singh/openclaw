import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildCardIndex,
  buildHint,
  chooseOffer,
  isConversationalTurn,
  mergeCards,
  readableRequest,
  replyUsesCard,
  resolveGoodAdviceSettings,
  type AdviceCard,
  type DayState,
} from "./good-advice.ts";
import register from "./index.ts";

const settings = resolveGoodAdviceSettings(undefined);
const interview: AdviceCard = {
  id: "1",
  author: "gabriel1",
  quote: 'never say "i can work on anything you want me to" in an interview',
  triggers: ["interview", "recruiter screen", "what should i know beforehand"],
  daily: false,
};
const walk: AdviceCard = {
  id: "2",
  author: "tunguz",
  quote: "Go for a walk. Go for a walk. Go for a walk.",
  triggers: ["stuck", "cant focus"],
  daily: true,
};
const index = buildCardIndex([interview, walk]);
const freshDay = (over: Partial<DayState> = {}): DayState => ({
  dailyUsed: false,
  dailyOffers: 0,
  matchedUsed: 0,
  sessionsUsed: new Set(),
  blockedCards: new Set(),
  ...over,
});
const offerFor = (message: string, state = freshDay()) =>
  chooseOffer({
    index,
    message,
    sessionKey: "agent:main:main",
    date: "2026-11-11",
    state,
    settings,
  });

test("settings fall back to defaults for missing or invalid config", () => {
  assert.equal(settings.folderName, "Good advice");
  assert.equal(resolveGoodAdviceSettings({ maxDailyOffers: 0 }).maxDailyOffers, 0);
  assert.equal(
    resolveGoodAdviceSettings({ cooldownDays: "x", matchThreshold: 0 }).cooldownDays,
    30,
  );
  assert.equal(resolveGoodAdviceSettings({ journalUrl: "http://j:1/" }).journalUrl, "http://j:1");
});

test("only conversational sessions get advice", () => {
  const cases: Array<[string, string | undefined, boolean]> = [
    ["agent:main:main", "user", true],
    ["agent:main:dashboard:abc", undefined, true],
    ["agent:main:host-talk:ubuntu-laptop", "user", true],
    ["agent:main:main", "heartbeat", false],
    ["agent:main:cron:abc:run:1", "cron", false],
    ["agent:main:main:heartbeat", "user", false],
    ["agent:main:journal-chat-3", "user", false],
    ["agent:main:explicit:research", "user", false],
  ];
  for (const [sessionKey, trigger, expected] of cases) {
    assert.equal(isConversationalTurn({ sessionKey, trigger }), expected, sessionKey);
  }
  assert.equal(isConversationalTurn({}), false);
});

test("badly timed and non-human messages get no advice", () => {
  const quiet = [
    undefined,
    "yes apply those",
    "[OpenClaw exec completion] Disable automatic completion turns",
    "Should I take 1000mg Tylenol or 2 dayquils now I had a fever of 103.5",
    "do my data in context quiz now hurry up and get 100",
    "the quiz is due in 3 min please open it",
    "x ".repeat(900),
  ];
  for (const message of quiet) {
    assert.equal(readableRequest(message), undefined, String(message).slice(0, 40));
  }
  assert.equal(
    readableRequest(
      "What should I know before the interview? Context: The person said this aloud in a live voice conversation. Spoken style.",
    ),
    "What should I know before the interview?",
  );
});

test("a strong trigger match offers matched advice; otherwise the daily remark", () => {
  const matched = offerFor("my recruiter screen is tomorrow, what should i know beforehand");
  assert.equal(matched?.mode, "matched");
  assert.deepEqual(matched?.cards, [interview]);

  const daily = offerFor("list my next five due assignments please");
  assert.equal(daily?.mode, "daily");
  assert.deepEqual(daily?.cards, [walk]);
});

test("caps: one matched per conversation, a daily limit, and no repeats", () => {
  const message = "i have an interview with the recruiter screen tomorrow morning";
  const sameSession = offerFor(message, freshDay({ sessionsUsed: new Set(["agent:main:main"]) }));
  assert.equal(sameSession?.mode, "daily");
  const dayFull = offerFor(message, freshDay({ matchedUsed: settings.maxMatchedPerDay }));
  assert.equal(dayFull?.mode, "daily");
  const cooling = offerFor(message, freshDay({ blockedCards: new Set(["1"]), dailyUsed: true }));
  assert.equal(cooling, undefined);
  const spent = offerFor("list my next five due assignments please", freshDay({ dailyUsed: true }));
  assert.equal(spent, undefined);
  const gaveUp = offerFor(
    "list my next five due assignments please",
    freshDay({ dailyOffers: settings.maxDailyOffers }),
  );
  assert.equal(gaveUp, undefined);
});

test("hint names the folder, quotes the cards and tells the model it may decline", () => {
  const hint = buildHint(
    { mode: "matched", cards: [interview] },
    { folderName: "Good advice", voice: true },
  );
  assert.match(hint, /^\[good-advice\]/);
  assert.match(hint, /"Good advice" bookmarks/);
  assert.match(hint, /\(@gabriel1\)/);
  assert.match(hint, /ignore this note completely/);
  assert.match(hint, /spoken aloud/);
});

test("a reply counts as using a card only when it quotes it closely", () => {
  assert.equal(
    replyUsesCard(
      'One from your saved advice: never say "I can work on anything you want me to" in an interview.',
      interview,
    ),
    true,
  );
  assert.equal(
    replyUsesCard("Your interview is at 1pm. Bring anything you want to ask.", interview),
    false,
  );
});

test("curated cards win; uncurated short text posts become plain cards", () => {
  const cards = mergeCards(
    [
      {
        id: "1",
        use: true,
        quote: "Do the damn problems.",
        triggers: ["practice problems"],
        daily: false,
      },
      { id: "2", use: false },
    ],
    [
      { id: "1", author: "justinskycak", text: "Do the damn problems. And more.", hasMedia: false },
      {
        id: "2",
        author: "x",
        text: "A politics take that is long enough to pass the length check.",
        hasMedia: false,
      },
      {
        id: "3",
        author: "paulg",
        text: "Cultivate a habit of impatience about the things you most want to do. https://t.co/x",
        hasMedia: false,
      },
      {
        id: "4",
        author: "y",
        text: "Steve Jobs on asking people for help, a very good watch",
        hasMedia: true,
      },
    ],
  );
  assert.deepEqual(
    cards.map((card) => [card.id, card.author]),
    [
      ["1", "justinskycak"],
      ["3", "paulg"],
    ],
  );
  assert.equal(
    cards[1].quote,
    "Cultivate a habit of impatience about the things you most want to do.",
  );
  assert.ok(cards[1].triggers.includes("impatience"));
});

test("plugin offers once, records the used quote, and stays quiet afterwards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "good-advice-"));
  const cardsPath = join(dir, "cards.json");
  await writeFile(cardsPath, JSON.stringify({ cards: [{ id: "1", use: true, ...interview }] }));
  const rows = new Map<string, unknown>();
  const handlers: Record<string, (event: never, ctx: never) => Promise<unknown>> = {};
  register(
    {
      pluginConfig: { cardsPath, maxDailyOffers: 0 },
      runtime: {
        state: {
          openKeyedStore: () => ({
            register: async (key: string, value: unknown) => void rows.set(key, value),
            entries: async () => [...rows].map(([key, value]) => ({ key, value })),
          }),
        },
      },
      on: ((hook: string, handler: never) => {
        handlers[hook] = handler;
      }) as never,
    },
    { fetch: (async () => new Response("{}", { status: 503 })) as typeof fetch },
  );
  const ctx = { runId: "run-1", sessionKey: "agent:main:main", trigger: "user" } as never;
  const ask = () =>
    handlers.before_prompt_build(
      {
        prompt: "",
        currentUserMessage: "recruiter screen tomorrow, what should i know beforehand",
      } as never,
      ctx,
    ) as Promise<{ appendContext: string } | undefined>;

  try {
    // The first turn only starts the background card load.
    assert.equal(await ask(), undefined);
    let offered: { appendContext: string } | undefined;
    for (let i = 0; i < 20 && !offered; i += 1) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      offered = await ask();
    }
    assert.match(offered?.appendContext ?? "", /@gabriel1/);
    // The same card is not offered twice in a day.
    assert.equal(await ask(), undefined);
    assert.ok([...rows.keys()].some((key) => key.startsWith("day:")));

    // A reply that does not quote the card leaves the offer open for a later model call.
    await handlers.llm_output({ assistantTexts: ["Your screen is at 1pm."] } as never, ctx);
    assert.equal(rows.has("card:1"), false);
    await handlers.llm_output(
      {
        runId: "run-1",
        assistantTexts: ['never say "i can work on anything you want me to" in an interview'],
      } as never,
      ctx,
    );
    assert.ok(rows.has("card:1"));
    const day = [...rows].find(([key]) => key.startsWith("day:"))?.[1] as {
      matchedUsed: number;
      sessions: string[];
    };
    assert.equal(day.matchedUsed, 1);
    assert.deepEqual(day.sessions, ["agent:main:main"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
