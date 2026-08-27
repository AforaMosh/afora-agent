// Argv invocation tests cover CLI argv normalization before command dispatch.
import { describe, expect, it } from "vitest";
import { resolveCliArgvInvocation } from "./argv-invocation.js";

describe("argv-invocation", () => {
  it("resolves root help and empty command path", () => {
    expect(resolveCliArgvInvocation(["node", "afora", "--help"])).toEqual({
      argv: ["node", "afora", "--help"],
      commandPath: [],
      primary: null,
      hasHelpOrVersion: true,
      isRootHelpInvocation: true,
    });
  });

  it("resolves command path and primary with root options", () => {
    expect(
      resolveCliArgvInvocation(["node", "afora", "--profile", "work", "gateway", "status"]),
    ).toEqual({
      argv: ["node", "afora", "--profile", "work", "gateway", "status"],
      commandPath: ["gateway", "status"],
      primary: "gateway",
      hasHelpOrVersion: false,
      isRootHelpInvocation: false,
    });
  });

  it.each([
    {
      name: "version-pinned install",
      argv: ["node", "afora", "skills", "install", "@owner/weather", "--version", "1.2.3"],
      commandPath: ["skills", "install"],
    },
    {
      name: "version-pinned verification",
      argv: ["node", "afora", "skills", "verify", "@owner/weather", "--version", "1.2.3"],
      commandPath: ["skills", "verify"],
    },
    {
      name: "equals-form version-pinned install",
      argv: ["node", "afora", "skills", "install", "@owner/weather", "--version=1.2.3"],
      commandPath: ["skills", "install"],
    },
    {
      name: "profiled version-pinned verification",
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
      commandPath: ["skills", "verify"],
    },
  ])("keeps $name in command execution mode", ({ argv, commandPath }) => {
    expect(resolveCliArgvInvocation(argv)).toEqual({
      argv,
      commandPath,
      primary: "skills",
      hasHelpOrVersion: false,
      isRootHelpInvocation: false,
    });
  });

  it("consumes agent parent option values before the exec subcommand", () => {
    expect(
      resolveCliArgvInvocation([
        "node",
        "afora",
        "agent",
        "--model",
        "openai/gpt-5.6-sol",
        "exec",
        "fix it",
      ]).commandPath,
    ).toEqual(["agent", "exec"]);
  });

  it("does not treat an exec-valued parent option as the subcommand", () => {
    expect(
      resolveCliArgvInvocation(["node", "afora", "agent", "--message", "exec"]).commandPath,
    ).toEqual(["agent"]);
  });

  it("consumes root options between the agent parent and exec", () => {
    expect(
      resolveCliArgvInvocation([
        "node",
        "afora",
        "agent",
        "--no-color",
        "--model",
        "openai/gpt-5.6-sol",
        "exec",
        "fix it",
      ]).commandPath,
    ).toEqual(["agent", "exec"]);
  });

  it.each([
    ["separate agent value", ["models", "--agent", "main", "--status-json"]],
    ["inline agent value", ["models", "--agent=main", "--status-json"]],
    ["status alias before agent", ["models", "--status-json", "--agent", "main"]],
  ])("keeps models parent status options on the parent path: %s", (_name, args) => {
    expect(resolveCliArgvInvocation(["node", "afora", ...args]).commandPath).toEqual(["models"]);
  });

  it("still resolves a models child after parent options", () => {
    expect(
      resolveCliArgvInvocation(["node", "afora", "models", "--agent", "main", "status"])
        .commandPath,
    ).toEqual(["models", "status"]);
  });
});
