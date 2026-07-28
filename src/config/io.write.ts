import type fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isVerbose } from "../global-state.js";
import { isVitestRuntimeEnv } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import { replaceFileAtomic } from "../infra/replace-file.js";
import { maintainConfigBackups } from "./backup-rotation.js";
import { collectChangedPaths } from "./config-change-paths.js";
import {
  configSnapshotAuditRecordMatchesPath,
  fingerprintConfigSnapshotAuthoredConfig,
  readLatestConfigSnapshotAuditRecord,
  restoreConfigSnapshotAuditRecord,
  upsertConfigSnapshotAuditRecord,
} from "./config-journal-snapshot.js";
import { resolveManagedUnsetPathsForWrite } from "./config-path-mutation.js";
import { INCLUDE_KEY } from "./includes.js";
import {
  appendConfigAuditRecord,
  capConfigAuditIssues,
  capConfigAuditPaths,
  createConfigWriteAuditRecordBase,
  finalizeConfigWriteAuditRecord,
  formatConfigOverwriteLogMessage,
  type ConfigWriteAuditResult,
} from "./io.audit.js";
import type { ConfigIoContext } from "./io.context.js";
import { recordConfigWriteMetadata } from "./io.meta.js";
import {
  hashConfigRaw,
  hasConfigMeta,
  resolveConfigIncludesForRead,
  resolveConfigSnapshotHash,
  resolveGatewayMode,
  restoreAuthoredTildePathsForWrite,
} from "./io.read-helpers.js";
import { loggedConfigWarningFingerprints, setBoundedConfigIoWarningEntry } from "./io.state.js";
import type {
  ConfigWriteOptions,
  InternalConfigWriteResult,
  ReadConfigFileSnapshotInternalResult,
} from "./io.types.js";
import { ConfigRuntimeRefreshError, configWritePostCommitRollback } from "./io.types.js";
import { logConfigWarningsOnce } from "./io.warnings.js";
import { formatConfigValidationFailure, formatConfigWriteRejection } from "./io.write-errors.js";
import { prepareConfigWrite, type ConfigWriteIntent } from "./io.write-plan.js";
import {
  assertBaseSnapshotStillCurrent,
  formatConfigArtifactTimestamp,
  resolveConfigSizeBaselineBytes,
  resolveConfigStatMetadata,
  resolveConfigWriteBlockingReasons,
  resolveConfigWriteSuspiciousReasons,
  rollbackConfigFileWriteIfUnchanged,
  stampConfigVersion,
  tightenStateDirPermissionsIfNeeded,
} from "./io.write-safety.js";
import { formatConfigIssueLines } from "./issue-format.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import { assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard.js";
import { preflightRuntimeSnapshotWrite } from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";

function hasOwnIncludeDirective(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.hasOwn(value, INCLUDE_KEY);
}

