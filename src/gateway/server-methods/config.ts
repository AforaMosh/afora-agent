// Config gateway methods: validation, redaction, secrets, reload planning.
import { isDeepStrictEqual } from "node:util";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateConfigApplyParams,
  validateConfigGetParams,
  validateConfigPatchParams,
  validateConfigSchemaLookupParams,
  validateConfigSchemaLookupResult,
  validateConfigSchemaParams,
  validateConfigSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { readAgentRosterProperty } from "../../agents/agent-scope-config.js";
import {
  applyConfigOperations,
  configPathExists,
  createConfigMutationOperations,
  type ConfigMutationOperation,
} from "../../config/config-path-mutation.js";
import { resolveConfigEnvVars } from "../../config/env-substitution.js";
import { INCLUDE_KEY, stripConfigIncludeDirectives } from "../../config/includes.js";
import {
  createConfigIO,
  parseConfigJson5,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
} from "../../config/io.js";
import { formatConfigWriteRejection } from "../../config/io.write-errors.js";
import { checkConfigIncludeOwnership } from "../../config/io.write-includes.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import {
  applyMergePatch,
  createMergePatch,
  isMergePatchObjectKeyAllowed,
} from "../../config/merge-patch.js";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import { normalizeConfigPatchReplacePaths } from "../../config/patch-replace-paths.js";
import {
  REDACTED_SENTINEL,
  redactConfigObject,
  restoreRedactedValues,
} from "../../config/redact-snapshot.js";
import { loadGatewayRuntimeConfigSchema } from "../../config/runtime-schema.js";
import { projectSourceOntoRuntimeShape } from "../../config/runtime-source-projection.js";
import { lookupConfigSchema, type ConfigSchemaResponse } from "../../config/schema.js";
import type {
  ConfigFileSnapshot,
  ConfigValidationIssue,
  OpenClawConfig,
} from "../../config/types.openclaw.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "../../config/validation.js";
import { isBuiltInModelProviderOverlayId } from "../../config/zod-schema.core.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isPlainObject } from "../../infra/plain-object.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  isRetryableSecretDegradationReason,
  redactSecretDegradationReason,
} from "../../secrets/runtime-degraded-state.js";
import {
  prepareSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../../secrets/runtime.js";
import { diffConfigPaths } from "../config-diff.js";
import { createConfigGetResponse } from "../config-get-response.js";
import { resolveConfigReloadMetadata } from "../config-reload-plan.js";
import {
  formatControlPlaneActor,
  resolveControlPlaneActor,
  summarizeChangedPaths,
} from "../control-plane-audit.js";
import { resolveBaseHashParam } from "./base-hash.js";
import {
  commitGatewayConfigWrite,
  didActiveSharedGatewayAuthChange,
  didSharedGatewayAuthChange,
  resolveGatewayConfigPath,
  resolveGatewayConfigRestartWriteResult,
} from "./config-write-flow.js";
import {
  execOpenPath,
  formatOpenPathError,
  isHeadlessOpenPathError,
  resolveOpenPathCommand,
  sanitizePathForLog,
} from "./open-path.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const MAX_CONFIG_ISSUES_IN_ERROR_MESSAGE = 3;
const CONFIG_SCHEMA_RESPONSE_CACHE_TTL_MS = 5_000;
// ui.prefs is the cross-device Control UI preference surface documented in docs/web/control-ui.md.
// Leaf preferences are LWW so independent tabs/devices do not CAS-conflict on the whole config;
// every other path keeps strict document CAS.
const HASHLESS_PATCH_LWW_PATH_PREFIXES = ["ui.prefs"] as const;

let configSchemaResponseCache: {
  expiresAtMs: number;
  response: ConfigSchemaResponse;
} | null = null;

type ConfigRedactionHints = Parameters<typeof redactConfigObject>[1];
type ConfigWriteCommitResult = Awaited<ReturnType<typeof commitGatewayConfigWrite>>;
type ConfigRestartWriteKind = Parameters<typeof resolveGatewayConfigRestartWriteResult>[0]["kind"];
type ConfigRestartWriteMode = Parameters<typeof resolveGatewayConfigRestartWriteResult>[0]["mode"];

function requireConfigBaseHash(
  params: unknown,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  respond: RespondFn,
): boolean {
  if (!snapshot.exists) {
    return true;
  }
  const snapshotHash = resolveConfigSnapshotHash(snapshot);
  if (!snapshotHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config base hash unavailable; re-run config.get and retry",
      ),
    );
    return false;
  }
  const baseHash = resolveBaseHashParam(params);
  if (!baseHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config base hash required; re-run config.get and retry",
      ),
    );
    return false;
  }
  if (baseHash !== snapshotHash) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config changed since last load; re-run config.get and retry",
      ),
    );
    return false;
  }
  return true;
}

function formatConfigPatchPath(parentPath: string, key: string): string {
  return parentPath ? `${parentPath}.${key}` : key;
}

function readConfigPatchReplacePaths(params: unknown): Set<string> {
  const rawPaths = (params as { replacePaths?: unknown }).replacePaths;
  return normalizeConfigPatchReplacePaths(Array.isArray(rawPaths) ? rawPaths : undefined);
}

const REDACTION_SENTINEL_VALIDATION_PROBE = "__CONFIG_REDACTION_PATH_PROBE__";

function replaceRedactionSentinelsWithProbe(value: unknown): unknown {
  if (value === REDACTED_SENTINEL) {
    return REDACTION_SENTINEL_VALIDATION_PROBE;
  }
  if (Array.isArray(value)) {
    return value.map(replaceRedactionSentinelsWithProbe);
  }
  if (!isRecord(value)) {
    return structuredClone(value);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, replaceRedactionSentinelsWithProbe(child)]),
  );
}

function findInvalidRedactionSentinelPath(
  value: unknown,
  redactedProbe: unknown,
  path = "",
): string | null {
  if (value === REDACTED_SENTINEL) {
    return redactedProbe === REDACTED_SENTINEL ? null : path || "<root>";
  }
  if (Array.isArray(value)) {
    const redactedArray = Array.isArray(redactedProbe) ? redactedProbe : [];
    for (let index = 0; index < value.length; index += 1) {
      const invalidPath = findInvalidRedactionSentinelPath(
        value[index],
        redactedArray[index],
        `${path}[${index}]`,
      );
      if (invalidPath) {
        return invalidPath;
      }
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const redactedRecord = isRecord(redactedProbe) ? redactedProbe : {};
  for (const [key, child] of Object.entries(value)) {
    const invalidPath = findInvalidRedactionSentinelPath(
      child,
      redactedRecord[key],
      formatConfigPatchPath(path, key),
    );
    if (invalidPath) {
      return invalidPath;
    }
  }
  return null;
}

function stripRedactedPatchSentinels(value: unknown): unknown {
  if (value === REDACTED_SENTINEL) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const stripped = stripRedactedPatchSentinels(item);
      return stripped === undefined ? [] : [stripped];
    });
  }
  if (!isRecord(value)) {
    return structuredClone(value);
  }
  const entries = Object.entries(value);
  const strippedEntries = entries.flatMap(([key, child]) => {
    const stripped = stripRedactedPatchSentinels(child);
    return stripped === undefined ? [] : [[key, stripped]];
  });
  return entries.length > 0 && strippedEntries.length === 0
    ? undefined
    : Object.fromEntries(strippedEntries);
}

