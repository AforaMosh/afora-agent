// Prepares an authored config document from explicit source-level write intent.
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { LEGACY_IMPLICIT_AGENT_ID } from "../routing/session-key.js";
import { isRecord } from "../utils.js";
import { collectChangedPaths } from "./config-change-paths.js";
import {
  applyConfigOperations,
  configPathExists,
  type ConfigMutationOperation,
  type ConfigPath,
} from "./config-path-mutation.js";
import {
  checkConfigIncludeOwnership,
  type IncludeOwnedWriteRejection,
} from "./io.write-includes.js";
import { isMergePatchObjectKeyAllowed } from "./merge-patch.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";

export type ConfigWriteIntent =
  | {
      kind: "mutate";
      operations: readonly ConfigMutationOperation[];
    }
  | { kind: "replace"; config: OpenClawConfig };

export type ConfigWriteRejection =
  | IncludeOwnedWriteRejection
  | { code: "implicit-agent-removal"; agentIds: readonly string[] }
  | { code: "blocked-key"; path: ConfigPath };

export type PreparedConfigWrite = {
  authoredDocument: OpenClawConfig;
  changedPaths: readonly string[];
};

function readAuthoredAgentEntries(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.agents) || !isRecord(value.agents.entries)) {
    return undefined;
  }
  return value.agents.entries;
}

function materializeImplicitMain(params: {
  snapshot: Pick<ConfigFileSnapshot, "parsed" | "runtimeConfig">;
  authoredDocument: OpenClawConfig;
  operations: readonly ConfigMutationOperation[];
}): OpenClawConfig {
  const authoredEntries = readAuthoredAgentEntries(params.authoredDocument);
  const sourceEntries = readAuthoredAgentEntries(params.snapshot.parsed);
  const runtimeEntries = readAuthoredAgentEntries(params.snapshot.runtimeConfig);
  if (
    !authoredEntries ||
    // An existing authored roster owns its default markers. This helper only
    // carries forward runtime-only implicit main when a mutation creates the roster.
    sourceEntries ||
    params.operations.some((operation) =>
      operationExplicitlyRemovesAgent(operation, LEGACY_IMPLICIT_AGENT_ID),
    ) ||
    Object.keys(runtimeEntries ?? {}).length !== 1 ||
    !isRecord(runtimeEntries?.[LEGACY_IMPLICIT_AGENT_ID]) ||
    runtimeEntries[LEGACY_IMPLICIT_AGENT_ID].default !== true
  ) {
    return params.authoredDocument;
  }
  const hasExplicitDefault = Object.values(authoredEntries).some(
    (entry) => isRecord(entry) && entry.default === true,
  );
  const authoredMain = authoredEntries[LEGACY_IMPLICIT_AGENT_ID];
  if (
    authoredMain !== undefined &&
    (!isRecord(authoredMain) || Object.hasOwn(authoredMain, "default"))
  ) {
    return params.authoredDocument;
  }
  const materializedMain = isRecord(authoredMain)
    ? hasExplicitDefault
      ? authoredMain
      : { default: true, ...authoredMain }
    : hasExplicitDefault
      ? {}
      : { default: true };
  return applyConfigOperations(params.authoredDocument, [
    {
      kind: "set",
      path: ["agents", "entries"],
      value: {
        ...authoredEntries,
        [LEGACY_IMPLICIT_AGENT_ID]: materializedMain,
      },
    },
  ]);
}

function operationExplicitlyRemovesAgent(
  operation: ConfigMutationOperation,
  agentId: string,
): boolean {
  const target = ["agents", "entries", agentId];
  if (operation.kind === "unset") {
    return (
      operation.path.length > 0 &&
      operation.path.every((segment, index) => segment === target[index])
    );
  }
  if (operation.kind !== "merge" || !isRecord(operation.patch)) {
    return false;
  }
  const agents = operation.patch.agents;
  if (agents === null) {
    return true;
  }
  if (!isRecord(agents)) {
    return false;
  }
  const entries = agents.entries;
  return entries === null || (isRecord(entries) && entries[agentId] === null);
}

