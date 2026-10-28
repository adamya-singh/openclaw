import { isIntermediateAssistantTranscriptMessage } from "../../agents/embedded-agent-runner/message-visibility.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "../../agents/harness/transcript-visibility.js";
import type { PrepareAssistantTranscriptMessage } from "../../config/sessions/transcript-assistant-delivery.js";

// Spoken transcripts own the final Chat answer. Keep the consult's answer in
// audit/model history without hiding tool work, progress, or interrupted replies.
export const prepareTalkAgentConsultTranscript: PrepareAssistantTranscriptMessage = (message) =>
  projectAgentHarnessTranscriptMessageForDisplay({
    hidden:
      message.stopReason === "stop" &&
      !isIntermediateAssistantTranscriptMessage(message) &&
      !message.content.some((block) => block.type === "toolCall"),
    message,
  });

// Forced routing speaks the final answer verbatim, so the spoken mirror already carries it.
// Keeping both in model history shows the model each answer twice, and it starts repeating
// itself in later turns; the hidden final stays for audit only.
export const prepareForcedTalkAgentConsultTranscript: PrepareAssistantTranscriptMessage = (
  message,
  sourceText,
) => {
  const prepared = prepareTalkAgentConsultTranscript(message, sourceText);
  return Reflect.get(prepared, "display") === false
    ? Object.assign({}, prepared, { excludeFromContext: true as const })
    : prepared;
};