function assertNoDuplicateConfigPatchIds(value: unknown, path = ""): void {
  if (Array.isArray(value)) {
    const ids = new Set<string>();
    for (const entry of value) {
      if (isConfigPatchObjectWithStringId(entry)) {
        if (ids.has(entry.id)) {
          throw new Error(`Ambiguous duplicate ID ${entry.id} in array at ${path || "<root>"}.`);
        }
        ids.add(entry.id);
      }
      assertNoDuplicateConfigPatchIds(entry, `${path}[]`);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assertNoDuplicateConfigPatchIds(child, formatConfigPatchPath(path, key));
  }
}

function mapConfigPatchIdsToSource(params: {
  patch: unknown;
  source: unknown;
  resolvedSource: unknown;
  runtime: unknown;
  env: NodeJS.ProcessEnv;
  replaceArrayPaths: ReadonlySet<string>;
  path?: string;
}): unknown {
  const path = params.path ?? "";
  const patch = params.patch;
  const sourceInput = params.source;
  const resolvedSourceInput = params.resolvedSource;
  const runtimeInput = params.runtime;
  if (patch === REDACTED_SENTINEL) {
    return structuredClone(sourceInput);
  }
  if (isRecord(patch)) {
    const source = isRecord(sourceInput) ? sourceInput : {};
    const resolvedSource = isRecord(resolvedSourceInput) ? resolvedSourceInput : {};
    const runtime = isRecord(runtimeInput) ? runtimeInput : {};
    const mappedEntries: Array<[string, unknown]> = [];
    for (const [key, value] of Object.entries(patch)) {
      const mapped = mapConfigPatchIdsToSource({
        patch: value,
        source: source[key],
        resolvedSource: resolvedSource[key],
        runtime: runtime[key],
        env: params.env,
        replaceArrayPaths: params.replaceArrayPaths,
        path: formatConfigPatchPath(path, key),
      });
      if (mapped !== undefined) {
        mappedEntries.push([key, mapped]);
      }
    }
    return Object.keys(patch).length > 0 && mappedEntries.length === 0
      ? undefined
      : Object.fromEntries(mappedEntries);
  }
  if (Array.isArray(patch)) {
    const submittedIds = new Set<string>();
    for (const entry of patch) {
      if (!isConfigPatchObjectWithStringId(entry)) {
        continue;
      }
      if (submittedIds.has(entry.id)) {
        throw new Error(`Ambiguous duplicate ID ${entry.id} in array at ${path || "<root>"}.`);
      }
      submittedIds.add(entry.id);
    }
  }
  if (Array.isArray(patch) && params.replaceArrayPaths.has(path) && Array.isArray(sourceInput)) {
    const source = sourceInput;
    const resolvedSource = Array.isArray(resolvedSourceInput) ? resolvedSourceInput : [];
    const runtime = Array.isArray(runtimeInput) ? runtimeInput : [];
    return patch.map((entry) => {
      const resolvedMatches = isConfigPatchObjectWithStringId(entry)
        ? resolvedSource.flatMap((candidate, index) =>
            isConfigPatchObjectWithStringId(candidate) && candidate.id === entry.id ? [index] : [],
          )
        : [];
      const authoredMatches = isConfigPatchObjectWithStringId(entry)
        ? source.flatMap((candidate, index) => {
            if (!isConfigPatchObjectWithStringId(candidate)) {
              return [];
            }
            try {
              return candidate.id === entry.id ||
                resolveConfigEnvVars(candidate.id, params.env) === entry.id
                ? [index]
                : [];
            } catch {
              return [];
            }
          })
        : [];
      const runtimeMatches = isConfigPatchObjectWithStringId(entry)
        ? runtime.flatMap((candidate, index) =>
            isConfigPatchObjectWithStringId(candidate) && candidate.id === entry.id ? [index] : [],
          )
        : [];
      if (resolvedMatches.length > 1 || authoredMatches.length > 1 || runtimeMatches.length > 1) {
        throw new Error(`Ambiguous duplicate ID ${entry.id} in replacement array at ${path}.`);
      }
      const resolvedIndex = resolvedMatches[0] ?? -1;
      const runtimeIndex = runtimeMatches[0] ?? -1;
      // Runtime-only IDs may select a runtime sibling, but they never own an
      // authored source slot. Unmatched authored IDs remain new entries.
      const sourceIndex = authoredMatches[0] ?? resolvedIndex;
      if (containsRedactedPatchSentinel(entry) && sourceIndex < 0) {
        throw new Error(`Cannot restore redacted values for replacement array at ${path}.`);
      }
      if (sourceIndex < 0) {
        return structuredClone(entry);
      }
      const sourceEntry = source[sourceIndex];
      const mapped = mapConfigPatchIdsToSource({
        patch: entry,
        source: sourceEntry,
        resolvedSource: resolvedSource[sourceIndex],
        runtime: runtime[runtimeIndex >= 0 ? runtimeIndex : sourceIndex],
        env: params.env,
        replaceArrayPaths: params.replaceArrayPaths,
        path: `${path}[]`,
      }) as Record<string, unknown>;
      if (isConfigPatchObjectWithStringId(sourceEntry)) {
        mapped.id = sourceEntry.id;
      }
      return mapped;
    });
  }
  if (Array.isArray(patch) && containsRedactedPatchSentinel(patch)) {
    if (!patch.every(isConfigPatchObjectWithStringId)) {
      throw new Error(
        `Cannot safely restore redacted values for array at ${path || "<root>"} without stable IDs.`,
      );
    }
  }
  if (
    !Array.isArray(patch) ||
    !Array.isArray(sourceInput) ||
    !Array.isArray(resolvedSourceInput) ||
    !Array.isArray(runtimeInput) ||
    !patch.every(isConfigPatchObjectWithStringId)
  ) {
    return structuredClone(patch);
  }
  const source = sourceInput;
  const resolvedSource = resolvedSourceInput;
  const runtime = runtimeInput;
  const mappedEntries = patch.flatMap((entry, patchIndex) => {
    const authoredMatches = source.flatMap((candidate, index) => {
      if (!isConfigPatchObjectWithStringId(candidate)) {
        return [];
      }
      try {
        return resolveConfigEnvVars(candidate.id, params.env) === entry.id ? [index] : [];
      } catch {
        return [];
      }
    });
    const resolvedMatches = resolvedSource.flatMap((candidate, index) =>
      isConfigPatchObjectWithStringId(candidate) && candidate.id === entry.id ? [index] : [],
    );
    const runtimeMatches = runtime.flatMap((candidate, index) =>
      isConfigPatchObjectWithStringId(candidate) && candidate.id === entry.id ? [index] : [],
    );
    if (authoredMatches.length > 1 || resolvedMatches.length > 1 || runtimeMatches.length > 1) {
      throw new Error(`Ambiguous duplicate ID ${entry.id} in ID-merged array at ${path}.`);
    }
    const authoredIndex = authoredMatches[0] ?? -1;
    const resolvedIndex = resolvedMatches[0] ?? -1;
    const runtimeIndex = runtimeMatches[0] ?? -1;
    const sourceIndex =
      authoredIndex >= 0
        ? authoredIndex
        : resolvedIndex >= 0
          ? resolvedIndex
          : patch.length === source.length &&
              resolvedSource.length === source.length &&
              runtime.length === source.length &&
              isConfigPatchObjectWithStringId(runtime[patchIndex]) &&
              runtime[patchIndex].id === entry.id
            ? patchIndex
            : -1;
    const sourceEntry = source[sourceIndex];
    const runtimeEntry = runtime[runtimeIndex];
    if (sourceIndex < 0 || !isRecord(sourceEntry)) {
      if (containsRedactedPatchSentinel(entry)) {
        throw new Error(`Cannot restore redacted values for unmatched ID ${entry.id} at ${path}.`);
      }
      return structuredClone(entry);
    }
    const mapped = mapConfigPatchIdsToSource({
      patch: entry,
      source: sourceEntry,
      resolvedSource: resolvedSource[sourceIndex],
      runtime: isRecord(runtimeEntry) ? runtimeEntry : {},
      env: params.env,
      replaceArrayPaths: params.replaceArrayPaths,
      path: `${path}[]`,
    }) as Record<string, unknown>;
    if (typeof sourceEntry.id === "string") {
      mapped.id = sourceEntry.id;
    } else if (
      containsRedactedPatchSentinel(entry) &&
      isRecord(runtimeEntry) &&
      isDeepStrictEqual(
        applyMergePatch(runtimeEntry, mapped, {
          mergeObjectArraysById: true,
          replaceArrayPaths: params.replaceArrayPaths,
          path: `${path}[]`,
        }),
        runtimeEntry,
      )
    ) {
      return [];
    }
    return [mapped];
  });
  return patch.length > 0 && mappedEntries.length === 0 ? undefined : mappedEntries;
}

function containsRedactedPatchSentinel(value: unknown): boolean {
  if (value === REDACTED_SENTINEL) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsRedactedPatchSentinel);
  }
  return isRecord(value) && Object.values(value).some(containsRedactedPatchSentinel);
}

