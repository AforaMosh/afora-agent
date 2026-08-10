import { describe, expect, it, vi } from "vitest";
import { openCatalogSetup, resolveCatalogComposerGate } from "./chat-catalog-composer-gate.ts";

describe("catalog composer capability gate", () => {
  it("keeps a setup-backed unavailable session disabled with its provider reason", () => {
    const onOpenSetup = vi.fn();
    const result = resolveCatalogComposerGate({
      catalog: true,
      loading: false,
      session: {
        threadId: "thread-disabled",
        status: "idle",
        archived: false,
        canContinue: false,
        continueDisabledReason:
          "Codex supervision is disabled. Enable it to continue this session.",
        continueSetupConfigPath: "plugins.entries.codex.config.supervision.enabled",
        canArchive: true,
      },
      hostKind: "gateway",
      onOpenSetup,
    });

    expect(result).toMatchObject({
      disabledReason: "Codex supervision is disabled. Enable it to continue this session.",
      disabledBanner: {
        kind: "above-composer",
        text: "Codex supervision is disabled. Enable it to continue this session.",
        actionLabel: "Open settings",
      },
    });
    result.disabledBanner?.onAction();
    expect(onOpenSetup).toHaveBeenCalledWith("plugins.entries.codex.config.supervision.enabled");
  });

  it("routes a setup path to its owning settings page", () => {
    const navigate = vi.fn();
    openCatalogSetup(navigate, "plugins.entries.codex.config.supervision.enabled");
    expect(navigate).toHaveBeenCalledWith("automation", {
      search: "?setting=plugins.entries.codex.config.supervision.enabled",
    });
  });

  it("does not disable a continuable or still-loading catalog session", () => {
    expect(
      resolveCatalogComposerGate({
        catalog: true,
        loading: true,
        session: null,
        onOpenSetup: vi.fn(),
      }),
    ).toEqual({ disabledReason: null });
    expect(
      resolveCatalogComposerGate({
        catalog: true,
        loading: false,
        session: {
          threadId: "thread-ready",
          status: "idle",
          archived: false,
          canContinue: true,
          canArchive: false,
        },
        onOpenSetup: vi.fn(),
      }),
    ).toEqual({ disabledReason: null });
  });
});
