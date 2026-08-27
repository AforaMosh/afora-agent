import { vi } from "vitest";

vi.mock("afora-agent/plugin-sdk/exec-approvals-runtime", async () => {
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const displayPath = () => {
    const stateDir = process.env.AFORA_STATE_DIR?.trim();
    return stateDir
      ? nodePath.join(stateDir, "state", "afora.sqlite#exec_approvals_config")
      : "~/.afora/state/afora.sqlite#exec_approvals_config";
  };
  return {
    resolveExecApprovalsDisplayPath: displayPath,
    readExecApprovalsSnapshot: () => {
      const fixtureRoot =
        process.env.AFORA_STATE_DIR?.trim() ?? process.env.AFORA_HOME?.trim() ?? "";
      const directFixturePath = nodePath.join(fixtureRoot, "exec-approvals.json");
      const fixturePath = nodeFs.existsSync(directFixturePath)
        ? directFixturePath
        : nodePath.join(fixtureRoot, ".afora", "exec-approvals.json");
      try {
        const raw = nodeFs.readFileSync(fixturePath, "utf8");
        return {
          path: displayPath(),
          exists: true,
          raw,
          file: { version: 1, agents: {} },
          hash: "fixture",
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        return {
          path: displayPath(),
          exists: false,
          raw: null,
          file: { version: 1, agents: {} },
          hash: "missing:fixture",
        };
      }
    },
  };
});

import "./register.base.test-utils.js";
import "./register.models-and-mcp.test-utils.js";
import "./register.ingress-and-secrets.test-utils.js";
import "./register.sandbox-and-tools.test-utils.js";
import "./register.gateway-data-and-approvals.test-utils.js";
