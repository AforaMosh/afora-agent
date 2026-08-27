import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toStructuredErrorObject } from "@afora/normalization-core/error-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  confirmAforaAgentDatabaseIntegrity,
  listAforaRegisteredAgentDatabases,
  recordAforaAgentDatabaseOpenFailure,
} from "./afora-agent-db.js";
import type {
  AforaDatabaseVerifyResult,
  AforaDatabaseVerifyTarget,
} from "./afora-database-verify.worker.js";
import { recordAforaDatabaseQuarantine } from "./afora-quarantine-store.js";
import {
  confirmAforaStateDatabaseIntegrity,
  recordAforaStateDatabaseOpenFailure,
} from "./afora-state-db.js";
import { resolveAforaStateSqlitePath } from "./afora-state-db.paths.js";

export const AFORA_DATABASE_VERIFY_INITIAL_DELAY_MS = 5 * 60_000;
export const AFORA_DATABASE_VERIFY_INTERVAL_MS = 24 * 60 * 60_000;

const log = createSubsystemLogger("state/database-verify");
const DATABASE_VERIFY_CHILD_ARG = "--afora-database-verify-child";
function resolveDatabaseVerifyWorkerUrl(currentModuleUrl = import.meta.url): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const distMarker = "/dist/";
  const distIndex = normalized.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length);
    return pathToFileURL(path.join(distRoot, "state", "afora-database-verify.worker.js"));
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./afora-database-verify.worker${extension}`, currentModuleUrl);
}

function isVerifyResult(value: unknown): value is AforaDatabaseVerifyResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  return (
    typeof result.path === "string" &&
    typeof result.ok === "boolean" &&
    (result.error === undefined || typeof result.error === "string") &&
    (result.terminal === undefined || typeof result.terminal === "boolean")
  );
}

export function runDatabaseVerifyWorker(
  targets: readonly AforaDatabaseVerifyTarget[],
  options: { onWorker?: (worker: ChildProcess | undefined) => void; workerUrl?: URL } = {},
): Promise<AforaDatabaseVerifyResult[]> {
  const workerUrl = options.workerUrl ?? resolveDatabaseVerifyWorkerUrl();
  const execArgv = workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined;
  let worker: ChildProcess;
  try {
    // Snapshot preparation opens and closes raw source descriptors. Isolate it
    // because POSIX close() can release the Gateway's process-owned SQLite locks.
    worker = fork(fileURLToPath(workerUrl), [DATABASE_VERIFY_CHILD_ARG], {
      execArgv,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
  } catch (error) {
    return Promise.reject(toStructuredErrorObject(error));
  }
  options.onWorker?.(worker);

  return new Promise((resolve, reject) => {
    let settled = false;
    let result: AforaDatabaseVerifyResult[] | undefined;
    let protocolError: Error | undefined;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let disconnected = !worker.connected;
    const settle = (finish: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      worker.removeAllListeners();
      options.onWorker?.(undefined);
      finish();
    };
    const settleAfterExitAndDisconnect = () => {
      const completedExit = exit;
      if (!completedExit || !disconnected) {
        return;
      }
      settle(() => {
        if (protocolError) {
          reject(toStructuredErrorObject(protocolError));
        } else if (completedExit.code !== 0) {
          reject(
            new Error(
              `database verification worker exited with ${
                completedExit.signal
                  ? `signal ${completedExit.signal}`
                  : `code ${completedExit.code}`
              }`,
            ),
          );
        } else if (!result) {
          reject(new Error("database verification worker exited without results"));
        } else {
          resolve(result);
        }
      });
    };
    worker.once("message", (message: unknown) => {
      if (!Array.isArray(message) || !message.every(isVerifyResult)) {
        protocolError = new Error("database verification worker returned invalid results");
        worker.kill();
        return;
      }
      result = message;
    });
    worker.once("error", (error) => settle(() => reject(toStructuredErrorObject(error))));
    worker.once("disconnect", () => {
      disconnected = true;
      settleAfterExitAndDisconnect();
    });
    worker.once("exit", (code, signal) => {
      exit = { code, signal };
      disconnected ||= !worker.connected;
      settleAfterExitAndDisconnect();
    });
    worker.send(targets, (error) => {
      if (!error) {
        return;
      }
      worker.kill();
      settle(() => reject(toStructuredErrorObject(error)));
    });
  });
}

export async function terminateDatabaseVerifyWorker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    worker.once("exit", () => resolve());
    if (!worker.kill()) {
      resolve();
    }
  });
}

/** Resolve the state database and current registered agent database paths. */
export function collectAforaDatabaseVerifyTargets(options: {
  env: NodeJS.ProcessEnv;
}): AforaDatabaseVerifyTarget[] {
  const targets = new Map<string, AforaDatabaseVerifyTarget>();
  const statePath = path.resolve(resolveAforaStateSqlitePath(options.env));
  if (existsSync(statePath)) {
    targets.set(statePath, { kind: "state", label: "Afora state database", path: statePath });
  }
  let registeredDatabases: ReturnType<typeof listAforaRegisteredAgentDatabases> = [];
  try {
    registeredDatabases = listAforaRegisteredAgentDatabases({ env: options.env });
  } catch (error) {
    log.warn("failed to collect registered agent databases for integrity verification", {
      error: String(error),
    });
  }
  for (const registered of registeredDatabases) {
    const agentPath = path.resolve(registered.path);
    if (!existsSync(agentPath) || targets.has(agentPath)) {
      continue;
    }
    targets.set(agentPath, {
      kind: "agent",
      label: `Afora agent database ${registered.agentId}`,
      path: agentPath,
    });
  }
  return [...targets.values()];
}

/** Reconfirm worker failures on live owners before quarantine and latching. */
export function applyAforaDatabaseVerificationResults(options: {
  env: NodeJS.ProcessEnv;
  results: readonly AforaDatabaseVerifyResult[];
  targets: readonly AforaDatabaseVerifyTarget[];
}): void {
  const targetByPath = new Map(options.targets.map((target) => [target.path, target]));

  for (const result of options.results) {
    const target = targetByPath.get(result.path);
    if (!target) {
      continue;
    }
    if (result.ok) {
      log.info("database integrity verification passed", {
        kind: target.kind,
        label: target.label,
        path: result.path,
      });
      continue;
    }
    if (!result.terminal) {
      log.warn("database integrity verification was inconclusive", {
        kind: target.kind,
        label: target.label,
        path: result.path,
        error: result.error,
      });
      continue;
    }
    const confirmation =
      target.kind === "state"
        ? confirmAforaStateDatabaseIntegrity(result.path)
        : confirmAforaAgentDatabaseIntegrity(result.path);
    if (confirmation.status === "healthy") {
      log.info("discarding stale database integrity verification result", {
        kind: target.kind,
        label: target.label,
        path: result.path,
      });
      continue;
    }
    if (!confirmation.terminal) {
      log.warn("database integrity verification was inconclusive", {
        kind: target.kind,
        label: target.label,
        path: result.path,
        error: confirmation.error.message,
      });
      continue;
    }
    const latched =
      target.kind === "state"
        ? recordAforaStateDatabaseOpenFailure(
            result.path,
            confirmation.error,
            confirmation.generation,
          )
        : recordAforaAgentDatabaseOpenFailure(
            result.path,
            confirmation.error,
            confirmation.generation,
          );
    if (!latched) {
      log.info("discarding database integrity result after database generation changed", {
        kind: target.kind,
        label: target.label,
        path: result.path,
      });
      continue;
    }
    const recorded = recordAforaDatabaseQuarantine({
      env: options.env,
      generation: confirmation.generation,
      kind: target.kind,
      path: result.path,
      reason: confirmation.error.message,
    });
    if (!recorded) {
      // Store unavailable. Daily verification retries persistence.
      log.error("failed to persist database quarantine; quarantine is process-local", {
        kind: target.kind,
        path: result.path,
      });
    }
    log.error("database integrity verification failed", {
      kind: target.kind,
      label: target.label,
      path: result.path,
      error: confirmation.error.message,
    });
  }
}
