import { FsSafeError } from "./errors.js";
import { getNativeBinding } from "./native.js";
export function readOwnerAndDacl(targetPath) {
    if (process.platform !== "win32") {
        return { status: "unsupported-platform", platform: process.platform };
    }
    const native = getNativeBinding();
    if (!native) {
        throw new FsSafeError("helper-unavailable", "Windows owner and DACL facts require the bundled native binding");
    }
    const facts = native.readOwnerAndDacl(targetPath);
    return {
        status: "supported",
        ownerSid: facts.ownerSid,
        currentUserSid: facts.currentUserSid,
        daclPresent: facts.daclPresent,
        isLocal: facts.isLocal,
        complete: facts.aceListComplete,
        unsupportedAceTypes: [...facts.unsupportedAceTypes],
        aces: facts.aces.map((entry) => ({
            sid: entry.sid,
            mask: entry.mask,
            aceType: entry.aceType,
            flags: { ...entry.flags },
        })),
    };
}
