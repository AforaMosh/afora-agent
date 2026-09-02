import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isNotFoundPathError } from "./path.js";
function isFilesystemRoot(candidate) {
    return path.parse(candidate).root === candidate;
}
async function pathExists(targetPath) {
    try {
        await fsp.lstat(targetPath);
        return true;
    }
    catch (error) {
        if (isNotFoundPathError(error)) {
            return false;
        }
        throw error;
    }
}
export async function resolvePathViaExistingAncestor(targetPath) {
    const normalized = path.resolve(targetPath);
    let cursor = normalized;
    const missingSuffix = [];
    while (!isFilesystemRoot(cursor) && !(await pathExists(cursor))) {
        missingSuffix.unshift(path.basename(cursor));
        const parent = path.dirname(cursor);
        if (parent === cursor) {
            break;
        }
        cursor = parent;
    }
    if (!(await pathExists(cursor))) {
        return normalized;
    }
    try {
        const resolvedAncestor = path.resolve(await fsp.realpath(cursor));
        return missingSuffix.length === 0
            ? resolvedAncestor
            : path.resolve(resolvedAncestor, ...missingSuffix);
    }
    catch {
        return normalized;
    }
}
export function resolvePathViaExistingAncestorSync(targetPath) {
    const normalized = path.resolve(targetPath);
    let cursor = normalized;
    const missingSuffix = [];
    while (!isFilesystemRoot(cursor) && !fs.existsSync(cursor)) {
        missingSuffix.unshift(path.basename(cursor));
        const parent = path.dirname(cursor);
        if (parent === cursor) {
            break;
        }
        cursor = parent;
    }
    if (!fs.existsSync(cursor)) {
        return normalized;
    }
    try {
        const resolvedAncestor = path.resolve(fs.realpathSync(cursor));
        return missingSuffix.length === 0
            ? resolvedAncestor
            : path.resolve(resolvedAncestor, ...missingSuffix);
    }
    catch {
        return normalized;
    }
}