const OMIT_REDACTED_REPLACEMENT_VALUE = Symbol("omit-redacted-replacement-value");

function restoreRedactedReplacementSource(
  value: unknown,
  source: unknown,
  resolvedSource: unknown,
  validated: unknown,
  path = "",
  includeOwned = false,
): unknown {
  const currentIncludeOwned =
    includeOwned || (isRecord(source) && Object.hasOwn(source, INCLUDE_KEY));
  if (value === REDACTED_SENTINEL) {
    if (validated === REDACTED_SENTINEL) {
      throw new Error("unvalidated redaction sentinel in replacement config");
    }
    if (source === undefined) {
      if (currentIncludeOwned) {
        throw new Error(
          `Cannot restore redacted include-owned value at ${path || "<root>"}; use config.patch for unrelated source edits.`,
        );
      }
      return OMIT_REDACTED_REPLACEMENT_VALUE;
    }
    return structuredClone(source);
  }
  if (Array.isArray(value)) {
    const sourceArray = Array.isArray(source) ? source : [];
    const resolvedSourceArray = Array.isArray(resolvedSource) ? resolvedSource : [];
    const validatedArray = Array.isArray(validated) ? validated : [];
    if (value.some(containsRedactedPatchSentinel)) {
      if (!value.every(isConfigPatchObjectWithStringId)) {
        throw new Error(
          `Cannot safely restore redacted values for replacement array at ${path || "<root>"} without stable IDs.`,
        );
      }
      const submittedIds = new Set<string>();
      for (const entry of value) {
        if (submittedIds.has(entry.id)) {
          throw new Error(
            `Ambiguous duplicate ID ${entry.id} in replacement array at ${path || "<root>"}.`,
          );
        }
        submittedIds.add(entry.id);
      }
      return value.map((entry, index) => {
        const sourceMatches = sourceArray.flatMap((candidate, sourceIndex) =>
          isConfigPatchObjectWithStringId(candidate) && candidate.id === entry.id
            ? [sourceIndex]
            : [],
        );
        const resolvedSourceMatches = resolvedSourceArray.flatMap((candidate, sourceIndex) =>
          isConfigPatchObjectWithStringId(candidate) && candidate.id === entry.id
            ? [sourceIndex]
            : [],
        );
        if (sourceMatches.length > 1 || resolvedSourceMatches.length > 1) {
          throw new Error(
            `Ambiguous duplicate ID ${entry.id} in replacement array at ${path || "<root>"}.`,
          );
        }
        const resolvedSourceIndex = resolvedSourceMatches[0] ?? -1;
        const sourceIndex =
          sourceMatches[0] ??
          (resolvedSourceIndex >= 0 && sourceArray.length === resolvedSourceArray.length
            ? resolvedSourceIndex
            : -1);
        if (containsRedactedPatchSentinel(entry) && sourceIndex < 0) {
          throw new Error(
            `Cannot restore redacted values for unmatched ID ${entry.id} at ${path || "<root>"}.`,
          );
        }
        const sourceEntry = sourceArray[sourceIndex];
        const restored = restoreRedactedReplacementSource(
          entry,
          sourceEntry,
          resolvedSourceArray[resolvedSourceIndex],
          validatedArray[index],
          `${path}[]`,
          currentIncludeOwned,
        ) as Record<string, unknown>;
        if (isConfigPatchObjectWithStringId(sourceEntry)) {
          restored.id = sourceEntry.id;
        }
        return restored;
      });
    }
    return value.flatMap((entry, index) => {
      const restored = restoreRedactedReplacementSource(
        entry,
        sourceArray[index],
        resolvedSourceArray[index],
        validatedArray[index],
        `${path}[]`,
        currentIncludeOwned,
      );
      return restored === OMIT_REDACTED_REPLACEMENT_VALUE ? [] : [restored];
    });
  }
  if (!isRecord(value)) {
    return structuredClone(value);
  }
  const sourceRecord = isRecord(source) ? source : {};
  const resolvedSourceRecord = isRecord(resolvedSource) ? resolvedSource : {};
  const validatedRecord = isRecord(validated) ? validated : {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const restored = restoreRedactedReplacementSource(
        entry,
        sourceRecord[key],
        resolvedSourceRecord[key],
        validatedRecord[key],
        formatConfigPatchPath(path, key),
        currentIncludeOwned,
      );
      return restored === OMIT_REDACTED_REPLACEMENT_VALUE ? [] : [[key, restored]];
    }),
  );
}

function collectRuntimeOnlyAgentUnsets(params: {
  patch: unknown;
  parsed: unknown;
  runtime: OpenClawConfig;
}): Array<{ kind: "unset"; path: readonly string[] }> {
  if (!isRecord(params.patch) || !Object.hasOwn(params.patch, "agents")) {
    return [];
  }
  const agentsPatch = params.patch.agents;
  const runtimeIds = Object.keys(params.runtime.agents?.entries ?? {});
  const removedIds =
    agentsPatch === null
      ? runtimeIds
      : isRecord(agentsPatch) && Object.hasOwn(agentsPatch, "entries")
        ? agentsPatch.entries === null
          ? runtimeIds
          : isRecord(agentsPatch.entries)
            ? Object.entries(agentsPatch.entries).flatMap(([id, value]) =>
                value === null ? [id] : [],
              )
            : []
        : [];
  return removedIds.flatMap((agentId) => {
    const path = ["agents", "entries", agentId] as const;
    return configPathExists(params.parsed, path) ? [] : [{ kind: "unset" as const, path }];
  });
}

function findPatchedIncludeOwner(
  patch: unknown,
  authored: unknown,
  path: readonly string[] = [],
): readonly string[] | undefined {
  if (isRecord(authored) && Object.hasOwn(authored, "$include")) {
    return path;
  }
  if (Array.isArray(patch) && Array.isArray(authored)) {
    return authored.some((entry) => isRecord(entry) && Object.hasOwn(entry, "$include"))
      ? path
      : undefined;
  }
  if (!isRecord(patch) || !isRecord(authored)) {
    return undefined;
  }
  for (const [key, value] of Object.entries(patch)) {
    const owner = findPatchedIncludeOwner(value, authored[key], [...path, key]);
    if (owner) {
      return owner;
    }
  }
  return undefined;
}

function isEmptyMergePatchAgainst(patch: unknown, current: unknown): boolean {
  if (!isRecord(patch) || !isRecord(current)) {
    return false;
  }
  return Object.entries(patch).every(
    ([key, value]) => Object.hasOwn(current, key) && isEmptyMergePatchAgainst(value, current[key]),
  );
}

