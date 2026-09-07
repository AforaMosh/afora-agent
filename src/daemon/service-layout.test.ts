import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { summarizeGatewayServiceLayout } from "./service-layout.js";

describe("resolveGatewayServiceEntrypoint", () => {
  it("resolves a relative entrypoint against an absolute working directory", async () => {
    expect(
      (
        await summarizeGatewayServiceLayout({
          programArguments: ["node", "dist/index.js", "gateway", "run"],
          workingDirectory: "/repo/afora",
        })
      )?.entrypoint,
    ).toBe(path.join("/repo/afora", "dist", "index.js"));
  });

  it("resolves Windows service entrypoints with Windows path semantics", async () => {
    expect(
      (
        await summarizeGatewayServiceLayout({
          programArguments: ["node.exe", "dist\\index.js", "gateway", "run"],
          workingDirectory: "C:\\afora",
        })
      )?.entrypoint,
    ).toBe("C:\\afora\\dist\\index.js");
  });

  it("rejects a relative entrypoint without an absolute service working directory", async () => {
    await expect(
      summarizeGatewayServiceLayout({
        programArguments: ["node", "dist/index.js", "gateway", "run"],
      }),
    ).resolves.not.toHaveProperty("entrypoint");
    await expect(
      summarizeGatewayServiceLayout({
        programArguments: ["node", "dist/index.js", "gateway", "run"],
        workingDirectory: "./checkout",
      }),
    ).resolves.not.toHaveProperty("entrypoint");
  });
});

describe("resolveAforaPackageRoot", () => {
  const roots: string[] = [];

  afterAll(async () => {
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  // The prod resolver realpaths the entrypoint, and macOS resolves os.tmpdir() through the
  // /var -> /private/var symlink. Canonicalize here or every assertion below passes on Linux
  // and fails on a Mac for a reason that has nothing to do with the code under test.
  async function makePackageRoot(name: string, version = "9.9.9"): Promise<string> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "afora-svc-layout-")));
    roots.push(root);
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name, version }));
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "index.js"), "");
    return root;
  }

  async function layoutFor(root: string) {
    return await summarizeGatewayServiceLayout({
      programArguments: ["node", path.join(root, "dist", "index.js"), "gateway", "run"],
    });
  }

  // Every name a core root can present on disk today. "afora-agent" is this repository's own
  // manifest, so before the shared predicate landed the resolver could not identify the package
  // it was running from, and ownership silently failed closed for every install of this fork.
  it.each(["afora-agent", "afora", "openclaw"])(
    "resolves a service package root whose manifest name is '%s'",
    async (name) => {
      const root = await makePackageRoot(name);
      const layout = await layoutFor(root);
      expect(layout?.packageRoot).toBe(root);
      expect(layout?.packageVersion).toBe("9.9.9");
    },
  );

  it("leaves the package root unresolved for a manifest that is not a core package", async () => {
    const root = await makePackageRoot("some-other-gateway");
    const layout = await layoutFor(root);
    expect(layout?.entrypoint).toBe(path.join(root, "dist", "index.js"));
    expect(layout).not.toHaveProperty("packageRoot");
    expect(layout).not.toHaveProperty("packageVersion");
  });
});
