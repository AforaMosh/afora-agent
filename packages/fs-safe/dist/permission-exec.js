import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export const DEFAULT_PERMISSION_EXEC_TIMEOUT_MS = 30_000;
export async function executePermissionCommand(command, args, timeoutMs = DEFAULT_PERMISSION_EXEC_TIMEOUT_MS) {
    try {
        return (await execFileAsync(command, args, {
            encoding: "utf8",
            windowsHide: true,
            maxBuffer: 1024 * 1024,
            timeout: timeoutMs,
            killSignal: "SIGKILL",
        }));
    }
    catch (err) {
        if (err &&
            typeof err === "object" &&
            "killed" in err &&
            err.killed === true &&
            "signal" in err &&
            err.signal === "SIGKILL") {
            throw new Error(`Windows permission inspection timed out after ${timeoutMs}ms`, {
                cause: err,
            });
        }
        throw err;
    }
}