function pruneEmptyMergePatchBranches(patch: unknown, current: unknown): unknown {
  if (!isRecord(patch) || !isRecord(current)) {
    return patch;
  }
  return Object.fromEntries(
    Object.entries(patch).flatMap(([key, value]) => {
      const prunedValue = pruneEmptyMergePatchBranches(value, current[key]);
      if (Object.hasOwn(current, key) && isEmptyMergePatchAgainst(prunedValue, current[key])) {
        return [];
      }
      return [[key, prunedValue]];
    }),
  );
}

const OMIT_OWNERSHIP_PATCH = Symbol("omit-ownership-patch");

function pruneNoopOwnershipPatch(
  patch: unknown,
  current: unknown,
  replaceArrayPaths: ReadonlySet<string>,
  path = "",
  originalPatch: unknown = patch,
): unknown | typeof OMIT_OWNERSHIP_PATCH {
  if (Array.isArray(patch) && Array.isArray(current)) {
    if (replaceArrayPaths.has(path) || !patch.every(isConfigPatchObjectWithStringId)) {
      return isDeepStrictEqual(patch, current) ? OMIT_OWNERSHIP_PATCH : patch;
    }
    const originalEntries = Array.isArray(originalPatch) ? originalPatch : [];
    const entries = patch.filter((entry) => {
      const originalEntry = originalEntries.find(
        (candidate) => isConfigPatchObjectWithStringId(candidate) && candidate.id === entry.id,
      );
      if (!containsRedactedPatchSentinel(originalEntry)) {
        return true;
      }
      const matches = current.filter(
        (candidate) => isConfigPatchObjectWithStringId(candidate) && candidate.id === entry.id,
      );
      if (matches.length !== 1) {
        return true;
      }
      const merged = applyMergePatch(matches[0], entry, {
        mergeObjectArraysById: true,
        replaceArrayPaths,
        path: `${path}[]`,
      });
      return !isDeepStrictEqual(merged, matches[0]);
    });
    return entries.length === 0 ? OMIT_OWNERSHIP_PATCH : entries;
  }
  if (!isRecord(patch) || !isRecord(current)) {
    return patch;
  }
  const entries = Object.entries(patch).flatMap(([key, value]) => {
    const childPath = formatConfigPatchPath(path, key);
    const pruned = pruneNoopOwnershipPatch(
      value,
      current[key],
      replaceArrayPaths,
      childPath,
      isRecord(originalPatch) ? originalPatch[key] : undefined,
    );
    if (
      pruned === OMIT_OWNERSHIP_PATCH ||
      (Object.hasOwn(current, key) && isEmptyMergePatchAgainst(pruned, current[key]))
    ) {
      return [];
    }
    return [[key, pruned]];
  });
  return entries.length === 0 ? OMIT_OWNERSHIP_PATCH : Object.fromEntries(entries);
}

function collectDestructiveArrayPatchPaths(params: {
  base: unknown;
  patch: unknown;
  merged: unknown;
  path?: string;
}): string[] {
  if (!isPlainObject(params.patch) || !isPlainObject(params.base)) {
    return [];
  }

  const merged = isPlainObject(params.merged) ? params.merged : {};
  const paths: string[] = [];
  for (const [key, patchValue] of Object.entries(params.patch)) {
    const path = formatConfigPatchPath(params.path ?? "", key);
    if (!isMergePatchObjectKeyAllowed(key, params.path)) {
      continue;
    }
    const baseValue = params.base[key];
    const mergedValue = merged[key];

    if (Array.isArray(baseValue)) {
      if (patchValue === null || !Array.isArray(patchValue)) {
        paths.push(path);
        continue;
      }
      if (Array.isArray(mergedValue)) {
        if (isConfigPatchIdKeyedArray(baseValue)) {
          if (!idKeyedArrayPreservesBaseIds(baseValue, mergedValue)) {
            paths.push(path);
            continue;
          }
          paths.push(
            ...collectDestructiveIdKeyedArrayEntryPatchPaths({
              base: baseValue,
              patch: patchValue,
              merged: mergedValue,
              path,
            }),
          );
        } else if (!arrayPreservesBaseEntries(baseValue, mergedValue)) {
          paths.push(path);
          continue;
        }
      }
    } else if (isPlainObject(baseValue) && !isPlainObject(patchValue)) {
      paths.push(...collectBaseArrayPaths(baseValue, path));
      continue;
    }

    if (isPlainObject(patchValue)) {
      paths.push(
        ...collectDestructiveArrayPatchPaths({
          base: baseValue,
          patch: patchValue,
          merged: mergedValue,
          path,
        }),
      );
    }
  }
  return paths;
}

function collectBaseArrayPaths(base: unknown, path: string): string[] {
  if (Array.isArray(base)) {
    return [path];
  }
  if (!isPlainObject(base)) {
    return [];
  }
  const paths: string[] = [];
  for (const [key, value] of Object.entries(base)) {
    const childPath = formatConfigPatchPath(path, key);
    if (!isMergePatchObjectKeyAllowed(key, path)) {
      continue;
    }
    paths.push(...collectBaseArrayPaths(value, childPath));
  }
  return paths;
}

function isConfigPatchObjectWithStringId(
  value: unknown,
): value is Record<string, unknown> & { id: string } {
  return isPlainObject(value) && typeof value.id === "string" && value.id.length > 0;
}

function isConfigPatchIdKeyedArray(
  value: unknown[],
): value is Array<Record<string, unknown> & { id: string }> {
  return value.every(isConfigPatchObjectWithStringId);
}

function idKeyedArrayPreservesBaseIds(
  base: Array<Record<string, unknown> & { id: string }>,
  merged: unknown[],
): boolean {
  const mergedIds = new Set(
    merged.filter(isConfigPatchObjectWithStringId).map((entry) => entry.id),
  );
  return base.every((entry) => mergedIds.has(entry.id));
}

function arrayPreservesBaseEntries(base: unknown[], merged: unknown[]): boolean {
  const unmatchedMerged = [...merged];
  for (const baseEntry of base) {
    const matchIndex = unmatchedMerged.findIndex((mergedEntry) =>
      isDeepStrictEqual(mergedEntry, baseEntry),
    );
    if (matchIndex === -1) {
      return false;
    }
    unmatchedMerged.splice(matchIndex, 1);
  }
  return true;
}

function collectDestructiveIdKeyedArrayEntryPatchPaths(params: {
  base: unknown[];
  patch: unknown[];
  merged: unknown[];
  path: string;
}): string[] {
  if (!isConfigPatchIdKeyedArray(params.base)) {
    return [];
  }
  const baseById = new Map(params.base.map((entry) => [entry.id, entry]));
  const mergedById = new Map(
    params.merged.filter(isConfigPatchObjectWithStringId).map((entry) => [entry.id, entry]),
  );
  const paths: string[] = [];
  for (const patchEntry of params.patch) {
    if (!isConfigPatchObjectWithStringId(patchEntry)) {
      continue;
    }
    const baseEntry = baseById.get(patchEntry.id);
    const mergedEntry = mergedById.get(patchEntry.id);
    if (!baseEntry || !mergedEntry) {
      continue;
    }
    paths.push(
      ...collectDestructiveArrayPatchPaths({
        base: baseEntry,
        patch: patchEntry,
        merged: mergedEntry,
        path: `${params.path}[]`,
      }),
    );
  }
  return paths;
}

function rejectDestructiveArrayPatchWithoutIntent(params: {
  currentConfig: OpenClawConfig;
  mergedConfig: unknown;
  patch: unknown;
  replacePaths: Set<string>;
  respond: RespondFn;
}): boolean {
  const destructivePaths = collectDestructiveArrayPatchPaths({
    base: params.currentConfig,
    patch: params.patch,
    merged: params.mergedConfig,
  });
  const unconfirmedPaths = destructivePaths.filter((path) => !params.replacePaths.has(path));
  if (unconfirmedPaths.length === 0) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `config.patch would remove entries from array path(s): ${unconfirmedPaths.join(", ")}. ` +
        `Pass replacePaths with the exact path(s) when this is intentional, or use config.apply for full-config replacement.`,
    ),
  );
  return true;
}

