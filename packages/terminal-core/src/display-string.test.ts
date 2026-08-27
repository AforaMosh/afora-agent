// Terminal Core tests cover display-safe path shortening.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { displayString } from "./display-string.js";

function stubHome(home: string, aforaHome = ""): void {
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", "");
  vi.stubEnv("AFORA_HOME", aforaHome);
}

describe("displayString", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shortens whole-value homes and child paths without clipping sibling prefixes", () => {
    const home = path.resolve("test-home", "alice");
    stubHome(home);

    expect(displayString(home)).toBe("~");
    expect(displayString(`${home}/project`)).toBe("~/project");
    expect(displayString(`${home}\\project`)).toBe("~\\project");
    expect(displayString(`Workspace: ${home}/project`)).toBe("Workspace: ~/project");
    expect(displayString(`${home}/one ${home}/two`)).toBe("~/one ~/two");
    expect(displayString(`Home: ${home},`)).toBe("Home: ~,");
    expect(displayString(`(${home})`)).toBe("(~)");
    expect(displayString(`${home}.`)).toBe("~.");

    expect(displayString(`${home}2/project`)).toBe(`${home}2/project`);
    expect(displayString(`${home},backup`)).toBe(`${home},backup`);
    expect(displayString(`${home} backup/project`)).toBe(`${home} backup/project`);
    expect(displayString(`${home}../project`)).toBe(`${home}../project`);
    expect(displayString(`prefix${home}/project`)).toBe(`prefix${home}/project`);
    expect(displayString(`/tmp${home}/project`)).toBe(`/tmp${home}/project`);
  });

  it("uses AFORA_HOME as the display prefix", () => {
    const home = path.resolve("test-home", "alice");
    const aforaHome = path.resolve("test-afora-home");
    stubHome(home, aforaHome);

    expect(displayString(aforaHome)).toBe("$AFORA_HOME");
    expect(displayString(`${aforaHome}/state`)).toBe("$AFORA_HOME/state");
    expect(displayString(`${aforaHome}2/state`)).toBe(`${aforaHome}2/state`);
  });

  it.each(["$&", "$`", "$'", "$$"])("keeps %s literal when expanding AFORA_HOME", (pattern) => {
    const home = path.resolve("test-home", `${pattern}user`);
    stubHome(home, "~/state");

    expect(displayString(path.join(home, "state", "project"))).toBe(
      `$AFORA_HOME${path.sep}project`,
    );
  });

  it.skipIf(process.platform !== "win32")(
    "shortens real Windows home casing aliases inside table display text",
    () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "afora-home-display-"));
      try {
        const homeAlias = home.toUpperCase();
        expect(fs.statSync(homeAlias).isDirectory()).toBe(true);
        stubHome(home);

        expect(displayString(`Workspace: ${homeAlias}\\project`)).toBe("Workspace: ~\\project");
        expect(displayString(`İ Workspace: ${homeAlias}\\project`)).toBe("İ Workspace: ~\\project");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
