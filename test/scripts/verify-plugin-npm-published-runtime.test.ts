// Verify Plugin Npm Published Runtime tests cover verify plugin npm published runtime script behavior.
import { describe, expect, it } from "vitest";
import {
  collectPluginNpmPublishedRuntimeErrors,
  findPackedPackageReadmePath,
  parseVerifyPublishedPluginRuntimeArgs,
  parseNpmReadmeMetadata,
  readPluginNpmCommandOptions,
  readPositiveIntEnv,
  resolveNpmPackFilename,
  runPluginNpmCommand,
  usage,
} from "../../scripts/verify-plugin-npm-published-runtime.mts";

describe("plugin npm publish verifier args", () => {
  it("parses help and package specs before npm calls", () => {
    expect(parseVerifyPublishedPluginRuntimeArgs(["--help"])).toEqual({ help: true, spec: "" });
    expect(parseVerifyPublishedPluginRuntimeArgs(["--", "@afora/discord@2026.5.2"])).toEqual({
      help: false,
      spec: "@afora/discord@2026.5.2",
    });
  });

  it("rejects unknown and extra args before npm calls", () => {
    expect(() => parseVerifyPublishedPluginRuntimeArgs([])).toThrow(usage());
    expect(() => parseVerifyPublishedPluginRuntimeArgs(["--wat"])).toThrow(
      "Unknown plugin npm verifier option: --wat",
    );
    expect(() =>
      parseVerifyPublishedPluginRuntimeArgs(["@afora/discord@2026.5.2", "extra"]),
    ).toThrow("Unexpected plugin npm verifier argument: extra");
  });
});

describe("plugin npm publish verifier retry limits", () => {
  it("rejects loose numeric retry env values instead of parsing prefixes", () => {
    expect(() =>
      readPositiveIntEnv("AFORA_PLUGIN_NPM_VERIFY_ATTEMPTS", 90, {
        AFORA_PLUGIN_NPM_VERIFY_ATTEMPTS: "2tries",
      }),
    ).toThrow("invalid AFORA_PLUGIN_NPM_VERIFY_ATTEMPTS: 2tries");
    expect(() =>
      readPositiveIntEnv("AFORA_PLUGIN_NPM_VERIFY_DELAY_MS", 10000, {
        AFORA_PLUGIN_NPM_VERIFY_DELAY_MS: "1e3",
      }),
    ).toThrow("invalid AFORA_PLUGIN_NPM_VERIFY_DELAY_MS: 1e3");
    expect(() =>
      readPositiveIntEnv("AFORA_PLUGIN_NPM_README_VERIFY_ATTEMPTS", 6, {
        AFORA_PLUGIN_NPM_README_VERIFY_ATTEMPTS: "0",
      }),
    ).toThrow("invalid AFORA_PLUGIN_NPM_README_VERIFY_ATTEMPTS: 0");
  });

  it("accepts strict positive retry env values and defaults", () => {
    expect(readPositiveIntEnv("AFORA_PLUGIN_NPM_VERIFY_ATTEMPTS", 90, {})).toBe(90);
    expect(
      readPositiveIntEnv("AFORA_PLUGIN_NPM_README_VERIFY_DELAY_MS", 10000, {
        AFORA_PLUGIN_NPM_README_VERIFY_DELAY_MS: "2500",
      }),
    ).toBe(2500);
  });
});

