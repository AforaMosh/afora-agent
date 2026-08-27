// Frontmatter tests cover shared Markdown frontmatter parsing helpers.
import { describe, expect, it, test } from "vitest";
import {
  applyAforaManifestInstallCommonFields,
  getFrontmatterString,
  normalizeStringList,
  parseFrontmatterBool,
  parseAforaManifestInstallBase,
  resolveAforaManifestBlock,
  resolveAforaManifestInstall,
  resolveAforaManifestOs,
  resolveAforaManifestRequires,
} from "./frontmatter.js";

function expectInstallBase(
  parsed: ReturnType<typeof parseAforaManifestInstallBase>,
): NonNullable<ReturnType<typeof parseAforaManifestInstallBase>> {
  if (parsed === undefined) {
    throw new Error("Expected manifest install base");
  }
  return parsed;
}

describe("shared/frontmatter", () => {
  test("normalizeStringList handles strings, arrays, and non-list values", () => {
    expect(normalizeStringList("a, b,,c")).toEqual(["a", "b", "c"]);
    expect(normalizeStringList([" a ", "", "b", 42])).toEqual(["a", "b", "42"]);
    expect(normalizeStringList(null)).toStrictEqual([]);
  });

  test("getFrontmatterString extracts strings only", () => {
    expect(getFrontmatterString({ a: "b" }, "a")).toBe("b");
    expect(getFrontmatterString({ a: 1 }, "a")).toBeUndefined();
  });

  test("parseFrontmatterBool respects explicit values and fallback", () => {
    expect(parseFrontmatterBool("true", false)).toBe(true);
    expect(parseFrontmatterBool("false", true)).toBe(false);
    expect(parseFrontmatterBool(undefined, true)).toBe(true);
    expect(parseFrontmatterBool("maybe", false)).toBe(false);
  });

  test("resolveAforaManifestBlock reads current manifest keys and custom metadata fields", () => {
    expect(
      resolveAforaManifestBlock({
        frontmatter: {
          metadata: "{ afora: { foo: 1, bar: 'baz' } }",
        },
      }),
    ).toEqual({ foo: 1, bar: "baz" });

    expect(
      resolveAforaManifestBlock({
        frontmatter: {
          pluginMeta: "{ afora: { foo: 2 } }",
        },
        key: "pluginMeta",
      }),
    ).toEqual({ foo: 2 });
  });

  test("resolveAforaManifestBlock reads legacy manifest keys", () => {
    expect(
      resolveAforaManifestBlock({
        frontmatter: {
          metadata: "{ clawdbot: { requires: { bins: ['op'] }, install: [] } }",
        },
      }),
    ).toEqual({ requires: { bins: ["op"] }, install: [] });
  });

  test("resolveAforaManifestBlock prefers current manifest keys over legacy keys", () => {
    expect(
      resolveAforaManifestBlock({
        frontmatter: {
          metadata:
            "{ afora: { requires: { bins: ['current'] } }, clawdbot: { requires: { bins: ['legacy'] } } }",
        },
      }),
    ).toEqual({ requires: { bins: ["current"] } });
  });

  test("resolveAforaManifestBlock returns undefined for invalid input", () => {
    expect(resolveAforaManifestBlock({ frontmatter: {} })).toBeUndefined();
    expect(
      resolveAforaManifestBlock({ frontmatter: { metadata: "not-json5" } }),
    ).toBeUndefined();
    expect(resolveAforaManifestBlock({ frontmatter: { metadata: "123" } })).toBeUndefined();
    expect(resolveAforaManifestBlock({ frontmatter: { metadata: "[]" } })).toBeUndefined();
    expect(
      resolveAforaManifestBlock({ frontmatter: { metadata: "{ nope: { a: 1 } }" } }),
    ).toBeUndefined();
  });

  it("normalizes manifest requirement and os lists", () => {
    expect(
      resolveAforaManifestRequires({
        requires: {
          bins: "bun, node",
          anyBins: [" ffmpeg ", ""],
          env: ["AFORA_TOKEN", " AFORA_URL "],
          config: null,
        },
      }),
    ).toEqual({
      bins: ["bun", "node"],
      anyBins: ["ffmpeg"],
      env: ["AFORA_TOKEN", "AFORA_URL"],
      config: [],
    });
    expect(resolveAforaManifestRequires({})).toBeUndefined();
    expect(resolveAforaManifestOs({ os: [" darwin ", "linux", ""] })).toEqual([
      "darwin",
      "linux",
    ]);
  });

  it("parses and applies install common fields", () => {
    const parsed = parseAforaManifestInstallBase(
      {
        type: " Brew ",
        id: "brew.git",
        label: "Git",
        bins: [" git ", "git"],
      },
      ["brew", "npm"],
    );

    expect(parsed).toEqual({
      raw: {
        type: " Brew ",
        id: "brew.git",
        label: "Git",
        bins: [" git ", "git"],
      },
      kind: "brew",
      id: "brew.git",
      label: "Git",
      bins: ["git", "git"],
    });
    expect(parseAforaManifestInstallBase({ kind: "bad" }, ["brew"])).toBeUndefined();
    expect(
      applyAforaManifestInstallCommonFields<{
        extra: boolean;
        id?: string;
        label?: string;
        bins?: string[];
      }>({ extra: true }, expectInstallBase(parsed)),
    ).toEqual({
      extra: true,
      id: "brew.git",
      label: "Git",
      bins: ["git", "git"],
    });
  });

  it("prefers explicit kind, ignores invalid common fields, and leaves missing ones untouched", () => {
    const parsed = parseAforaManifestInstallBase(
      {
        kind: " npm ",
        type: "brew",
        id: 42,
        label: null,
        bins: [" ", ""],
      },
      ["brew", "npm"],
    );

    expect(parsed).toEqual({
      raw: {
        kind: " npm ",
        type: "brew",
        id: 42,
        label: null,
        bins: [" ", ""],
      },
      kind: "npm",
    });
    expect(
      applyAforaManifestInstallCommonFields(
        { id: "keep", label: "Keep", bins: ["bun"] },
        parsed!,
      ),
    ).toEqual({
      id: "keep",
      label: "Keep",
      bins: ["bun"],
    });
  });

  it("maps install entries through the parser and filters rejected specs", () => {
    expect(
      resolveAforaManifestInstall(
        {
          install: [{ id: "keep" }, { id: "drop" }, "bad"],
        },
        (entry) => {
          if (
            typeof entry === "object" &&
            entry !== null &&
            (entry as { id?: string }).id === "keep"
          ) {
            return { id: "keep" };
          }
          return undefined;
        },
      ),
    ).toEqual([{ id: "keep" }]);
  });
});