async function readConfigWriteSnapshotOrRespond(
  params: unknown,
  respond: RespondFn,
): Promise<Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>> | null> {
  const result = await readConfigFileSnapshotForWrite();
  if (!requireConfigBaseHash(params, result.snapshot, respond)) {
    return null;
  }
  return result;
}

function parseRawConfigOrRespond(
  params: unknown,
  requestName: string,
  respond: RespondFn,
): string | null {
  const rawValue = (params as { raw?: unknown }).raw;
  if (typeof rawValue !== "string") {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid ${requestName} params: raw (string) required`,
      ),
    );
    return null;
  }
  return rawValue;
}

function hasOwnRecordValue(value: unknown, key: string): boolean {
  return isRecord(value) && Object.hasOwn(value, key);
}

function stripBundledProviderRuntimeDefaults(params: {
  candidate: unknown;
  sourceConfig: unknown;
}): unknown {
  if (!isRecord(params.candidate)) {
    return params.candidate;
  }
  const models = params.candidate.models;
  if (!isRecord(models) || !isRecord(models.providers)) {
    return params.candidate;
  }
  const sourceModels = isRecord(params.sourceConfig) ? params.sourceConfig.models : undefined;
  const sourceProviders = isRecord(sourceModels) ? sourceModels.providers : undefined;

  let nextProviders: Record<string, unknown> | undefined;
  for (const [providerId, provider] of Object.entries(models.providers)) {
    // Runtime overlays can materialize empty defaults that should not become persisted config.
    if (!isBuiltInModelProviderOverlayId(providerId) || !isRecord(provider)) {
      continue;
    }
    const sourceProvider = isRecord(sourceProviders) ? sourceProviders[providerId] : undefined;
    let nextProvider: Record<string, unknown> | undefined;
    if (provider.baseUrl === "" && !hasOwnRecordValue(sourceProvider, "baseUrl")) {
      nextProvider = { ...provider };
      delete nextProvider.baseUrl;
    }
    if (
      Array.isArray(provider.models) &&
      provider.models.length === 0 &&
      !hasOwnRecordValue(sourceProvider, "models")
    ) {
      nextProvider ??= { ...provider };
      delete nextProvider.models;
    }
    if (nextProvider) {
      nextProviders ??= { ...models.providers };
      nextProviders[providerId] = nextProvider;
    }
  }
  if (!nextProviders) {
    return params.candidate;
  }
  return {
    ...params.candidate,
    models: {
      ...models,
      providers: nextProviders,
    },
  };
}

function parseValidateConfigFromRawOrRespond(
  params: unknown,
  requestName: string,
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  respond: RespondFn,
): {
  config: OpenClawConfig;
  writeConfig: OpenClawConfig;
  schema: ConfigSchemaResponse;
} | null {
  const rawValue = parseRawConfigOrRespond(params, requestName, respond);
  if (!rawValue) {
    return null;
  }
  const parsedRes = parseConfigJson5(rawValue);
  if (!parsedRes.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
    return null;
  }
  const schema = loadSchemaWithPlugins();
  const restored = restoreRedactedValues(parsedRes.parsed, snapshot.config, schema.uiHints);
  if (!restored.ok) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, restored.humanReadableMessage ?? "invalid config"),
    );
    return null;
  }
  let restoredSource: unknown;
  try {
    restoredSource = restoreRedactedReplacementSource(
      parsedRes.parsed,
      snapshot.parsed,
      snapshot.resolved,
      restored.result,
    );
  } catch (error) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
    return null;
  }
  if (restoredSource === OMIT_REDACTED_REPLACEMENT_VALUE) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid config"));
    return null;
  }
  // Validate against runtime shape, but write the source-shaped config the operator submitted.
  const projectedValidationCandidate = snapshot.valid
    ? applyConfigOperations(
        projectSourceOntoRuntimeShape(snapshot.resolved, snapshot.config),
        createConfigMutationOperations(snapshot.config, restored.result),
      )
    : restored.result;
  const validationCandidate = stripBundledProviderRuntimeDefaults({
    candidate: projectedValidationCandidate,
    sourceConfig: snapshot.sourceConfig,
  });
  const writeCandidate = restoredSource as OpenClawConfig;
  const sourceValidated = validateConfigObjectRawWithPlugins(validationCandidate);
  if (!sourceValidated.ok) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        summarizeConfigValidationIssues(sourceValidated.issues),
        {
          details: { issues: sourceValidated.issues },
        },
      ),
    );
    return null;
  }
  const validated = validateConfigObjectWithPlugins(validationCandidate);
  if (!validated.ok) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, summarizeConfigValidationIssues(validated.issues), {
        details: { issues: validated.issues },
      }),
    );
    return null;
  }
  return {
    config: validated.config,
    writeConfig: writeCandidate,
    schema,
  };
}

function listExplicitAgentRosterIds(config: OpenClawConfig): string[] {
  const roster = readAgentRosterProperty(config);
  if (roster?.kind === "entries" && isRecord(roster.value)) {
    return Object.keys(roster.value);
  }
  if (roster?.kind !== "list" || !Array.isArray(roster.value)) {
    return [];
  }
  return roster.value.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
  );
}

function rejectDroppedAgentRosterEntries(params: {
  currentConfig: OpenClawConfig;
  submittedConfig: OpenClawConfig;
  respond: RespondFn;
}): boolean {
  const submittedIds = new Set(
    listExplicitAgentRosterIds(params.submittedConfig).map((agentId) => normalizeAgentId(agentId)),
  );
  const droppedIds = listExplicitAgentRosterIds(params.currentConfig)
    .filter((agentId) => !submittedIds.has(normalizeAgentId(agentId)))
    .toSorted();
  if (droppedIds.length === 0) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `config.set would remove existing agent entries: ${droppedIds.join(", ")}. ` +
        "Use the agents.delete RPC or `openclaw agents delete <id>` for intentional deletion.",
    ),
  );
  return true;
}

function summarizeConfigValidationIssues(issues: ReadonlyArray<ConfigValidationIssue>): string {
  const trimmed = issues.slice(0, MAX_CONFIG_ISSUES_IN_ERROR_MESSAGE);
  const lines = normalizeStringEntries(
    formatConfigIssueLines(trimmed, "", { normalizeRoot: true }),
  );
  if (lines.length === 0) {
    return "invalid config";
  }
  const hiddenCount = Math.max(0, issues.length - lines.length);
  return `invalid config: ${lines.join("; ")}${
    hiddenCount > 0 ? ` (+${hiddenCount} more issue${hiddenCount === 1 ? "" : "s"})` : ""
  }`;
}

async function ensureResolvableSecretRefsOrRespond(params: {
  config: OpenClawConfig;
  respond: RespondFn;
}): Promise<PreparedSecretsRuntimeSnapshot | null> {
  try {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: params.config,
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
    });
    for (const owner of snapshot.degradedOwners ?? []) {
      const reason = redactSecretDegradationReason(owner.reason);
      if (!isRetryableSecretDegradationReason(reason)) {
        throw new Error(reason);
      }
    }
    return snapshot;
  } catch (error) {
    const details = formatErrorMessage(error);
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid config: active SecretRef resolution failed (${details})`,
      ),
    );
    return null;
  }
}

