// Model Catalog Core tests cover provider model id normalize behavior.
import { describe, expect, it } from "vitest";
import {
  isCloudModelSource,
  normalizeGooglePreviewModelId,
} from "./provider-model-id-normalize.js";

describe("provider model id normalization", () => {
  it.each([
    ["glm-5.2:cloud", true],
    ["gpt-oss:120b-cloud", true],
    ["ollama/gpt-oss:120b-cloud", true],
    [" GLM-5.2:CLOUD ", true],
    ["qwen3:8b", false],
    ["qwen3:local", false],
    ["local-cloud", false],
    ["invalid:cloud-cloud", false],
    ["invalid:local:cloud", false],
    ["invalid:local-cloud", false],
    ["invalid:cloud:local", false],
    ["ollama:cloud/model", false],
    ["", false],
    [undefined, false],
  ])("classifies model source %s as hosted=%s", (modelId, expected) => {
    expect(isCloudModelSource(modelId)).toBe(expected);
  });

  it("routes bare Gemini 3 Pro to the current Gemini 3.1 Pro preview", () => {
    expect(normalizeGooglePreviewModelId("gemini-3-pro")).toBe("gemini-3.1-pro-preview");
    expect(normalizeGooglePreviewModelId("gemini-3-pro-preview")).toBe("gemini-3.1-pro-preview");
    expect(normalizeGooglePreviewModelId("gemini-3.1-pro")).toBe("gemini-3.1-pro-preview");
  });

  it("routes provider-prefixed Gemini 3 Pro to the current Gemini 3.1 Pro preview", () => {
    expect(normalizeGooglePreviewModelId("google/gemini-3-pro-preview")).toBe(
      "google/gemini-3.1-pro-preview",
    );
  });

  it("does not rewrite already-current Gemini replacement ids", () => {
    expect(normalizeGooglePreviewModelId("gemini-3.1-pro-preview")).toBe("gemini-3.1-pro-preview");
    expect(normalizeGooglePreviewModelId("gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

  it("maps deprecated flash-lite-preview to GA flash-lite", () => {
    expect(normalizeGooglePreviewModelId("gemini-3.1-flash-lite-preview")).toBe(
      "gemini-3.1-flash-lite",
    );
    expect(normalizeGooglePreviewModelId("google/gemini-3.1-flash-lite-preview")).toBe(
      "google/gemini-3.1-flash-lite",
    );
  });

  it("does not rewrite stable GA flash-lite", () => {
    expect(normalizeGooglePreviewModelId("gemini-3.1-flash-lite")).toBe("gemini-3.1-flash-lite");
  });

  it("routes Gemma 4 26B shorthand to Google's canonical API id", () => {
    expect(normalizeGooglePreviewModelId("gemma-4-26b")).toBe("gemma-4-26b-a4b-it");
    expect(normalizeGooglePreviewModelId("google/gemma-4-26b")).toBe("google/gemma-4-26b-a4b-it");
  });
});
