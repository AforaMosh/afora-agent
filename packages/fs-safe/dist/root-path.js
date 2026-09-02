import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { formatErrorDetail } from "./error-detail.js";
import { FsSafeError } from "./errors.js";
import { assertNoNulPathInput, isNotFoundPathError, isPathInside, isPathRelativeEscape, } from "./path.js";
import { resolvePathViaExistingAncestor, resolvePathViaExistingAncestorSync, } from "./root-path-existing.js";
import { resolveSymlinkHopPath, resolveSymlinkHopPathSync } from "./root-path-symlink.js";
import { assertNoDriveRelativePathSegments } from "./safe-path-segment.js";
import { shortPath } from "./short-path.js";
export { resolvePathViaExistingAncestorSync } from "./root-path-existing.js";
export const ROOT_PATH_ALIAS_POLICIES = {
    strict: Object.freeze({
        allowFinalSymlinkForUnlink: false,
        allowFinalHardlinkForUnlink: false,
    }),
    unlinkTarget: Object.freeze({
        allowFinalSymlinkForUnlink: true,
        allowFinalHardlinkForUnlink: true,
    }),
};
export async function resolveRootPath(params) {
    try {
        return await resolveRootPathInternal(params);
    }
    catch (error) {
        throw sanitizeRootPathError(error);
    }
}
async function resolveRootPathInternal(params) {
    assertValidRootPathInputs(params);
    const rootPath = path.resolve(params.rootPath);
    const absolutePath = path.resolve(params.absolutePath);
    const rootCanonicalPath = params.rootCanonicalPath
        ? path.resolve(params.rootCanonicalPath)
        : await resolvePathViaExistingAncestor(rootPath);
    const context = createBoundaryResolutionContext({
        resolveParams: params,
        rootPath,
        absolutePath,
        rootCanonicalPath,
        outsideLexicalCanonicalPath: await resolveOutsideLexicalCanonicalPathAsync({
            rootPath,
            absolutePath,
        }),
    });
    const outsideResult = await resolveOutsideRootPathAsync({
        boundaryLabel: params.boundaryLabel,
        context,
    });
    if (outsideResult) {
        return outsideResult;
    }
    return resolveRootPathLexicalAsync({
        params,
        absolutePath: context.absolutePath,
        rootPath: context.rootPath,
        rootCanonicalPath: context.rootCanonicalPath,
    });
}
export function resolveRootPathSync(params) {
    try {
        return resolveRootPathSyncInternal(params);
    }
    catch (error) {
        throw sanitizeRootPathError(error);
    }
}
function resolveRootPathSyncInternal(params) {
    assertValidRootPathInputs(params);
    const rootPath = path.resolve(params.rootPath);
    const absolutePath = path.resolve(params.absolutePath);
    const rootCanonicalPath = params.rootCanonicalPath
        ? path.resolve(params.rootCanonicalPath)
        : resolvePathViaExistingAncestorSync(rootPath);
    const context = createBoundaryResolutionContext({
        resolveParams: params,
        rootPath,
        absolutePath,
        rootCanonicalPath,
        outsideLexicalCanonicalPath: resolveOutsideLexicalCanonicalPathSync({
            rootPath,
            absolutePath,
        }),
    });
    const outsideResult = resolveOutsideRootPathSync({
        boundaryLabel: params.boundaryLabel,
        context,
    });
    if (outsideResult) {
        return outsideResult;
    }
    return resolveRootPathLexicalSync({
        params,
        absolutePath: context.absolutePath,
        rootPath: context.rootPath,
        rootCanonicalPath: context.rootCanonicalPath,
    });
}
function sanitizeRootPathError(error) {
    if (error instanceof Error) {
        error.message = formatErrorDetail(error.message);
    }
    return error;
}
function assertValidRootPathInputs(params) {
    assertNoNulPathInput(params.rootPath, "root path contains a NUL byte");
    assertNoNulPathInput(params.absolutePath, "absolute path contains a NUL byte");
    assertNoEmbeddedDriveRelativeSegment(params.rootPath, "root path");
    assertNoEmbeddedDriveRelativeSegment(params.absolutePath, "absolute path");
    if (params.rootCanonicalPath !== undefined) {
        assertNoNulPathInput(params.rootCanonicalPath, "canonical root path contains a NUL byte");
        assertNoEmbeddedDriveRelativeSegment(params.rootCanonicalPath, "canonical root path");
    }
}
function assertNoEmbeddedDriveRelativeSegment(filePath, label) {
    if (process.platform !== "win32") {
        return;
    }
    const root = path.parse(filePath).root;
    assertNoDriveRelativePathSegments(filePath.slice(root.length).replaceAll("\\", "/"), label);
}
function isPromiseLike(value) {
    return Boolean(value &&
        (typeof value === "object" || typeof value === "function") &&
        "then" in value &&
        typeof value.then === "function");
}
function createLexicalTraversalState(params) {
    const rawAbsolutePath = params.params.absolutePath;
    const rawRelativePath = rawPathRelativeToRoot(params.rootPath, rawAbsolutePath);
    const relative = rawRelativePath ?? path.relative(params.rootPath, params.absolutePath);
    return {
        segments: splitTraversalSegments(relative),
        allowFinalSymlink: params.params.policy?.allowFinalSymlinkForUnlink === true,
        canonicalCursor: params.rootCanonicalPath,
        lexicalCursor: params.rootPath,
        preserveFinalSymlink: false,
    };
}
function createLexicalTraversalContext(params) {
    return {
        state: createLexicalTraversalState(params),
        resolveParams: params.params,
        rootPath: params.rootPath,
        rootCanonicalPath: params.rootCanonicalPath,
        absolutePath: params.absolutePath,
    };
}
function splitTraversalSegments(value) {
    return value
        .split(process.platform === "win32" ? /[\\/]+/ : /\/+/)
        .filter((segment) => Boolean(segment) && segment !== ".");
}
function rawPathRelativeToRoot(rootPath, candidatePath) {
    if (!path.isAbsolute(candidatePath)) {
        return undefined;
    }
    const root = path.resolve(rootPath);
    const candidate = process.platform === "win32"
        ? candidatePath.replaceAll("/", path.sep)
        : candidatePath;
    if (candidate === root) {
        return "";
    }
    const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    const candidatePrefix = candidate.slice(0, rootWithSep.length);
    const prefixMatches = process.platform === "win32"
        ? candidatePrefix.toLowerCase() === rootWithSep.toLowerCase()
        : candidatePrefix === rootWithSep;
    return prefixMatches ? candidate.slice(rootWithSep.length) : undefined;
}
function assertLexicalCursorInsideBoundary(context, candidatePath) {
    assertInsideBoundary({
        boundaryLabel: context.resolveParams.boundaryLabel,
        rootCanonicalPath: context.rootCanonicalPath,
        candidatePath,
        absolutePath: context.absolutePath,
    });
}
function applyMissingSuffixToCanonicalCursor(context, missingFromIndex) {
    const missingSuffix = context.state.segments.slice(missingFromIndex);
    for (const segment of missingSuffix) {
        advanceCanonicalCursorForSegment(context, segment);
    }
}
function advanceCanonicalCursorForSegment(context, segment) {
    context.state.canonicalCursor = path.resolve(context.state.canonicalCursor, segment);
    assertLexicalCursorInsideBoundary(context, context.state.canonicalCursor);
}
function finalizeLexicalResolution(context, kind) {
    assertLexicalCursorInsideBoundary(context, context.state.canonicalCursor);
    return buildResolvedRootPath({
        absolutePath: context.absolutePath,
        canonicalPath: context.state.canonicalCursor,
        rootPath: context.rootPath,
        rootCanonicalPath: context.rootCanonicalPath,
        kind,
    });
}
function handleLexicalLstatFailure(context, error, missingFromIndex) {
    if (!isNotFoundPathError(error)) {
        return false;
    }
    applyMissingSuffixToCanonicalCursor(context, missingFromIndex);
    return true;
}
function handleLexicalStatReadFailure(context, error, missingFromIndex) {
    if (handleLexicalLstatFailure(context, error, missingFromIndex)) {
        return null;
    }
    throw error;
}
function handleLexicalStatDisposition(context, params) {
    if (!params.isSymbolicLink) {
        advanceCanonicalCursorForSegment(context, params.segment);
        return "continue";
    }
    if (context.resolveParams.rejectSymlinks === true && params.isLast) {
        throw new FsSafeError("symlink", "symlink path component not allowed");
    }
    if (context.state.allowFinalSymlink && params.isLast) {
        context.state.preserveFinalSymlink = true;
        advanceCanonicalCursorForSegment(context, params.segment);
        return "break";
    }
    return "resolve-link";
}
function applyResolvedSymlinkHop(context, linkCanonical) {
    if (!isPathInside(context.rootCanonicalPath, linkCanonical)) {
        throw symlinkEscapeError({
            boundaryLabel: context.resolveParams.boundaryLabel,
            rootCanonicalPath: context.rootCanonicalPath,
            symlinkPath: context.state.lexicalCursor,
        });
    }
    context.state.canonicalCursor = linkCanonical;
    context.state.lexicalCursor = linkCanonical;
}
function readLexicalStat(context, params) {
    try {
        const stat = params.read(context.state.lexicalCursor);
        if (isPromiseLike(stat)) {
            return Promise.resolve(stat).catch((error) => handleLexicalStatReadFailure(context, error, params.missingFromIndex));
        }
        return stat;
    }
    catch (error) {
        return handleLexicalStatReadFailure(context, error, params.missingFromIndex);
    }
}
function resolveAndApplySymlinkHop(context, params) {
    const linkCanonical = params.resolveLinkCanonical(context.state.lexicalCursor);
    if (isPromiseLike(linkCanonical)) {
        return Promise.resolve(linkCanonical).then((value) => {
            applyResolvedSymlinkHop(context, value);
        });
    }
    applyResolvedSymlinkHop(context, linkCanonical);
}
function applyParentTraversalStep(context) {
    context.state.lexicalCursor = path.resolve(context.state.lexicalCursor, "..");
    advanceCanonicalCursorForSegment(context, "..");
}
function* iterateLexicalTraversal(state) {
    for (let idx = 0; idx < state.segments.length; idx += 1) {
        const segment = state.segments[idx] ?? "";
        const isLast = idx === state.segments.length - 1;
        yield { idx, segment, isLast };
    }
}
async function resolveRootPathLexicalAsync(params) {
    const context = createLexicalTraversalContext(params);
    const { state } = context;
    for (const { idx, segment, isLast } of iterateLexicalTraversal(state)) {
        if (segment === "..") {
            applyParentTraversalStep(context);
            continue;
        }
        state.lexicalCursor = path.join(state.lexicalCursor, segment);
        const stat = await readLexicalStat(context, {
            missingFromIndex: idx,
            read: (cursor) => fsp.lstat(cursor),
        });
        if (!stat) {
            break;
        }
        const disposition = handleLexicalStatDisposition(context, {
            isSymbolicLink: stat.isSymbolicLink(),
            segment,
            isLast,
        });
        if (disposition === "continue") {
            continue;
        }
        if (disposition === "break") {
            break;
        }
        await resolveAndApplySymlinkHop(context, {
            resolveLinkCanonical: (cursor) => resolveSymlinkHopPath(cursor),
        });
        if (context.resolveParams.rejectSymlinks === true) {
            throw new FsSafeError("symlink", "symlink path component not allowed");
        }
    }
    const kind = await getPathKind(state.canonicalCursor, state.preserveFinalSymlink);
    return finalizeLexicalResolution(context, kind);
}
function resolveRootPathLexicalSync(params) {
    const context = createLexicalTraversalContext(params);
    const { state } = context;
    for (let idx = 0; idx < state.segments.length; idx += 1) {
        const segment = state.segments[idx] ?? "";
        const isLast = idx === state.segments.length - 1;
        if (segment === "..") {
            applyParentTraversalStep(context);
            continue;
        }
        state.lexicalCursor = path.join(state.lexicalCursor, segment);
        const maybeStat = readLexicalStat(context, {
            missingFromIndex: idx,
            read: (cursor) => fs.lstatSync(cursor),
        });
        if (isPromiseLike(maybeStat)) {
            throw new Error("Unexpected async lexical stat");
        }
        const stat = maybeStat;
        if (!stat) {
            break;
        }
        const disposition = handleLexicalStatDisposition(context, {
            isSymbolicLink: stat.isSymbolicLink(),
            segment,
            isLast,
        });
        if (disposition === "continue") {
            continue;
        }
        if (disposition === "break") {
            break;
        }
        const maybeApplied = resolveAndApplySymlinkHop(context, {
            resolveLinkCanonical: (cursor) => resolveSymlinkHopPathSync(cursor),
        });
        if (isPromiseLike(maybeApplied)) {
            throw new Error("Unexpected async symlink resolution");
        }
        if (context.resolveParams.rejectSymlinks === true) {
            throw new FsSafeError("symlink", "symlink path component not allowed");
        }
    }
    const kind = getPathKindSync(state.canonicalCursor, state.preserveFinalSymlink);
    return finalizeLexicalResolution(context, kind);
}
function resolveCanonicalOutsideLexicalPath(params) {
    return params.outsideLexicalCanonicalPath ?? params.absolutePath;
}
function createBoundaryResolutionContext(params) {
    const lexicalInside = isPathInside(params.rootPath, params.absolutePath);
    const canonicalOutsideLexicalPath = resolveCanonicalOutsideLexicalPath({
        absolutePath: params.absolutePath,
        outsideLexicalCanonicalPath: params.outsideLexicalCanonicalPath,
    });
    assertLexicalBoundaryOrCanonicalAlias({
        skipLexicalRootCheck: params.resolveParams.skipLexicalRootCheck,
        lexicalInside,
        canonicalOutsideLexicalPath,
        rootCanonicalPath: params.rootCanonicalPath,
        boundaryLabel: params.resolveParams.boundaryLabel,
        rootPath: params.rootPath,
        absolutePath: params.absolutePath,
    });
    return {
        rootPath: params.rootPath,
        absolutePath: params.absolutePath,
        rootCanonicalPath: params.rootCanonicalPath,
        lexicalInside,
        canonicalOutsideLexicalPath,
    };
}
async function resolveOutsideRootPathAsync(params) {
    if (params.context.lexicalInside) {
        return null;
    }
    const kind = await getPathKind(params.context.absolutePath, false);
    return buildOutsideRootPathFromContext({
        boundaryLabel: params.boundaryLabel,
        context: params.context,
        kind,
    });
}
function resolveOutsideRootPathSync(params) {
    if (params.context.lexicalInside) {
        return null;
    }
    const kind = getPathKindSync(params.context.absolutePath, false);
    return buildOutsideRootPathFromContext({
        boundaryLabel: params.boundaryLabel,
        context: params.context,
        kind,
    });
}
function buildOutsideRootPathFromContext(params) {
    return buildOutsideLexicalRootPath({
        boundaryLabel: params.boundaryLabel,
        rootCanonicalPath: params.context.rootCanonicalPath,
        absolutePath: params.context.absolutePath,
        canonicalOutsideLexicalPath: params.context.canonicalOutsideLexicalPath,
        rootPath: params.context.rootPath,
        kind: params.kind,
    });
}
async function resolveOutsideLexicalCanonicalPathAsync(params) {
    if (isPathInside(params.rootPath, params.absolutePath)) {
        return undefined;
    }
    return await resolvePathViaExistingAncestor(params.absolutePath);
}
function resolveOutsideLexicalCanonicalPathSync(params) {
    if (isPathInside(params.rootPath, params.absolutePath)) {
        return undefined;
    }
    return resolvePathViaExistingAncestorSync(params.absolutePath);
}
function buildOutsideLexicalRootPath(params) {
    assertInsideBoundary({
        boundaryLabel: params.boundaryLabel,
        rootCanonicalPath: params.rootCanonicalPath,
        candidatePath: params.canonicalOutsideLexicalPath,
        absolutePath: params.absolutePath,
    });
    return buildResolvedRootPath({
        absolutePath: params.absolutePath,
        canonicalPath: params.canonicalOutsideLexicalPath,
        rootPath: params.rootPath,
        rootCanonicalPath: params.rootCanonicalPath,
        kind: params.kind,
    });
}
function assertLexicalBoundaryOrCanonicalAlias(params) {
    if (params.skipLexicalRootCheck || params.lexicalInside) {
        return;
    }
    if (isPathInside(params.rootCanonicalPath, params.canonicalOutsideLexicalPath)) {
        return;
    }
    throw pathEscapeError({
        boundaryLabel: params.boundaryLabel,
        rootPath: params.rootPath,
        absolutePath: params.absolutePath,
    });
}
function buildResolvedRootPath(params) {
    return {
        absolutePath: params.absolutePath,
        canonicalPath: params.canonicalPath,
        rootPath: params.rootPath,
        rootCanonicalPath: params.rootCanonicalPath,
        relativePath: relativeInsideRoot(params.rootCanonicalPath, params.canonicalPath),
        exists: params.kind.exists,
        kind: params.kind.kind,
    };
}
async function getPathKind(absolutePath, preserveFinalSymlink) {
    try {
        const stat = preserveFinalSymlink
            ? await fsp.lstat(absolutePath)
            : await fsp.stat(absolutePath);
        return { exists: true, kind: toResolvedKind(stat) };
    }
    catch (error) {
        if (isNotFoundPathError(error)) {
            return { exists: false, kind: "missing" };
        }
        throw error;
    }
}
function getPathKindSync(absolutePath, preserveFinalSymlink) {
    try {
        const stat = preserveFinalSymlink ? fs.lstatSync(absolutePath) : fs.statSync(absolutePath);
        return { exists: true, kind: toResolvedKind(stat) };
    }
    catch (error) {
        if (isNotFoundPathError(error)) {
            return { exists: false, kind: "missing" };
        }
        throw error;
    }
}
function toResolvedKind(stat) {
    if (stat.isFile()) {
        return "file";
    }
    if (stat.isDirectory()) {
        return "directory";
    }
    if (stat.isSymbolicLink()) {
        return "symlink";
    }
    return "other";
}
function relativeInsideRoot(rootPath, targetPath) {
    const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
    if (!relative || relative === ".") {
        return "";
    }
    if (isPathRelativeEscape(relative)) {
        return "";
    }
    return relative;
}
function assertInsideBoundary(params) {
    if (isPathInside(params.rootCanonicalPath, params.candidatePath)) {
        return;
    }
    throw new Error(`Path resolves outside ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.absolutePath)}`);
}
function pathEscapeError(params) {
    return new Error(`Path escapes ${params.boundaryLabel} (${shortPath(params.rootPath)}): ${shortPath(params.absolutePath)}`);
}
function symlinkEscapeError(params) {
    return new Error(`Symlink escapes ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.symlinkPath)}`);
}