function listPreparedSecretDegradations(snapshot: PreparedSecretsRuntimeSnapshot) {
  return (snapshot.degradedOwners ?? []).map((owner) => ({
    ownerKind: owner.ownerKind,
    ownerId: owner.ownerId,
    state: owner.degradationState ?? "cold",
    paths: [...owner.paths],
    reason: redactSecretDegradationReason(owner.reason),
  }));
}

function preparedSecretDegradationPayload(snapshot: PreparedSecretsRuntimeSnapshot) {
  const degradedSecretOwners = listPreparedSecretDegradations(snapshot);
  return degradedSecretOwners.length > 0 ? { degradedSecretOwners } : {};
}

export function clearConfigSchemaResponseCacheForTests() {
  configSchemaResponseCache = null;
}

export function loadConfigSchemaResponseForTests(): ConfigSchemaResponse {
  return loadSchemaWithPlugins();
}

function clearConfigSchemaResponseCache() {
  configSchemaResponseCache = null;
}

async function respondWithConfigRestartWrite(params: {
  requestParams: unknown;
  kind: ConfigRestartWriteKind;
  mode: ConfigRestartWriteMode;
  writeResult: ConfigWriteCommitResult;
  changedPaths: string[];
  actor: ReturnType<typeof resolveControlPlaneActor>;
  context: GatewayRequestContext | undefined;
  respond: RespondFn;
  uiHints: ConfigRedactionHints;
  preparedSecretsSnapshot: PreparedSecretsRuntimeSnapshot;
}): Promise<void> {
  clearConfigSchemaResponseCache();
  const { payload, sentinelPersisted, restart } = await resolveGatewayConfigRestartWriteResult({
    requestParams: params.requestParams,
    kind: params.kind,
    mode: params.mode,
    configPath: params.writeResult.path,
    changedPaths: params.changedPaths,
    nextConfig: params.writeResult.config,
    actor: params.actor,
    context: params.context,
  });
  params.respond(
    true,
    {
      ok: true,
      path: params.writeResult.path,
      // Additive ack hash: matches the hash config.get would report for the
      // persisted bytes, so writers can adopt it without a reload.
      ...(params.writeResult.hash ? { hash: params.writeResult.hash } : {}),
      config: redactConfigObject(params.writeResult.config, params.uiHints),
      ...preparedSecretDegradationPayload(params.preparedSecretsSnapshot),
      restart,
      sentinel: {
        persisted: sentinelPersisted,
        payload,
      },
    },
    undefined,
  );
  params.writeResult.queueFollowUp();
}

function shouldDisconnectSharedAuthClientsForConfigWrite(params: {
  prevConfig: OpenClawConfig;
  prevSourceConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  preparedSecretsSnapshot: PreparedSecretsRuntimeSnapshot;
}): boolean {
  return (
    didSharedGatewayAuthChange(params.prevConfig, params.nextConfig) ||
    didActiveSharedGatewayAuthChange({
      fallbackPrev: params.prevConfig,
      fallbackSource: params.prevSourceConfig,
      next: params.preparedSecretsSnapshot.config,
    })
  );
}

function resolveSharedAuthAuthoredSource(
  snapshot: Pick<ConfigFileSnapshot, "parsed" | "sourceConfig" | "includeProvenance">,
): OpenClawConfig {
  const includeOwnsPath = (target: readonly string[]) =>
    Boolean(
      snapshot.includeProvenance?.some((entry) =>
        (entry.contributedPaths ?? [entry.path]).some(
          (owned) =>
            owned.every((segment, index) => target[index] === segment) ||
            target.every((segment, index) => owned[index] === segment),
        ),
      ),
    );
  const parsedGateway =
    isRecord(snapshot.parsed) && isRecord(snapshot.parsed.gateway) ? snapshot.parsed.gateway : {};
  const sourceGateway = snapshot.sourceConfig.gateway;
  const gateway: NonNullable<OpenClawConfig["gateway"]> = {};
  for (const key of ["auth", "tailscale", "trustedProxies"] as const) {
    if (includeOwnsPath(["gateway", key]) && sourceGateway && Object.hasOwn(sourceGateway, key)) {
      Object.assign(gateway, { [key]: sourceGateway[key] });
    } else if (Object.hasOwn(parsedGateway, key)) {
      Object.assign(gateway, {
        [key]: projectSourceOntoRuntimeShape(parsedGateway[key], sourceGateway?.[key]),
      });
    }
  }
  return Object.keys(gateway).length > 0 ? { gateway } : {};
}

function respondConfigPatchNoop(params: {
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  config: OpenClawConfig;
  uiHints: ConfigRedactionHints;
  actor: ReturnType<typeof resolveControlPlaneActor>;
  context: GatewayRequestContext | undefined;
  respond: RespondFn;
}): void {
  params.context?.logGateway?.info(
    `config.patch noop ${formatControlPlaneActor(params.actor)} (no changed paths)`,
  );
  params.respond(
    true,
    {
      ok: true,
      noop: true,
      path: resolveGatewayConfigPath(params.snapshot),
      config: redactConfigObject(params.config, params.uiHints),
    },
    undefined,
  );
}

function loadSchemaWithPlugins(): ConfigSchemaResponse {
  const now = asDateTimestampMs(Date.now());
  const cachedExpiresAt =
    configSchemaResponseCache === null
      ? undefined
      : asDateTimestampMs(configSchemaResponseCache.expiresAtMs);
  if (
    configSchemaResponseCache &&
    now !== undefined &&
    cachedExpiresAt !== undefined &&
    cachedExpiresAt > now
  ) {
    return configSchemaResponseCache.response;
  }
  if (configSchemaResponseCache) {
    configSchemaResponseCache = null;
  }

  // Plugin schema loading is process-local; short caching avoids repeated UI lookups per render.
  const response = loadGatewayRuntimeConfigSchema();
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(CONFIG_SCHEMA_RESPONSE_CACHE_TTL_MS);
  if (expiresAtMs !== undefined) {
    configSchemaResponseCache = {
      expiresAtMs,
      response,
    };
  }
  return response;
}

async function commitGatewayConfigWriteOrRespond(
  params: Parameters<typeof commitGatewayConfigWrite>[0] & { respond: RespondFn },
): Promise<Awaited<ReturnType<typeof commitGatewayConfigWrite>> | null> {
  try {
    return await commitGatewayConfigWrite(params);
  } catch (error) {
    if (!(error instanceof ConfigMutationConflictError)) {
      throw error;
    }
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `${error.message}; re-run config.get and retry`),
    );
    return null;
  }
}

