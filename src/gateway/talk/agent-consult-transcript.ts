import { isIntermediateAssistantTranscriptMessage } from "../../agents/embedded-agent-runner/message-visibility.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "../../agents/harness/transcript-visibility.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";

// Spoken transcripts own the final Chat answer. Keep the consult's answer for audit
// without hiding tool work, progress, or interrupted replies. The hidden final also
// leaves model context: the spoken mirror right after it carries the same answer, and
// seeing every answer twice made the model repeat its replies two or three times.
export const prepareTalkAgentConsultTranscript: PrepareAssistantTranscriptMessage = (message) => {
  const prepared = projectAgentHarnessTranscriptMessageForDisplay({
    hidden:
      message.stopReason === "stop" &&
      !isIntermediateAssistantTranscriptMessage(message) &&
      !message.content.some((block) => block.type === "toolCall"),
    message,
  });
  return Reflect.get(prepared, "display") === false
    ? Object.assign({}, prepared, { excludeFromContext: true as const })
    : prepared;
};
