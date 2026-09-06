/**
 * Loopback interrupt tests.
 * On the claude-cli backend the CLI child does not run Afora tools in-process:
 * it calls them back over this MCP HTTP loopback, so "the tool" executes inside
 * the Gateway while the run's AbortController lives in the Gateway's own map.
 * The request socket alone only reports that the child hung up, which happens
 * after the child is already dead and the tool has already finished. These
 * tests pin that the run's own signal reaches tool.execute.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import type { runBeforeToolCallHook } from "../agents/agent-tools.before-tool-call.js";
import { killProcessTree } from "../process/kill-tree.js";
import { waitForPidToExit } from "../test-utils/process-tree.js";

type MockBeforeToolCallHookResult = Awaited<ReturnType<typeof runBeforeToolCallHook>>;

const runBeforeToolCallHookMock = vi.hoisted(() =>
  vi.fn(
    async (args: { params: unknown }): Promise<MockBeforeToolCallHookResult> => ({
      blocked: false,
      params: args.params,
    }),
  ),
);

const scopedToolsMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => { agentId: string; tools: unknown[] }>(() => ({
    agentId: "main",
    tools: [],
  })),
);

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => ({ session: { mainKey: "main" } }),
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKey: () => "agent:main:main",
}));

vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: (...args: Parameters<typeof runBeforeToolCallHookMock>) =>
    runBeforeToolCallHookMock(...args),
}));

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools: (...args: Parameters<typeof scopedToolsMock>) =>
    scopedToolsMock(...args),
}));

import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { createExecTool } from "../agents/bash-tools.exec-run.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

const TOOL_CALL_TIMEOUT_MS = 20_000;
const CHILD_HOLD_MS = 10_000;
const PID_WAIT_TIMEOUT_MS = 10_000;

const admissions: PreparedAgentRunAdmission[] = [];
let tmpDir: string | undefined;
let holdScriptPath = "";
let capturedPid: number | undefined;
let server: Awaited<ReturnType<typeof ensureMcpLoopbackServer>> | undefined;

async function admitted(runId: string): Promise<AdmittedRunContext> {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "system", boundary: "mcp-http-abort-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  admissions.push(admission);
  return await admission.admit("gateway", `gateway-${runId}`);
}

/** Quotes a command the way the platform's default shell parses it. */
function shellCommand(parts: string[]): string {
  const quoted = parts.map((part) => `"${part}"`).join(" ");
  // PowerShell treats a leading quoted string as a literal, not a command.
  return process.platform === "win32" ? `& ${quoted}` : quoted;
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contents = (await fs.readFile(filePath, "utf8")).trim();
      if (contents) {
        return true;
      }
    } catch {
      // Not written yet.
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return false;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

type LoopbackToolCall = {
  response: Promise<Response>;
  pidPath: string;
  sentinelPath: string;
};

/**
 * Boots the loopback server with the real exec tool behind a grant carrying
 * `runAbortSignal`, and issues one `tools/call` that parks a real child process.
 */
async function startHeldExecToolCall(params: {
  runId: string;
  runAbortSignal?: AbortSignal;
  fetchSignal?: AbortSignal;
  holdMs?: number;
}): Promise<LoopbackToolCall> {
  const execTool = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    // Yielding to background is a deliberate abort exemption
    // (bash-tools.exec-run.ts). Keep this call in the foreground so the test
    // measures cancellation, not the exemption.
    allowBackground: false,
  });
  scopedToolsMock.mockImplementation(() => ({ agentId: "main", tools: [execTool] }));

  server = await ensureMcpLoopbackServer(0);
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("expected active MCP loopback runtime");
  }
  const grant = mintMcpLoopbackClientGrant({
    context: { sessionKey: "agent:main:main", senderIsOwner: true },
    runtimeOwnerToken: runtime.ownerToken,
    admittedRunContext: await admitted(params.runId),
    ...(params.runAbortSignal ? { runAbortSignal: params.runAbortSignal } : {}),
  });
  expect(
    activateMcpLoopbackClientGrantCapture({
      token: grant.token,
      runtimeOwnerToken: runtime.ownerToken,
      captureKey: "capture-abort",
    }),
  ).toBe(true);

  const pidPath = path.join(tmpDir ?? os.tmpdir(), `${params.runId}.pid`);
  const sentinelPath = path.join(tmpDir ?? os.tmpdir(), `${params.runId}.done`);
  const command = shellCommand([
    process.execPath,
    holdScriptPath,
    pidPath,
    sentinelPath,
    String(params.holdMs ?? CHILD_HOLD_MS),
  ]);

  const response = fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${grant.token}`,
      "content-type": "application/json",
      "x-afora-cli-capture-key": "capture-abort",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "exec", arguments: { command } },
    }),
    ...(params.fetchSignal ? { signal: params.fetchSignal } : {}),
  });
  return { response, pidPath, sentinelPath };
}

async function readToolCallResult(response: Response) {
  expect(response.status).toBe(200);
  return (await response.json()) as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  capturedPid = undefined;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "afora-loopback-abort-"));
  holdScriptPath = path.join(tmpDir, "hold.cjs");
  // The pid lands on disk before the hold starts, so the test can wait for a
  // real child rather than racing the spawn with a fixed sleep.
  await fs.writeFile(
    holdScriptPath,
    [
      'const fs = require("node:fs");',
      "const [pidPath, sentinelPath, holdMs] = process.argv.slice(2);",
      "fs.writeFileSync(pidPath, String(process.pid));",
      'setTimeout(() => fs.writeFileSync(sentinelPath, "completed"), Number(holdMs));',
    ].join("\n"),
    "utf8",
  );
});

afterEach(async () => {
  await closeMcpLoopbackServer();
  server = undefined;
  if (capturedPid !== undefined) {
    try {
      killProcessTree(capturedPid);
    } catch {
      // The child is normally already gone; cleanup must not fail the test.
    }
  }
  resetProcessRegistryForTests();
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("mcp loopback run interrupt", () => {
  it(
    "kills a foreground exec child when the run is interrupted",
    async () => {
      const runAbort = new AbortController();
      const call = await startHeldExecToolCall({
        runId: "run-loopback-abort",
        runAbortSignal: runAbort.signal,
      });

      expect(await waitForFile(call.pidPath, PID_WAIT_TIMEOUT_MS)).toBe(true);
      capturedPid = Number((await fs.readFile(call.pidPath, "utf8")).trim());
      expect(Number.isInteger(capturedPid)).toBe(true);

      runAbort.abort();

      expect(await waitForPidToExit(capturedPid, 5_000)).toBe(true);
      expect(await fileExists(call.sentinelPath)).toBe(false);

      // The tool_use the child issued is still answered: an aborted loopback
      // call returns an isError result rather than dropping the response, so
      // the transcript cannot be left waiting for a result that never comes.
      const payload = await readToolCallResult(await call.response);
      expect(payload.result?.isError).toBe(true);
    },
    TOOL_CALL_TIMEOUT_MS,
  );

  it(
    "leaves an uninterrupted exec call to complete normally",
    async () => {
      const runAbort = new AbortController();
      const call = await startHeldExecToolCall({
        runId: "run-loopback-complete",
        runAbortSignal: runAbort.signal,
        holdMs: 0,
      });

      const payload = await readToolCallResult(await call.response);
      expect(payload.result?.isError).toBeFalsy();
      expect(await fileExists(call.sentinelPath)).toBe(true);
      expect(runAbort.signal.aborted).toBe(false);
    },
    TOOL_CALL_TIMEOUT_MS,
  );

  it(
    "still cancels on request disconnect when the run carries no signal",
    async () => {
      // A grant with no runAbortSignal must leave the handler on exactly the
      // request socket it used before this lane existed.
      const fetchAbort = new AbortController();
      const call = await startHeldExecToolCall({
        runId: "run-loopback-socket",
        fetchSignal: fetchAbort.signal,
      });
      void call.response.catch(() => {});

      expect(await waitForFile(call.pidPath, PID_WAIT_TIMEOUT_MS)).toBe(true);
      capturedPid = Number((await fs.readFile(call.pidPath, "utf8")).trim());

      fetchAbort.abort();
      await expect(call.response).rejects.toThrow();
      expect(await waitForPidToExit(capturedPid, 5_000)).toBe(true);
      expect(await fileExists(call.sentinelPath)).toBe(false);
    },
    TOOL_CALL_TIMEOUT_MS,
  );
});
