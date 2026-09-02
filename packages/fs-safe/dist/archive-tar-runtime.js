import { ArchiveFormatError } from "./archive-errors.js";
export async function importOptionalTar() {
    try {
        return await import("tar");
    }
    catch (cause) {
        throw new Error('Optional archive dependency "tar" is not installed. Install it to use TAR archive helpers from @afora/fs-safe/archive.', { cause });
    }
}
export function normalizeTarParserError(error) {
    const code = error?.code;
    if (typeof code !== "string" || !code.startsWith("TAR_")) {
        return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new ArchiveFormatError(`invalid TAR archive: ${message}`, {
        cause: error instanceof Error ? error : undefined,
    });
}
