// Google Live session config: closed option types and provider-config normalization.
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import type { RealtimeVoiceProviderConfig } from "openclaw/plugin-sdk/realtime-voice";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asBoolean,
  asFiniteNumber,
  asOptionalRecord,
  asSafeIntegerInRange,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export type GoogleRealtimeSensitivity = "low" | "high";
export type GoogleRealtimeThinkingLevel = "minimal" | "low" | "medium" | "high";
export type GoogleRealtimeActivityHandling = "start-of-activity-interrupts" | "no-interruption";
export type GoogleRealtimeTurnCoverage =
  | "only-activity"
  | "all-input"
  | "audio-activity-and-all-video";

export type GoogleRealtimeVoiceProviderConfig = {
  apiKey?: string;
  model?: string;
  voice?: string;
  temperature?: number;
  apiVersion?: string;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
  startSensitivity?: GoogleRealtimeSensitivity;
  endSensitivity?: GoogleRealtimeSensitivity;
  activityHandling?: GoogleRealtimeActivityHandling;
  turnCoverage?: GoogleRealtimeTurnCoverage;
  automaticActivityDetectionDisabled?: boolean;
  enableAffectiveDialog?: boolean;
  sessionResumption?: boolean;
  contextWindowCompression?: boolean;
  thinkingLevel?: GoogleRealtimeThinkingLevel;
  thinkingBudget?: number;
};

function asSensitivity(value: unknown): GoogleRealtimeSensitivity | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized === "low" || normalized === "high" ? normalized : undefined;
}

function asThinkingLevel(value: unknown): GoogleRealtimeThinkingLevel | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high"
    ? normalized
    : undefined;
}

function asActivityHandling(value: unknown): GoogleRealtimeActivityHandling | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase().replaceAll("_", "-");
  switch (normalized) {
    case "start-of-activity-interrupts":
    case "start-of-activity-interrupt":
    case "interrupt":
    case "interrupts":
      return "start-of-activity-interrupts";
    case "no-interruption":
    case "no-interruptions":
    case "none":
      return "no-interruption";
    default:
      return undefined;
  }
}

function asTurnCoverage(value: unknown): GoogleRealtimeTurnCoverage | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase().replaceAll("_", "-");
  switch (normalized) {
    case "only-activity":
    case "turn-includes-only-activity":
      return "only-activity";
    case "all-input":
    case "turn-includes-all-input":
      return "all-input";
    case "audio-activity-and-all-video":
    case "turn-includes-audio-activity-and-all-video":
      return "audio-activity-and-all-video";
    default:
      return undefined;
  }
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: 0 });
}

function resolveGoogleRealtimeProviderConfigRecord(
  config: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asOptionalRecord(config.providers);
  return asOptionalRecord(providers?.google) ?? asOptionalRecord(config.google) ?? config;
}

export function normalizeGoogleRealtimeProviderConfig(
  config: RealtimeVoiceProviderConfig,
  cfg?: OpenClawConfig,
): GoogleRealtimeVoiceProviderConfig {
  const raw = resolveGoogleRealtimeProviderConfigRecord(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey ?? cfg?.models?.providers?.google?.apiKey,
      path: "plugins.entries.voice-call.config.realtime.providers.google.apiKey",
    }),
    ...normalizeGoogleLiveSessionConfig(raw),
  };
}

// Session tuning is identical on both Google Live surfaces; only auth differs per provider id.
export function normalizeGoogleLiveSessionConfig(
  raw: Record<string, unknown> | undefined,
): Omit<GoogleRealtimeVoiceProviderConfig, "apiKey"> {
  return {
    model: normalizeOptionalString(raw?.model),
    voice: normalizeOptionalString(raw?.speakerVoice) ?? normalizeOptionalString(raw?.voice),
    temperature: asFiniteNumber(raw?.temperature),
    apiVersion: normalizeOptionalString(raw?.apiVersion),
    prefixPaddingMs: asNonNegativeInteger(raw?.prefixPaddingMs),
    silenceDurationMs: asNonNegativeInteger(raw?.silenceDurationMs),
    startSensitivity: asSensitivity(raw?.startSensitivity),
    endSensitivity: asSensitivity(raw?.endSensitivity),
    activityHandling: asActivityHandling(raw?.activityHandling),
    turnCoverage: asTurnCoverage(raw?.turnCoverage),
    automaticActivityDetectionDisabled: asBoolean(raw?.automaticActivityDetectionDisabled),
    enableAffectiveDialog: asBoolean(raw?.enableAffectiveDialog),
    sessionResumption: asBoolean(raw?.sessionResumption),
    contextWindowCompression: asBoolean(raw?.contextWindowCompression),
    thinkingLevel: asThinkingLevel(raw?.thinkingLevel),
    thinkingBudget: asSafeIntegerInRange(raw?.thinkingBudget, { min: -1, max: 24_576 }),
  };
}
