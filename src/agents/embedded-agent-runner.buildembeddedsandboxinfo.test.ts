// Covers prompt-facing sandbox metadata and full-access availability rules.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals.js";
import {
  buildEmbeddedSandboxInfo,
  resolveEmbeddedFullAccessState,
  resolveEmbeddedSandboxInfoExecPolicy,
} from "./embedded-agent-runner/sandbox-info.js";
import type { SandboxContext } from "./sandbox.js";

function createSandboxContext(overrides?: Partial<SandboxContext>): SandboxContext {
  // Mirrors the sandbox runtime shape enough for prompt-info tests without
  // starting Docker or browser sidecars.
  const base = {
    enabled: true,
    backendId: "docker",
    sessionKey: "session:test",
    workspaceDir: "/tmp/afora-sandbox",
    agentWorkspaceDir: "/tmp/afora-workspace",
    workspaceAccess: "none",
    runtimeId: "afora-sbx-test",
    runtimeLabel: "afora-sbx-test",
    containerName: "afora-sbx-test",
    containerWorkdir: "/workspace",
    docker: {
      image: "afora-sandbox:bookworm-slim",
      containerPrefix: "afora-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp"],
      network: "none",
      user: "1000:1000",
      capDrop: ["ALL"],
      env: { LANG: "C.UTF-8" },
    },
    tools: {
      allow: ["exec"],
      deny: ["browser"],
    },
    browserAllowHostControl: true,
    browser: {
      bridgeUrl: "http://localhost:9222",
      noVncUrl: "http://localhost:6080",
      containerName: "afora-sbx-browser-test",
    },
  } satisfies SandboxContext;
  return { ...base, ...overrides };
}

