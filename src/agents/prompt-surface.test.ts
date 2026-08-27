// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildAforaToolFallbackText } from "./prompt-surface.js";

describe("buildAforaToolFallbackText", () => {
  it("does not invent tool names when the structured list is unavailable", () => {
    const text = buildAforaToolFallbackText({
      surface: "afora_main",
    });

    expect(text).toContain("Use only exposed tools");
    expect(text).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
  });
});
