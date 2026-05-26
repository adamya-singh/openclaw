import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { buildTelegramNativeCommandCallbackData } from "./bot-native-commands.js";
import {
  resolveTelegramInlineButtonsScope,
  resolveTelegramTargetChatType,
} from "./inline-buttons.js";
import {
  buildBrowseProvidersButton,
  buildModelsKeyboard,
  buildProviderKeyboard,
  type ProviderInfo,
} from "./model-buttons.js";

type TelegramCommandChannelData = Record<string, unknown>;

export function buildCommandsPaginationKeyboard(
  currentPage: number,
  totalPages: number,
  agentId?: string,
): Array<Array<{ text: string; callback_data: string }>> {
  const buttons: Array<{ text: string; callback_data: string }> = [];
  const suffix = agentId ? `:${agentId}` : "";

  if (currentPage > 1) {
    buttons.push({
      text: "◀ Prev",
      callback_data: `commands_page_${currentPage - 1}${suffix}`,
    });
  }

  buttons.push({
    text: `${currentPage}/${totalPages}`,
    callback_data: `commands_page_noop${suffix}`,
  });

  if (currentPage < totalPages) {
    buttons.push({
      text: "Next ▶",
      callback_data: `commands_page_${currentPage + 1}${suffix}`,
    });
  }

  return [buttons];
}

export function buildTelegramCommandsListChannelData(params: {
  currentPage: number;
  totalPages: number;
  agentId?: string;
}): TelegramCommandChannelData | null {
  if (params.totalPages <= 1) {
    return null;
  }
  return {
    telegram: {
      buttons: buildCommandsPaginationKeyboard(
        params.currentPage,
        params.totalPages,
        params.agentId,
      ),
    },
  };
}

export function buildTelegramModelsProviderChannelData(params: {
  providers: ProviderInfo[];
}): TelegramCommandChannelData | null {
  if (params.providers.length === 0) {
    return null;
  }
  return {
    telegram: {
      buttons: buildProviderKeyboard(params.providers),
    },
  };
}

export function buildTelegramModelsListChannelData(params: {
  provider: string;
  models: readonly string[];
  currentModel?: string;
  currentPage: number;
  totalPages: number;
  pageSize?: number;
  modelNames?: ReadonlyMap<string, string>;
}): TelegramCommandChannelData | null {
  return {
    telegram: {
      buttons: buildModelsKeyboard(params),
    },
  };
}

export function buildTelegramModelBrowseChannelData(): TelegramCommandChannelData {
  return {
    telegram: {
      buttons: buildBrowseProvidersButton(),
    },
  };
}

export function buildTelegramContextBloatWarningChannelData(params: {
  cfg: OpenClawConfig;
  to: string;
  accountId?: string | null;
}): TelegramCommandChannelData | null {
  const scope = resolveTelegramInlineButtonsScope({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const chatType = resolveTelegramTargetChatType(params.to);
  if (
    scope === "off" ||
    (scope === "dm" && chatType !== "direct") ||
    (scope === "group" && chatType !== "group")
  ) {
    return null;
  }
  return {
    telegram: {
      buttons: [
        [
          {
            text: "Reset context",
            callback_data: buildTelegramNativeCommandCallbackData("/reset"),
            style: "danger",
          },
          {
            text: "Compact context",
            callback_data: buildTelegramNativeCommandCallbackData("/compact"),
            style: "primary",
          },
        ],
      ],
    },
  };
}
