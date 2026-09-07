// Verifies legacy public names still map to current exports where supported.
import { describe, expect, it } from "vitest";
import {
  isManifestSection,
  LEGACY_MANIFEST_KEYS,
  MANIFEST_KEY,
  MANIFEST_KEYS,
  manifestSectionDeclares,
  readManifestSection,
} from "./legacy-names.js";

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

  it("orders the read list canonical first", () => {
    expect(MANIFEST_KEYS).toEqual([MANIFEST_KEY, ...LEGACY_MANIFEST_KEYS]);
  });
});

describe("compat/legacy-names readManifestSection", () => {
  const declaresExtensions = manifestSectionDeclares("extensions");

  // This is the divergence table. Before it existed, three readers of the same package.json used
  // three different acceptance predicates: the plugin loader took the first key that was not
  // `undefined`, the frontmatter parser took the first truthy object, and the deep-scan scanner
  // took the first key whose `extensions` was an array. They agreed on the shapes anybody had
  // thought to try and disagreed everywhere else, and the direction that matters is the one where
  // the loader runs an entrypoint the scanner never looked at.
  const CURRENT = { extensions: ["./current.js"] };
  const LEGACY = { extensions: ["./legacy.js"] };

  it.each([
    {
      name: "canonical only",
      manifest: { afora: CURRENT },
      expected: CURRENT,
    },
    {
      name: "legacy only",
      manifest: { openclaw: LEGACY },
      expected: LEGACY,
    },
    {
      name: "both declare the field, canonical wins",
      manifest: { afora: CURRENT, openclaw: LEGACY },
      expected: CURRENT,
    },
    {
      name: "canonical section without the field must not shadow a legacy one with it",
      manifest: { afora: { plugin: { id: "x" } }, openclaw: LEGACY },
      expected: LEGACY,
    },
    {
      name: "an empty canonical section must not shadow a legacy one",
      manifest: { afora: {}, openclaw: LEGACY },
      expected: LEGACY,
    },
    {
      name: "a null canonical section must not shadow a legacy one",
      manifest: { afora: null, openclaw: LEGACY },
      expected: LEGACY,
    },
    {
      name: "the oldest spelling is read when it is the only one",
      manifest: { clawdbot: LEGACY },
      expected: LEGACY,
    },
    {
      name: "an explicitly empty extensions list is a statement, not an absence",
      manifest: { afora: { extensions: [] }, openclaw: LEGACY },
      expected: { extensions: [] },
    },
  ])("selects the right section: $name", ({ manifest, expected }) => {
    expect(readManifestSection(manifest, declaresExtensions)).toEqual(expected);
  });

  it("falls back to the first section-shaped value when no section declares the field", () => {
    const manifest = { afora: { plugin: { id: "x" } }, openclaw: { plugin: { id: "y" } } };
    expect(readManifestSection(manifest, declaresExtensions)).toEqual(manifest.afora);
  });

  // The callers that report a malformed manifest have to keep seeing the malformed value. If the
  // resolver swallowed it, `plugins install` would answer "missing" for a package.json whose
  // `afora` key is a string, which reads as "you declared nothing" rather than "this is wrong".
  it("surfaces a malformed section rather than reporting it absent", () => {
    expect(readManifestSection({ afora: "invalid" }, declaresExtensions)).toBe("invalid");
    expect(readManifestSection({ afora: null }, declaresExtensions)).toBe(null);
    expect(readManifestSection({ afora: ["./a.js"] }, declaresExtensions)).toEqual(["./a.js"]);
  });

  it("returns undefined when no manifest key is present at all", () => {
    expect(readManifestSection({ name: "bare" }, declaresExtensions)).toBeUndefined();
    expect(readManifestSection(undefined, declaresExtensions)).toBeUndefined();
    expect(readManifestSection("not an object", declaresExtensions)).toBeUndefined();
  });

  it("treats an array as a non-section, so a section's fields cannot be read off one", () => {
    expect(isManifestSection([])).toBe(false);
    expect(isManifestSection(null)).toBe(false);
    expect(isManifestSection({})).toBe(true);
  });

  it("reads a plain section with no predicate", () => {
    const manifest = { afora: { channel: { id: "c" } }, openclaw: LEGACY };
    expect(readManifestSection(manifest)).toEqual(manifest.afora);
  });
});
