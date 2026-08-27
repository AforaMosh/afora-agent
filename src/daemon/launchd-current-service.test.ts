// Launchd current service tests cover resolving active macOS service labels.
import { describe, expect, it } from "vitest";
import { isCurrentProcessLaunchdServiceLabel } from "./launchd-current-service.js";

describe("isCurrentProcessLaunchdServiceLabel", () => {
  it("matches launchd-provided service labels", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel("ai.afora.gateway", {
        LAUNCH_JOB_LABEL: "ai.afora.gateway",
      }),
    ).toBe(true);
  });

  it("falls back to Afora service markers when XPC_SERVICE_NAME is inherited", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel("ai.afora.gateway", {
        XPC_SERVICE_NAME: "0",
        AFORA_SERVICE_MARKER: "afora",
        AFORA_SERVICE_KIND: "gateway",
        AFORA_LAUNCHD_LABEL: "ai.afora.gateway",
      }),
    ).toBe(true);
  });

  it("preserves label-only fallback when launchd exposes no label variables", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel("ai.afora.gateway", {
        AFORA_LAUNCHD_LABEL: "ai.afora.gateway",
      }),
    ).toBe(true);
  });

  it("can require service markers for label-only fallback", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel(
        "ai.afora.gateway",
        {
          AFORA_LAUNCHD_LABEL: "ai.afora.gateway",
        },
        { allowConfiguredLabelFallback: false },
      ),
    ).toBe(false);
  });

  it("does not treat unrelated inherited launchd labels as current services", () => {
    expect(
      isCurrentProcessLaunchdServiceLabel("ai.afora.gateway", {
        XPC_SERVICE_NAME: "0",
        AFORA_LAUNCHD_LABEL: "ai.afora.gateway",
      }),
    ).toBe(false);
  });
});
