import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoogleVertexRealtimeVoiceProvider } from "./realtime-voice-provider.js";
import {
  isGoogleVertexRealtimeConfigured,
  resolveGoogleVertexRealtimeTarget,
} from "./realtime-voice-vertex.js";

const { connectMock, createGoogleGenAIMock } = vi.hoisted(() => {
  const connectMockLocal = vi.fn(async (_params: { model: string }) => ({
    close: vi.fn(),
    sendClientContent: vi.fn(),
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
  }));
  return {
    connectMock: connectMockLocal,
    createGoogleGenAIMock: vi.fn((_options: unknown) => ({ live: { connect: connectMockLocal } })),
  };
});

vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: createGoogleGenAIMock,
}));

const VERTEX_ENV_KEYS = ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"];

function createVertexBridge(providerConfig: Record<string, unknown>) {
  return buildGoogleVertexRealtimeVoiceProvider().createBridge({
    providerConfig,
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
  });
}

describe("Google Vertex realtime voice", () => {
  let adcDir: string;
  let adcPath: string;

  beforeEach(() => {
    connectMock.mockClear();
    createGoogleGenAIMock.mockClear();
    for (const key of VERTEX_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
    adcDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vertex-live-"));
    adcPath = path.join(adcDir, "adc.json");
    fs.writeFileSync(adcPath, JSON.stringify({ type: "service_account" }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(adcDir, { recursive: true, force: true });
  });

  afterAll(() => {
    vi.doUnmock("./google-genai-runtime.js");
    vi.resetModules();
  });

  it.each([
    {
      name: "prefers provider config over env",
      config: { project: "cfg-project", location: "us-central1" },
      env: { GOOGLE_CLOUD_PROJECT: "env-project", GOOGLE_CLOUD_LOCATION: "global" },
      expected: { project: "cfg-project", location: "us-central1" },
    },
    {
      name: "reads the keyed google-vertex provider record",
      config: { providers: { "google-vertex": { location: "europe-west4" } } },
      env: { GCLOUD_PROJECT: "legacy-project" },
      expected: { project: "legacy-project", location: "europe-west4" },
    },
    {
      name: "is unresolved without a location",
      config: { project: "cfg-project" },
      env: {},
      expected: undefined,
    },
  ])("target $name", ({ config, env, expected }) => {
    expect(resolveGoogleVertexRealtimeTarget(config, env)).toEqual(expected);
  });

  it("is configured only with a target and file-backed ADC", () => {
    const config = { project: "p", location: "us-central1" };
    const home = { HOME: adcDir };

    expect(isGoogleVertexRealtimeConfigured(config, home)).toBe(false);
    expect(
      isGoogleVertexRealtimeConfigured(config, {
        ...home,
        GOOGLE_APPLICATION_CREDENTIALS: adcPath,
      }),
    ).toBe(true);
    expect(
      isGoogleVertexRealtimeConfigured(
        { project: "p" },
        { ...home, GOOGLE_APPLICATION_CREDENTIALS: adcPath },
      ),
    ).toBe(false);
  });

  it("is relay-only because Vertex has no browser session tokens", () => {
    const provider = buildGoogleVertexRealtimeVoiceProvider();

    expect(provider.id).toBe("google-vertex");
    expect(provider.capabilities?.transports).toEqual(["gateway-relay"]);
    expect(provider.capabilities?.supportsBrowserSession).toBe(false);
    expect(provider.createBrowserSession).toBeUndefined();
    expect(provider.capabilities?.supportsToolCalls).toBe(true);
  });

  it("connects through a Vertex-mode client without the Gemini API version default", async () => {
    await createVertexBridge({ project: "cfg-project", location: "us-central1" }).connect();

    expect(createGoogleGenAIMock).toHaveBeenCalledWith({
      vertexai: true,
      project: "cfg-project",
      location: "us-central1",
    });
    expect(connectMock.mock.calls[0]?.[0].model).toBe("gemini-live-2.5-flash-native-audio");
  });

  it("passes explicit model and apiVersion overrides to the Vertex client", async () => {
    await createVertexBridge({
      project: "cfg-project",
      location: "us-central1",
      model: "custom-live-model",
      apiVersion: "v1",
    }).connect();

    expect(createGoogleGenAIMock).toHaveBeenCalledWith({
      vertexai: true,
      project: "cfg-project",
      location: "us-central1",
      httpOptions: { apiVersion: "v1" },
    });
    expect(connectMock.mock.calls[0]?.[0].model).toBe("custom-live-model");
  });

  it("fails bridge creation with the missing project and location named", () => {
    expect(() => createVertexBridge({})).toThrow(/project and location/);
    expect(createGoogleGenAIMock).not.toHaveBeenCalled();
  });
});
