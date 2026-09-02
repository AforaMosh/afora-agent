import { FsSafeError } from "./errors.js";
import { isNodeError } from "./path.js";
export function throwFsSafeReadError(error, label) {
    if (error instanceof FsSafeError) {
        throw error;
    }
    if (isNodeError(error)) {
        throw new FsSafeError("read-failed", `${label} target could not be read`, { cause: error });
    }
    throw error;
}
