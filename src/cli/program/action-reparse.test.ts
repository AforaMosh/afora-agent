// Action reparse tests cover Commander action reparsing for nested CLI commands.
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { reparseProgramFromActionCommand } from "./action-reparse.js";

function setRawArgs(command: Command, rawArgs: string[]): void {
  (command as Command & { rawArgs: string[] }).rawArgs = rawArgs;
}

async function expectReparseArgv(params: {
  parent: Command;
  action: Command;
  argv: string[];
  expected: string[];
}): Promise<void> {
  let root = params.parent;
  while (root.parent) {
    root = root.parent;
  }
  setRawArgs(root, params.argv);
  const parseAsync = vi.spyOn(root, "parseAsync").mockResolvedValue(root);

  await reparseProgramFromActionCommand(params.parent, params.action);

  expect(parseAsync).toHaveBeenCalledWith(params.expected);
}

describe("reparseProgramFromActionCommand", () => {
  it("uses root raw args and reparses the root for nested lazy commands", async () => {
    const root = new Command().name("afora");
    setRawArgs(root, ["node", "afora", "workspaces", "audit", "export", "--since", "1"]);
    const workspaces = root.command("workspaces");
    const audit = workspaces.command("audit");
    const exportCommand = audit.command("export");
    const parseAsync = vi.spyOn(root, "parseAsync").mockResolvedValue(root);
    const auditParseAsync = vi.spyOn(audit, "parseAsync");

    await reparseProgramFromActionCommand(audit, exportCommand);

    expect(parseAsync).toHaveBeenCalledWith([
      "node",
      "afora",
      "workspaces",
      "audit",
      "export",
      "--since",
      "1",
    ]);
    expect(auditParseAsync).not.toHaveBeenCalled();
  });

  it("hoists a trailing lazy-parent option before the loaded command", async () => {
    const root = new Command().name("afora");
    const browser = root.command("browser").option("--browser-profile <name>");
    const tabs = browser.command("tabs");
    await expectReparseArgv({
      parent: browser,
      action: tabs,
      argv: ["node", "afora", "browser", "tabs", "--browser-profile", "remote"],
      expected: ["node", "afora", "browser", "--browser-profile", "remote", "tabs"],
    });
  });

  it("hoists a lazy-parent short option with an attached required value", async () => {
    const root = new Command().name("afora");
    const browser = root.command("browser").option("-p, --browser-profile <name>");
    const tabs = browser.command("tabs");
    await expectReparseArgv({
      parent: browser,
      action: tabs,
      argv: ["node", "afora", "browser", "tabs", "-premote"],
      expected: ["node", "afora", "browser", "-premote", "tabs"],
    });
  });

  it("hoists a lazy-parent short option with an attached optional value", async () => {
    const root = new Command().name("afora");
    const browser = root.command("browser").option("-p, --browser-profile [name]");
    const tabs = browser.command("tabs");
    await expectReparseArgv({
      parent: browser,
      action: tabs,
      argv: ["node", "afora", "browser", "tabs", "-premote"],
      expected: ["node", "afora", "browser", "-premote", "tabs"],
    });
  });

  it("skips root option values that match the parent command name", async () => {
    const root = new Command().name("afora").option("--profile <name>");
    const browser = root.command("browser").option("--browser-profile <name>");
    const tabs = browser.command("tabs");
    await expectReparseArgv({
      parent: browser,
      action: tabs,
      argv: [
        "node",
        "afora",
        "--profile",
        "browser",
        "browser",
        "tabs",
        "--browser-profile",
        "remote",
      ],
      expected: [
        "node",
        "afora",
        "--profile",
        "browser",
        "browser",
        "--browser-profile",
        "remote",
        "tabs",
      ],
    });
  });

  it("skips an attached root option value that matches the parent command name", async () => {
    const root = new Command().name("afora").option("-p, --profile <name>");
    const browser = root.command("browser").option("--browser-profile <name>");
    const tabs = browser.command("tabs");
    await expectReparseArgv({
      parent: browser,
      action: tabs,
      argv: ["node", "afora", "-pbrowser", "browser", "tabs", "--browser-profile", "remote"],
      expected: ["node", "afora", "-pbrowser", "browser", "--browser-profile", "remote", "tabs"],
    });
  });

  it("hoists parent options after nested lazy commands", async () => {
    const root = new Command().name("afora");
    const browser = root.command("browser").option("--browser-profile <name>");
    const tab = browser.command("tab");
    tab.command("new");
    await expectReparseArgv({
      parent: browser,
      action: tab,
      argv: ["node", "afora", "browser", "tab", "new", "--browser-profile", "work"],
      expected: ["node", "afora", "browser", "--browser-profile", "work", "tab", "new"],
    });
  });

  it("leaves a child-owned option collision after the child command", async () => {
    const root = new Command().name("afora");
    const browser = root.command("browser").option("--json");
    const extension = browser.command("extension");
    extension.command("path");
    extension.command("pair").option("--json");
    const argv = ["node", "afora", "browser", "extension", "pair", "--json"];
    await expectReparseArgv({ parent: browser, action: extension, argv, expected: argv });
  });

  it("leaves a child-owned attached short option after the child command", async () => {
    const root = new Command().name("afora");
    const browser = root.command("browser").option("-p, --browser-profile <name>");
    const extension = browser.command("extension");
    extension.command("pair").option("-p, --pairing-profile <name>");
    const argv = ["node", "afora", "browser", "extension", "pair", "-premote"];
    await expectReparseArgv({ parent: browser, action: extension, argv, expected: argv });
  });

  it("preserves an unknown suffix after a child-owned boolean short flag", async () => {
    const root = new Command().name("afora");
    const browser = root.command("browser").option("-p, --browser-profile <name>");
    const extension = browser.command("extension");
    const pair = extension.command("pair").option("-p, --preview");

    const parsed = pair.parseOptions(["-pfoo"]);

    expect(parsed.unknown).toEqual(["-foo"]);
    expect(pair.opts()).toEqual({ preview: true });

    const argv = ["node", "afora", "browser", "extension", "pair", "-pfoo"];
    await expectReparseArgv({ parent: browser, action: extension, argv, expected: argv });
  });

  it.each([
    {
      label: "boolean flags",
      retryFlags: "-r, --retry",
      tokens: ["-pr"],
      expected: { preview: true, retry: true },
    },
    {
      label: "a required attached value",
      retryFlags: "-r, --retry <value>",
      tokens: ["-prremote"],
      expected: { preview: true, retry: "remote" },
    },
    {
      label: "a required separate value",
      retryFlags: "-r, --retry <value>",
      tokens: ["-pr", "remote"],
      expected: { preview: true, retry: "remote" },
    },
    {
      label: "an optional attached value",
      retryFlags: "-r, --retry [value]",
      tokens: ["-prremote"],
      expected: { preview: true, retry: "remote" },
    },
    {
      label: "an optional separate value",
      retryFlags: "-r, --retry [value]",
      tokens: ["-pr", "remote"],
      expected: { preview: true, retry: "remote" },
    },
  ] as const)(
    "preserves child-owned short groups with $label",
    async ({ retryFlags, tokens, expected }) => {
      const root = new Command().name("afora");
      const browser = root.command("browser").option("-p, --browser-profile <name>");
      const extension = browser.command("extension");
      const pair = extension.command("pair").option("-p, --preview").option(retryFlags);

      const parsed = pair.parseOptions([...tokens]);

      expect(parsed.unknown).toEqual([]);
      expect(pair.opts()).toEqual(expected);

      const argv = ["node", "afora", "browser", "extension", "pair", ...tokens];
      await expectReparseArgv({ parent: browser, action: extension, argv, expected: argv });
    },
  );

  it("hoists a parent option when only a sibling command owns the same flag", async () => {
    const root = new Command().name("afora");
    const browser = root.command("browser").option("--url <url>");
    const cookies = browser.command("cookies");
    cookies.command("list");
    cookies.command("set").option("--url <url>");
    await expectReparseArgv({
      parent: browser,
      action: cookies,
      argv: ["node", "afora", "browser", "cookies", "list", "--url", "ws://gateway"],
      expected: ["node", "afora", "browser", "--url", "ws://gateway", "cookies", "list"],
    });
  });

  it("keeps a missing parent option value after the loaded command", async () => {
    const root = new Command().name("afora");
    const browser = root.command("browser").option("--browser-profile <name>");
    const tabs = browser.command("tabs");
    const argv = ["node", "afora", "browser", "tabs", "--browser-profile"];
    await expectReparseArgv({ parent: browser, action: tabs, argv, expected: argv });
  });
});
