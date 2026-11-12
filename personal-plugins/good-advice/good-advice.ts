// Pure decision logic for the good-advice plugin: which saved advice (if any) to offer the model
// for one user message, how to phrase the offer, and whether a reply actually used it.

export type AdviceCard = {
  id: string;
  author: string;
  quote: string;
  /** Lowercase words/phrases the user would type when this advice is relevant. */
  triggers: string[];
  /** Also fine as a light unprompted remark on an ordinary day. */
  daily: boolean;
};

/** One entry of the curated cards file; `use: false` keeps a saved post out for good. */
export type CuratedCard = {
  id: string;
  use: boolean;
  author?: string;
  quote?: string;
  triggers?: string[];
  daily?: boolean;
};

export type SavedPost = { id: string; author: string; text: string; hasMedia: boolean };

export type GoodAdviceSettings = {
  journalUrl: string;
  folderName: string;
  cardsPath: string;
  /** Minimum trigger score for advice matched to the current message. */
  matchThreshold: number;
  /** Matched advice allowed across all conversations per day. */
  maxMatchedPerDay: number;
  /** Times per day the unprompted remark may be offered before giving up for the day. */
  maxDailyOffers: number;
  /** Days before a used quote may come back. */
  cooldownDays: number;
};

export type Offer = { mode: "matched" | "daily"; cards: AdviceCard[] };

export type DayState = {
  dailyUsed: boolean;
  dailyOffers: number;
  matchedUsed: number;
  /** Session keys that already got matched advice today. */
  sessionsUsed: ReadonlySet<string>;
  /** Card ids offered today or still cooling down after use. */
  blockedCards: ReadonlySet<string>;
};

const DEFAULT_SETTINGS: GoodAdviceSettings = {
  journalUrl: "http://127.0.0.1:3000",
  folderName: "Good advice",
  cardsPath: "~/.openclaw/good-advice/cards.json",
  matchThreshold: 2.5,
  maxMatchedPerDay: 3,
  maxDailyOffers: 3,
  cooldownDays: 30,
};

export function resolveGoodAdviceSettings(
  raw: Record<string, unknown> | undefined,
): GoodAdviceSettings {
  const text = (key: keyof GoodAdviceSettings) => {
    const value = raw?.[key];
    return typeof value === "string" && value.trim()
      ? value.trim()
      : (DEFAULT_SETTINGS[key] as string);
  };
  const count = (key: keyof GoodAdviceSettings, min: number) => {
    const value = raw?.[key];
    return typeof value === "number" && Number.isFinite(value) && value >= min
      ? value
      : (DEFAULT_SETTINGS[key] as number);
  };
  return {
    journalUrl: text("journalUrl").replace(/\/+$/, ""),
    folderName: text("folderName"),
    cardsPath: text("cardsPath"),
    matchThreshold: count("matchThreshold", 0.5),
    maxMatchedPerDay: Math.floor(count("maxMatchedPerDay", 0)),
    maxDailyOffers: Math.floor(count("maxDailyOffers", 0)),
    cooldownDays: Math.floor(count("cooldownDays", 1)),
  };
}

/** Lowercase words only: "Don't  STOP!" -> "dont stop". */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Machine-run sessions never get advice: nobody reads those replies as conversation.
const MACHINE_SESSION = /(:cron|heartbeat|:subagent|:explicit:|:journal-|action-cards|:acp)/;

export function isConversationalTurn(ctx: { sessionKey?: string; trigger?: string }): boolean {
  if (!ctx.sessionKey || MACHINE_SESSION.test(ctx.sessionKey)) {
    return false;
  }
  return ctx.trigger === undefined || ctx.trigger === "user";
}

export function isVoiceTurn(sessionKey: string | undefined, message: string): boolean {
  return Boolean(sessionKey?.includes("host-talk")) || VOICE_CONTEXT.test(message);
}

