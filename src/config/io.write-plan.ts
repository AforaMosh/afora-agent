import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
// Prepares an authored config document from explicit source-level write intent.
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { LEGACY_IMPLICIT_AGENT_ID } from "../routing/session-key.js";
import { isRecord } from "../utils.js";
import { collectChangedPaths } from "./config-change-paths.js";
import {
  applyConfigOperations,
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
      allowAgentRosterRemovals?: readonly string[];
    }
  | { kind: "replace"; config: OpenClawConfig; allowAgentRosterRemovals: true };

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

function preserveImplicitMainWhenMaterializingRoster(params: {
  snapshot: Pick<ConfigFileSnapshot, "parsed" | "sourceConfig" | "runtimeConfig">;
  authoredDocument: OpenClawConfig;
  intent: Extract<ConfigWriteIntent, { kind: "mutate" }>;
}): OpenClawConfig {
  const authoredEntries = readAuthoredAgentEntries(params.authoredDocument);
  const parsedEntries = readAuthoredAgentEntries(params.snapshot.parsed);
  const sourceEntries = readAuthoredAgentEntries(params.snapshot.sourceConfig);
  if (!authoredEntries || parsedEntries || sourceEntries) {
    return params.authoredDocument;
  }
  const runtimeEntries = readAuthoredAgentEntries(params.snapshot.runtimeConfig);
  const implicitMain = runtimeEntries?.[LEGACY_IMPLICIT_AGENT_ID];
  const removalAuthorized = (params.intent.allowAgentRosterRemovals ?? []).some(
    (agentId) => normalizeAgentId(agentId) === LEGACY_IMPLICIT_AGENT_ID,
  );
  const target = ["agents", "entries", LEGACY_IMPLICIT_AGENT_ID];
  const explicitlyRemovesMain = params.intent.operations.some((operation) => {
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
    return entries === null || (isRecord(entries) && entries[LEGACY_IMPLICIT_AGENT_ID] === null);
  });
  if (
    removalAuthorized &&
    explicitlyRemovesMain &&
    !Object.hasOwn(authoredEntries, LEGACY_IMPLICIT_AGENT_ID)
  ) {
    return params.authoredDocument;
  }
  if (
    !isRecord(implicitMain) ||
    implicitMain.default !== true ||
    Object.keys(runtimeEntries ?? {}).length !== 1
  ) {
    return params.authoredDocument;
  }
  // Once a mutation materializes the roster, the runtime-only main agent must
  // become authored too; otherwise adding the first named agent silently deletes it.
  const authoredDefaultExists = Object.values(authoredEntries).some(
    (entry) => isRecord(entry) && entry.default === true,
  );
  const authoredMain = isRecord(authoredEntries[LEGACY_IMPLICIT_AGENT_ID])
    ? authoredEntries[LEGACY_IMPLICIT_AGENT_ID]
    : {};
  return applyConfigOperations(params.authoredDocument, [
    {
      kind: "set",
      path: ["agents", "entries"],
      value: {
        ...authoredEntries,
        [LEGACY_IMPLICIT_AGENT_ID]: authoredDefaultExists
          ? structuredClone(authoredMain)
          : { ...structuredClone(authoredMain), default: true },
      },
    },
  ]);
}

function findImplicitAgentRemovals(params: {
  before: unknown;
  after: unknown;
  allowedAgentIds?: readonly string[];
}): string[] {
  const beforeEntries = readAuthoredAgentEntries(params.before);
  if (!beforeEntries) {
    return [];
  }
  const afterEntries = readAuthoredAgentEntries(params.after) ?? {};
  const afterIds = new Set(Object.keys(afterEntries).map((agentId) => normalizeAgentId(agentId)));
  const allowed = new Set(
    (params.allowedAgentIds ?? []).map((agentId) => normalizeAgentId(agentId)),
  );
  return Object.keys(beforeEntries)
    .filter(
      (agentId) =>
        !afterIds.has(normalizeAgentId(agentId)) && !allowed.has(normalizeAgentId(agentId)),
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
  const mandatoryUnsetOperations = (params.mandatoryUnsets ?? []).map(
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

  let authoredDocument =
    params.intent.kind === "replace"
      ? structuredClone(params.intent.config)
      : applyConfigOperations(params.snapshot.parsed, params.intent.operations);
  if (params.intent.kind === "mutate") {
    authoredDocument = preserveImplicitMainWhenMaterializingRoster({
      snapshot: params.snapshot,
      authoredDocument,
      intent: params.intent,
    });
    const droppedIds = findImplicitAgentRemovals({
      before: params.snapshot.parsed,
      after: authoredDocument,
      allowedAgentIds: params.intent.allowAgentRosterRemovals,
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