describe("plugin npm publish verifier command limits", () => {
  it("bounds npm command runtime and captured output by default", () => {
    expect(readPluginNpmCommandOptions({})).toStrictEqual({
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60 * 1000,
    });
  });

  it("accepts strict npm command timeout and buffer overrides", () => {
    expect(
      readPluginNpmCommandOptions({
        AFORA_PLUGIN_NPM_COMMAND_MAX_BUFFER_BYTES: "33554432",
        AFORA_PLUGIN_NPM_COMMAND_TIMEOUT_MS: "120000",
      }),
    ).toMatchObject({
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120000,
    });
  });

  it("rejects loose npm command timeout and buffer overrides", () => {
    expect(() =>
      readPluginNpmCommandOptions({
        AFORA_PLUGIN_NPM_COMMAND_TIMEOUT_MS: "60s",
      }),
    ).toThrow("invalid AFORA_PLUGIN_NPM_COMMAND_TIMEOUT_MS: 60s");
    expect(() =>
      readPluginNpmCommandOptions({
        AFORA_PLUGIN_NPM_COMMAND_MAX_BUFFER_BYTES: "16mb",
      }),
    ).toThrow("invalid AFORA_PLUGIN_NPM_COMMAND_MAX_BUFFER_BYTES: 16mb");
  });

  it("runs npm metadata commands with bounded exec options", () => {
    const calls: unknown[] = [];
    const output = runPluginNpmCommand(["view", "@afora/discord", "readme"], {
      env: {
        AFORA_PLUGIN_NPM_COMMAND_MAX_BUFFER_BYTES: "1024",
        AFORA_PLUGIN_NPM_COMMAND_TIMEOUT_MS: "2500",
      },
      execFileSyncImpl(command: string, args: string[], options: unknown) {
        calls.push({ args, command, options });
        return JSON.stringify("# Discord");
      },
    });

    expect(output).toBe(JSON.stringify("# Discord"));
    expect(calls).toStrictEqual([
      {
        args: ["view", "@afora/discord", "readme"],
        command: "npm",
        options: {
          encoding: "utf8",
          killSignal: "SIGKILL",
          maxBuffer: 1024,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 2500,
        },
      },
    ]);
  });
});

describe("collectPluginNpmPublishedRuntimeErrors", () => {
  it("flags published plugin packages with TypeScript entries and no compiled runtime output", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        spec: "@afora/discord@2026.5.2",
        packageJson: {
          name: "@afora/discord",
          version: "2026.5.2",
          afora: {
            extensions: ["./index.ts"],
          },
        },
        files: ["package.json", "afora.plugin.json", "index.ts"],
      }),
    ).toEqual([
      "@afora/discord@2026.5.2 requires compiled runtime output for TypeScript entry ./index.ts: expected ./dist/index.js, ./dist/index.mjs, ./dist/index.cjs, ./index.js, ./index.mjs, ./index.cjs",
    ]);
  });

  it("accepts published plugin packages with explicit runtimeExtensions", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@afora/zalo",
          version: "2026.5.3",
          afora: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
          },
        },
        files: ["package.json", "afora.plugin.json", "index.ts", "dist/index.js"],
      }),
    ).toStrictEqual([]);
  });

  it("flags plugin npm packages without an Afora plugin manifest", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@afora/searxng-plugin",
          version: "2026.6.11",
          afora: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
          },
        },
        files: ["package.json", "dist/index.js"],
      }),
    ).toEqual([
      "@afora/searxng-plugin@2026.6.11 plugin npm package must include afora.plugin.json",
    ]);
  });

  it("flags reservation packages before they can pass plugin runtime verification", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@afora/tavily-plugin",
          version: "0.0.0",
          description: "Bootstrap reservation",
        },
        files: ["package.json", "README.md"],
      }),
    ).toEqual([
      "@afora/tavily-plugin@0.0.0 plugin npm package must include afora.plugin.json",
    ]);
  });

  it("flags missing explicit runtimeExtensions outputs", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@afora/line",
          version: "2026.5.3",
          afora: {
            extensions: ["./src/index.ts"],
            runtimeExtensions: ["./dist/index.js"],
          },
        },
        files: ["package.json", "afora.plugin.json", "src/index.ts"],
      }),
    ).toEqual(["@afora/line@2026.5.3 runtime extension entry not found: ./dist/index.js"]);
  });

  it("flags runtimeExtensions length mismatches", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@afora/acpx",
          version: "2026.5.3",
          afora: {
            extensions: ["./index.ts", "./tools.ts"],
            runtimeExtensions: ["./dist/index.js"],
          },
        },
        files: ["package.json", "afora.plugin.json", "dist/index.js"],
      }),
    ).toEqual([
      "@afora/acpx@2026.5.3 package.json afora.runtimeExtensions length (1) must match afora.extensions length (2)",
    ]);
  });

  it("flags blank runtimeExtensions entries instead of falling back to inferred outputs", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@afora/whatsapp",
          version: "2026.5.3",
          afora: {
            extensions: ["./src/index.ts"],
            runtimeExtensions: [" "],
          },
        },
        files: ["package.json", "afora.plugin.json", "src/index.ts", "dist/index.js"],
      }),
    ).toEqual([
      "@afora/whatsapp@2026.5.3 package.json afora.runtimeExtensions[0] must be a non-empty string",
    ]);
  });

  it("flags published plugin packages with TypeScript setup entries and no compiled setup runtime", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@afora/line",
          version: "2026.5.3",
          afora: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
            setupEntry: "./setup-entry.ts",
          },
        },
        files: [
          "package.json",
          "afora.plugin.json",
          "index.ts",
          "dist/index.js",
          "setup-entry.ts",
        ],
      }),
    ).toEqual([
      "@afora/line@2026.5.3 requires compiled runtime output for TypeScript entry ./setup-entry.ts: expected ./dist/setup-entry.js, ./dist/setup-entry.mjs, ./dist/setup-entry.cjs, ./setup-entry.js, ./setup-entry.mjs, ./setup-entry.cjs",
    ]);
  });

  it("accepts published plugin packages with explicit runtimeSetupEntry", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@afora/example-channel",
          version: "2026.5.3",
          afora: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
            setupEntry: "./setup-entry.ts",
            runtimeSetupEntry: "./dist/setup-entry.js",
          },
        },
        files: ["package.json", "afora.plugin.json", "dist/index.js", "dist/setup-entry.js"],
      }),
    ).toStrictEqual([]);
  });

  it("flags missing explicit runtimeSetupEntry outputs", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@afora/matrix",
          version: "2026.5.3",
          afora: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
            setupEntry: "./setup-entry.ts",
            runtimeSetupEntry: "./dist/setup-entry.js",
          },
        },
        files: ["package.json", "afora.plugin.json", "dist/index.js"],
      }),
    ).toEqual(["@afora/matrix@2026.5.3 runtime setup entry not found: ./dist/setup-entry.js"]);
  });

  it("flags runtimeSetupEntry without setupEntry", () => {
    expect(
      collectPluginNpmPublishedRuntimeErrors({
        packageJson: {
          name: "@afora/twitch",
          version: "2026.5.3",
          afora: {
            extensions: ["./index.ts"],
            runtimeExtensions: ["./dist/index.js"],
            runtimeSetupEntry: "./dist/setup-entry.js",
          },
        },
        files: ["package.json", "afora.plugin.json", "dist/index.js", "dist/setup-entry.js"],
      }),
    ).toEqual([
      "@afora/twitch@2026.5.3 package.json afora.runtimeSetupEntry requires afora.setupEntry",
    ]);
  });
});

