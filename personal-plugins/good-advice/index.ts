import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  buildCardIndex,
  buildHint,
  chooseOffer,
  isConversationalTurn,
  isVoiceTurn,
  localDate,
  mergeCards,
  readableRequest,
  replyUsesCard,
  resolveGoodAdviceSettings,
  type CardIndex,
  type CuratedCard,
  type Offer,
  type SavedPost,
} from "./good-advice.ts";

// Minimal local view of the OpenClaw plugin API (path-loaded plugins stay dependency-free).
type DayRecord = {
  dailyUsed: boolean;
  dailyOffers: number;
  matchedUsed: number;
  sessions: string[];
  offered: string[];
};
type StoreValue = DayRecord | { usedAt: number };
type Store = {
  register(key: string, value: StoreValue, opts?: { ttlMs?: number }): Promise<void>;
  entries(): Promise<Array<{ key: string; value: StoreValue }>>;
};
type AgentCtx = { runId?: string; sessionKey?: string; trigger?: string };

type OpenClawPluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger?: { warn?: (message: string) => void; debug?: (message: string) => void };
  runtime: {
    state: { openKeyedStore: (options: { namespace: string; maxEntries: number }) => unknown };
  };
  on: {
    (
      hook: "before_prompt_build",
      handler: (
        event: { prompt: string; currentUserMessage?: string },
        ctx: AgentCtx,
      ) => Promise<{ appendContext: string } | undefined>,
    ): void;
    (
      hook: "llm_output",
      handler: (event: { assistantTexts: string[] }, ctx: AgentCtx) => Promise<void>,
    ): void;
  };
};

const DAY_MS = 86_400_000;
const CARD_REFRESH_MS = 6 * 60 * 60 * 1000;
const FOLLOW_UP_MS = 15 * 60 * 1000;
const PENDING_MS = 15 * 60 * 1000;
const MAX_PENDING = 50;
const emptyDay = (): DayRecord => ({
  dailyUsed: false,
  dailyOffers: 0,
  matchedUsed: 0,
  sessions: [],
  offered: [],
});

export default function register(api: OpenClawPluginApi, deps: { fetch?: typeof fetch } = {}) {
  const settings = resolveGoodAdviceSettings(api.pluginConfig);
  const fetcher = deps.fetch ?? fetch;
  const warn = (what: string, error: unknown) =>
    api.logger?.warn?.(`good-advice: ${what} (${String(error)})`);

  let store: Store | undefined;
  // Opened on first use: the state DB may not be ready while plugins register.
  const openStore = (): Store =>
    (store ??= api.runtime.state.openKeyedStore({
      namespace: "good-advice",
      maxEntries: 2000,
    }) as Store);

  // Today's counters and card cooldowns, read from the store once and written through after that.
  let loaded: Promise<void> | undefined;
  let date = "";
  let day = emptyDay();
  const cooldownUntil = new Map<string, number>();
  const loadState = () =>
    (loaded ??= (async () => {
      for (const { key, value } of await openStore().entries()) {
        if (key.startsWith("card:") && "usedAt" in value) {
          cooldownUntil.set(key.slice(5), value.usedAt + settings.cooldownDays * DAY_MS);
        } else if (key === `day:${localDate(new Date())}` && "sessions" in value) {
          date = key.slice(4);
          day = value;
        }
      }
    })());
  const rollDay = (now: Date) => {
    const today = localDate(now);
    if (today !== date) {
      date = today;
      day = emptyDay();
    }
  };
  const saveDay = () => openStore().register(`day:${date}`, day, { ttlMs: 3 * DAY_MS });

  // Cards are rebuilt at most every six hours, in the background; a turn never waits on the Journal.
  let index: CardIndex | undefined;
  let refreshedAt = 0;
  let refreshing = false;
  const refreshCards = async () => {
    const curated = await readCurated(settings.cardsPath);
    const posts = await fetchFolderPosts(settings, fetcher).catch((error) => {
      warn("Journal unreachable, using curated cards only", error);
      return [] as SavedPost[];
    });
    index = buildCardIndex(mergeCards(curated, posts));
    api.logger?.debug?.(`good-advice: ${index.cards.length} cards ready`);
  };
  const ensureCards = (now: number) => {
    if (refreshing || now - refreshedAt < CARD_REFRESH_MS) {
      return;
    }
    refreshing = true;
    refreshedAt = now;
    void refreshCards()
      .catch((error) => warn("could not load cards", error))
      .finally(() => {
        refreshing = false;
      });
  };

  // Offers waiting for their reply, by conversation. They expire by age instead of on agent_end:
  // the host fires llm_output and agent_end without ordering, so clearing there loses replies.
  const pending = new Map<string, { offer: Offer; sessionKey: string; at: number }>();
  // The user's last message per conversation, kept briefly so a short follow-up keeps its topic.
  const lastSaid = new Map<string, { text: string; at: number }>();

  api.on("before_prompt_build", async (event, ctx) => {
    try {
      if (!isConversationalTurn(ctx)) {
        return undefined;
      }
      const now = new Date();
      ensureCards(now.getTime());
      const message = readableRequest(event.currentUserMessage ?? event.prompt);
      if (!message || !index || !ctx.sessionKey) {
        return undefined;
      }
      const previous = lastSaid.get(ctx.sessionKey);
      if (lastSaid.size >= MAX_PENDING && !previous) {
        lastSaid.delete(lastSaid.keys().next().value as string);
      }
      lastSaid.set(ctx.sessionKey, { text: message, at: now.getTime() });
      await loadState();
      rollDay(now);
      const blockedCards = new Set(day.offered);
      for (const [cardId, until] of cooldownUntil) {
        if (until > now.getTime()) {
          blockedCards.add(cardId);
        }
      }
      const offer = chooseOffer({
        index,
        message,
        earlier:
          previous && now.getTime() - previous.at < FOLLOW_UP_MS && previous.text !== message
            ? previous.text
            : undefined,
        sessionKey: ctx.sessionKey,
        date,
        state: { ...day, sessionsUsed: new Set(day.sessions), blockedCards },
        settings,
      });
      if (!offer) {
        return undefined;
      }
      // A card is offered once a day at most, so a declined line does not come back every turn.
      day.offered.push(...offer.cards.map((card) => card.id));
      if (offer.mode === "daily") {
        day.dailyOffers += 1;
      }
      await saveDay();
      pending.delete(ctx.sessionKey);
      if (pending.size >= MAX_PENDING) {
        pending.delete(pending.keys().next().value as string);
      }
      pending.set(ctx.sessionKey, { offer, sessionKey: ctx.sessionKey, at: now.getTime() });
      return {
        appendContext: buildHint(offer, {
          folderName: settings.folderName,
          voice: isVoiceTurn(ctx.sessionKey, event.currentUserMessage ?? event.prompt),
        }),
      };
    } catch (error) {
      // Advice must never block a reply.
      warn("skipped", error);
      return undefined;
    }
  });

  api.on("llm_output", async (event, ctx) => {
    const key = ctx.sessionKey;
    const entry = key ? pending.get(key) : undefined;
    if (!key || !entry) {
      return;
    }
    if (Date.now() - entry.at > PENDING_MS) {
      pending.delete(key);
      return;
    }
    const used = entry.offer.cards.find((card) =>
      replyUsesCard(event.assistantTexts.join("\n"), card),
    );
    if (!used) {
      return;
    }
    pending.delete(key);
    try {
      const now = Date.now();
      rollDay(new Date(now));
      if (entry.offer.mode === "daily") {
        day.dailyUsed = true;
      } else {
        day.matchedUsed += 1;
        day.sessions.push(entry.sessionKey);
      }
      cooldownUntil.set(used.id, now + settings.cooldownDays * DAY_MS);
      await saveDay();
      await openStore().register(
        `card:${used.id}`,
        { usedAt: now },
        { ttlMs: settings.cooldownDays * DAY_MS },
      );
    } catch (error) {
      warn("could not record a used quote", error);
    }
  });
}

