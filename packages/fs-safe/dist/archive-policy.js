import { ArchiveSecurityError } from "./archive-errors.js";
import { formatErrorDetail } from "./error-detail.js";
export function archiveEntryKindFromTarType(type) {
    if (type === "Directory" || type === "GNUDumpDir")
        return "directory";
    if (type === "File" || type === "OldFile" || type === "ContiguousFile")
        return "file";
    if (type === "SymbolicLink" || type === "Link")
        return "symlink";
    return "other";
}
export function resolveArchiveEntryMode(params) {
    const archivedMode = (params.archivedMode ?? 0) & 0o777;
    if (params.policy === "preserve") {
        return archivedMode || (params.kind === "directory" ? 0o755 : 0o644);
    }
    if (params.kind === "directory") {
        return 0o755;
    }
    return archivedMode & 0o100 ? 0o755 : 0o644;
}
export function shouldExtractArchiveEntry(params) {
    if (!params.filter || params.filter(params.entry) === "extract") {
        return true;
    }
    if ((params.onFiltered ?? "reject-archive") === "reject-archive") {
        throw new ArchiveSecurityError("entry-filtered", `archive entry rejected by filter: ${formatErrorDetail(params.entry.path)}`);
    }
    return false;
}
