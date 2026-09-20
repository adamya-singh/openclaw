// IPC contract between the gateway-side service and the forked audio worker.
// Buffers cross the channel natively (fork uses serialization: "advanced").

export type WakeEngineConfig = {
  modelDir: string;
  phrases: string[];
  threshold: number;
  score: number;
};

export type WorkerInbound =
  | { t: "configure"; wake: WakeEngineConfig }
  | { t: "stream"; on: boolean; flushPreroll?: boolean }
  | { t: "play"; pcm24k: Buffer }
  | { t: "clear" }
  | { t: "drain"; id: number }
  | { t: "shutdown" };

export type WorkerFatalReason =
  | "sherpa-missing"
  | "model-missing"
  | "wake-init-failed"
  | "record-failed"
  | "play-failed";

export type WorkerOutbound =
  | { t: "ready"; phrases: string[]; skippedPhrases: string[] }
  | { t: "wake"; phrase: string }
  | { t: "pcm"; pcm24k: Buffer }
  | { t: "drained"; id: number }
  | { t: "heartbeat"; rssBytes: number }
  | { t: "fatal"; reason: WorkerFatalReason; detail: string };
