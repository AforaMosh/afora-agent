import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { CrablineError, ensureErrorMessage } from "../core/errors.js";
import { ManifestSchema } from "./schema.js";
const DEFAULT_CONFIG_CANDIDATES = ["crabline.yaml", "crabline.yml", "crabline.json"];
class DuplicateJsonKeyError extends SyntaxError {
}
function configLoadError(resolvedPath, error, detail) {
    return new CrablineError(`Unable to load config file "${resolvedPath}": ${detail}`, {
        cause: error,
        kind: "config",
    });
}
function formatYamlParseError(error) {
    if (!(error instanceof Error) || error.name !== "YAMLParseError") {
        return "YAML parse failed.";
    }
    const yamlError = error;
    const code = typeof yamlError.code === "string" ? ` (${yamlError.code})` : "";
    const position = yamlError.linePos?.[0];
    const location = typeof position?.line === "number" && typeof position.col === "number"
        ? ` at line ${position.line}, column ${position.col}`
        : "";
    return `YAML parse error${code}${location}.`;
}
function formatJsonParseError(error) {
    if (error instanceof DuplicateJsonKeyError) {
        return "JSON parse error: duplicate object key.";
    }
    if (!(error instanceof SyntaxError)) {
        return "JSON parse failed.";
    }
    const position = /\bposition (\d+)\b/u.exec(error.message)?.[1];
    return position ? `JSON parse error at position ${position}.` : "JSON parse error.";
}
function parseJson(raw) {
    const parsed = JSON.parse(raw);
    const document = YAML.parseDocument(raw, { schema: "json", uniqueKeys: true });
    if (document.errors.some((error) => error.code === "DUPLICATE_KEY")) {
        throw new DuplicateJsonKeyError("JSON contains a duplicate object key.");
    }
    return parsed;
}
export async function resolveConfigPath(explicitPath) {
    if (explicitPath) {
        return path.resolve(explicitPath);
    }
    for (const candidate of DEFAULT_CONFIG_CANDIDATES) {
        const resolved = path.resolve(candidate);
        try {
            if ((await stat(resolved)).isFile()) {
                return resolved;
            }
        }
        catch (error) {
            if (typeof error === "object" &&
                error !== null &&
                "code" in error &&
                (error.code === "ENOENT" || error.code === "ENOTDIR")) {
                continue;
            }
            throw error;
        }
    }
    throw new CrablineError("No config file found. Create crabline.yaml, crabline.yml, or crabline.json.", { kind: "config" });
}
export async function loadManifest(configPath) {
    const resolvedPath = await resolveConfigPath(configPath);
    let raw;
    try {
        raw = await readFile(resolvedPath, "utf8");
    }
    catch (error) {
        throw configLoadError(resolvedPath, error, ensureErrorMessage(error));
    }
    const isJson = path.extname(resolvedPath).toLowerCase() === ".json";
    let parsed;
    try {
        parsed = isJson ? parseJson(raw) : YAML.parse(raw, { merge: true });
    }
    catch (error) {
        const detail = isJson ? formatJsonParseError(error) : formatYamlParseError(error);
        throw configLoadError(resolvedPath, new Error(detail), detail);
    }
    try {
        const manifest = ManifestSchema.parse(parsed);
        return { manifest, path: resolvedPath };
    }
    catch (error) {
        throw configLoadError(resolvedPath, error, ensureErrorMessage(error));
    }
}
