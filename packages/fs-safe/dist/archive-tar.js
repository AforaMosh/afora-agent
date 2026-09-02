import { createArchiveOutputPathTracker, resolveArchiveOutputPath, stripArchivePath, validateArchiveEntryPath, } from "./archive-entry.js";
import { assertArchiveEntryCountWithinLimit, assertArchiveEntryPathComponentsWithinLimit, createByteBudgetTracker, resolveExtractLimits, } from "./archive-limits.js";
import { archiveEntryKindFromTarType, shouldExtractArchiveEntry, } from "./archive-policy.js";
import { ArchiveSecurityError } from "./archive-errors.js";
import { formatErrorDetail } from "./error-detail.js";
const BLOCKED_TAR_ENTRY_TYPES = new Set([
    "SymbolicLink",
    "Link",
    "BlockDevice",
    "CharacterDevice",
    "FIFO",
    "Socket",
]);
export function readTarEntryInfo(entry) {
    const p = typeof entry === "object" && entry !== null && "path" in entry
        ? String(entry.path)
        : "";
    const t = typeof entry === "object" && entry !== null && "type" in entry
        ? String(entry.type)
        : "";
    const s = typeof entry === "object" &&
        entry !== null &&
        "size" in entry &&
        typeof entry.size === "number" &&
        Number.isFinite(entry.size)
        ? Math.max(0, Math.floor(entry.size))
        : 0;
    const mode = typeof entry === "object" &&
        entry !== null &&
        "mode" in entry &&
        typeof entry.mode === "number"
        ? entry.mode
        : undefined;
    return { path: p, type: t, size: s, mode };
}
export function createTarEntryPreflightChecker(params) {
    const strip = Math.max(0, Math.floor(params.stripComponents ?? 0));
    const limits = resolveExtractLimits(params.limits);
    let entryCount = 0;
    const budget = createByteBudgetTracker(limits);
    const trackOutputPath = createArchiveOutputPathTracker();
    return (entry) => {
        entryCount += 1;
        assertArchiveEntryCountWithinLimit(entryCount, limits);
        validateArchiveEntryPath(entry.path, { escapeLabel: params.escapeLabel });
        const relPath = stripArchivePath(entry.path, strip);
        if (!relPath) {
            return false;
        }
        validateArchiveEntryPath(relPath, { escapeLabel: params.escapeLabel });
        assertArchiveEntryPathComponentsWithinLimit(relPath, limits);
        trackOutputPath(relPath, entry.path);
        resolveArchiveOutputPath({
            rootDir: params.rootDir,
            relPath,
            originalPath: entry.path,
            escapeLabel: params.escapeLabel,
        });
        const kind = archiveEntryKindFromTarType(entry.type);
        if (!shouldExtractArchiveEntry({
            filter: params.entryFilter,
            onFiltered: params.onFiltered,
            entry: { path: entry.path, kind, size: entry.size },
        })) {
            return false;
        }
        if (BLOCKED_TAR_ENTRY_TYPES.has(entry.type)) {
            throw new ArchiveSecurityError("entry-link", `tar entry is a link: ${formatErrorDetail(entry.path)}`);
        }
        budget.startEntry();
        budget.addEntrySize(entry.size);
        return true;
    };
}
