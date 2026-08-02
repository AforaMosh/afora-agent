import { describe, expect, it } from "vitest";
import {
  isCronWebhookTokenDestinationAllowed,
  normalizeCronWebhookTokenDestination,
  resolveCronWebhookTokenDestinations,
} from "./cron-webhook-token-destinations.js";

describe("cron webhook token destinations", () => {
  it.each([
    ["https://hooks.example.com/cron", "https://hooks.example.com/cron"],
    ["https://hooks.example.com:443/cron", "https://hooks.example.com/cron"],
    ["https://hooks.example.com./cron", "https://hooks.example.com/cron"],
    ["http://hooks.example.com/cron", null],
    ["https://user@hooks.example.com/cron", null],
    ["https://*.example.com/cron", null],
    ["https://hooks.example.com/cron#fragment", null],
  ])("normalizes %s", (value, expected) => {
    expect(normalizeCronWebhookTokenDestination(value)).toBe(expected);
  });

  it("preserves legacy bearer delivery until destination scoping is configured", () => {
    expect(isCronWebhookTokenDestinationAllowed("http://any.example/hook", undefined)).toBe(true);
  });

  it("treats an explicit empty list as allowing no destinations", () => {
    expect(isCronWebhookTokenDestinationAllowed("https://hooks.example.com/cron", new Set())).toBe(
      false,
    );
  });

  it("matches the exact normalized URL including path and query", () => {
    const destinations = resolveCronWebhookTokenDestinations([
      "https://hooks.example.com/cron?tenant=ops",
    ]);
    expect(
      isCronWebhookTokenDestinationAllowed(
        "https://hooks.example.com/cron?tenant=ops",
        destinations,
      ),
    ).toBe(true);
    expect(
      isCronWebhookTokenDestinationAllowed(
        "https://hooks.example.com/cron?tenant=other",
        destinations,
      ),
    ).toBe(false);
  });
});