function findImplicitAgentRemovals(params: {
  before: unknown;
  after: unknown;
  operations: readonly ConfigMutationOperation[];
}): string[] {
  const beforeEntries = readAuthoredAgentEntries(params.before);
  if (!beforeEntries) {
    return [];
  }
  const afterEntries = readAuthoredAgentEntries(params.after) ?? {};
  return Object.keys(beforeEntries)
    .filter(
      (agentId) =>
        !Object.hasOwn(afterEntries, agentId) &&
        !params.operations.some((operation) => operationExplicitlyRemovesAgent(operation, agentId)),
    )
    .toSorted();
}

function findBlockedConfigPath(value: unknown, path: ConfigPath = []): ConfigPath | undefined {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const blocked = findBlockedConfigPath(child, [...path, String(index)]);
      if (blocked) {
        return blocked;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    if (!isMergePatchObjectKeyAllowed(key, path.length > 0 ? path.join(".") : undefined)) {
      return [...path, key];
    }
    const blocked = findBlockedConfigPath(child, [...path, key]);
    if (blocked) {
      return blocked;
    }
  }
  return undefined;
}

function findBlockedOperationPath(path: ConfigPath): ConfigPath | undefined {
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index]!;
    const parent = index > 0 ? path.slice(0, index).join(".") : undefined;
    if (!isMergePatchObjectKeyAllowed(segment, parent)) {
      return path.slice(0, index + 1);
    }
  }
  return undefined;
}

export function prepareConfigWrite(params: {
  snapshot: Pick<
    ConfigFileSnapshot,
    "path" | "parsed" | "sourceConfig" | "runtimeConfig" | "includeProvenance" | "valid"
  >;
  intent: ConfigWriteIntent;
  mandatoryUnsets?: readonly ConfigPath[];
}): Result<PreparedConfigWrite, ConfigWriteRejection> {
  const operations =
    params.intent.kind === "mutate"
      ? params.intent.operations
      : [{ kind: "set", path: [], value: params.intent.config } satisfies ConfigMutationOperation];
  const intentDocument =
    params.intent.kind === "replace"
      ? structuredClone(params.intent.config)
      : applyConfigOperations(params.snapshot.parsed, params.intent.operations);
  const mandatoryUnsetOperations = (params.mandatoryUnsets ?? [])
    .filter(
      (path) =>
        configPathExists(params.snapshot.parsed, path) ||
        configPathExists(params.snapshot.sourceConfig, path) ||
        configPathExists(intentDocument, path),
    )
    .map(
      (path): ConfigMutationOperation => ({ kind: "unset", path, strictIncludeOwnership: true }),
    );
  for (const operation of operations) {
    const blocked =
      operation.kind === "merge"
        ? findBlockedConfigPath(operation.patch)
        : (findBlockedOperationPath(operation.path) ??
          (operation.kind === "set"
            ? findBlockedConfigPath(operation.value, operation.path)
            : undefined));
    if (blocked) {
      return err({ code: "blocked-key", path: blocked });
    }
  }
  if (params.intent.kind === "mutate" || params.snapshot.valid) {
    const includeCheck = checkConfigIncludeOwnership({
      snapshot: params.snapshot,
      operations: [...operations, ...mandatoryUnsetOperations],
    });
    if (!includeCheck.ok) {
      return includeCheck;
    }
  }

  let authoredDocument = intentDocument;
  if (params.intent.kind === "mutate") {
    authoredDocument = materializeImplicitMain({
      snapshot: params.snapshot,
      authoredDocument,
      operations: params.intent.operations,
    });
    const droppedIds = findImplicitAgentRemovals({
      before: params.snapshot.parsed,
      after: authoredDocument,
      operations: params.intent.operations,
    });
    if (droppedIds.length > 0) {
      return err({ code: "implicit-agent-removal", agentIds: droppedIds });
    }
  }
  authoredDocument = applyConfigOperations(authoredDocument, mandatoryUnsetOperations);
  const changedPaths = new Set<string>();
  collectChangedPaths(params.snapshot.parsed, authoredDocument, "", changedPaths);
  return ok({
    authoredDocument,
    changedPaths: [...changedPaths],
  });
}