async function readCurated(cardsPath: string): Promise<CuratedCard[]> {
  const path = cardsPath.startsWith("~/") ? `${homedir()}/${cardsPath.slice(2)}` : cardsPath;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as { cards?: unknown };
  if (!Array.isArray(parsed.cards)) {
    throw new Error(`${path} needs a "cards" array`);
  }
  return parsed.cards.filter(
    (card): card is CuratedCard =>
      typeof card === "object" &&
      card !== null &&
      typeof (card as CuratedCard).id === "string" &&
      typeof (card as CuratedCard).use === "boolean",
  );
}

type BookmarkPage = {
  success: boolean;
  data?: {
    items: Array<{ id: string; text?: string; author?: { username?: string }; media?: unknown[] }>;
    nextOffset?: number | null;
    folders?: Array<{ id: string; name: string }>;
  };
};

/** Reads the folder from the Journal's local bookmarks API. Local data only; never calls X. */
async function fetchFolderPosts(
  settings: { journalUrl: string; folderName: string },
  fetcher: typeof fetch,
): Promise<SavedPost[]> {
  const page = async (query: string) => {
    const response = await fetcher(`${settings.journalUrl}/api/bookmarks?${query}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as BookmarkPage;
    if (!response.ok || !body.success || !body.data) {
      throw new Error(`bookmarks API answered ${response.status}`);
    }
    return body.data;
  };
  const folder = (await page("limit=1")).folders?.find(
    (candidate) => candidate.name.toLowerCase() === settings.folderName.toLowerCase(),
  );
  if (!folder) {
    throw new Error(`no bookmark folder named "${settings.folderName}"`);
  }
  const posts: SavedPost[] = [];
  let offset: number | null | undefined = 0;
  for (let pages = 0; offset != null && pages < 50; pages += 1) {
    const data = await page(`folder=${folder.id}&limit=100&offset=${offset}`);
    for (const item of data.items) {
      posts.push({
        id: item.id,
        author: item.author?.username ?? "unknown",
        text: item.text ?? "",
        hasMedia: (item.media?.length ?? 0) > 0,
      });
    }
    offset = data.items.length > 0 ? data.nextOffset : null;
  }
  return posts;
}
