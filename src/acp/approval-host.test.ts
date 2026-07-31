import type {
  AgentSideConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunExecApprovalRequest } from "../agents/agent-run-approval.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { createAcpApprovalHost } from "./approval-host.js";

type TestAcpConnection = AgentSideConnection & {
  permissionSpy: ReturnType<typeof vi.fn>;
};

function createConnection(
  requestPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
): TestAcpConnection {
  const requestPermissionSpy = vi.fn(requestPermission);
  return {
    requestPermission: requestPermissionSpy,
    permissionSpy: requestPermissionSpy,
  } as unknown as TestAcpConnection;
}

function createHost(connection: AgentSideConnection) {
  return createAcpApprovalHost({ connection, sessionId: "acp-session-1" });
}

function execRequest(
  overrides: Partial<AgentRunExecApprovalRequest> = {},
): AgentRunExecApprovalRequest {
  return {
    id: "exec-approval-1",
    command: "echo hi",
    commandArgv: ["echo", "hi"],
    env: { Z_VAR: "secret-z", A_VAR: "secret-a" },
    cwd: "/tmp/project",
    host: "gateway",
    security: "allowlist",
    ask: "on-miss",
    toolCallId: "tool-1",
    ...overrides,
  };
}

function pluginRequest(
  overrides: Partial<PluginApprovalRequestPayload> = {},
): PluginApprovalRequestPayload {
  return {
    pluginId: "test-plugin",
    title: "Approve operation",
    description: "Review the operation",
    detail: "Operation detail",
    severity: "warning",
    toolName: "test_tool",
    toolCallId: "tool-plugin-1",
    allowedDecisions: ["allow-once"],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createAcpApprovalHost", () => {
  it("returns the exact exec lease and maps its request directly to ACP", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const connection = createConnection(async () => ({
      outcome: { outcome: "selected", optionId: "allow-always" },
    }));
    const host = createHost(connection);

    const lease = await host.exec!.request({
      request: execRequest(),
      timeoutMs: 5_000,
    });

    expect(host.exec!.supportsDetachedExecution).toBeUndefined();
    expect(lease.id).toBe("exec-approval-1");
    expect(lease.expiresAtMs).toBe(1_800_000_005_000);
    expect(connection.permissionSpy).not.toHaveBeenCalled();
    await expect(lease.wait()).resolves.toBe("allow-always");
    expect(connection.permissionSpy).toHaveBeenCalledWith({
      sessionId: "acp-session-1",
      toolCall: {
        toolCallId: "tool-1",
        title: "Command approval requested",
        kind: "execute",
        status: "pending",
        rawInput: {
          name: "exec",
          approvalId: "exec-approval-1",
          host: "gateway",
          security: "allowlist",
          ask: "on-miss",
          command: "echo hi",
          commandArgv: ["echo", "hi"],
          cwd: "/tmp/project",
          envKeys: ["A_VAR", "Z_VAR"],
        },
        _meta: {
          toolName: "exec",
          approvalId: "exec-approval-1",
        },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    expect(JSON.stringify(connection.permissionSpy.mock.calls)).not.toContain("secret-");
  });

  it("removes unavailable exec decisions from ACP options", async () => {
    const connection = createConnection(async () => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));
    const lease = await createHost(connection).exec!.request({
      request: execRequest({ unavailableDecisions: ["allow-always"] }),
      timeoutMs: 5_000,
    });

    await expect(lease.wait()).resolves.toBe("allow-once");
    expect(connection.permissionSpy.mock.calls[0]?.[0].options).toEqual([
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ]);
  });

  it("shows only the authoritative system run plan command, argv, and cwd", async () => {
    const connection = createConnection(async () => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));
    const lease = await createHost(connection).exec!.request({
      request: execRequest({
        command: "cat /tmp/approved.txt",
        commandArgv: ["cat", "/tmp/approved.txt"],
        cwd: "/tmp/outer-cwd",
        host: "node",
        systemRunPlan: {
          commandText: "rm -rf /tmp/actual-target",
          commandPreview: "rm -rf /tmp/actual-target",
          argv: ["rm", "-rf", "/tmp/actual-target"],
          cwd: "/tmp/plan-cwd",
          agentId: "main",
          sessionKey: "agent:main:session-1",
        },
      }),
      timeoutMs: 5_000,
    });

    await expect(lease.wait()).resolves.toBe("allow-once");
    expect(connection.permissionSpy.mock.calls[0]?.[0].toolCall.rawInput).toMatchObject({
      command: "rm -rf /tmp/actual-target",
      commandArgv: ["rm", "-rf", "/tmp/actual-target"],
      cwd: "/tmp/plan-cwd",
    });
    expect(JSON.stringify(connection.permissionSpy.mock.calls)).not.toContain("approved.txt");
    expect(JSON.stringify(connection.permissionSpy.mock.calls)).not.toContain("outer-cwd");
  });

  it.each([
    { outcome: { outcome: "cancelled" as const } },
    { outcome: { outcome: "selected" as const, optionId: "not-offered" } },
  ])("fails closed for cancelled or invalid exec outcomes", async (response) => {
    const connection = createConnection(async () => response);
    const lease = await createHost(connection).exec!.request({
      request: execRequest(),
      timeoutMs: 5_000,
    });

    await expect(lease.wait()).resolves.toBe("deny");
  });

  it("fails closed when the exec permission request throws", async () => {
    const connection = createConnection(async () => {
      throw new Error("client disconnected");
    });
    const lease = await createHost(connection).exec!.request({
      request: execRequest(),
      timeoutMs: 5_000,
    });

    await expect(lease.wait()).resolves.toBe("deny");
  });

  it("keeps timed-out and cancelled exec approvals denied after late responses", async () => {
    vi.useFakeTimers();
    const expiredConnection = createConnection(async () => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));
    const expiredLease = await createHost(expiredConnection).exec!.request({
      request: execRequest({ id: "exec-expired" }),
      timeoutMs: 0,
    });
    await expiredLease.resolveAutoReview();
    await expect(expiredLease.wait()).resolves.toBe("deny");
    expect(expiredConnection.permissionSpy).not.toHaveBeenCalled();

    let resolveTimedOutPermission!: (response: RequestPermissionResponse) => void;
    const timeoutConnection = createConnection(
      () =>
        new Promise((resolve) => {
          resolveTimedOutPermission = resolve;
        }),
    );
    const timeoutLease = await createHost(timeoutConnection).exec!.request({
      request: execRequest(),
      timeoutMs: 100,
    });
    const timeoutDecision = timeoutLease.wait();
    await vi.advanceTimersByTimeAsync(100);
    await expect(timeoutDecision).resolves.toBe("deny");
    resolveTimedOutPermission({ outcome: { outcome: "selected", optionId: "allow-once" } });
    await expect(timeoutLease.wait()).resolves.toBe("deny");

    const stalledConnection = createConnection(async () => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));
    const stalledLease = await createHost(stalledConnection).exec!.request({
      request: execRequest({ id: "exec-stalled" }),
      timeoutMs: 100,
    });
    vi.setSystemTime(Date.now() + 100);
    await expect(stalledLease.wait()).resolves.toBe("deny");
    expect(stalledConnection.permissionSpy).not.toHaveBeenCalled();

    let resolveCancelledPermission!: (response: RequestPermissionResponse) => void;
    const cancelledConnection = createConnection(
      () =>
        new Promise((resolve) => {
          resolveCancelledPermission = resolve;
        }),
    );
    const cancelledLease = await createHost(cancelledConnection).exec!.request({
      request: execRequest({ id: "exec-cancelled" }),
      timeoutMs: 5_000,
    });
    const cancelledDecision = cancelledLease.wait();
    await vi.waitFor(() => {
      expect(cancelledConnection.permissionSpy).toHaveBeenCalledOnce();
    });
    await cancelledLease.cancel();
    await expect(cancelledDecision).resolves.toBe("deny");
    resolveCancelledPermission({ outcome: { outcome: "selected", optionId: "allow-once" } });
    await expect(cancelledLease.wait()).resolves.toBe("deny");
  });

  it("rejects exec run aborts with the original reason and ignores late approval", async () => {
    let resolvePermission!: (response: RequestPermissionResponse) => void;
    const connection = createConnection(
      () =>
        new Promise((resolve) => {
          resolvePermission = resolve;
        }),
    );
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    const lease = await createHost(connection).exec!.request({
      request: execRequest(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    const decision = lease.wait();
    await vi.waitFor(() => {
      expect(connection.permissionSpy).toHaveBeenCalledOnce();
    });

    controller.abort(abortReason);
    await expect(decision).rejects.toBe(abortReason);
    resolvePermission({ outcome: { outcome: "selected", optionId: "allow-once" } });
    await expect(lease.wait()).rejects.toBe(abortReason);

    let resolveWaitPermission!: (response: RequestPermissionResponse) => void;
    const waitConnection = createConnection(
      () =>
        new Promise((resolve) => {
          resolveWaitPermission = resolve;
        }),
    );
    const waitLease = await createHost(waitConnection).exec!.request({
      request: execRequest({ id: "exec-wait-aborted" }),
      timeoutMs: 5_000,
    });
    const waitController = new AbortController();
    const waitAbortReason = new Error("wait aborted");
    const waitDecision = waitLease.wait({ signal: waitController.signal });
    await vi.waitFor(() => {
      expect(waitConnection.permissionSpy).toHaveBeenCalledOnce();
    });
    waitController.abort(waitAbortReason);
    await expect(waitDecision).rejects.toBe(waitAbortReason);
    resolveWaitPermission({ outcome: { outcome: "selected", optionId: "allow-once" } });
    await expect(waitLease.wait()).resolves.toBe("allow-once");

    const synchronousController = new AbortController();
    const synchronousAbortReason = new Error("synchronous wait abort");
    const synchronousConnection = createConnection(
      () =>
        new Promise(() => {
          synchronousController.abort(synchronousAbortReason);
        }),
    );
    const synchronousLease = await createHost(synchronousConnection).exec!.request({
      request: execRequest({ id: "exec-synchronous-wait-abort" }),
      timeoutMs: 5_000,
    });
    await expect(synchronousLease.wait({ signal: synchronousController.signal })).rejects.toBe(
      synchronousAbortReason,
    );
  });

  it("resolves exec auto-review without opening ACP permission UI", async () => {
    const connection = createConnection(
      () =>
        new Promise(() => {
          // Auto-review owns this decision without asking the client.
        }),
    );
    const lease = await createHost(connection).exec!.request({
      request: execRequest(),
      timeoutMs: 5_000,
    });

    await lease.resolveAutoReview();
    await expect(lease.wait()).resolves.toBe("allow-once");
    expect(connection.permissionSpy).not.toHaveBeenCalled();
  });

  it("maps plugin approvals and registers the exact id sent to ACP", async () => {
    const connection = createConnection(async () => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));
    const onRegistered = vi.fn();

    await expect(
      createHost(connection).plugin!.request({
        request: pluginRequest(),
        timeoutMs: 5_000,
        onRegistered,
      }),
    ).resolves.toEqual({ outcome: "resolved", decision: "allow-once" });

    const approvalId = onRegistered.mock.calls[0]?.[0].id;
    expect(approvalId).toMatch(/^plugin:/);
    expect(connection.permissionSpy).toHaveBeenCalledWith({
      sessionId: "acp-session-1",
      toolCall: {
        toolCallId: "tool-plugin-1",
        title: "Approve operation",
        kind: "other",
        status: "pending",
        rawInput: {
          name: "test_tool",
          approvalId,
          title: "Approve operation",
          description: "Review the operation",
          pluginId: "test-plugin",
          detail: "Operation detail",
          severity: "warning",
        },
        _meta: {
          toolName: "test_tool",
          approvalId,
          pluginId: "test-plugin",
        },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
  });

  it.each([
    { outcome: { outcome: "cancelled" as const } },
    { outcome: { outcome: "selected" as const, optionId: "allow-always" } },
  ])("fails closed for cancelled or unoffered plugin outcomes", async (response) => {
    const connection = createConnection(async () => response);

    await expect(
      createHost(connection).plugin!.request({
        request: pluginRequest(),
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({ outcome: "resolved", decision: "deny" });
  });

  it("reports plugin timeout and transport failure without approving", async () => {
    vi.useFakeTimers();
    const timeoutConnection = createConnection(
      () =>
        new Promise(() => {
          // Intentionally unresolved until the approval deadline.
        }),
    );
    const timedOut = createHost(timeoutConnection).plugin!.request({
      request: pluginRequest(),
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(timedOut).resolves.toEqual({ outcome: "timed-out" });

    const failedConnection = createConnection(async () => {
      throw new Error("client disconnected");
    });
    await expect(
      createHost(failedConnection).plugin!.request({
        request: pluginRequest(),
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({
      outcome: "unavailable",
      reason: "ACP permission request failed.",
    });
  });

  it("keeps plugin approval denied after a response reaches its deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    let resolvePermission!: (response: RequestPermissionResponse) => void;
    const connection = createConnection(
      () =>
        new Promise((resolve) => {
          resolvePermission = resolve;
        }),
    );
    const approval = createHost(connection).plugin!.request({
      request: pluginRequest(),
      timeoutMs: 100,
    });
    await vi.waitFor(() => {
      expect(connection.permissionSpy).toHaveBeenCalledOnce();
    });

    vi.setSystemTime(1_800_000_000_100);
    resolvePermission({ outcome: { outcome: "selected", optionId: "allow-once" } });

    await expect(approval).resolves.toEqual({ outcome: "timed-out" });
  });

  it("counts plugin registration time against the approval deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const connection = createConnection(async () => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));

    await expect(
      createHost(connection).plugin!.request({
        request: pluginRequest(),
        timeoutMs: 100,
        onRegistered: () => {
          vi.setSystemTime(1_800_000_000_100);
        },
      }),
    ).resolves.toEqual({ outcome: "timed-out" });
    expect(connection.permissionSpy).not.toHaveBeenCalled();
  });

  it("propagates plugin aborts and does not open UI when registration fails", async () => {
    const abortConnection = createConnection(
      () =>
        new Promise(() => {
          // Intentionally unresolved until the run aborts.
        }),
    );
    const controller = new AbortController();
    const abortReason = new Error("run aborted");
    const approval = createHost(abortConnection).plugin!.request({
      request: pluginRequest(),
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(abortConnection.permissionSpy).toHaveBeenCalledOnce();
    });
    controller.abort(abortReason);
    await expect(approval).rejects.toBe(abortReason);

    const registrationConnection = createConnection(async () => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));
    await expect(
      createHost(registrationConnection).plugin!.request({
        request: pluginRequest(),
        timeoutMs: 5_000,
        onRegistered: () => {
          throw new Error("registration failed");
        },
      }),
    ).rejects.toThrow("registration failed");
    expect(registrationConnection.permissionSpy).not.toHaveBeenCalled();
  });
});
