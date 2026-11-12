# good-advice (personal plugin)

Lets the agent slip one saved line from the Agentic Journal **Good advice** bookmarks folder
into a reply:

- **Matched:** when what you just said hits at least two of a card's triggers, the card is
  offered for that turn. At most one per conversation per day, three per day overall.
- **Daily remark:** on a day with no match, an ordinary chat gets up to three light candidates,
  once the remark is used it is done for the day. It is offered on at most three turns a day.

The plugin only offers. It appends a short `[good-advice]` note to that turn's prompt and the
model decides whether a line fits; the note tells it to stay silent if the line would be forced,
preachy or badly timed. A quote counts as used only when the reply actually contains it, and a
used quote rests for 30 days. A declined card is not offered again that day.

It never speaks in cron, heartbeat, subagent or Journal helper sessions, on very short or
machine-written messages, or when the message is about being sick or in a rush.

## Cards

`~/.openclaw/good-advice/cards.json` holds one entry per saved post:

```json
{
  "id": "2075180326091923592",
  "use": true,
  "author": "gabriel1",
  "quote": "never say \"i can work on anything you want me to\" in an interview",
  "triggers": ["interview", "recruiter screen", "what should i know beforehand"],
  "daily": false
}
```

- `quote` is copied verbatim from the post. `triggers` are words and phrases you would type when
  the advice is relevant. `daily` marks lines light enough for the unprompted remark.
- `"use": false` keeps a post out (teasers for videos, news, tool tips).
- Edit the file by hand to fix triggers or retire a card; it is re-read every six hours and at
  gateway start.

Posts saved after the cards were written need no entry: the plugin reads the folder from the
Journal's local bookmarks API (never from X) and gives each short, text-only post a plain card
built from its own words. Those match less precisely than curated cards.

## Enable

Add this folder to `plugins.load.paths` and enable the entry in `~/.openclaw/openclaw.json`,
then restart the gateway:

```json5
{
  plugins: {
    load: { paths: ["/home/openclaw/projects/openclaw/personal-plugins/good-advice"] },
    entries: {
      "good-advice": {
        enabled: true,
        // Required: the plugin reads your message and the reply, which OpenClaw only lets a
        // non-bundled plugin do with this grant.
        hooks: { allowConversationAccess: true },
        config: {},
      },
    },
  },
}
```

Config (all optional): `journalUrl`, `folderName`, `cardsPath`, `matchThreshold` (2.5),
`maxMatchedPerDay` (3), `maxDailyOffers` (3; 0 turns the daily remark off), `cooldownDays` (30).

## Test

```bash
node --test personal-plugins/good-advice/good-advice.test.ts
```
