// host-talk: "hey openclaw" on the Gateway host's own microphone and speakers.
import os from "node:os";
import path from "node:path";
import { resolveGatewayPort } from "openclaw/plugin-sdk/core";
import { GatewayClient, resolveGatewayAuth } from "openclaw/plugin-sdk/gateway-runtime";
import { HostTalkService } from "./src/host-talk-service.ts";
import type { GatewayLink } from "./src/talk-relay-session.ts";
import { WorkerSupervisor } from "./src/worker-supervisor.ts";

const WAKE_MODEL = "sherpa-onnx-streaming-zipformer-en-20M-2023-02-17";
const DEFAULT_WAKE_PHRASES = ["hey openclaw"];
// read + talk run the relay; write lets voice consults use the agent's normal tools (the relay's
// spoken-confirmation gate still guards high-impact actions). Never admin: this is a room mic.
const LINK_SCOPES = ["operator.read", "operator.talk", "operator.write"];

type PluginApi = {
  source: string;
  rootDir?: string;
  pluginConfig?: Record<string, unknown>;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  registerService(service: {
    id: string;
    start(ctx: { config: any; stateDir: string }): Promise<void> | void;
    stop?(): Promise<void> | void;
  }): void;
  registerGatewayMethod(
    method: string,
    handler: (options: { respond: (ok: boolean, payload?: unknown) => void }) => void,
    opts?: { scope?: string },
  ): void;
};

// Deliberately NOT the Gateway's global voice-wake list: its defaults ("claude", "computer") are
// everyday words, fine for a push-to-hold phone but false wakes on an always-on room microphone.
function resolveWakePhrases(value: unknown): string[] {
  const phrases = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
  return phrases.length > 0 ? phrases : DEFAULT_WAKE_PHRASES;
}

export default function register(api: PluginApi) {
  const log = (message: string) => api.logger?.info?.(message);
  let service: HostTalkService | undefined;
  let supervisor: WorkerSupervisor | undefined;
  let client: InstanceType<typeof GatewayClient> | undefined;
  let linkState = "starting";

  api.registerGatewayMethod(
    "hosttalk.status",
    ({ respond }) =>
      respond(true, { link: linkState, worker: supervisor?.status, ...service?.snapshot() }),
    { scope: "operator.read" },
  );

  api.registerService({
    id: "host-talk",
    start(ctx) {
      const cfg = ctx.config;
      const settings = api.pluginConfig ?? {};
      const agentId = typeof settings.agentId === "string" ? settings.agentId : "main";
      const host = os
        .hostname()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");
      const sessionKey = `agent:${agentId}:host-talk:${host}`;
      const listeners = new Set<(event: { event: string; payload?: unknown }) => void>();

      const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: process.env });
      const gateway = new GatewayClient({
        url: `ws://127.0.0.1:${resolveGatewayPort(cfg)}`,
        token: auth.token,
        password: auth.password,
        role: "operator",
        scopes: LINK_SCOPES,
        // Loopback backend clients keep their scopes without device pairing.
        deviceIdentity: null,
        clientDisplayName: "host-talk",
        onHelloOk: () => {
          linkState = "connected";
        },
        onConnectError: (error: Error) => {
          linkState = `connect error: ${error.message}`;
        },
        onClose: () => {
          linkState = "disconnected";
          // Relay sessions are owned by the connection, so any conversation died with it.
          service?.dispatch({ type: "session-lost" });
        },
        onEvent: (event: { event: string; payload?: unknown }) => {
          for (const listener of listeners) listener(event);
        },
      });
      client = gateway;
      const link: GatewayLink = {
        request: (method, params) => gateway.request(method, params),
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };

      supervisor = new WorkerSupervisor({
        workerPath: path.join(api.rootDir ?? path.dirname(api.source), "audio-worker.mjs"),
        onMessage: (message) => service?.handleWorkerMessage(message),
        onFailure: () => service?.dispatch({ type: "worker-failed" }),
        log,
      });
      service = new HostTalkService({
        link,
        sessionKey,
        sendToWorker: (message) => supervisor?.send(message),
        log,
      });
      supervisor.configure({
        modelDir: path.join(ctx.stateDir, "tools", "host-talk", "models", WAKE_MODEL),
        phrases: resolveWakePhrases(settings.wakePhrases),
      });
      gateway.start();
      log(`host-talk: listening for the wake word; voice session ${sessionKey}`);
    },
    stop() {
      service?.stop();
      supervisor?.stop();
      client?.stop();
    },
  });
}
