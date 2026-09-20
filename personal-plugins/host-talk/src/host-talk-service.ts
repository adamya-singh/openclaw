import { TalkRelaySession, type GatewayLink } from "./talk-relay-session.ts";
// Executes the state machine's effects against the audio worker and the Gateway relay.
import { synthesizeTone } from "./tone-synth.ts";
import {
  reduceHostTalk,
  type HostTalkEffect,
  type HostTalkEvent,
  type HostTalkState,
  type WakeOutcome,
} from "./voice-session-machine.ts";
import type { WorkerInbound, WorkerOutbound } from "./worker-protocol.ts";

export type HostTalkServiceDeps = {
  link: GatewayLink;
  sessionKey: string;
  sendToWorker(message: WorkerInbound): void;
  log(message: string): void;
};

export type HostTalkSnapshot = {
  state: HostTalkState;
  lastOutcome?: { outcome: WakeOutcome; at: string };
  wakes: number;
};

export class HostTalkService {
  private state: HostTalkState = { kind: "listening" };
  private session: TalkRelaySession | undefined;
  private timer: NodeJS.Timeout | undefined;
  private nextDrainId = 1;
  private readonly drains = new Map<number, () => void>();
  private lastOutcome: HostTalkSnapshot["lastOutcome"];
  private wakes = 0;
  private openedAtMs = 0;
  private readonly deps: HostTalkServiceDeps;

  constructor(deps: HostTalkServiceDeps) {
    this.deps = deps;
  }

  snapshot(): HostTalkSnapshot {
    return { state: this.state, lastOutcome: this.lastOutcome, wakes: this.wakes };
  }

  dispatch(event: HostTalkEvent): void {
    const step = reduceHostTalk(this.state, event);
    this.state = step.state;
    for (const effect of step.effects) {
      this.run(effect);
    }
  }

  handleWorkerMessage(message: WorkerOutbound): void {
    switch (message.t) {
      case "wake":
        this.deps.log(`host-talk: wake phrase "${message.phrase}"`);
        this.dispatch({ type: "wake" });
        return;
      case "pcm":
        this.session?.appendAudio(Buffer.from(message.pcm24k));
        return;
      case "drained":
        this.drains.get(message.id)?.();
        this.drains.delete(message.id);
        return;
      default:
        return;
    }
  }

  stop(): void {
    clearTimeout(this.timer);
    void this.session?.close();
    this.session = undefined;
  }

  private afterPlaybackDrains(run: () => void): void {
    const id = this.nextDrainId++;
    this.drains.set(id, run);
    this.deps.sendToWorker({ t: "drain", id });
  }

  private run(effect: HostTalkEffect): void {
    switch (effect.type) {
      case "tone":
        this.deps.sendToWorker({ t: "play", pcm24k: synthesizeTone(effect.tone) });
        return;
      case "stream-mic":
        this.deps.sendToWorker({ t: "stream", on: effect.on, flushPreroll: effect.flushPreroll });
        return;
      case "timer":
        clearTimeout(this.timer);
        if (effect.ms !== undefined) {
          this.timer = setTimeout(() => this.dispatch({ type: "timer" }), effect.ms);
          this.timer.unref();
        }
        return;
      case "cancel-output":
        this.session?.cancelOutput();
        this.deps.sendToWorker({ t: "clear" });
        return;
      case "close-session": {
        const closing = this.session;
        this.session = undefined;
        this.drains.clear();
        void closing?.close();
        return;
      }
      case "outcome":
        this.lastOutcome = { outcome: effect.outcome, at: new Date().toISOString() };
        this.deps.log(`host-talk: conversation ended (${effect.outcome})`);
        return;
      case "open-session":
        this.wakes += 1;
        this.openSession();
        return;
    }
  }

  private openSession(): void {
    this.openedAtMs = Date.now();
    const session: TalkRelaySession = new TalkRelaySession(this.deps.link, this.deps.sessionKey, {
      onReady: () =>
        this.ifCurrent(session, () => {
          this.deps.log(`host-talk: voice session ready in ${Date.now() - this.openedAtMs} ms`);
          this.dispatch({ type: "session-ready" });
        }),
      onAudio: (pcm24k) =>
        this.ifCurrent(session, () => {
          this.dispatch({ type: "assistant-audio" });
          this.deps.sendToWorker({ t: "play", pcm24k });
        }),
      onClear: () => this.ifCurrent(session, () => this.deps.sendToWorker({ t: "clear" })),
      onMark: (markName) =>
        this.ifCurrent(session, () =>
          this.afterPlaybackDrains(() => session.acknowledgeMark(markName)),
        ),
      onUserSpeech: () => this.ifCurrent(session, () => this.dispatch({ type: "user-speech" })),
      onUserTranscript: (text) =>
        this.ifCurrent(session, () => this.dispatch({ type: "user-transcript", text })),
      onReplyIdle: () =>
        this.ifCurrent(session, () =>
          this.afterPlaybackDrains(() =>
            this.ifCurrent(session, () => this.dispatch({ type: "reply-finished" })),
          ),
        ),
      onLost: (reason) =>
        this.ifCurrent(session, () => {
          this.deps.log(`host-talk: relay session lost (${reason})`);
          this.session = undefined;
          this.dispatch({ type: "session-lost" });
        }),
    });
    this.session = session;
    session.open().catch((error: unknown) =>
      this.ifCurrent(session, () => {
        this.deps.log(`host-talk: could not start a voice session: ${String(error)}`);
        this.session = undefined;
        this.dispatch({ type: "session-failed" });
      }),
    );
  }

  // Late callbacks from a session that was already replaced or closed must not drive the machine.
  private ifCurrent(session: TalkRelaySession, run: () => void): void {
    if (this.session === session) {
      run();
    }
  }
}
