// Covers the shared set that every "is this directory my own package root?" walker agrees on.
import { describe, expect, it } from "vitest";
import { isCorePackageName } from "./core-package-names.js";

describe("isCorePackageName", () => {
  // Each accepted name stands for a different on-disk reality, so each is recorded with the
  // reason it cannot be dropped. Callers act on a true answer by deleting or replacing the
  // directory, so a name silently leaving this set turns a repair path off rather than failing.
  it.each([
    ["afora-agent", "this repository's own package.json name"],
    ["afora", "the published package, which is what an install puts on disk"],
    ["openclaw", "a core root installed before the rename, still present on tenant disks"],
  ])("accepts %s: %s", (name) => {
    expect(isCorePackageName(name)).toBe(true);
  });

  // A prefix or substring match would wrongly claim a fork or an unrelated package as our own
  // root, which is a delete on someone else's directory.
  it.each(["afora-agent-extra", "afora-fork", "not-afora", "@afora/plugin-sdk", "openclaw-fork"])(
    "rejects %s",
    (name) => {
      expect(isCorePackageName(name)).toBe(false);
    },
  );

  // A directory with no readable package.json yields no name. Treating that as a core root would
  // let callers delete a directory they never identified.
  it.each([null, undefined, ""])("rejects %s rather than assuming a core root", (name) => {
    expect(isCorePackageName(name)).toBe(false);
  });

  // Callers pass a field parsed straight out of a package.json, where `name` is only claimed to
  // be a string. The narrowing lives here so no caller writes its own typeof check, so a
  // non-string has to be rejected here rather than thrown from a caller that skipped one.
  // The last two hold an accepted name inside a wrapper: a Set membership test that reached them
  // would be answering "does this look related to us?" instead of "is this our own root?".
  it.each([42, true, ["afora"], { name: "afora" }])(
    "rejects %s without throwing",
    (name: unknown) => {
      expect(isCorePackageName(name)).toBe(false);
    },
  );
});
