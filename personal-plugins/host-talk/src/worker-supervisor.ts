// Forks and supervises the audio worker: restart with capped backoff, heartbeat watchdog, and a
// terminal "unavailable" state for setup problems a restart cannot fix.
import { fork, type ChildProcess } from "node:child_process";
import type {
  WakeEngineConfig,
  WorkerFatalReason,
  WorkerInbound,
  WorkerOutbound,
} from "./worker-protocol.ts";

// Missing addon or model needs operator action; respawning would only loop.
const SETUP_FATALS: ReadonlySet<WorkerFatalReason> = new Set([
  "sherpa-missing",
  "model-missing",
  "wake-init-failed",
]);
const HEARTBEAT_TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;

export type WorkerStatus =
  | { kind: "starting" }
  | { kind: "ready"; phrases: string[]; rssBytes?: number }
  | { kind: "restarting"; detail: string }
  | { kind: "unavailable"; reason: WorkerFatalReason; detail: string };

export type WorkerSupervisorOptions = {
  /**
   * Absolute path of audio-worker.mjs in the ORIGINAL plugin folder. The Gateway runs plugins
   * from a staged copy whose node_modules lacks sherpa's platform binary package.
   */
  workerPath: string;
  onMessage(message: WorkerOutbound): void;
  /** The worker died or wedged while it may have owned an active conversation. */
  onFailure(detail: string): void;
  log(message: string): void;
  spawnWorker?: () => ChildProcess;
};

export class WorkerSupervisor {
  status: WorkerStatus = { kind: "starting" };
  private child: ChildProcess | undefined;
  private wake: WakeEngineConfig | undefined;
  private stopped = false;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private readonly options: WorkerSupervisorOptions;

  constructor(options: WorkerSupervisorOptions) {
    this.options = options;
  }

  configure(wake: WakeEngineConfig): void {
    this.wake = wake;
    if (this.status.kind === "unavailable") {
      return;
    }
    if (!this.child) {
      this.spawn();
      return;
    }
    this.send({ t: "configure", wake });
  }

  send(message: WorkerInbound): void {
    if (this.child?.connected) {
      this.child.send(message);
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    clearTimeout(this.heartbeatTimer);
    this.send({ t: "shutdown" });
    const child = this.child;
    this.child = undefined;
    setTimeout(() => child?.kill("SIGKILL"), 2000).unref();
  }

  private spawn(): void {
    const spawnWorker =
      this.options.spawnWorker ??
      (() =>
        fork(this.options.workerPath, [], {
          serialization: "advanced",
          // Plain Node, not the Gateway's loader flags.
          execArgv: [],
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        }));
    const child = spawnWorker();
    this.child = child;
    this.status = { kind: "starting" };
    this.armHeartbeat();
    child.on("message", (message: WorkerOutbound) => this.handleMessage(child, message));
    child.on("exit", (code, signal) => {
      if (this.child === child) {
        this.handleExit(`worker exited (code ${code}, signal ${signal})`);
      }
    });
    if (this.wake) {
      child.send({ t: "configure", wake: this.wake } satisfies WorkerInbound);
    }
  }

  private handleMessage(child: ChildProcess, message: WorkerOutbound): void {
    if (this.child !== child) {
      return;
    }
    this.armHeartbeat();
    if (message.t === "ready") {
      this.restarts = 0;
      this.status = { kind: "ready", phrases: message.phrases };
    } else if (message.t === "heartbeat") {
      if (this.status.kind === "ready") {
        this.status = { ...this.status, rssBytes: message.rssBytes };
      }
      return;
    } else if (message.t === "fatal" && SETUP_FATALS.has(message.reason)) {
      this.status = { kind: "unavailable", reason: message.reason, detail: message.detail };
      this.options.log(`host-talk unavailable: ${message.reason}: ${message.detail}`);
      this.child = undefined;
      clearTimeout(this.heartbeatTimer);
      this.options.onFailure(message.reason);
      return;
    }
    this.options.onMessage(message);
  }

  private handleExit(detail: string): void {
    this.child = undefined;
    clearTimeout(this.heartbeatTimer);
    if (this.stopped || this.status.kind === "unavailable") {
      return;
    }
    this.options.onFailure(detail);
    this.restarts += 1;
    const delayMs = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (this.restarts - 1));
    this.status = { kind: "restarting", detail };
    this.options.log(`host-talk worker restarting in ${delayMs} ms: ${detail}`);
    this.restartTimer = setTimeout(() => this.spawn(), delayMs);
    this.restartTimer.unref();
  }

  private armHeartbeat(): void {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      // A wedged native call never exits on its own; kill it so handleExit restarts it.
      this.child?.kill("SIGKILL");
    }, HEARTBEAT_TIMEOUT_MS);
    this.heartbeatTimer.unref();
  }
}
