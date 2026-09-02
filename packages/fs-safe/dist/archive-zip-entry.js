import { resolveArchiveEntryMode, } from "./archive-policy.js";
export function zipEntryIntegrityMetadata(entry) {
    const data = entry._data;
    if (!data || "then" in data)
        return undefined;
    return data;
}
export function hasDeferredEmptyZipData(entry) {
    const data = entry._data;
    return Boolean(data && "then" in data);
}
const ZIP_UNIX_FILE_TYPE_MASK = 0o170000;
const ZIP_UNIX_SYMLINK_TYPE = 0o120000;
export function isZipSymlinkEntry(entry) {
    return (typeof entry.unixPermissions === "number" &&
        (entry.unixPermissions & ZIP_UNIX_FILE_TYPE_MASK) === ZIP_UNIX_SYMLINK_TYPE);
}
export function zipEntryMode(entry, policy) {
    return resolveArchiveEntryMode({
        kind: entry.dir ? "directory" : "file",
        archivedMode: entry.unixPermissions,
        policy,
    });
}
export function zipEntryDeclaredSize(entry) {
    return Math.max(0, Math.floor(zipEntryIntegrityMetadata(entry)?.uncompressedSize ?? 0));
}