function hasIncludedGatewayModeOwner(value: unknown): boolean {
  if (hasOwnIncludeDirective(value)) {
    return true;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const gateway = (value as Record<string, unknown>).gateway;
  if (hasOwnIncludeDirective(gateway)) {
    return true;
  }
  if (gateway === null || typeof gateway !== "object" || Array.isArray(gateway)) {
    return false;
  }
  return hasOwnIncludeDirective((gateway as Record<string, unknown>).mode);
}

export async function writeConfigFileFromContext(
  context: ConfigIoContext,
  intent: ConfigWriteIntent,
  options: ConfigWriteOptions,
  readSnapshot: () => Promise<ReadConfigFileSnapshotInternalResult>,
): Promise<InternalConfigWriteResult> {
  const { deps, configPath } = context;
  options.assertConfigPathForWrite?.();
  assertConfigWriteAllowedInCurrentMode({ configPath, env: deps.env });
  const snapshotRead = options.baseSnapshot
    ? {
        snapshot: options.baseSnapshot,
        pluginMetadataSnapshot: options.basePluginMetadataSnapshot,
      }
    : await readSnapshot();
  const snapshot = snapshotRead.snapshot;
  if (options.baseSnapshot) {
    assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
  }
  if (!snapshot.valid && intent.kind === "mutate") {
    throw new Error(
      `Config is invalid; run \`openclaw doctor --fix\` before applying source mutations to ${configPath}.`,
    );
  }
  const prepared = prepareConfigWrite({
    snapshot,
    intent,
    mandatoryUnsets: resolveManagedUnsetPathsForWrite(undefined),
  });
  if (!prepared.ok) {
    throw new Error(formatConfigWriteRejection(prepared.error));
  }
  const cfg = prepared.value.authoredDocument;
  const persistCandidate: unknown = cfg;
  const changedPaths = new Set(prepared.value.changedPaths);
  const validationCandidate = context.resolveRuntimePreflightSourceConfig(
    persistCandidate as OpenClawConfig,
  );
  const validated = validateConfigObjectRawWithPlugins(validationCandidate, {
    env: deps.env,
    pluginValidation: options.skipPluginValidation ? "skip" : "full",
    preservedLegacyRootKeys: options.preservedLegacyRootKeys,
  });
  if (!validated.ok) {
    const issue = validated.issues[0];
    throw new Error(
      formatConfigValidationFailure(issue?.path || "<root>", issue?.message ?? "invalid"),
    );
  }
  const previousWarningFingerprint = loggedConfigWarningFingerprints.get(configPath);
  // Capture before commit so rollback cannot restore a watcher-updated slot.
  const priorSnapshotAuditRecord = readLatestConfigSnapshotAuditRecord({
    env: deps.env,
    homedir: deps.homedir,
  });

  const cfgToWrite = persistCandidate as OpenClawConfig;

  await deps.fs.promises.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await tightenStateDirPermissionsIfNeeded({
    configPath,
    env: deps.env,
    homedir: deps.homedir,
    fsModule: deps.fs,
  });
  const tildeRestoredOutputConfig = restoreAuthoredTildePathsForWrite(
    cfgToWrite,
    snapshot.parsed,
    undefined,
    deps.homedir(),
  ) as OpenClawConfig;
  const stampedOutputConfig = stampConfigVersion(
    tildeRestoredOutputConfig,
    options.lastTouchedVersionOverride,
    snapshot.exists ? snapshot.parsed : null,
  );
  const json = JSON.stringify(stampedOutputConfig, null, 2).trimEnd().concat("\n");
  const nextHash = hashConfigRaw(json);
  const previousHash = resolveConfigSnapshotHash(snapshot);
  const changedPathCount = changedPaths.size;
  const previousBytes =
    typeof snapshot.raw === "string" ? Buffer.byteLength(snapshot.raw, "utf-8") : null;
  const sizeBaselineBytes = resolveConfigSizeBaselineBytes({
    raw: snapshot.raw,
    json5: deps.json5,
    lastTouchedVersionOverride: options.lastTouchedVersionOverride,
  });
  const nextBytes = Buffer.byteLength(json, "utf-8");
  const previousStat = snapshot.exists
    ? await deps.fs.promises.stat(configPath).catch(() => null)
    : null;
  const hasMetaBefore = hasConfigMeta(snapshot.parsed);
  const hasMetaAfter = hasConfigMeta(stampedOutputConfig);
  const gatewayModeBefore = resolveGatewayMode(snapshot.resolved);
  // This is destructive-write detection, not reload policy. A surviving include
  // still supplies mode when a local gateway sibling changes; preflight/reload owns activation.
  const preservesIncludedGatewayMode =
    gatewayModeBefore != null && hasIncludedGatewayModeOwner(stampedOutputConfig);
  const gatewayModeAfter =
    resolveGatewayMode(stampedOutputConfig) ??
    (preservesIncludedGatewayMode ? gatewayModeBefore : null) ??
    null;
  const suspiciousReasons = resolveConfigWriteSuspiciousReasons({
    existsBefore: snapshot.exists,
    unreadableBefore: snapshot.readError != null,
    sizeBaselineBytes,
    nextBytes,
    hasMetaBefore,
    gatewayModeBefore,
    gatewayModeAfter,
  });

  const readTestLogFlag = (name: string) => isVitestRuntimeEnv(deps.env) && deps.env[name] === "1";
  const logConfigOverwrite = () => {
    if (
      !snapshot.exists ||
      options.skipOutputLogs ||
      (isVitestRuntimeEnv(deps.env) && !readTestLogFlag("OPENCLAW_TEST_CONFIG_WRITE_LOG"))
    ) {
      return;
    }
    const testLog = readTestLogFlag("OPENCLAW_TEST_CONFIG_WRITE_LOG");
    if (!isVerbose() && deps.env.OPENCLAW_CONFIG_OVERWRITE_LOG !== "1" && !testLog) {
      return;
    }
    deps.logger.warn(
      formatConfigOverwriteLogMessage({
        configPath,
        previousHash: previousHash ?? null,
        nextHash,
        changedPathCount,
      }),
    );
  };
  const logConfigWriteAnomalies = () => {
    const testLog = readTestLogFlag("OPENCLAW_TEST_CONFIG_WRITE_LOG");
    if (
      suspiciousReasons.length === 0 ||
      options.skipOutputLogs ||
      (isVitestRuntimeEnv(deps.env) && !testLog)
    ) {
      return;
    }
    const showMissingMeta =
      isVerbose() || deps.env.OPENCLAW_CONFIG_WRITE_ANOMALY_LOG === "1" || testLog;
    const visibleReasons = showMissingMeta
      ? suspiciousReasons
      : suspiciousReasons.filter((reason) => reason !== "missing-meta-before-write");
    if (visibleReasons.length > 0) {
      deps.logger.warn(`Config write anomaly: ${configPath} (${visibleReasons.join(", ")})`);
    }
  };

  const auditRecordBase = createConfigWriteAuditRecordBase({
    configPath,
    env: deps.env,
    existsBefore: snapshot.exists,
    previousHash: previousHash ?? null,
    nextHash,
    previousBytes,
    nextBytes,
    previousMetadata: resolveConfigStatMetadata(previousStat),
    changedPathCount,
    changedPaths: [...changedPaths],
    origin: options.auditOrigin,
    hasMetaBefore,
    hasMetaAfter,
    gatewayModeBefore,
    gatewayModeAfter,
    suspicious: suspiciousReasons,
  });
  const appendWriteAudit = async (
    result: ConfigWriteAuditResult,
    error?: unknown,
    nextStat?: fs.Stats | null,
  ) => {
    await appendConfigAuditRecord({
      env: deps.env,
      homedir: deps.homedir,
      record: finalizeConfigWriteAuditRecord({
        base: auditRecordBase,
        result,
        err: error,
        nextMetadata: resolveConfigStatMetadata(nextStat ?? null),
      }),
    });
  };
  const blockingReasons = resolveConfigWriteBlockingReasons(suspiciousReasons, options);
  if (blockingReasons.length > 0 && options.allowDestructiveWrite !== true) {
    const rejectedPath = `${configPath}.rejected.${formatConfigArtifactTimestamp(new Date().toISOString())}`;
    await deps.fs.promises
      .writeFile(rejectedPath, json, { encoding: "utf-8", mode: 0o600, flag: "wx" })
      .catch(() => {});
    const message = `Config write rejected: ${configPath} (${blockingReasons.join(", ")}). Rejected payload saved to ${rejectedPath}.`;
    const error = Object.assign(new Error(message), {
      code: "CONFIG_WRITE_REJECTED",
      rejectedPath,
      reasons: blockingReasons,
    });
    deps.logger.warn(message);
    await appendWriteAudit("rejected", error);
    throw error;
  }

  const preCommitRuntimePreflight =
    options.preCommitRuntimePreflight ??
    (async (sourceConfig: OpenClawConfig) => {
      await preflightRuntimeSnapshotWrite({
        nextSourceConfig: sourceConfig,
        refreshOptions: options.runtimeRefresh,
        formatRefreshError: (error) => formatErrorMessage(error),
        createRefreshError: (detail, cause) =>
          new ConfigRuntimeRefreshError(
            `Config write blocked before committing ${configPath}: active SecretRef resolution failed: ${detail}`,
            { cause },
          ),
      });
    });
  const sourceConfigForPreflight = context.resolveRuntimePreflightSourceConfig(stampedOutputConfig);
  const captureIncludeGraph = () => {
    const hashes: Record<string, string> = {};
    const targets: Record<string, string> = {};
    resolveConfigIncludesForRead(stampedOutputConfig, configPath, deps, hashes, targets);
    return { hashes, targets };
  };
  const committedIncludeGraph = captureIncludeGraph();
  await preCommitRuntimePreflight(sourceConfigForPreflight);

  try {
    const result = await replaceFileAtomic({
      filePath: configPath,
      content: json,
      dirMode: 0o700,
      mode: 0o600,
      tempPrefix: path.basename(configPath),
      copyFallbackOnPermissionError: true,
      fileSystem: deps.fs,
      beforeRename: async () => {
        options.assertConfigPathForWrite?.();
        if (options.baseSnapshot) {
          assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
        }
        if (deps.fs.existsSync(configPath)) {
          await maintainConfigBackups(configPath, deps.fs.promises);
        }
        if (options.baseSnapshot) {
          assertBaseSnapshotStillCurrent(snapshot, configPath, deps.fs);
        }
        options.assertConfigPathForWrite?.();
        const finalIncludeGraph = captureIncludeGraph();
        if (!isDeepStrictEqual(finalIncludeGraph, committedIncludeGraph)) {
          throw new ConfigMutationConflictError("included config changed while preparing write", {
            currentHash: null,
          });
        }
        // Warn only after final guards pass, with no later await before rename.
        warnIfJSON5CommentsWillBeStripped({
          raw: snapshot.raw,
          filePath: configPath,
          warn: (message) => deps.logger.warn(message),
          skipOutputLogs: options.skipOutputLogs,
        });
      },
    });
    try {
      options.assertConfigPathForWrite?.();
    } catch (error) {
      try {
        await rollbackConfigFileWriteIfUnchanged({
          configPath,
          previousSnapshot: snapshot,
          committedHash: nextHash,
          fsModule: deps.fs,
        });
      } catch (rollbackError) {
        throw new ConfigRuntimeRefreshError(
          `${formatErrorMessage(error)} Rollback failed: ${formatErrorMessage(rollbackError)}`,
          { cause: error },
        );
      }
      throw error;
    }
    try {
      recordConfigWriteMetadata(new Date().toISOString(), options.lastTouchedVersionOverride);
    } catch (error) {
      deps.logger.warn(`Config metadata state update failed: ${formatErrorMessage(error)}`);
    }
    logConfigOverwrite();
    logConfigWriteAnomalies();
    await appendWriteAudit(
      result.method,
      undefined,
      await deps.fs.promises.stat(configPath).catch(() => null),
    );
    if (
      configSnapshotAuditRecordMatchesPath(priorSnapshotAuditRecord, configPath) &&
      priorSnapshotAuditRecord.rawHash !== previousHash
    ) {
      const offlineChangedPaths = new Set<string>();
      collectChangedPaths(
        priorSnapshotAuditRecord.fingerprintedAuthoredConfig,
        fingerprintConfigSnapshotAuthoredConfig(snapshot.parsed, {
          env: deps.env,
          homedir: deps.homedir,
        }),
        "",
        offlineChangedPaths,
      );
      await appendConfigAuditRecord({
        env: deps.env,
        homedir: deps.homedir,
        record: {
          ts: new Date().toISOString(),
          source: "config-io",
          event: "config.external",
          detectedBy: "write",
          configPath,
          previousHash: priorSnapshotAuditRecord.rawHash,
          nextHash: previousHash ?? null,
          valid: snapshot.valid,
          ...(snapshot.valid
            ? offlineChangedPaths.size > 0
              ? { changedPaths: capConfigAuditPaths([...offlineChangedPaths]) }
              : { opaqueChange: true }
            : {
                issues: capConfigAuditIssues(
                  formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }),
                ),
              }),
        },
      });
    }
    const writtenSnapshotAuditRecord = upsertConfigSnapshotAuditRecord({
      env: deps.env,
      homedir: deps.homedir,
      configPath,
      rawHash: nextHash,
      authoredConfig: stampedOutputConfig,
      expectedSnapshot: priorSnapshotAuditRecord,
    });
    if (!options.skipPluginValidation) {
      logConfigWarningsOnce({ configPath, warnings: validated.warnings, logger: deps.logger });
    }
    return {
      persistedHash: nextHash,
      persistedConfig: stampedOutputConfig,
      committedIncludeFileHashes: committedIncludeGraph.hashes,
      committedIncludeFileTargets: committedIncludeGraph.targets,
      [configWritePostCommitRollback]: () => {
        restoreConfigSnapshotAuditRecord({
          env: deps.env,
          homedir: deps.homedir,
          snapshot: priorSnapshotAuditRecord,
          expectedSnapshot: writtenSnapshotAuditRecord,
        });
        if (previousWarningFingerprint === undefined) {
          loggedConfigWarningFingerprints.delete(configPath);
        } else {
          setBoundedConfigIoWarningEntry(
            loggedConfigWarningFingerprints,
            configPath,
            previousWarningFingerprint,
          );
        }
      },
    };
  } catch (error) {
    await appendWriteAudit("failed", error);
    throw error;
  }
}
