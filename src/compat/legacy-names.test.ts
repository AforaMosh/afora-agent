// Verifies legacy public names still map to current exports where supported.
import { describe, expect, it } from "vitest";
import { LEGACY_MANIFEST_KEYS, MANIFEST_KEY } from "./legacy-names.js";

describe("compat/legacy-names", () => {
  it("keeps the current manifest key primary while exposing legacy fallbacks", () => {
    expect(MANIFEST_KEY).toBe("afora");
    expect(LEGACY_MANIFEST_KEYS).toEqual(["openclaw", "clawdbot"]);
  });

  it("does not list the canonical key as a legacy fallback", () => {
    // Readers iterate [MANIFEST_KEY, ...LEGACY_MANIFEST_KEYS] and take the first hit, so a
    // duplicate here would silently make the fallback order meaningless.
    expect(LEGACY_MANIFEST_KEYS).not.toContain(MANIFEST_KEY);
  });
});
