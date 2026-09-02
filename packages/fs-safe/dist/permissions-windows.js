import os from "node:os";
import { getNativeBinding } from "./native.js";
import { executePermissionCommand } from "./permission-exec.js";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.js";
import { resolveWindowsSystemCommand } from "./windows-command.js";
import { inspectWindowsOwner, resolveWindowsCurrentUserSid, resolveWindowsPrincipalSids, } from "./windows-owner.js";
const INHERIT_FLAGS = new Set(["I", "OI", "CI", "IO", "NP"]);
const WORLD_PRINCIPALS = new Set(["everyone", "users", "builtin\\users", "authenticated users", "nt authority\\authenticated users", "anonymous logon", "nt authority\\anonymous logon", "guests", "builtin\\guests", "interactive", "nt authority\\interactive", "network", "nt authority\\network", "local"]);
const TRUSTED_BASE = new Set([
    "nt authority\\system",
    "system",
    "builtin\\administrators",
    "creator owner",
    "autorite nt\\système",
    "nt-autorität\\system",
    "autoridad nt\\system",
    "autoridade nt\\system",
]);
const WORLD_SUFFIXES = ["\\users", "\\authenticated users"];
const SID_RE = /^\*?s-\d+-\d+(-\d+)+$/i;
const TRUSTED_SIDS = new Set([
    "s-1-5-18",
    "s-1-5-32-544",
    "s-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
]);
const WORLD_SIDS = new Set(["s-1-1-0", "s-1-5-11", "s-1-5-32-545", "s-1-5-7", "s-1-5-32-546", "s-1-5-4", "s-1-2-0", "s-1-5-2"]);
const STATUS_PREFIXES = [
    "successfully processed",
    "processed",
    "failed processing",
    "no mapping between account names",
];
function stripDiacritics(value) {
    return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
const TRUSTED_BASE_ASCII = new Set([...TRUSTED_BASE].map(stripDiacritics));
const normalize = (value) => normalizeLowercaseStringOrEmpty(value);
const defaultWindowsUserInfo = () => os.userInfo();
const defaultPermissionExec = executePermissionCommand;
function inspectWindowsPermissionsNative(params) {
    const native = getNativeBinding();
    if (!native)
        return undefined;
    try {
        const facts = native.readOwnerAndDacl(params.targetPath);
        if (facts.fallbackRequired)
            return undefined;
        return {
            ok: true,
            isSymlink: params.stat.isSymlink,
            isDir: params.effectiveIsDir,
            mode: params.effectiveMode,
            bits: params.bits,
            source: "windows-acl",
            worldWritable: facts.worldWritable,
            groupWritable: facts.groupWritable,
            worldReadable: facts.worldReadable,
            groupReadable: facts.groupReadable,
            ownerSid: facts.ownerSid,
            ownerTrusted: facts.ownerClass !== "foreign",
            aclSummary: `native owner=${facts.ownerClass} world=` +
                `${facts.worldReadable ? "r" : "-"}${facts.worldWritable ? "w" : "-"} ` +
                `group=${facts.groupReadable ? "r" : "-"}${facts.groupWritable ? "w" : "-"}`,
        };
    }
    catch {
        return undefined;
    }
}
export async function inspectWindowsPermissions(params) {
    const native = inspectWindowsPermissionsNative(params);
    if (native)
        return native;
    const unverified = {
        ok: true,
        isSymlink: params.stat.isSymlink,
        isDir: params.effectiveIsDir,
        mode: params.effectiveMode,
        bits: params.bits,
        source: "unknown",
        worldWritable: false,
        groupWritable: false,
        worldReadable: false,
        groupReadable: false,
    };
    const owner = await inspectWindowsOwner({
        targetPath: params.targetPath,
        env: params.opts?.env,
        exec: params.opts?.exec ?? defaultPermissionExec,
    });
    if (owner.error) {
        const error = `Windows owner inspection failed: ${owner.error}`;
        return { ...unverified, ownerError: owner.error, error };
    }
    const acl = await inspectWindowsAcl(params.targetPath, {
        env: params.opts?.env,
        exec: params.opts?.exec,
        currentUserSid: owner.currentUserSid,
        principalSids: owner.principalSids,
        principalTranslationFailed: owner.principalTranslationFailed,
    });
    const ownerFields = {
        ...(owner.sid ? { ownerSid: owner.sid } : {}),
        ...(owner.trusted !== undefined ? { ownerTrusted: owner.trusted } : {}),
        ...(owner.error ? { ownerError: owner.error } : {}),
    };
    if (!acl.ok)
        return { ...unverified, ...ownerFields, error: acl.error };
    return {
        ok: true,
        isSymlink: params.stat.isSymlink,
        isDir: params.effectiveIsDir,
        mode: params.effectiveMode,
        bits: params.bits,
        source: "windows-acl",
        worldWritable: acl.untrustedWorld.some((entry) => entry.canWrite),
        groupWritable: acl.untrustedGroup.some((entry) => entry.canWrite),
        worldReadable: acl.untrustedWorld.some((entry) => entry.canRead),
        groupReadable: acl.untrustedGroup.some((entry) => entry.canRead),
        ...ownerFields,
        aclSummary: formatWindowsAclSummary(acl),
    };
}
function normalizeSid(value) {
    const normalized = normalize(value);
    return normalized.startsWith("*") ? normalized.slice(1) : normalized;
}
export function resolveWindowsUserPrincipal(env, userInfo = defaultWindowsUserInfo) {
    const username = env?.USERNAME?.trim() || userInfo().username?.trim();
    if (!username)
        return null;
    const domain = env?.USERDOMAIN?.trim();
    return domain ? `${domain}\\${username}` : username;
}
function buildTrustedPrincipals(env) {
    const trusted = new Set(TRUSTED_BASE);
    const principal = resolveWindowsUserPrincipal(env);
    if (principal) {
        trusted.add(normalize(principal));
        const userOnly = principal.split("\\").at(-1);
        if (userOnly)
            trusted.add(normalize(userOnly));
    }
    const userSid = normalizeSid(env?.USERSID ?? "");
    if (userSid && SID_RE.test(userSid) && !WORLD_SIDS.has(userSid))
        trusted.add(userSid);
    return trusted;
}
function classifyPrincipal(principal, trustedPrincipals) {
    const normalized = normalize(principal);
    if (SID_RE.test(normalized)) {
        const sid = normalizeSid(normalized);
        if (WORLD_SIDS.has(sid))
            return "world";
        if (TRUSTED_SIDS.has(sid) || trustedPrincipals.has(sid))
            return "trusted";
        return "group";
    }
    if (trustedPrincipals.has(normalized) || TRUSTED_BASE.has(normalized))
        return "trusted";
    if (WORLD_PRINCIPALS.has(normalized) || WORLD_SUFFIXES.some((suffix) => normalized.endsWith(suffix)))
        return "world";
    const stripped = stripDiacritics(normalized);
    return stripped !== normalized && TRUSTED_BASE_ASCII.has(stripped) ? "trusted" : "group";
}
function rightsFromTokens(tokens) {
    const upper = tokens.join("").toUpperCase();
    return {
        canWrite: upper.includes("F") || upper.includes("M") || upper.includes("W") || upper.includes("D"),
        canRead: upper.includes("F") || upper.includes("M") || upper.includes("R"),
    };
}
function stripTargetPrefix(params) {
    if (params.lowerLine.startsWith(params.lowerTarget))
        return params.trimmedLine.slice(params.normalizedTarget.length).trim();
    if (params.lowerLine.startsWith(params.quotedLower))
        return params.trimmedLine.slice(params.quotedTarget.length).trim();
    return params.trimmedLine;
}
function parseAceEntry(entry) {
    if (!entry.includes("("))
        return null;
    const idx = entry.indexOf(":");
    if (idx === -1)
        return null;
    const principal = entry.slice(0, idx).trim();
    const rawRights = entry.slice(idx + 1).trim();
    const tokens = rawRights.match(/\(([^)]+)\)/g)?.map((token) => token.slice(1, -1).trim()).filter(Boolean) ?? [];
    if (tokens.some((token) => token.toUpperCase() === "DENY"))
        return null;
    const rights = tokens.filter((token) => !INHERIT_FLAGS.has(token.toUpperCase()));
    if (rights.length === 0)
        return null;
    const normalizedPrincipal = normalizeSid(principal);
    return { principal, ...(SID_RE.test(normalizedPrincipal) ? { sid: normalizedPrincipal } : {}), rights, rawRights, ...rightsFromTokens(rights) };
}
export function parseIcaclsOutput(output, targetPath) {
    const entries = [];
    const normalizedTarget = targetPath.trim();
    const lowerTarget = normalizedTarget.toLowerCase();
    const quotedTarget = `"${normalizedTarget}"`;
    const quotedLower = quotedTarget.toLowerCase();
    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (!line.trim())
            continue;
        const trimmed = line.trim();
        const lowerLine = trimmed.toLowerCase();
        if (STATUS_PREFIXES.some((prefix) => lowerLine.startsWith(prefix)))
            continue;
        const parsed = parseAceEntry(stripTargetPrefix({ trimmedLine: trimmed, lowerLine, normalizedTarget, lowerTarget, quotedTarget, quotedLower }));
        if (parsed)
            entries.push(parsed);
    }
    return entries;
}
export function summarizeWindowsAcl(entries, env) {
    const trustedPrincipals = buildTrustedPrincipals(env);
    const trusted = [];
    const untrustedWorld = [];
    const untrustedGroup = [];
    for (const entry of entries) {
        const classification = classifyPrincipal(entry.sid ?? entry.principal, trustedPrincipals);
        if (classification === "trusted")
            trusted.push(entry);
        else if (classification === "world")
            untrustedWorld.push(entry);
        else
            untrustedGroup.push(entry);
    }
    return { trusted, untrustedWorld, untrustedGroup };
}
export async function inspectWindowsAcl(targetPath, opts) {
    const exec = opts?.exec ?? defaultPermissionExec;
    try {
        if (opts?.principalTranslationFailed)
            throw new Error("Windows ACL principal SID translation failed");
        const { stdout, stderr } = await exec(resolveWindowsSystemCommand("icacls.exe", opts?.env), [targetPath]);
        let entries = parseIcaclsOutput(`${stdout}\n${stderr}`.trim(), targetPath);
        if (!entries.length)
            throw new Error("Windows ACL output could not be verified");
        const unresolvedPrincipals = entries.filter((entry) => !entry.sid).map((entry) => entry.principal);
        const principalSids = await resolveWindowsPrincipalSids({ principals: unresolvedPrincipals, known: opts?.principalSids, env: opts?.env, exec });
        entries = entries.map((entry) => {
            const sid = entry.sid ?? principalSids[entry.principal.toLowerCase()];
            if (!sid)
                throw new Error(`Windows ACL principal SID could not be verified: ${entry.principal}`);
            return { ...entry, sid };
        });
        let currentUserSid = normalizeSid(opts?.currentUserSid ?? "");
        let effectiveEnv = currentUserSid ? { USERSID: currentUserSid } : undefined;
        let { trusted, untrustedWorld, untrustedGroup } = summarizeWindowsAcl(entries, effectiveEnv);
        if (!currentUserSid && untrustedGroup.some((entry) => entry.sid && !TRUSTED_SIDS.has(entry.sid))) {
            currentUserSid = (await resolveWindowsCurrentUserSid({ exec, env: opts?.env })) ?? "";
            if (currentUserSid) {
                effectiveEnv = { USERSID: currentUserSid };
                ({ trusted, untrustedWorld, untrustedGroup } = summarizeWindowsAcl(entries, effectiveEnv));
            }
        }
        return { ok: true, entries, trusted, untrustedWorld, untrustedGroup };
    }
    catch (err) {
        return { ok: false, entries: [], trusted: [], untrustedWorld: [], untrustedGroup: [], error: String(err) };
    }
}
export function formatWindowsAclSummary(summary) {
    if (!summary.ok)
        return "unknown";
    const untrusted = [...summary.untrustedWorld, ...summary.untrustedGroup];
    return untrusted.length === 0 ? "trusted-only" : untrusted.map((entry) => `${entry.principal}:${entry.rawRights}`).join(", ");
}
export function formatIcaclsResetCommand(targetPath, opts) {
    const command = resolveWindowsSystemCommand("icacls.exe", opts.env);
    const user = resolveWindowsUserPrincipal(opts.env, opts.userInfo) ?? "%USERNAME%";
    const grant = opts.isDir ? "(OI)(CI)F" : "F";
    return [command, `"${targetPath}"`, "/inheritance:r", "/grant:r", `"${user}:${grant}"`, "/grant:r", `"*S-1-5-18:${grant}"`].join(" ");
}
export function createIcaclsResetCommand(targetPath, opts) {
    const user = resolveWindowsUserPrincipal(opts.env, opts.userInfo);
    if (!user)
        return null;
    const grant = opts.isDir ? "(OI)(CI)F" : "F";
    const args = [targetPath, "/inheritance:r", "/grant:r", `${user}:${grant}`, "/grant:r", `*S-1-5-18:${grant}`];
    return { command: resolveWindowsSystemCommand("icacls.exe", opts.env), args, display: formatIcaclsResetCommand(targetPath, opts) };
}
