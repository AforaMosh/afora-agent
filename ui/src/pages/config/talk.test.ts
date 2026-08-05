/* @vitest-environment jsdom */

import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderTalk } from "./talk.ts";

function talkProps(configBusy: boolean): Parameters<typeof renderTalk>[0] {
  return {
    selection: {
      provider: "openai",
      model: "gpt-live",
      speakerVoice: "marin",
      transport: "webrtc",
      providerEntries: {},
    },
    catalog: {
      kind: "ready",
      ready: true,
      activeProvider: "openai",
      providers: [
        {
          id: "openai",
          label: "OpenAI",
          configured: true,
          aliases: [],
          models: ["gpt-live"],
          voices: ["marin"],
          transports: ["webrtc"],
          defaultModel: "gpt-live",
        },
      ],
    },
    configBusy,
    onProviderChange: vi.fn(),
    onModelChange: vi.fn(),
    onVoiceChange: vi.fn(),
    editor: html``,
  };
}

describe("renderTalk", () => {
  it("locks every curated picker when config mutation is unavailable", () => {
    const container = document.createElement("div");
    render(renderTalk(talkProps(true)), container);

    const provider = container.querySelector<HTMLElement & { disabled?: boolean }>(
      "wa-radio-group",
    );
    expect(provider?.disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLSelectElement>("select")]).toHaveLength(2);
    expect(
      [...container.querySelectorAll<HTMLSelectElement>("select")].every(
        (select) => select.disabled,
      ),
    ).toBe(true);
  });

  it("keeps experimental enrollment guidance out of the provider picker", () => {
    const container = document.createElement("div");
    render(renderTalk(talkProps(false)), container);

    const text = container.textContent?.replace(/\s+/gu, " ") ?? "";
    expect(text).toContain("OpenAI");
    expect(text).not.toContain("Boulder");
    expect(text).not.toContain("Platform API key");
  });
});
