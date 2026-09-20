import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { GOOGLE_PREBUILT_VOICES } from "./voice-catalog.js";

export const GOOGLE_REALTIME_DEFAULT_MODEL = "gemini-3.1-flash-live-preview";

// Vertex serves Live under its own GA model ids; the Gemini API preview ids do not exist there.
export const GOOGLE_VERTEX_REALTIME_DEFAULT_MODEL = "gemini-live-2.5-flash-native-audio";

export const GOOGLE_REALTIME_VOICE_METADATA = {
  id: "google",
  label: "Google Live Voice",
  defaultModel: GOOGLE_REALTIME_DEFAULT_MODEL,
  voices: GOOGLE_PREBUILT_VOICES,
  autoSelectOrder: 20,
} satisfies Pick<
  RealtimeVoiceProviderPlugin,
  "id" | "label" | "defaultModel" | "voices" | "autoSelectOrder"
>;

export const GOOGLE_VERTEX_REALTIME_VOICE_METADATA = {
  id: "google-vertex",
  label: "Google Vertex Live Voice",
  defaultModel: GOOGLE_VERTEX_REALTIME_DEFAULT_MODEL,
  voices: GOOGLE_PREBUILT_VOICES,
  autoSelectOrder: 21,
} satisfies Pick<
  RealtimeVoiceProviderPlugin,
  "id" | "label" | "defaultModel" | "voices" | "autoSelectOrder"
>;
