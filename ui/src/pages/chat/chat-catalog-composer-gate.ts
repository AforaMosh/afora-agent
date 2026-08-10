import type {
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { configPageForSection } from "../config/config-sections.ts";
import type { ChatComposerDisabledBanner } from "./components/chat-composer-types.ts";

type CatalogComposerGate = {
  disabledReason: string | null;
  disabledBanner?: ChatComposerDisabledBanner;
};

export function openCatalogSetup(
  navigate: ApplicationContext["navigate"],
  configPath: string,
): void {
  const section = configPath.split(".")[0];
  navigate(section ? configPageForSection(section) : "advanced", {
    search: `?setting=${encodeURIComponent(configPath)}`,
  });
}

export function resolveCatalogComposerGate(params: {
  catalog: boolean;
  loading: boolean;
  session: SessionCatalogSession | null;
  hostKind?: SessionCatalogHost["kind"];
  onOpenSetup: (configPath: string) => void;
}): CatalogComposerGate {
  if (!params.catalog || params.loading || params.session?.canContinue === true) {
    return { disabledReason: null };
  }
  const disabledReason =
    params.session?.continueDisabledReason ??
    (params.hostKind === "node"
      ? t("chat.catalog.remoteViewOnly")
      : t("chat.catalog.unsupportedViewOnly"));
  const configPath = params.session?.continueSetupConfigPath;
  return {
    disabledReason,
    ...(configPath
      ? {
          disabledBanner: {
            kind: "above-composer",
            text: disabledReason,
            actionLabel: t("chat.catalog.openSettings"),
            onAction: () => params.onOpenSetup(configPath),
          },
        }
      : {}),
  };
}
