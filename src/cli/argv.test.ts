// Argv tests cover CLI argument parsing helpers and platform-specific normalization.
import { describe, expect, it } from "vitest";
import {
  buildParseArgv,
  getFlagValue,
  getCommandPositionalsWithRootOptions,
  getCommandPathWithRootOptions,
  getPrimaryCommand,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasFlag,
  isHelpOrVersionInvocation,
  isRootHelpInvocation,
  isRootVersionInvocation,
  isSimpleCommandHelpInvocation,
  normalizeGeneratedHelpCommandArgv,
  normalizeRootHelpTargetArgv,
  normalizeRootLogLevelArgv,
  normalizeRootNoColorArgv,
} from "./argv.js";

describe("argv helpers", () => {
  it.each([
    {
      name: "known command group help command help flag",
      argv: ["node", "afora", "backup", "help", "--help"],
      expected: ["node", "afora", "backup", "help"],
    },
    {
      name: "known command group help command short help flag",
      argv: ["node", "afora", "--profile", "work", "backup", "help", "-h"],
      expected: ["node", "afora", "--profile", "work", "backup", "help"],
    },
    {
      name: "leaf positional help remains untouched",
      argv: ["node", "afora", "docs", "help", "--help"],
      expected: ["node", "afora", "docs", "help", "--help"],
    },
    {
      name: "known command group help target",
      argv: ["node", "afora", "plugins", "help", "list"],
      expected: ["node", "afora", "plugins", "list", "--help"],
    },
    {
      name: "known command group help target help flag",
      argv: ["node", "afora", "plugins", "help", "list", "--help"],
      expected: ["node", "afora", "plugins", "list", "--help"],
    },
    {
      name: "unknown plugin command group help target",
      argv: ["node", "afora", "external-plugin", "help", "inspect"],
      expected: ["node", "afora", "external-plugin", "inspect", "--help"],
    },
    {
      name: "unknown plugin command group help target help flag",
      argv: ["node", "afora", "external-plugin", "help", "inspect", "--help"],
      expected: ["node", "afora", "external-plugin", "inspect", "--help"],
    },
    {
      name: "generated help target with trailing root option",
      argv: ["node", "afora", "memory", "help", "status", "--no-color"],
      expected: ["node", "afora", "--no-color", "memory", "status", "--help"],
    },
    {
      name: "extra help positionals remain untouched",
      argv: ["node", "afora", "backup", "help", "missing", "extra", "--help"],
      expected: ["node", "afora", "backup", "help", "missing", "extra", "--help"],
    },
    {
      name: "terminator help flag remains untouched",
      argv: ["node", "afora", "backup", "help", "--", "--help"],
      expected: ["node", "afora", "backup", "help", "--", "--help"],
    },
  ])("normalizes generated help commands: $name", ({ argv, expected }) => {
    expect(normalizeGeneratedHelpCommandArgv(argv)).toEqual(expected);
  });

  it.each([
    {
      name: "root help target",
      argv: ["node", "afora", "help", "plugins"],
      expected: ["node", "afora", "plugins", "--help"],
    },
    {
      name: "root help target with help flag",
      argv: ["node", "afora", "help", "plugins", "--help"],
      expected: ["node", "afora", "plugins", "--help"],
    },
    {
      name: "root option before help target",
      argv: ["node", "afora", "--profile", "work", "help", "memory"],
      expected: ["node", "afora", "--profile", "work", "memory", "--help"],
    },
    {
      name: "bare root help remains untouched",
      argv: ["node", "afora", "help"],
      expected: ["node", "afora", "help"],
    },
    {
      name: "root help self-help remains untouched",
      argv: ["node", "afora", "help", "--help"],
      expected: ["node", "afora", "help", "--help"],
    },
    {
      name: "nested root help target",
      argv: ["node", "afora", "help", "plugins", "list"],
      expected: ["node", "afora", "plugins", "list", "--help"],
    },
    {
      name: "nested root help target with help flag",
      argv: ["node", "afora", "help", "plugins", "list", "--help"],
      expected: ["node", "afora", "plugins", "list", "--help"],
    },
    {
      name: "nested root help target with trailing root option",
      argv: ["node", "afora", "help", "memory", "status", "--no-color"],
      expected: ["node", "afora", "--no-color", "memory", "status", "--help"],
    },
  ])("normalizes root help targets: $name", ({ argv, expected }) => {
    expect(normalizeRootHelpTargetArgv(argv)).toEqual(expected);
  });

  it.each([
    {
      name: "subcommand trailing no-color",
      argv: ["node", "afora", "doctor", "--no-color", "--post-upgrade", "--json"],
      expected: ["node", "afora", "--no-color", "doctor", "--post-upgrade", "--json"],
    },
    {
      name: "keeps existing root options first",
      argv: ["node", "afora", "--profile", "work", "doctor", "--no-color", "--lint", "--json"],
      expected: [
        "node",
        "afora",
        "--profile",
        "work",
        "--no-color",
        "doctor",
        "--lint",
        "--json",
      ],
    },
    {
      name: "keeps no-color after possible command option value",
      argv: ["node", "afora", "doctor", "--lint", "--json", "--no-color"],
      expected: ["node", "afora", "doctor", "--lint", "--json", "--no-color"],
    },
    {
      name: "flag terminator leaves no-color positional",
      argv: ["node", "afora", "doctor", "--", "--no-color"],
      expected: ["node", "afora", "doctor", "--", "--no-color"],
    },
    {
      name: "command option value remains literal",
      argv: ["node", "afora", "agent", "--message", "--no-color"],
      expected: ["node", "afora", "agent", "--message", "--no-color"],
    },
    {
      name: "assigned command option value does not block no-color",
      argv: ["node", "afora", "agent", "--message=hello", "--no-color"],
      expected: ["node", "afora", "--no-color", "agent", "--message=hello"],
    },
  ])("normalizes root --no-color before command parsing: $name", ({ argv, expected }) => {
    expect(normalizeRootNoColorArgv(argv)).toEqual(expected);
  });

  it("allows final command metadata to lift no-color after boolean command flags", () => {
    const argv = ["node", "afora", "doctor", "--lint", "--json", "--no-color"];

    expect(
      normalizeRootNoColorArgv(argv, {
        shouldPreserveNoColor: ({ remainingArgs, noColorIndex }) =>
          remainingArgs[noColorIndex - 1] === "--message",
      }),
    ).toEqual(["node", "afora", "--no-color", "doctor", "--lint", "--json"]);
  });

  it.each([
    {
      name: "subcommand trailing log-level",
      argv: ["node", "afora", "doctor", "--log-level", "debug", "--json"],
      expected: ["node", "afora", "--log-level", "debug", "doctor", "--json"],
    },
    {
      name: "subcommand trailing log-level equals form",
      argv: ["node", "afora", "doctor", "--log-level=trace", "--json"],
      expected: ["node", "afora", "--log-level=trace", "doctor", "--json"],
    },
    {
      name: "keeps existing root options first",
      argv: ["node", "afora", "--profile", "work", "doctor", "--log-level", "debug"],
      expected: ["node", "afora", "--profile", "work", "--log-level", "debug", "doctor"],
    },
    {
      name: "keeps log-level after possible command option value",
      argv: ["node", "afora", "agent", "--message", "--log-level", "debug"],
      expected: ["node", "afora", "agent", "--message", "--log-level", "debug"],
    },
    {
      name: "flag terminator leaves log-level positional",
      argv: ["node", "afora", "nodes", "run", "--", "--log-level", "debug"],
      expected: ["node", "afora", "nodes", "run", "--", "--log-level", "debug"],
    },
    {
      name: "missing value remains command scoped",
      argv: ["node", "afora", "doctor", "--log-level", "--json"],
      expected: ["node", "afora", "doctor", "--log-level", "--json"],
    },
  ])("normalizes root --log-level before command parsing: $name", ({ argv, expected }) => {
    expect(normalizeRootLogLevelArgv(argv)).toEqual(expected);
  });

  it("allows final command metadata to lift log-level after boolean command flags", () => {
    const argv = ["node", "afora", "doctor", "--lint", "--json", "--log-level", "debug"];

    expect(
      normalizeRootLogLevelArgv(argv, {
        shouldPreserveLogLevel: ({ remainingArgs, logLevelIndex }) =>
          remainingArgs[logLevelIndex - 1] === "--message",
      }),
    ).toEqual(["node", "afora", "--log-level", "debug", "doctor", "--lint", "--json"]);
  });

  it("preserves log-level when final command metadata owns the option", () => {
    const argv = ["node", "afora", "plugin-cmd", "--log-level", "debug"];

    expect(
      normalizeRootLogLevelArgv(argv, {
        shouldPreserveLogLevel: ({ remainingArgs, logLevelIndex }) =>
          remainingArgs[logLevelIndex] === "--log-level",
      }),
    ).toEqual(argv);
  });

  it.each([
    {
      name: "root help command",
      argv: ["node", "afora", "help"],
      expected: true,
    },
    {
      name: "root help command with target",
      argv: ["node", "afora", "help", "matrix"],
      expected: true,
    },
    {
      name: "nested help command",
      argv: ["node", "afora", "matrix", "encryption", "help"],
      expected: true,
    },
    {
      name: "known subcommand root help command",
      argv: ["node", "afora", "config", "help"],
      expected: true,
    },
    {
      name: "known leaf command positional help",
      argv: ["node", "afora", "docs", "help"],
      expected: false,
    },
    {
      name: "known subcommand leaf positional help",
      argv: ["node", "afora", "config", "set", "some.path", "help"],
      expected: false,
    },
    {
      name: "unknown plugin command help",
      argv: ["node", "afora", "external-plugin", "tools", "help"],
      expected: true,
    },
    {
      name: "help flag",
      argv: ["node", "afora", "matrix", "encryption", "--help"],
      expected: true,
    },
    {
      name: "help as option value",
      argv: ["node", "afora", "agent", "--message", "help"],
      expected: false,
    },
    {
      name: "help after terminator",
      argv: ["node", "afora", "nodes", "invoke", "--", "help"],
      expected: false,
    },
    {
      name: "help flag after terminator",
      argv: ["node", "afora", "nodes", "invoke", "--", "--help"],
      expected: false,
    },
    {
      name: "version flag after terminator",
      argv: ["node", "afora", "nodes", "invoke", "--", "--version"],
      expected: false,
    },
    {
      name: "root version flag",
      argv: ["node", "afora", "--version"],
      expected: true,
    },
    {
      name: "root short version flag",
      argv: ["node", "afora", "-V"],
      expected: true,
    },
    {
      name: "root version alias after profile",
      argv: ["node", "afora", "--profile", "work", "-v"],
      expected: true,
    },
    {
      name: "root version flag after profile",
      argv: ["node", "afora", "--profile", "work", "--version"],
      expected: true,
    },
    {
      name: "version-pinned skill install",
      argv: ["node", "afora", "skills", "install", "@owner/weather", "--version", "1.2.3"],
      expected: false,
    },
    {
      name: "version-pinned skill verification",
      argv: ["node", "afora", "skills", "verify", "@owner/weather", "--version", "1.2.3"],
      expected: false,
    },
    {
      name: "equals-form version-pinned skill install",
      argv: ["node", "afora", "skills", "install", "@owner/weather", "--version=1.2.3"],
      expected: false,
    },
    {
      name: "profiled version-pinned skill verification",
      argv: [
        "node",
        "afora",
        "--profile",
        "work",
        "skills",
        "verify",
        "@owner/weather",
        "--version",
        "1.2.3",
      ],
      expected: false,
    },
    {
      name: "help for a version-pinned skill command",
      argv: [
        "node",
        "afora",
        "skills",
        "verify",
        "@owner/weather",
        "--version",
        "1.2.3",
        "--help",
      ],
      expected: true,
    },
    {
      name: "unknown root option does not turn version into root help",
      argv: ["node", "afora", "--unknown", "--version"],
      expected: false,
    },
  ])("detects help/version invocations: $name", ({ argv, expected }) => {
    expect(isHelpOrVersionInvocation(argv)).toBe(expected);
  });

  it.each([
    {
      name: "root --version",
      argv: ["node", "afora", "--version"],
      expected: true,
    },
    {
      name: "root -V",
      argv: ["node", "afora", "-V"],
      expected: true,
    },
    {
      name: "root -v alias with profile",
      argv: ["node", "afora", "--profile", "work", "-v"],
      expected: true,
    },
    {
      name: "subcommand version flag",
      argv: ["node", "afora", "status", "--version"],
      expected: false,
    },
    {
      name: "unknown root flag with version",
      argv: ["node", "afora", "--unknown", "--version"],
      expected: false,
    },
  ])("detects root-only version invocations: $name", ({ argv, expected }) => {
    expect(isRootVersionInvocation(argv)).toBe(expected);
  });

  it.each([
    {
      name: "root --help",
      argv: ["node", "afora", "--help"],
      expected: true,
    },
    {
      name: "root -h",
      argv: ["node", "afora", "-h"],
      expected: true,
    },
    {
      name: "root --help with profile",
      argv: ["node", "afora", "--profile", "work", "--help"],
      expected: true,
    },
    {
      name: "subcommand --help",
      argv: ["node", "afora", "status", "--help"],
      expected: false,
    },
    {
      name: "help before subcommand token",
      argv: ["node", "afora", "--help", "status"],
      expected: false,
    },
    {
      name: "help after -- terminator",
      argv: ["node", "afora", "nodes", "invoke", "--", "device.status", "--help"],
      expected: false,
    },
    {
      name: "unknown root flag before help",
      argv: ["node", "afora", "--unknown", "--help"],
      expected: false,
    },
    {
      name: "unknown root flag after help",
      argv: ["node", "afora", "--help", "--unknown"],
      expected: false,
    },
  ])("detects root-only help invocations: $name", ({ argv, expected }) => {
    expect(isRootHelpInvocation(argv)).toBe(expected);
  });

  it.each([
    {
      name: "single command with trailing flag",
      argv: ["node", "afora", "status", "--json"],
      expected: ["status"],
    },
    {
      name: "two-part command",
      argv: ["node", "afora", "agents", "list"],
      expected: ["agents", "list"],
    },
    {
      name: "terminator cuts parsing",
      argv: ["node", "afora", "status", "--", "ignored"],
      expected: ["status"],
    },
  ])("extracts command path: $name", ({ argv, expected }) => {
    expect(getCommandPathWithRootOptions(argv, 2)).toEqual(expected);
  });

  it("extracts command path while skipping known root option values", () => {
    expect(
      getCommandPathWithRootOptions(
        [
          "node",
          "afora",
          "--profile",
          "work",
          "--container",
          "demo",
          "--no-color",
          "config",
          "validate",
        ],
        2,
      ),
    ).toEqual(["config", "validate"]);
  });

  it("limits simple help fast paths to root options, a command, and help", () => {
    const commands = new Set(["setup"]);
    expect(
      isSimpleCommandHelpInvocation(
        ["node", "afora", "--profile", "work", "setup", "--help"],
        commands,
      ),
    ).toBe(true);
    expect(
      isSimpleCommandHelpInvocation(
        ["node", "afora", "setup", "--workspace", "--help"],
        commands,
      ),
    ).toBe(false);
    expect(
      isSimpleCommandHelpInvocation(
        ["node", "afora", "setup", "--profile", "work", "--help"],
        commands,
      ),
    ).toBe(false);
    expect(isSimpleCommandHelpInvocation(["node", "afora", "--help", "setup"], commands)).toBe(
      false,
    );
  });

  it("extracts routed config get positionals with interleaved root options", () => {
    expect(
      getCommandPositionalsWithRootOptions(
        ["node", "afora", "config", "get", "--log-level", "debug", "update.channel", "--json"],
        {
          commandPath: ["config", "get"],
          booleanFlags: ["--json"],
        },
      ),
    ).toEqual(["update.channel"]);
  });

  it("extracts routed config unset positionals with interleaved root options", () => {
    expect(
      getCommandPositionalsWithRootOptions(
        ["node", "afora", "config", "unset", "--profile", "work", "update.channel"],
        {
          commandPath: ["config", "unset"],
        },
      ),
    ).toEqual(["update.channel"]);
  });

  it("returns null when routed command sees unknown options", () => {
    expect(
      getCommandPositionalsWithRootOptions(
        ["node", "afora", "config", "get", "--mystery", "value", "update.channel"],
        {
          commandPath: ["config", "get"],
          booleanFlags: ["--json"],
        },
      ),
    ).toBeNull();
  });

  it.each([
    {
      name: "returns first command token",
      argv: ["node", "afora", "agents", "list"],
      expected: "agents",
    },
    {
      name: "returns null when no command exists",
      argv: ["node", "afora"],
      expected: null,
    },
    {
      name: "skips known root option values",
      argv: ["node", "afora", "--log-level", "debug", "status"],
      expected: "status",
    },
  ])("returns primary command: $name", ({ argv, expected }) => {
    expect(getPrimaryCommand(argv)).toBe(expected);
  });

  it.each([
    {
      name: "detects flag before terminator",
      argv: ["node", "afora", "status", "--json"],
      flag: "--json",
      expected: true,
    },
    {
      name: "ignores flag after terminator",
      argv: ["node", "afora", "--", "--json"],
      flag: "--json",
      expected: false,
    },
  ])("parses boolean flags: $name", ({ argv, flag, expected }) => {
    expect(hasFlag(argv, flag)).toBe(expected);
  });

  it.each([
    {
      name: "value in next token",
      argv: ["node", "afora", "status", "--timeout", "5000"],
      expected: "5000",
    },
    {
      name: "value in equals form",
      argv: ["node", "afora", "status", "--timeout=2500"],
      expected: "2500",
    },
    {
      name: "missing value",
      argv: ["node", "afora", "status", "--timeout"],
      expected: null,
    },
    {
      name: "next token is another flag",
      argv: ["node", "afora", "status", "--timeout", "--json"],
      expected: null,
    },
    {
      name: "flag appears after terminator",
      argv: ["node", "afora", "--", "--timeout=99"],
      expected: undefined,
    },
    {
      name: "repeated flag uses final value",
      argv: ["node", "afora", "status", "--timeout", "100", "--timeout=200"],
      expected: "200",
    },
    {
      name: "missing repeated value remains invalid",
      argv: ["node", "afora", "status", "--timeout", "--timeout", "200"],
      expected: null,
    },
  ])("extracts flag values: $name", ({ argv, expected }) => {
    expect(getFlagValue(argv, "--timeout")).toBe(expected);
  });

  it("parses verbose flags", () => {
    expect(getVerboseFlag(["node", "afora", "status", "--verbose"])).toBe(true);
    expect(getVerboseFlag(["node", "afora", "status", "--debug"])).toBe(false);
    expect(getVerboseFlag(["node", "afora", "status", "--debug"], { includeDebug: true })).toBe(
      true,
    );
  });

  it.each([
    {
      name: "missing flag",
      argv: ["node", "afora", "status"],
      expected: undefined,
    },
    {
      name: "missing value",
      argv: ["node", "afora", "status", "--timeout"],
      expected: null,
    },
    {
      name: "valid positive integer",
      argv: ["node", "afora", "status", "--timeout", "5000"],
      expected: 5000,
    },
    {
      name: "valid signed decimal positive integer",
      argv: ["node", "afora", "status", "--timeout", "+5000"],
      expected: 5000,
    },
    {
      name: "invalid integer",
      argv: ["node", "afora", "status", "--timeout", "nope"],
      expected: null,
    },
    {
      name: "non-decimal integer",
      argv: ["node", "afora", "status", "--timeout", "0x10"],
      expected: null,
    },
    {
      name: "partial integer",
      argv: ["node", "afora", "status", "--timeout", "5s"],
      expected: null,
    },
    {
      name: "zero",
      argv: ["node", "afora", "status", "--timeout", "0"],
      expected: null,
    },
    {
      name: "negative integer",
      argv: ["node", "afora", "status", "--timeout", "-5"],
      expected: null,
    },
    {
      name: "repeated value uses final valid integer",
      argv: ["node", "afora", "status", "--timeout", "nope", "--timeout", "5000"],
      expected: 5000,
    },
    {
      name: "repeated value rejects final invalid integer",
      argv: ["node", "afora", "status", "--timeout", "5000", "--timeout", "nope"],
      expected: null,
    },
  ])("parses positive integer flag values: $name", ({ argv, expected }) => {
    expect(getPositiveIntFlagValue(argv, "--timeout")).toBe(expected);
  });

  it.each([
    {
      name: "keeps plain node argv",
      rawArgs: ["node", "afora", "status"],
      expected: ["node", "afora", "status"],
    },
    {
      name: "keeps version-suffixed node binary",
      rawArgs: ["node-22", "afora", "status"],
      expected: ["node-22", "afora", "status"],
    },
    {
      name: "keeps windows versioned node exe",
      rawArgs: ["node-22.2.0.exe", "afora", "status"],
      expected: ["node-22.2.0.exe", "afora", "status"],
    },
    {
      name: "keeps dotted node binary",
      rawArgs: ["node-22.2", "afora", "status"],
      expected: ["node-22.2", "afora", "status"],
    },
    {
      name: "keeps dotted node exe",
      rawArgs: ["node-22.2.exe", "afora", "status"],
      expected: ["node-22.2.exe", "afora", "status"],
    },
    {
      name: "keeps absolute versioned node path",
      rawArgs: ["/usr/bin/node-22.2.0", "afora", "status"],
      expected: ["/usr/bin/node-22.2.0", "afora", "status"],
    },
    {
      name: "keeps node24 shorthand",
      rawArgs: ["node24", "afora", "status"],
      expected: ["node24", "afora", "status"],
    },
    {
      name: "keeps absolute node24 shorthand",
      rawArgs: ["/usr/bin/node24", "afora", "status"],
      expected: ["/usr/bin/node24", "afora", "status"],
    },
    {
      name: "keeps windows node24 exe",
      rawArgs: ["node24.exe", "afora", "status"],
      expected: ["node24.exe", "afora", "status"],
    },
    {
      name: "keeps nodejs binary",
      rawArgs: ["nodejs", "afora", "status"],
      expected: ["nodejs", "afora", "status"],
    },
    {
      name: "prefixes fallback when first arg is not a node launcher",
      rawArgs: ["node-dev", "afora", "status"],
      expected: ["node", "afora", "node-dev", "afora", "status"],
    },
    {
      name: "prefixes fallback when raw args start at program name",
      rawArgs: ["afora", "status"],
      expected: ["node", "afora", "status"],
    },
    {
      name: "keeps bun execution argv",
      rawArgs: ["bun", "src/entry.ts", "status"],
      expected: ["bun", "src/entry.ts", "status"],
    },
  ] as const)("builds parse argv from raw args: $name", ({ rawArgs, expected }) => {
    const parsed = buildParseArgv([...rawArgs]);
    expect(parsed).toEqual([...expected]);
  });
});
