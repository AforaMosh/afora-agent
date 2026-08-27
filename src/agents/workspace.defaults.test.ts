// Workspace default tests cover environment-variable precedence for the
// built-in agent workspace location.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { resolveDefaultAgentWorkspaceDir } from "./workspace.js";

describe("DEFAULT_AGENT_WORKSPACE_DIR", () => {
  it("uses AFORA_HOME when resolving the default workspace dir", () => {
    const home = path.join(path.sep, "srv", "afora-home");

    const resolved = withEnv(
      {
        AFORA_WORKSPACE_DIR: undefined,
        AFORA_PROFILE: undefined,
        AFORA_HOME: home,
        HOME: path.join(path.sep, "home", "other"),
      },
      () => resolveDefaultAgentWorkspaceDir(),
    );

    expect(resolved).toBe(path.join(path.resolve(home), ".afora", "workspace"));
  });

  it("uses AFORA_WORKSPACE_DIR before AFORA_HOME", () => {
    const workspaceDir = path.join(path.sep, "srv", "afora-workspace");

    const resolved = withEnv(
      {
        AFORA_WORKSPACE_DIR: workspaceDir,
        AFORA_HOME: path.join(path.sep, "srv", "afora-home"),
      },
      () => resolveDefaultAgentWorkspaceDir(),
    );

    expect(resolved).toBe(path.resolve(workspaceDir));
  });
});