describe("resolveNpmPackFilename", () => {
  it("uses the final tarball filename from plain npm pack output", () => {
    const noisyOutput = [
      "npm notice",
      "npm notice package: @afora/msteams@2026.5.24-beta.1",
      "afora-msteams-2026.5.24-beta.1.tgz",
      "",
    ].join("\n");

    expect(resolveNpmPackFilename(noisyOutput)).toBe("afora-msteams-2026.5.24-beta.1.tgz");
  });

  it("rejects path-like tarball output instead of reading outside the pack directory", () => {
    const unsafeOutputs = [
      "../afora-msteams.tgz",
      "nested/afora-msteams.tgz",
      "nested\\afora-msteams.tgz",
      "/tmp/afora-msteams.tgz",
      "C:\\temp\\afora-msteams.tgz",
      "afora-msteams\u0000.tgz",
    ];

    for (const output of unsafeOutputs) {
      expect(() => resolveNpmPackFilename(output)).toThrow(
        "npm pack did not report a tarball filename",
      );
    }
  });
});

describe("findPackedPackageReadmePath", () => {
  it("finds a root package README without accepting nested documentation files", () => {
    expect(
      findPackedPackageReadmePath(["package.json", "docs/README.md", "README.md", "dist/index.js"]),
    ).toBe("README.md");
    expect(findPackedPackageReadmePath(["package.json", "docs/README.md"])).toBe("");
  });
});

describe("parseNpmReadmeMetadata", () => {
  it("accepts non-empty npm readme metadata", () => {
    expect(parseNpmReadmeMetadata(JSON.stringify("# Plugin\n\nInstall it."))).toBe(
      "# Plugin\n\nInstall it.",
    );
  });

  it("rejects empty or unsupported npm readme metadata", () => {
    expect(parseNpmReadmeMetadata(JSON.stringify(""))).toBe("");
    expect(parseNpmReadmeMetadata(JSON.stringify(null))).toBe("");
    expect(parseNpmReadmeMetadata("{")).toBe("");
  });
});