function isHashlessPatchLwwPath(path: string): boolean {
  return HASHLESS_PATCH_LWW_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}.`),
  );
}

// Hash-free LWW is a per-leaf protocol. Container replacement or deletion requires document CAS
// so a stale client cannot wipe preference keys added by a concurrent writer.
function hasHashlessPatchLwwStructure(patch: unknown): boolean {
  return HASHLESS_PATCH_LWW_PATH_PREFIXES.every((prefix) => {
    let node = patch;
    for (const segment of prefix.split(".")) {
      if (!isPlainObject(node)) {
        return false;
      }
      if (!Object.hasOwn(node, segment)) {
        return true;
      }
      node = node[segment];
      if (!isPlainObject(node)) {
        return false;
      }
    }
    return true;
  });
}

function diffConfigLeafPaths(prev: unknown, next: unknown, prefix = ""): string[] {
  if (isPlainObject(prev) || isPlainObject(next)) {
    const prevRecord = isPlainObject(prev) ? prev : {};
    const nextRecord = isPlainObject(next) ? next : {};
    const keys = [...new Set([...Object.keys(prevRecord), ...Object.keys(nextRecord)])];
    if (keys.length === 0) {
      return isDeepStrictEqual(prev, next) ? [] : [prefix || "<root>"];
    }
    return keys.flatMap((key) =>
      diffConfigLeafPaths(prevRecord[key], nextRecord[key], prefix ? `${prefix}.${key}` : key),
    );
  }
  return diffConfigPaths(prev, next, prefix);
}

export const configHandlers: GatewayRequestHandlers = {
  "config.get": async ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigGetParams, "config.get", respond)) {
      return;
    }
    const snapshot = await readConfigFileSnapshot();
    const schema = loadSchemaWithPlugins();
    respond(true, createConfigGetResponse(snapshot, schema.uiHints), undefined);
  },
  "config.schema": ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigSchemaParams, "config.schema", respond)) {
      return;
    }
    respond(true, loadSchemaWithPlugins(), undefined);
  },
  "config.schema.lookup": ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateConfigSchemaLookupParams, "config.schema.lookup", respond)
    ) {
      return;
    }
    const path = (params as { path: string }).path;
    const schema = loadSchemaWithPlugins();
    const result = lookupConfigSchema(schema, path, resolveConfigReloadMetadata);
    if (!result) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config schema path not found"),
      );
      return;
    }
    if (!validateConfigSchemaLookupResult(result)) {
      const errors = validateConfigSchemaLookupResult.errors ?? [];
      context.logGateway.warn(
        `config.schema.lookup produced invalid payload for ${sanitizePathForLog(path)}: ${formatValidationErrors(errors)}`,
      );
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "config.schema.lookup returned invalid payload", {
          details: { errors },
        }),
      );
      return;
    }
    respond(true, result, undefined);
  },
  "config.set": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateConfigSetParams, "config.set", respond)) {
      return;
    }
    const writeSnapshot = await readConfigWriteSnapshotOrRespond(params, respond);
    if (!writeSnapshot) {
      return;
    }
    const { snapshot, writeOptions } = writeSnapshot;
    const parsed = parseValidateConfigFromRawOrRespond(params, "config.set", snapshot, respond);
    if (!parsed) {
      return;
    }
    if (
      rejectDroppedAgentRosterEntries({
        currentConfig: snapshot.config,
        submittedConfig: parsed.config,
        respond,
      })
    ) {
      return;
    }
    const preparedSecretsSnapshot = await ensureResolvableSecretRefsOrRespond({
      config: parsed.config,
      respond,
    });
    if (!preparedSecretsSnapshot) {
      return;
    }
    const writeResult = await commitGatewayConfigWriteOrRespond({
      snapshot,
      writeOptions,
      nextConfig: parsed.writeConfig,
      intent: {
        kind: "replace",
        config: parsed.writeConfig,
      },
      context,
      respond,
    });
    if (!writeResult) {
      return;
    }
    clearConfigSchemaResponseCache();
    respond(
      true,
      {
        ok: true,
        path: writeResult.path,
        // Additive ack hash: matches the hash config.get would report for the
        // persisted bytes, so writers can adopt it without a reload.
        ...(writeResult.hash ? { hash: writeResult.hash } : {}),
        config: redactConfigObject(writeResult.config, parsed.schema.uiHints),
        ...preparedSecretDegradationPayload(preparedSecretsSnapshot),
      },
      undefined,
    );
    writeResult.queueFollowUp();
  },
  "config.patch": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigPatchParams, "config.patch", respond)) {
      return;
    }
    const hashlessPatch = resolveBaseHashParam(params) === null;
    // Hash-free writes do not retry: only the client can replay fresh intent after a lost race;
    // server re-merge would replay frozen stale intent over the winner. A paused handler can still
    // commit stale state, an accepted residual instead of adding connection-liveness plumbing.
    const writeSnapshot = hashlessPatch
      ? await readConfigFileSnapshotForWrite()
      : await readConfigWriteSnapshotOrRespond(params, respond);
    if (!writeSnapshot) {
      return;
    }
    const { snapshot, writeOptions } = writeSnapshot;
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid config; fix before patching"),
      );
      return;
    }
    const runtimeConfig = stripConfigIncludeDirectives(snapshot.config) as OpenClawConfig;
    const rawValue = (params as { raw?: unknown }).raw;
    if (typeof rawValue !== "string") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid config.patch params: raw (string) required",
        ),
      );
      return;
    }
    const parsedRes = parseConfigJson5(rawValue);
    if (!parsedRes.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
      return;
    }
    if (
      !parsedRes.parsed ||
      typeof parsedRes.parsed !== "object" ||
      Array.isArray(parsedRes.parsed)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config.patch raw must be an object"),
      );
      return;
    }
    if (hashlessPatch && !hasHashlessPatchLwwStructure(parsedRes.parsed)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "config base hash required; re-run config.get and retry",
        ),
      );
      return;
    }
    const replacePaths = readConfigPatchReplacePaths(params);
    const inputPatch = pruneEmptyMergePatchBranches(parsedRes.parsed, runtimeConfig);
    try {
      assertNoDuplicateConfigPatchIds(inputPatch);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
      return;
    }
    const strippedOwnershipPatch = stripRedactedPatchSentinels(inputPatch) ?? {};
    const prunedOwnershipPatch = pruneNoopOwnershipPatch(
      strippedOwnershipPatch,
      runtimeConfig,
      replacePaths,
      "",
      inputPatch,
    );
    const ownershipPatch =
      prunedOwnershipPatch === OMIT_OWNERSHIP_PATCH ? {} : prunedOwnershipPatch;
    const patchIsEmptyMerge = isEmptyMergePatchAgainst(ownershipPatch, runtimeConfig);
    const patchedIncludeOwner = patchIsEmptyMerge
      ? null
      : findPatchedIncludeOwner(ownershipPatch, snapshot.parsed);
    if (patchedIncludeOwner) {
      const provenance = snapshot.includeProvenance?.find(
        (entry) =>
          entry.path.length === patchedIncludeOwner.length &&
          patchedIncludeOwner.every((segment, index) => entry.path[index] === segment),
      );
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          formatConfigWriteRejection({
            code: "include-owned",
            path: patchedIncludeOwner,
            filePath: provenance?.targetPath ?? snapshot.path,
          }),
        ),
      );
      return;
    }
    const includeCheck = checkConfigIncludeOwnership({
      snapshot,
      operations: [{ kind: "merge", patch: ownershipPatch }],
    });
    if (!includeCheck.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, formatConfigWriteRejection(includeCheck.error)),
      );
      return;
    }
    const schemaPatch = loadSchemaWithPlugins();
    const redactionProbe = redactConfigObject(
      replaceRedactionSentinelsWithProbe(parsedRes.parsed),
      schemaPatch.uiHints,
    );
    const invalidSentinelPath = findInvalidRedactionSentinelPath(parsedRes.parsed, redactionProbe);
    if (invalidSentinelPath) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Reserved redaction sentinel "${REDACTED_SENTINEL}" is not valid config data (${invalidSentinelPath}).`,
        ),
      );
      return;
    }
    let runtimePatchInput: unknown;
    try {
      runtimePatchInput = mapConfigPatchIdsToSource({
        patch: inputPatch,
        source: runtimeConfig,
        resolvedSource: runtimeConfig,
        runtime: runtimeConfig,
        env: writeOptions.envSnapshotForRestore ?? process.env,
        replaceArrayPaths: replacePaths,
      });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
      return;
    }
    const effectivePatch = stripRedactedPatchSentinels(runtimePatchInput) ?? {};
    const merged = applyMergePatch(runtimeConfig, effectivePatch, {
      // Arrays with stable ids behave like maps for partial control-plane edits.
      mergeObjectArraysById: true,
      replaceArrayPaths: replacePaths,
    });
    const restoredMerge = restoreRedactedValues(merged, runtimeConfig, schemaPatch.uiHints);
    if (!restoredMerge.ok) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          restoredMerge.humanReadableMessage ?? "invalid config",
        ),
      );
      return;
    }
    if (
      rejectDestructiveArrayPatchWithoutIntent({
        currentConfig: runtimeConfig,
        mergedConfig: restoredMerge.result,
        patch: effectivePatch,
        replacePaths,
        respond,
      })
    ) {
      return;
    }
    const restoredChangedPaths = diffConfigLeafPaths(runtimeConfig, restoredMerge.result);
    if (hashlessPatch && !restoredChangedPaths.every(isHashlessPatchLwwPath)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "config base hash required; re-run config.get and retry",
        ),
      );
      return;
    }
    const actor = resolveControlPlaneActor(client);
    if (restoredChangedPaths.length === 0) {
      respondConfigPatchNoop({
        snapshot,
        config: runtimeConfig,
        uiHints: schemaPatch.uiHints,
        actor,
        context,
        respond,
      });
      return;
    }
    const validationCandidate = stripBundledProviderRuntimeDefaults({
      candidate: restoredMerge.result,
      sourceConfig: snapshot.sourceConfig,
    });
    const sourceValidated = validateConfigObjectRawWithPlugins(validationCandidate);
    if (!sourceValidated.ok) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          summarizeConfigValidationIssues(sourceValidated.issues),
          {
            details: { issues: sourceValidated.issues },
          },
        ),
      );
      return;
    }
    const writeConfig = validationCandidate as OpenClawConfig;
    const validated = validateConfigObjectWithPlugins(validationCandidate);
    if (!validated.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, summarizeConfigValidationIssues(validated.issues), {
          details: { issues: validated.issues },
        }),
      );
      return;
    }
    const preparedSecretsSnapshot = await ensureResolvableSecretRefsOrRespond({
      config: validated.config,
      respond,
    });
    if (!preparedSecretsSnapshot) {
      return;
    }
    const changedPaths = diffConfigPaths(runtimeConfig, validated.config);

    // No-op: if the validated config is identical to the current config,
    // skip the file write and SIGUSR1 restart entirely. This avoids a full
    // gateway restart (and the resulting connection drop) when a control-plane
    // client re-sends the same config (e.g. hot-apply with no actual changes).
    if (changedPaths.length === 0) {
      respondConfigPatchNoop({
        snapshot,
        config: validated.config,
        uiHints: schemaPatch.uiHints,
        actor,
        context,
        respond,
      });
      return;
    }

    context?.logGateway?.info(
      `config.patch write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.patch`,
    );
    // Compare before the write so we invalidate clients authenticated against the
    // previous shared secret immediately after the config update succeeds.
    const disconnectSharedAuthClients = shouldDisconnectSharedAuthClientsForConfigWrite({
      prevConfig: runtimeConfig,
      prevSourceConfig: resolveSharedAuthAuthoredSource(snapshot),
      nextConfig: validated.config,
      preparedSecretsSnapshot,
    });
    let sourcePatchInput: unknown;
    try {
      sourcePatchInput = mapConfigPatchIdsToSource({
        patch: inputPatch,
        source: snapshot.parsed,
        resolvedSource: snapshot.resolved,
        runtime: runtimeConfig,
        env: writeOptions.envSnapshotForRestore ?? process.env,
        replaceArrayPaths: replacePaths,
      });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
      return;
    }
    const restoredSourcePatch = restoreRedactedValues(
      sourcePatchInput,
      snapshot.parsed,
      schemaPatch.uiHints,
    );
    if (!restoredSourcePatch.ok) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          restoredSourcePatch.humanReadableMessage ?? "invalid config",
        ),
      );
      return;
    }
    const authoredCandidate = applyMergePatch(snapshot.parsed, restoredSourcePatch.result, {
      mergeObjectArraysById: true,
      replaceArrayPaths: replacePaths,
    });
    const sourcePatch = createMergePatch(snapshot.parsed, authoredCandidate);
    const sourceOperations: ConfigMutationOperation[] =
      isRecord(sourcePatch) && Object.keys(sourcePatch).length === 0
        ? []
        : [{ kind: "merge" as const, patch: sourcePatch }];
    sourceOperations.push(
      ...collectRuntimeOnlyAgentUnsets({
        patch: inputPatch,
        parsed: snapshot.parsed,
        runtime: runtimeConfig,
      }),
    );
    const writeResult = await commitGatewayConfigWriteOrRespond({
      snapshot,
      writeOptions,
      nextConfig: writeConfig,
      intent: {
        kind: "mutate",
        operations: sourceOperations,
      },
      context,
      disconnectSharedAuthClients,
      respond,
    });
    if (!writeResult) {
      return;
    }
    await respondWithConfigRestartWrite({
      requestParams: params,
      kind: "config-patch",
      mode: "config.patch",
      writeResult,
      changedPaths,
      actor,
      context,
      respond,
      uiHints: schemaPatch.uiHints,
      preparedSecretsSnapshot,
    });
  },
  "config.apply": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigApplyParams, "config.apply", respond)) {
      return;
    }
    const writeSnapshot = await readConfigWriteSnapshotOrRespond(params, respond);
    if (!writeSnapshot) {
      return;
    }
    const { snapshot, writeOptions } = writeSnapshot;
    const parsed = parseValidateConfigFromRawOrRespond(params, "config.apply", snapshot, respond);
    if (!parsed) {
      return;
    }
    const preparedSecretsSnapshot = await ensureResolvableSecretRefsOrRespond({
      config: parsed.config,
      respond,
    });
    if (!preparedSecretsSnapshot) {
      return;
    }
    const changedPaths = diffConfigPaths(snapshot.config, parsed.config);
    const actor = resolveControlPlaneActor(client);
    context?.logGateway?.info(
      `config.apply write ${formatControlPlaneActor(actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=config.apply`,
    );
    // Compare before the write so we invalidate clients authenticated against the
    // previous shared secret immediately after the config update succeeds.
    const disconnectSharedAuthClients = shouldDisconnectSharedAuthClientsForConfigWrite({
      prevConfig: snapshot.config,
      prevSourceConfig: resolveSharedAuthAuthoredSource(snapshot),
      nextConfig: parsed.config,
      preparedSecretsSnapshot,
    });
    const writeResult = await commitGatewayConfigWriteOrRespond({
      snapshot,
      writeOptions,
      nextConfig: parsed.writeConfig,
      intent: {
        kind: "replace",
        config: parsed.writeConfig,
      },
      context,
      disconnectSharedAuthClients,
      respond,
    });
    if (!writeResult) {
      return;
    }
    await respondWithConfigRestartWrite({
      requestParams: params,
      kind: "config-apply",
      mode: "config.apply",
      writeResult,
      changedPaths,
      actor,
      context,
      respond,
      uiHints: parsed.schema.uiHints,
      preparedSecretsSnapshot,
    });
  },
  "config.openFile": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateConfigGetParams, "config.openFile", respond)) {
      return;
    }
    const configPath = createConfigIO().configPath;
    try {
      await execOpenPath(resolveOpenPathCommand(configPath));
      respond(true, { ok: true, path: configPath }, undefined);
    } catch (error) {
      const errorMessage = formatOpenPathError(error);
      const isHeadlessError = isHeadlessOpenPathError(errorMessage);
      const detailedError = isHeadlessError
        ? `Cannot open file in headless environment. File path: ${configPath}. This environment appears to lack a graphical or terminal browser handler.`
        : `Failed to open config file: ${errorMessage}`;
      context?.logGateway?.warn(
        `config.openFile failed path=${sanitizePathForLog(configPath)}: ${errorMessage}`,
      );
      respond(true, { ok: false, path: configPath, error: detailedError }, undefined);
    }
  },
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
