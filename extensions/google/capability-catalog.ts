import type { PluginCapabilityCatalog } from "openclaw/plugin-sdk/plugin-entry";
import {
  createLazyGoogleRealtimeVoiceProvider,
  createLazyGoogleVertexRealtimeVoiceProvider,
} from "./realtime-voice-lazy.js";
import { buildGoogleSpeechProvider } from "./speech-provider.js";

export default {
  speechProviders: [buildGoogleSpeechProvider()],
  realtimeVoiceProviders: [
    createLazyGoogleRealtimeVoiceProvider(),
    createLazyGoogleVertexRealtimeVoiceProvider(),
  ],
} satisfies PluginCapabilityCatalog;
