import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
export async function createPrivateDirectory(targetPath, options) {
    const platform = options?.platform ?? process.platform;
    if (platform !== "win32") {
        throw new FsSafeError("helper-unavailable", "private-directory creation is available only on Windows through the bundled native binding");
    }
    const native = getNativeBinding();
    if (!native) {
        throw new FsSafeError("helper-unavailable", "private Windows directory creation requires the bundled native binding");
    }
    native.createPrivateDirectory(targetPath);
}
