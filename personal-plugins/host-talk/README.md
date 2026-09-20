# host-talk (personal plugin)

"Hey OpenClaw" on the Gateway host's own microphone and speakers.

- **Wake**: say "hey openclaw". You hear a rising chime.
- **One-shot (default)**: ask your question right away (even in the same breath). It answers out
  loud, waits about 7 seconds for a follow-up, then plays a falling chime and goes back to
  listening for the wake word only.
- **Live conversation**: say "let's talk" (or "let's chat", "stay with me"). It then stays in the
  conversation until you end it.
- **End**: say "goodbye", "that's all", "stop listening", or "end conversation".
- **Interrupt**: say "hey openclaw" while it is speaking.
- A low two-note tone means something failed (for example the voice provider was unreachable).

The voice assistant has its own session, `agent:<agentId>:host-talk:<hostname>`, separate from
Telegram and the main session.

## How it works

`audio-worker.mjs` runs in its own process and owns the microphone (`pw-record`), the speaker
(`pw-play`), and wake detection (a small streaming speech recognizer plus fuzzy matching, so
spellings like "open claw" or "opened claw" still count). No microphone audio leaves that process
until a wake phrase is heard. After a wake, audio goes to the Gateway's realtime Talk relay
(`talk.realtime` in `openclaw.json`), and agent work runs in the normal OpenClaw agent with the
relay's spoken-confirmation gate for high-impact actions.

It is half-duplex: the microphone is not forwarded while the assistant speaks, so it cannot hear
itself. The wake word still works during playback and interrupts it.

## Setup

1. `cd personal-plugins/host-talk && npm install --ignore-scripts`
2. Put the model folder `sherpa-onnx-streaming-zipformer-en-20M-2023-02-17` (from the sherpa-onnx
   `asr-models` release) under `~/.openclaw/tools/host-talk/models/`.
3. Microphone gain matters more than anything else. On this laptop the internal mic boost was at
   +36 dB, which buried speech in noise; +24 dB works: `amixer -c 1 sset 'Internal Mic Boost' 2`.
4. Add the folder to `plugins.load.paths`, enable it, and restart the Gateway:

```json5
{
  plugins: {
    load: { paths: ["/home/openclaw/projects/openclaw/personal-plugins/host-talk"] },
    entries: { "host-talk": { enabled: true, config: { wakePhrases: ["hey openclaw"] } } },
  },
}
```

Check it with `openclaw gateway call hosttalk.status --json`.

## Known limits

- Near-homophones of the wake phrase, such as "open Claude" or "open a claim", can wake it.
- The first conversation after a Gateway restart takes several seconds to connect; nothing you say
  is lost, because audio is held from the wake until the session is ready.
- English only (wake recognizer and the "let's talk" / "goodbye" phrases).

## Test

```bash
node --test personal-plugins/host-talk/src/*.test.ts
```
