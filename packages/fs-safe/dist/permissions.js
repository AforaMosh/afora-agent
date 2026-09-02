import fs from "node:fs/promises";
import { formatIcaclsResetCommand, inspectWindowsPermissions, } from "./permissions-windows.js";
export { createIcaclsResetCommand, formatIcaclsResetCommand, formatWindowsAclSummary, inspectWindowsAcl, parseIcaclsOutput, resolveWindowsUserPrincipal, summarizeWindowsAcl, } from "./permissions-windows.js";
export async function safeStat(targetPath) {
    try {
        const lst = await fs.lstat(targetPath);
        return {
            ok: true,
            isSymlink: lst.isSymbolicLink(),
            isDir: lst.isDirectory(),
            mode: typeof lst.mode === "number" ? lst.mode : null,
            uid: typeof lst.uid === "number" ? lst.uid : null,
            gid: typeof lst.gid === "number" ? lst.gid : null,
        };
    }
    catch (err) {
        return {
            ok: false,
            isSymlink: false,
            isDir: false,
            mode: null,
            uid: null,
            gid: null,
            error: String(err),
        };
    }
}
export async function inspectPathPermissions(targetPath, opts) {
    const st = await safeStat(targetPath);
    if (!st.ok) {
        return {
            ok: false,
            isSymlink: false,
            isDir: false,
            mode: null,
            bits: null,
            source: "unknown",
            worldWritable: false,
            groupWritable: false,
            worldReadable: false,
            groupReadable: false,
            error: st.error,
        };
    }
    let effectiveMode = st.mode;
    let effectiveIsDir = st.isDir;
    if (st.isSymlink) {
        try {
            const target = await fs.stat(targetPath);
            effectiveMode = typeof target.mode === "number" ? target.mode : st.mode;
            effectiveIsDir = target.isDirectory();
        }
        catch {
            // Keep lstat metadata when the symlink target cannot be inspected.
        }
    }
    const bits = modeBits(effectiveMode);
    const platform = opts?.platform ?? process.platform;
    if (platform === "win32") {
        return await inspectWindowsPermissions({
            targetPath,
            stat: st,
            effectiveIsDir,
            effectiveMode,
            bits,
            opts,
        });
    }
    return {
        ok: true,
        isSymlink: st.isSymlink,
        isDir: effectiveIsDir,
        mode: effectiveMode,
        bits,
        source: "posix",
        worldWritable: isWorldWritable(bits),
        groupWritable: isGroupWritable(bits),
        worldReadable: isWorldReadable(bits),
        groupReadable: isGroupReadable(bits),
    };
}
export function formatPermissionDetail(targetPath, perms) {
    if (perms.source === "windows-acl") {
        return `${targetPath} acl=${perms.aclSummary ?? "unknown"}`;
    }
    return `${targetPath} mode=${formatOctal(perms.bits)}`;
}
export function formatPermissionRemediation(params) {
    if (params.perms.source === "windows-acl") {
        return formatIcaclsResetCommand(params.targetPath, {
            isDir: params.isDir,
            env: params.env,
        });
    }
    const optionSeparator = params.targetPath.startsWith("-") ? "-- " : "";
    return (`chmod ${params.posixMode.toString(8).padStart(3, "0")} ${optionSeparator}` +
        formatPosixShellArgument(params.targetPath));
}
function formatPosixShellArgument(value) {
    if (value && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
        return value;
    }
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
export function modeBits(mode) {
    return mode == null ? null : mode & 0o777;
}
export function formatOctal(bits) {
    return bits == null ? "unknown" : bits.toString(8).padStart(3, "0");
}
export function isWorldWritable(bits) {
    return bits != null && (bits & 0o002) !== 0;
}
export function isGroupWritable(bits) {
    return bits != null && (bits & 0o020) !== 0;
}
export function isWorldReadable(bits) {
    return bits != null && (bits & 0o004) !== 0;
}
export function isGroupReadable(bits) {
    return bits != null && (bits & 0o040) !== 0;
}
