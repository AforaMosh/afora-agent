import { html, type TemplateResult } from "lit";
import type { ModelsProbeResult } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { renderDocsLink } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { modelProviderErrorMessage } from "./config-mutation.ts";

const MODEL_PROVIDERS_DOCS_URL = "https://docs.openclaw.ai/concepts/model-providers";
const PROBE_FAILURE_PRIORITY: readonly ModelsProbeResult["status"][] = [
  "auth",
  "billing",
  "rate_limit",
  "timeout",
  "format",
  "no_model",
  "unknown",
];

type AgentScopeProps = Parameters<typeof renderAgentScopeControl>[0];

export function isMissingMethodError(error: unknown): boolean {
  return /method (?:not found|not supported)|unknown method/iu.test(
    modelProviderErrorMessage(error),
  );
}

export function mergeProbeResults(cardId: string, results: ModelsProbeResult[]): ModelsProbeResult {
  if (results.length === 1) {
    return results[0]!;
  }
  const status = results.some((result) => result.status === "ok")
    ? "ok"
    : (PROBE_FAILURE_PRIORITY.find((candidate) =>
        results.some((result) => result.status === candidate),
      ) ?? "unknown");
  const error = results.find((result) => result.status === status)?.error;
  return {
    provider: cardId,
    status,
    ...(error ? { error } : {}),
    results: results.flatMap((result) =>
      result.results.map((target) => ({
        ...target,
        label: `${result.provider}: ${target.label}`,
      })),
    ),
  };
}

export function renderModelProvidersPageChrome(props: {
  body: TemplateResult;
  agents: AgentScopeProps["agents"];
  selection: AgentScopeProps["selection"];
  selectedId: string;
  onOpenModelSetup: () => void;
}) {
  return html`
    <section class="content-header">
      <div>
        <div class="page-title">${titleForRoute("model-providers")}</div>
        <div class="page-subtitle">
          ${t("modelProviders.subtitle")}
          ${renderDocsLink(MODEL_PROVIDERS_DOCS_URL, t("common.learnMore"))}
        </div>
      </div>
      <div class="page-header-actions">
        ${renderAgentScopeControl({
          agents: props.agents,
          selection: props.selection,
          allowAll: false,
          selectedId: props.selectedId,
        })}
        <button class="btn" @click=${props.onOpenModelSetup}>${t("tabs.modelSetup")}</button>
      </div>
    </section>
    ${renderSettingsWorkspace(props.body)}
  `;
}