describe("buildEmbeddedSandboxInfo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(execApprovals, "loadExecApprovals").mockReturnValue({
      version: 1,
      agents: {},
    });
  });

  it("returns undefined when sandbox is missing", () => {
    expect(buildEmbeddedSandboxInfo()).toBeUndefined();
  });

  it("maps sandbox context into prompt info", () => {
    const sandbox = createSandboxContext();

    expect(buildEmbeddedSandboxInfo(sandbox)).toEqual({
      enabled: true,
      workspaceDir: "/tmp/afora-sandbox",
      containerWorkspaceDir: "/workspace",
      workspaceAccess: "none",
      agentWorkspaceMount: undefined,
      browserBridgeUrl: "http://localhost:9222",
      hostBrowserAllowed: true,
    });
  });

  it("includes elevated info when allowed", () => {
    const sandbox = createSandboxContext({
      browserAllowHostControl: false,
      browser: undefined,
    });

    expect(
      buildEmbeddedSandboxInfo(sandbox, {
        enabled: true,
        allowed: true,
        defaultLevel: "on",
      }),
    ).toEqual({
      enabled: true,
      workspaceDir: "/tmp/afora-sandbox",
      containerWorkspaceDir: "/workspace",
      workspaceAccess: "none",
      agentWorkspaceMount: undefined,
      hostBrowserAllowed: false,
      elevated: {
        allowed: true,
        defaultLevel: "on",
        fullAccessAvailable: true,
      },
    });
  });

  it("keeps full-access unavailability truth when provided", () => {
    // Runtime-level blocks are authoritative and must not be overwritten by
    // host exec policy that appears permissive.
    const sandbox = createSandboxContext();

    expect(
      buildEmbeddedSandboxInfo(sandbox, {
        enabled: true,
        allowed: true,
        defaultLevel: "full",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      }),
    ).toEqual({
      enabled: true,
      workspaceDir: "/tmp/afora-sandbox",
      containerWorkspaceDir: "/workspace",
      workspaceAccess: "none",
      agentWorkspaceMount: undefined,
      browserBridgeUrl: "http://localhost:9222",
      hostBrowserAllowed: true,
      elevated: {
        allowed: true,
        defaultLevel: "full",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      },
    });
  });

  it("marks full access unavailable when exec policy denies execution", () => {
    const sandbox = createSandboxContext();

    expect(
      buildEmbeddedSandboxInfo(
        sandbox,
        {
          enabled: true,
          allowed: true,
          defaultLevel: "full",
        },
        { mode: "deny" },
      )?.elevated,
    ).toEqual({
      allowed: true,
      defaultLevel: "full",
      fullAccessAvailable: false,
      fullAccessBlockedReason: "host-policy",
    });
  });

  it("uses config exec mode when building prompt full-access state", () => {
    const sandbox = createSandboxContext();
    const execPolicy = resolveEmbeddedSandboxInfoExecPolicy({
      config: {
        tools: {
          exec: {
            mode: "auto",
          },
        },
      },
      agentId: "main",
      sandboxAvailable: true,
    });

    expect(
      buildEmbeddedSandboxInfo(
        sandbox,
        {
          enabled: true,
          allowed: true,
          defaultLevel: "full",
        },
        execPolicy,
      )?.elevated,
    ).toEqual({
      allowed: true,
      defaultLevel: "full",
      fullAccessAvailable: false,
      fullAccessBlockedReason: "host-policy",
    });
  });

  it("uses elevated host policy when sandbox is active and exec policy is unset", () => {
    const sandbox = createSandboxContext();
    const execPolicy = resolveEmbeddedSandboxInfoExecPolicy({
      config: {
        tools: {
          exec: {
            host: "auto",
          },
        },
      },
      agentId: "main",
      sandboxAvailable: true,
    });

    expect(
      buildEmbeddedSandboxInfo(
        sandbox,
        {
          enabled: true,
          allowed: true,
          defaultLevel: "full",
        },
        execPolicy,
      )?.elevated,
    ).toEqual({
      allowed: true,
      defaultLevel: "full",
      fullAccessAvailable: true,
    });
  });

  it("marks full access unavailable when host approval defaults deny execution", () => {
    const sandbox = createSandboxContext();

    expect(
      buildEmbeddedSandboxInfo(
        sandbox,
        {
          enabled: true,
          allowed: true,
          defaultLevel: "full",
        },
        { mode: "full", security: "full" },
        { security: "deny" },
      )?.elevated,
    ).toEqual({
      allowed: true,
      defaultLevel: "full",
      fullAccessAvailable: false,
      fullAccessBlockedReason: "host-policy",
    });
  });

  it("marks full access unavailable when host approval floors still require review", () => {
    // Full access is prompt-advertised only when both security level and ask
    // policy allow execution without review.
    const sandbox = createSandboxContext();

    expect(
      buildEmbeddedSandboxInfo(
        sandbox,
        {
          enabled: true,
          allowed: true,
          defaultLevel: "full",
        },
        { mode: "full", security: "full", ask: "off" },
        { security: "allowlist", ask: "off" },
      )?.elevated,
    ).toEqual({
      allowed: true,
      defaultLevel: "full",
      fullAccessAvailable: false,
      fullAccessBlockedReason: "host-policy",
    });

    expect(
      buildEmbeddedSandboxInfo(
        sandbox,
        {
          enabled: true,
          allowed: true,
          defaultLevel: "full",
        },
        { mode: "full", security: "full", ask: "off" },
        { security: "full", ask: "always" },
      )?.elevated,
    ).toEqual({
      allowed: true,
      defaultLevel: "full",
      fullAccessAvailable: false,
      fullAccessBlockedReason: "host-policy",
    });

    expect(
      buildEmbeddedSandboxInfo(
        sandbox,
        {
          enabled: true,
          allowed: true,
          defaultLevel: "full",
        },
        { mode: "full", security: "full", ask: "on-miss" },
        { security: "full", ask: "on-miss" },
      )?.elevated,
    ).toEqual({
      allowed: true,
      defaultLevel: "full",
      fullAccessAvailable: true,
    });
  });
});

describe("resolveEmbeddedFullAccessState", () => {
  it("treats direct host runs with allowed elevation as full-access available", () => {
    expect(
      resolveEmbeddedFullAccessState({
        execElevated: {
          enabled: true,
          allowed: true,
          defaultLevel: "full",
        },
      }),
    ).toEqual({ available: true });
  });

  it("keeps explicit runtime blocks even when host exec is allowed", () => {
    expect(
      resolveEmbeddedFullAccessState({
        execElevated: {
          enabled: true,
          allowed: true,
          defaultLevel: "full",
          fullAccessAvailable: false,
          fullAccessBlockedReason: "runtime",
        },
      }),
    ).toEqual({
      available: false,
      blockedReason: "runtime",
    });
  });
});
