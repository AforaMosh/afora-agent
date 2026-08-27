// Git utility tests cover plugin git source parsing, ref normalization, and path
// traversal rejection before managed checkouts are created.
import { describe, expect, it } from "vitest";
import { parseGitUrl } from "./git.js";

describe("parseGitUrl", () => {
  it("parses ordinary hosted git sources", () => {
    expect(parseGitUrl("git:github.com/afora/example-plugin")).toMatchObject({
      type: "git",
      host: "github.com",
      path: "afora-agent/example-plugin",
    });
    expect(parseGitUrl("git:https://example.com/@team/example-plugin")).toMatchObject({
      host: "example.com",
      path: "@team/example-plugin",
    });
  });

  it.each([
    ["git:https://github.com/afora/example-plugin.git@v1.2.3", "github.com"],
    ["git:git@github.com:afora/example-plugin.git@feature/foo", "github.com"],
    ["git:example.com/afora/example-plugin@main", "example.com"],
    ["git:gitlab.com/afora/example-plugin@feature/foo", "gitlab.com"],
    ["git:https://example.com/@team/example-plugin@main", "example.com", "@team/example-plugin"],
  ])("ignores refs in the identity for %s", (source, host, path = "afora-agent/example-plugin") => {
    expect(parseGitUrl(source)).toMatchObject({ host, path });
  });

  it("rejects repository paths that could escape managed checkout roots", () => {
    // Managed plugin checkouts derive local paths from repo path segments, so
    // dot-segments are rejected instead of normalized.
    expect(parseGitUrl("git:https://example.com/afora/../outside")).toBeNull();
    expect(parseGitUrl("git:git@example.com:afora/../outside")).toBeNull();
    expect(parseGitUrl("git:example.com/afora/./outside")).toBeNull();
    expect(parseGitUrl("git:https://github.com/afora/../outside@feature/foo")).toBeNull();
    expect(parseGitUrl("git:https://github.com/afora/%2e%2e/outside")).toBeNull();
    expect(parseGitUrl("git:https://github.com/afora/repo\\..\\outside")).toBeNull();
  });
});
