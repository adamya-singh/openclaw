# context-warning (personal plugin)

Adds a one-time warning to the bot's reply when a chat session's context grows
past a token threshold (default 100,000 tokens per model call), with **Reset
context** (`/reset`) and **Compact context** (`/compact`) buttons. Large context
makes every reply cost more.

It warns once per session and re-arms after the context drops back under the
threshold (for example after `/compact` or `/reset`).

## Enable

Add this folder to `plugins.load.paths` and enable the entry in
`~/.openclaw/openclaw.json`, then restart the gateway:

```json5
{
  plugins: {
    load: { paths: ["/home/openclaw/projects/openclaw/personal-plugins/context-warning"] },
    entries: {
      "context-warning": {
        enabled: true,
        config: { thresholdTokens: 100000, channels: ["telegram"] },
      },
    },
  },
}
```

## Test

```bash
node --test personal-plugins/context-warning/context-warning.test.ts
```
