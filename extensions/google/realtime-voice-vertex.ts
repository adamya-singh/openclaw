// Synchronous Vertex Live target facts; realtime provider discovery must not load the Live runtime.
import type { RealtimeVoiceProviderConfig } from "openclaw/plugin-sdk/realtime-voice";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGoogleApplicationCredentialsPath } from "./vertex-adc-config.js";

export type GoogleVertexRealtimeTarget = { project: string; location: string };

export function resolveGoogleVertexRealtimeConfigRecord(
  config: RealtimeVoiceProviderConfig,
): Record<string, unknown> {
  const providers = asOptionalRecord(config.providers);
  return (
    asOptionalRecord(providers?.["google-vertex"]) ??
    asOptionalRecord(config["google-vertex"]) ??
    config
  );
}

// Provider config wins over env: Live native-audio models are regional, while
// GOOGLE_CLOUD_LOCATION is often "global" for the text model transport.
export function resolveGoogleVertexRealtimeTarget(
  config: RealtimeVoiceProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): GoogleVertexRealtimeTarget | undefined {
  const raw = resolveGoogleVertexRealtimeConfigRecord(config);
  const project =
    normalizeOptionalString(raw.project) ??
    normalizeOptionalString(env.GOOGLE_CLOUD_PROJECT) ??
    normalizeOptionalString(env.GCLOUD_PROJECT);
  const location =
    normalizeOptionalString(raw.location) ?? normalizeOptionalString(env.GOOGLE_CLOUD_LOCATION);
  return project && location ? { project, location } : undefined;
}

// File-backed ADC only, like Vertex model discovery: metadata-server ADC needs an async
// probe this sync gate cannot run. Accepted tradeoff: metadata-only hosts are unsupported.
export function isGoogleVertexRealtimeConfigured(
  config: RealtimeVoiceProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    resolveGoogleVertexRealtimeTarget(config, env) && resolveGoogleApplicationCredentialsPath(env),
  );
}
