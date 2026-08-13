/**
 * Warns once per Codex runtime when an explicitly enabled app is unavailable
 * to the signed-in account.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { serializeCodexAppInventoryError } from "./app-inventory-cache.js";
import type { CodexAppServerClient } from "./client.js";
import { isJsonObject } from "./protocol.js";

type ConfiguredAppAvailabilityCheckParams = {
  client: Pick<CodexAppServerClient, "request">;
  appCacheKey: string;
  configCwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

/** Coalesces live configured-app checks and logs each runtime result once. */
export class CodexConfiguredAppAvailabilityMonitor {
  private readonly checks = new Map<string, Promise<void>>();

  check(params: ConfiguredAppAvailabilityCheckParams): Promise<void> {
    const checkKey = `${params.appCacheKey}\0${params.configCwd ?? ""}`;
    const existing = this.checks.get(checkKey);
    if (existing) {
      return existing;
    }

    const check = this.checkOnce(params).catch((error) => {
      this.checks.delete(checkKey);
      embeddedAgentLog.warn("configured Codex app availability check failed", {
        error: serializeCodexAppInventoryError(error),
      });
    });
    this.checks.set(checkKey, check);
    return check;
  }

  private async checkOnce(params: ConfiguredAppAvailabilityCheckParams): Promise<void> {
    const options = { timeoutMs: params.timeoutMs, signal: params.signal };
    const configResponse = await params.client.request(
      "config/read",
      {
        includeLayers: false,
        ...(params.configCwd ? { cwd: params.configCwd } : {}),
      },
      options,
    );
    const configuredAppIds = resolveExplicitlyEnabledAppIds(configResponse.config);
    if (configuredAppIds.length === 0) {
      return;
    }

    const installed = await params.client.request("app/installed", { forceRefresh: true }, options);
    const installedAppIds = new Set(installed.apps.map((app) => app.id));
    for (const appId of configuredAppIds) {
      if (installedAppIds.has(appId)) {
        continue;
      }
      embeddedAgentLog.warn(
        "configured Codex app is unavailable; install or authorize it to expose its tools",
        {
          appId,
          state: "not_installed_or_authorized",
        },
      );
    }
  }
}

export const defaultCodexConfiguredAppAvailabilityMonitor =
  new CodexConfiguredAppAvailabilityMonitor();

function resolveExplicitlyEnabledAppIds(config: unknown): string[] {
  if (!isJsonObject(config) || !isJsonObject(config.apps)) {
    return [];
  }
  return Object.entries(config.apps)
    .flatMap(([appId, value]) =>
      appId !== "_default" && isJsonObject(value) && value.enabled === true ? [appId] : [],
    )
    .toSorted();
}
