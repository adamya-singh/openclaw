// Google realtime voice provider identities shared by the plugin entry and the
// lazily loaded runtime module, so registration never imports @google/genai.
export type GoogleRealtimeVoiceTarget = "gemini-api" | "vertex";

export type GoogleRealtimeVoiceProviderMetadata = {
  id: string;
  label: string;
  defaultModel: string;
  // The Live service is published under different API versions per surface;
  // sending the Gemini API version to Vertex yields an invalid service path.
  apiVersion: string;
};

export const GOOGLE_REALTIME_VOICE_PROVIDERS = {
  "gemini-api": {
    id: "google",
    label: "Google Live Voice",
    defaultModel: "gemini-3.1-flash-live-preview",
    apiVersion: "v1beta",
  },
  vertex: {
    id: "google-vertex",
    label: "Google Vertex Live Voice",
    defaultModel: "gemini-live-2.5-flash-native-audio",
    apiVersion: "v1beta1",
  },
} as const satisfies Record<GoogleRealtimeVoiceTarget, GoogleRealtimeVoiceProviderMetadata>;
