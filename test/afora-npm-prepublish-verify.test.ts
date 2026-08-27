import { describe, expect, it } from "vitest";
import {
  aforaNpmPrepublishVerifyUsage,
  parseAforaNpmPrepublishVerifyArgs,
  usesPreparedLocalDependencyInstall,
} from "../scripts/afora-npm-prepublish-verify.ts";

describe("parseAforaNpmPrepublishVerifyArgs", () => {
  it("supports help, optional versions, and package-manager separators", () => {
    expect(parseAforaNpmPrepublishVerifyArgs(["--help"])).toEqual({
      dependencyTarballPaths: [],
      help: true,
      tarballPath: "",
    });
    expect(parseAforaNpmPrepublishVerifyArgs(["afora.tgz"])).toEqual({
      dependencyTarballPaths: [],
      help: false,
      tarballPath: "afora.tgz",
    });
    expect(parseAforaNpmPrepublishVerifyArgs(["--", "afora.tgz", "2026.3.23"])).toEqual({
      dependencyTarballPaths: [],
      expectedVersion: "2026.3.23",
      help: false,
      tarballPath: "afora.tgz",
    });
  });

  it("rejects missing, option-like, and extra arguments before installing", () => {
    expect(() => parseAforaNpmPrepublishVerifyArgs([])).toThrow(
      aforaNpmPrepublishVerifyUsage(),
    );
    expect(() => parseAforaNpmPrepublishVerifyArgs(["--tag"])).toThrow(
      "Unknown afora npm prepublish verifier option: --tag",
    );
    expect(() => parseAforaNpmPrepublishVerifyArgs(["afora.tgz", "--tag"])).toThrow(
      "Unknown afora npm prepublish verifier option: --tag",
    );
    expect(
      parseAforaNpmPrepublishVerifyArgs(["afora.tgz", "2026.3.23", "llm-core.tgz", "ai.tgz"]),
    ).toEqual({
      dependencyTarballPaths: ["llm-core.tgz", "ai.tgz"],
      expectedVersion: "2026.3.23",
      help: false,
      tarballPath: "afora.tgz",
    });
    expect(() =>
      parseAforaNpmPrepublishVerifyArgs(["afora.tgz", "2026.3.23", "--bad"]),
    ).toThrow("Invalid dependency tarball path: --bad");
  });
});

describe("usesPreparedLocalDependencyInstall", () => {
  it("uses the prepared local project only for the single AI tarball release path", () => {
    expect(usesPreparedLocalDependencyInstall(0)).toBe(false);
    expect(usesPreparedLocalDependencyInstall(1)).toBe(true);
    expect(usesPreparedLocalDependencyInstall(2)).toBe(false);
  });
});