const VOICE_CONTEXT = /\s*Context: The person said this aloud[\s\S]*$/;
const SYSTEM_MESSAGE =
  /^(\[OpenClaw|\[System|\[cron|\[Queued|System:|Exec (completed|failed|denied)|Read HEARTBEAT|Continue the current task|Pre-compaction|A subagent|\/)/i;
// Health, urgency and venting: advice here reads as tone-deaf, so the plugin stays out entirely.
const BAD_TIMING = new RegExp(
  [
    "\\b(fever|tylenol|ibuprofen|nyquil|dayquil|\\d+ ?mg|throw(ing)? up|nauseous|sick|hospital|pain)\\b",
    "\\b(hurry|asap|right now|im late|running late|rushing)\\b",
    "\\b(due|left) in \\d+ ?(min|mins|minutes)\\b",
    "\\b(therapist|panic|crying|hate myself|worthless)\\b",
  ].join("|"),
  "i",
);

/** The user's own words for this turn, or undefined when the turn should get no advice at all. */
export function readableRequest(raw: string | undefined): string | undefined {
  const message = (raw ?? "").replace(VOICE_CONTEXT, "").trim();
  if (!message || message.length > 1500 || SYSTEM_MESSAGE.test(message)) {
    return undefined;
  }
  if (message.split(/\s+/).length < 4 || BAD_TIMING.test(message)) {
    return undefined;
  }
  return message;
}

export type CardIndex = {
  cards: AdviceCard[];
  /** Per card: normalized trigger and its weight (rarer and longer triggers count more). */
  weights: Array<Array<{ trigger: string; weight: number }>>;
};

export function buildCardIndex(cards: AdviceCard[]): CardIndex {
  const normalized = cards.map((card) => [
    ...new Set(card.triggers.map(normalizeText).filter((trigger) => trigger.length >= 3)),
  ]);
  const cardsPerTrigger = new Map<string, number>();
  for (const triggers of normalized) {
    for (const trigger of triggers) {
      cardsPerTrigger.set(trigger, (cardsPerTrigger.get(trigger) ?? 0) + 1);
    }
  }
  const weights = normalized.map((triggers) =>
    triggers.map((trigger) => ({
      trigger,
      weight: (trigger.includes(" ") ? 3 : 1.5) / Math.sqrt(cardsPerTrigger.get(trigger) ?? 1),
    })),
  );
  return { cards, weights };
}

export type ScoredCard = { card: AdviceCard; score: number; hits: number };

/**
 * Scores each card against the message. `earlier` is what the user said just before in the same
 * conversation: it adds to a card's score only when the current message hits that card too, so
 * "what should I know beforehand" right after "my interview is tomorrow" still finds interview advice.
 */
export function scoreCards(index: CardIndex, message: string, earlier = ""): ScoredCard[] {
  const current = ` ${normalizeText(message)} `;
  const before = ` ${normalizeText(earlier)} `;
  const within = (text: string, trigger: string) =>
    text.includes(` ${trigger} `) || text.includes(` ${trigger}s `);
  const scored: ScoredCard[] = [];
  index.weights.forEach((triggers, i) => {
    let score = 0;
    let hits = 0;
    let currentHits = 0;
    for (const { trigger, weight } of triggers) {
      const now = within(current, trigger);
      if (now || within(before, trigger)) {
        score += weight;
        hits += 1;
        currentHits += now ? 1 : 0;
      }
    }
    if (currentHits > 0) {
      scored.push({ card: index.cards[i], score, hits });
    }
  });
  return scored.toSorted((a, b) => b.score - a.score);
}

/** Stable per-day order so the same ordinary day offers the same remark candidates. */
function dayRank(cardId: string, date: string): number {
  let hash = 2166136261;
  for (const char of `${date}:${cardId}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  }
  return hash >>> 0;
}

export function chooseOffer(params: {
  index: CardIndex;
  message: string;
  /** The user's previous message in this conversation, when recent. */
  earlier?: string;
  sessionKey: string;
  date: string;
  state: DayState;
  settings: GoodAdviceSettings;
}): Offer | undefined {
  const { index, message, sessionKey, date, state, settings } = params;
  const open = (card: AdviceCard) => !state.blockedCards.has(card.id);
  const scored = scoreCards(index, message, params.earlier).filter(({ card }) => open(card));

  // One trigger alone ("regression methods", "due tonight") is topic overlap, not a moment for
  // advice: two separate triggers must agree.
  const strong = scored.filter(({ score, hits }) => hits >= 2 && score >= settings.matchThreshold);
  if (
    strong.length > 0 &&
    state.matchedUsed < settings.maxMatchedPerDay &&
    !state.sessionsUsed.has(sessionKey)
  ) {
    return { mode: "matched", cards: strong.slice(0, 2).map(({ card }) => card) };
  }

  if (state.dailyUsed || state.dailyOffers >= settings.maxDailyOffers) {
    return undefined;
  }
  // Loosely related cards first, then the day's stable shuffle.
  const related = scored.filter(({ card }) => card.daily).map(({ card }) => card);
  const rest = index.cards
    .filter((card) => card.daily && open(card) && !related.includes(card))
    .toSorted((a, b) => dayRank(a.id, date) - dayRank(b.id, date));
  const cards = [...related, ...rest].slice(0, 3);
  return cards.length > 0 ? { mode: "daily", cards } : undefined;
}

export function buildHint(offer: Offer, opts: { folderName: string; voice: boolean }): string {
  const lines = offer.cards.map((card) => `- "${card.quote}" (@${card.author})`);
  const intro =
    offer.mode === "matched"
      ? `Saved advice from the user's "${opts.folderName}" bookmarks that may fit what they just said:`
      : `The user likes hearing one line a day from their "${opts.folderName}" bookmarks. Today's options:`;
  const rules = [
    "If one of these fits this reply naturally, work it into a single sentence in your own voice, quote it accurately, and say it comes from their saved advice.",
    "Use at most one. Answer their actual request first; the line is a brief aside, never the point of the reply.",
    "If none fits, or it would sound preachy, forced or badly timed, ignore this note completely and do not mention it.",
    ...(opts.voice ? ["This reply is spoken aloud: keep the aside to a short clause."] : []),
  ];
  return [`[good-advice] ${intro}`, ...lines, ...rules].join("\n");
}

/** True when the reply quotes the card closely enough to count as used. */
export function replyUsesCard(reply: string, card: AdviceCard): boolean {
  const text = ` ${normalizeText(reply)} `;
  const words = [
    ...new Set(
      normalizeText(card.quote)
        .split(" ")
        .filter((word) => word.length >= 4),
    ),
  ];
  if (words.length === 0) {
    return text.includes(` ${normalizeText(card.author)} `);
  }
  const hits = words.filter((word) => text.includes(` ${word} `)).length;
  return hits >= Math.min(words.length, 4) && hits / words.length >= 0.6;
}

const AUTO_STOPWORDS = new Set(
  "about after again also always because been before being between both cannot could does doing dont every from have having here into just like more most much must never only other over people really should some such than that their them then there these they thing things this those through very want what when where which while will with without would your youre yourself".split(
    " ",
  ),
);

/**
 * Cards for the folder: curated entries win; a saved post with no curated entry yet gets a plain
 * card from its own text so new saves take part before anyone writes triggers for them.
 */
export function mergeCards(curated: CuratedCard[], posts: SavedPost[]): AdviceCard[] {
  const curatedById = new Map(curated.map((card) => [card.id, card]));
  const authorById = new Map(posts.map((post) => [post.id, post.author]));
  const cards: AdviceCard[] = [];
  for (const card of curated) {
    if (card.use && card.quote?.trim()) {
      cards.push({
        id: card.id,
        author: card.author ?? authorById.get(card.id) ?? "unknown",
        quote: card.quote.trim(),
        triggers: card.triggers ?? [],
        daily: card.daily ?? false,
      });
    }
  }
  for (const post of posts) {
    if (curatedById.has(post.id)) {
      continue;
    }
    const quote = post.text
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    // Short text-only posts stand on their own; teasers for media and long threads do not.
    if (post.hasMedia || quote.length < 40 || quote.length > 220) {
      continue;
    }
    const triggers = [
      ...new Set(
        normalizeText(quote)
          .split(" ")
          .filter((word) => word.length >= 6 && !AUTO_STOPWORDS.has(word)),
      ),
    ].slice(0, 8);
    cards.push({ id: post.id, author: post.author, quote, triggers, daily: quote.length <= 140 });
  }
  return cards;
}

export function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
