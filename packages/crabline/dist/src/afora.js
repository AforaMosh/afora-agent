import { randomUUID } from "node:crypto";
import { CRABLINE_SERVER_CHANNELS, isCrablineServerChannel, startCrablineServer, } from "./servers/index.js";
import { SLACK_AFORA_CRABLINE_PROVIDER_BRIDGE } from "./afora/bridges/slack.js";
import { MATTERMOST_AFORA_CRABLINE_PROVIDER_BRIDGE } from "./afora/bridges/mattermost.js";
import { MATRIX_AFORA_CRABLINE_PROVIDER_BRIDGE } from "./afora/bridges/matrix.js";
import { SIGNAL_AFORA_CRABLINE_PROVIDER_BRIDGE } from "./afora/bridges/signal.js";
import { TELEGRAM_AFORA_CRABLINE_PROVIDER_BRIDGE } from "./afora/bridges/telegram.js";
import { WHATSAPP_AFORA_CRABLINE_PROVIDER_BRIDGE } from "./afora/bridges/whatsapp.js";
import { ZALO_AFORA_CRABLINE_PROVIDER_BRIDGE } from "./afora/bridges/zalo.js";
import { AFORA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH, AFORA_CRABLINE_CHANNEL_SMOKE_PATH, AFORA_CRABLINE_PROVIDER_READINESS_PATH, AFORA_CRABLINE_DEFAULT_CHANNEL, AFORA_CRABLINE_ARTIFACT_POINTER_PATH, AFORA_CRABLINE_ARTIFACT_STORE_DIRECTORY, AFORA_CRABLINE_MANIFEST_PATH, parseQaTarget, runAforaCrablineProviderProbe, } from "./afora/shared.js";
import { publishAforaCrablineArtifactGeneration } from "./afora/artifact-generation.js";
import { isAcceptedAforaCrablineOutbound } from "./afora/outbound-contract.js";
import { syncParentDirectory } from "./afora/private-file.js";
import { acquireAforaCrablineSmokeRunLock, releaseAforaCrablineSmokeRunLock, } from "./afora/smoke-lock.js";
import fs from "node:fs/promises";
import path from "node:path";
export { AFORA_CRABLINE_ARTIFACT_POINTER_PATH, AFORA_CRABLINE_ARTIFACT_STORE_DIRECTORY, AFORA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH, AFORA_CRABLINE_CHANNEL_SMOKE_PATH, AFORA_CRABLINE_PROVIDER_READINESS_PATH, AFORA_CRABLINE_DEFAULT_CHANNEL, AFORA_CRABLINE_MANIFEST_PATH, };
const AFORA_CRABLINE_PROVIDER_BRIDGES = {
    mattermost: MATTERMOST_AFORA_CRABLINE_PROVIDER_BRIDGE,
    matrix: MATRIX_AFORA_CRABLINE_PROVIDER_BRIDGE,
    signal: SIGNAL_AFORA_CRABLINE_PROVIDER_BRIDGE,
    slack: SLACK_AFORA_CRABLINE_PROVIDER_BRIDGE,
    telegram: TELEGRAM_AFORA_CRABLINE_PROVIDER_BRIDGE,
    whatsapp: WHATSAPP_AFORA_CRABLINE_PROVIDER_BRIDGE,
    zalo: ZALO_AFORA_CRABLINE_PROVIDER_BRIDGE,
};
const AFORA_CRABLINE_PROVIDER_BRIDGE_LIST = Object.values(AFORA_CRABLINE_PROVIDER_BRIDGES);
const RECORDER_TEMP_NAME_PATTERN = /^\.([a-z]+)-fake-provider\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl\.tmp$/iu;
const RECORDER_LOCK_REMOVAL_TOMBSTONE_PATTERN = /^\.(.+)\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.remove$/iu;
function isAforaCrablineRecorderTemporary(name) {
    const channel = RECORDER_TEMP_NAME_PATTERN.exec(name)?.[1]?.toLowerCase();
    return channel !== undefined && isCrablineServerChannel(channel);
}
function isAforaCrablineRecorderTemporaryLock(name) {
    return name.endsWith(".lock") && isAforaCrablineRecorderTemporary(name.slice(0, -5));
}
function aforaCrablineRecorderLockTombstoneBaseName(name) {
    const originalName = RECORDER_LOCK_REMOVAL_TOMBSTONE_PATTERN.exec(name)?.[1];
    return originalName !== undefined && isAforaCrablineRecorderTemporaryLock(originalName)
        ? originalName
        : null;
}
async function reclaimAforaCrablineRecorderTemporaryLock(directoryPath, name, lock, quarantineBaseName = name) {
    const lockPath = path.join(directoryPath, name);
    let identity;
    try {
        identity = await fs.lstat(lockPath, { bigint: true });
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return;
        }
        throw error;
    }
    if (!identity.isDirectory()) {
        return;
    }
    const currentUserId = process.geteuid?.();
    if (currentUserId !== undefined && identity.uid !== BigInt(currentUserId)) {
        return;
    }
    const quarantinePath = path.join(directoryPath, `.${quarantineBaseName}.${process.pid}.${randomUUID()}.remove`);
    await lock.assertOwned();
    try {
        await fs.rename(lockPath, quarantinePath);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return;
        }
        throw error;
    }
    const quarantined = await fs.lstat(quarantinePath, { bigint: true });
    if (!quarantined.isDirectory() ||
        quarantined.dev !== identity.dev ||
        quarantined.ino !== identity.ino) {
        throw new Error("Afora Crabline recorder lock identity changed during recovery.");
    }
    await syncParentDirectory(quarantinePath);
    await fs.rm(quarantinePath, { force: true, recursive: true });
    await syncParentDirectory(quarantinePath);
}
async function reclaimAforaCrablineRecorderTemporaries(directoryPath, lock) {
    for (const entry of await fs.readdir(directoryPath, { withFileTypes: true })) {
        const tombstoneBaseName = entry.isDirectory()
            ? aforaCrablineRecorderLockTombstoneBaseName(entry.name)
            : null;
        if (isAforaCrablineRecorderTemporaryLock(entry.name) || tombstoneBaseName !== null) {
            if (entry.isDirectory()) {
                await reclaimAforaCrablineRecorderTemporaryLock(directoryPath, entry.name, lock, tombstoneBaseName ?? entry.name);
            }
            continue;
        }
        if (!isAforaCrablineRecorderTemporary(entry.name) ||
            (!entry.isFile() && !entry.isSymbolicLink())) {
            continue;
        }
        await lock.assertOwned();
        const temporaryPath = path.join(directoryPath, entry.name);
        await fs.rm(temporaryPath, { force: true });
        await syncParentDirectory(temporaryPath);
    }
}
function createAforaCrablineProviderAdapter(manifest) {
    const bridge = AFORA_CRABLINE_PROVIDER_BRIDGE_LIST.find((candidate) => candidate.provider === manifest.provider);
    if (bridge) {
        const adapter = bridge.createAdapterFromManifest(manifest);
        return {
            ...adapter,
            createOutboundFromRecorderEvent: (params) => isAcceptedAforaCrablineOutbound({
                event: params.event,
                manifest,
            })
                ? adapter.createOutboundFromRecorderEvent(params)
                : null,
            probe: () => runAforaCrablineProviderProbe(manifest.provider, (signal) => adapter.probe(signal)),
        };
    }
    throw new Error("Unsupported Afora provider binding.");
}
export function resolveAforaCrablineChannel(input) {
    const channel = input === undefined || input === null
        ? AFORA_CRABLINE_DEFAULT_CHANNEL
        : input.trim().toLowerCase();
    if (isCrablineServerChannel(channel)) {
        return channel;
    }
    throw new Error(`--channel must be one of ${CRABLINE_SERVER_CHANNELS.join(", ")} for --channel-driver crabline, got "${input}".`);
}
export function resolveAforaCrablineChannelDriverSelection(params) {
    return {
        channel: resolveAforaCrablineChannel(params.channel),
        channelDriver: "crabline",
        capabilityMatrixPath: AFORA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH,
        providerReadinessArtifactPath: AFORA_CRABLINE_PROVIDER_READINESS_PATH,
        smokeArtifactPath: AFORA_CRABLINE_CHANNEL_SMOKE_PATH,
    };
}
export async function probeAforaCrablineProvider(manifest) {
    return await createAforaCrablineProviderAdapter(manifest).probe();
}
export function createAforaCrablineProviderBinding(manifest) {
    return createAforaCrablineProviderAdapter(manifest).createBinding();
}
export function createAforaCrablineAgentDelivery(params) {
    return createAforaCrablineProviderAdapter(params.manifest).createAgentDelivery(parseQaTarget(params.target));
}
export function createAforaCrablineInbound(params) {
    return createAforaCrablineProviderAdapter(params.manifest).createInbound(params.input);
}
export function createAforaCrablineOutboundFromRecorderEvent(params) {
    return createAforaCrablineProviderAdapter(params.manifest).createOutboundFromRecorderEvent({
        event: params.event,
        targetByProviderTarget: params.targetByProviderTarget,
    });
}
export async function startAforaCrablineAdapter(params, dependencies = {}) {
    const server = await (dependencies.startServer ?? startCrablineServer)({
        channel: params.channel,
        onEvent: params.onEvent,
        recorderPath: params.recorderPath,
    });
    try {
        const providerAdapter = (dependencies.createProviderAdapter ?? createAforaCrablineProviderAdapter)(server.manifest);
        const binding = providerAdapter.createBinding();
        return {
            ...binding,
            close: server.close,
            createGatewayConfig: (aforaConfig = params.aforaConfig ?? {}) => binding.createGatewayConfig(aforaConfig),
            createAgentDelivery: ({ target }) => providerAdapter.createAgentDelivery(parseQaTarget(target)),
            createInbound: ({ input }) => providerAdapter.createInbound(input),
            createOutboundFromRecorderEvent: ({ event, targetByProviderTarget }) => providerAdapter.createOutboundFromRecorderEvent({
                event,
                targetByProviderTarget,
            }),
            manifest: server.manifest,
            probe: () => providerAdapter.probe(),
        };
    }
    catch (error) {
        try {
            await server.close();
        }
        catch (closeError) {
            const aggregateError = new AggregateError([error, closeError], "Afora Crabline adapter startup failed.");
            aggregateError.cause = error;
            throw aggregateError;
        }
        throw error;
    }
}
export async function runAforaCrablineProviderReadiness(params, dependencies = {}) {
    const outputDir = path.resolve(params.outputDir);
    const releaseLock = dependencies.releaseLock ?? releaseAforaCrablineSmokeRunLock;
    const smokeLock = await (dependencies.acquireLock ?? acquireAforaCrablineSmokeRunLock)({
        channel: params.selection.channel,
        outputDir,
    });
    let outcome;
    let recorderPath;
    try {
        const recorderDirectory = path.join(outputDir, "artifacts", "crabline");
        await fs.mkdir(recorderDirectory, { recursive: true });
        await reclaimAforaCrablineRecorderTemporaries(recorderDirectory, smokeLock);
        recorderPath = path.join(recorderDirectory, `.${params.selection.channel}-fake-provider.${randomUUID()}.jsonl.tmp`);
        const adapter = await (dependencies.startAdapter ?? startAforaCrablineAdapter)({
            channel: params.selection.channel,
            aforaConfig: {},
            recorderPath,
        });
        let probe;
        let probeFailed = false;
        let probeFailure;
        try {
            probe = await adapter.probe();
        }
        catch (error) {
            probeFailed = true;
            probeFailure = error;
        }
        try {
            await adapter.close();
        }
        catch (cleanupError) {
            if (!probeFailed) {
                throw cleanupError;
            }
            if (probeFailure instanceof Error) {
                const existingCause = probeFailure.cause;
                try {
                    Object.defineProperty(probeFailure, "cause", {
                        configurable: true,
                        value: existingCause === undefined
                            ? cleanupError
                            : new AggregateError([existingCause, cleanupError], "Afora Crabline provider probe cleanup also failed."),
                    });
                }
                catch {
                    // Some provider errors are frozen; preserving the primary failure is authoritative.
                }
                throw probeFailure;
            }
            const combinedError = new Error("Afora Crabline provider probe and cleanup both failed.", {
                cause: cleanupError,
            });
            Object.defineProperty(combinedError, "errors", {
                value: [probeFailure, cleanupError],
            });
            throw combinedError;
        }
        if (probeFailed) {
            throw probeFailure;
        }
        let recorderSnapshotContents = "";
        try {
            recorderSnapshotContents = await fs.readFile(recorderPath, "utf8");
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
        const capabilityReport = {
            result: {
                driver: "crabline",
                selectedChannel: params.selection.channel,
                supportedChannels: [...CRABLINE_SERVER_CHANNELS],
            },
        };
        const providerReadiness = {
            result: {
                ok: true,
                proof: "provider-api-probe",
                ready: true,
                probe,
                provider: adapter.manifest.provider,
                endpoints: adapter.manifest.endpoints,
                recorderPath: path.relative(outputDir, adapter.manifest.recorderPath),
            },
        };
        const generation = await (dependencies.publishGeneration ?? publishAforaCrablineArtifactGeneration)({
            capabilityReport,
            lock: smokeLock,
            manifest: adapter.manifest,
            outputDir,
            recorderSnapshot: {
                contents: recorderSnapshotContents,
                fileName: `${params.selection.channel}-fake-provider.jsonl`,
            },
            selection: params.selection,
            providerReadiness,
        });
        let recorderCleanupWarning;
        try {
            await fs.rm(recorderPath, { force: true });
            recorderPath = undefined;
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            recorderCleanupWarning = `Afora Crabline recorder snapshot committed but temporary cleanup failed: ${detail}`;
        }
        outcome = {
            committed: true,
            result: {
                artifactPointerPath: generation.pointerPath,
                capabilityReport,
                capabilityMatrixPath: generation.capabilityMatrixPath,
                generation: generation.generation,
                manifestPath: generation.manifestPath,
                providerReadiness: generation.providerReadiness,
                providerReadinessArtifactPath: generation.providerReadinessArtifactPath,
                smoke: generation.providerReadiness,
                smokeArtifactPath: generation.providerReadinessArtifactPath,
                ...(generation.warnings || recorderCleanupWarning
                    ? {
                        warnings: [
                            ...(generation.warnings ?? []),
                            ...(recorderCleanupWarning ? [recorderCleanupWarning] : []),
                        ],
                    }
                    : {}),
            },
        };
    }
    catch (error) {
        let primaryError = error;
        if (recorderPath) {
            try {
                await fs.rm(recorderPath, { force: true });
                recorderPath = undefined;
            }
            catch (cleanupError) {
                if (primaryError instanceof Error) {
                    const existingCause = primaryError.cause;
                    try {
                        Object.defineProperty(primaryError, "cause", {
                            configurable: true,
                            value: existingCause === undefined
                                ? cleanupError
                                : new AggregateError([existingCause, cleanupError], "Afora Crabline readiness failure cleanup also failed."),
                        });
                    }
                    catch {
                        // Frozen failures remain authoritative even if temporary cleanup also fails.
                    }
                }
                else {
                    const combinedError = new Error("Afora Crabline readiness and temporary cleanup both failed.", { cause: cleanupError });
                    Object.defineProperty(combinedError, "errors", {
                        value: [primaryError, cleanupError],
                    });
                    primaryError = combinedError;
                }
            }
        }
        outcome = { committed: false, error: primaryError };
    }
    try {
        await releaseLock(smokeLock);
    }
    catch (cleanupError) {
        // The pointer switch is authoritative; lock removal cannot roll it back.
        if (!outcome.committed) {
            if (outcome.error instanceof Error) {
                const existingCause = outcome.error.cause;
                try {
                    Object.defineProperty(outcome.error, "cause", {
                        configurable: true,
                        value: existingCause === undefined
                            ? cleanupError
                            : new AggregateError([existingCause, cleanupError], "Afora Crabline smoke failure cleanup also failed."),
                    });
                }
                catch {
                    // Some failures are frozen; preserving the primary error is authoritative.
                }
                throw outcome.error;
            }
            const combinedError = new Error("Afora Crabline smoke and lock cleanup both failed.", {
                cause: cleanupError,
            });
            Object.defineProperty(combinedError, "errors", {
                value: [outcome.error, cleanupError],
            });
            throw combinedError;
        }
        const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        outcome.result = {
            ...outcome.result,
            warnings: [
                ...(outcome.result.warnings ?? []),
                `Afora Crabline smoke committed but lock cleanup failed: ${detail}`,
            ],
        };
    }
    if (!outcome.committed) {
        throw outcome.error;
    }
    return outcome.result;
}
/** @deprecated Use runAforaCrablineProviderReadiness. */
export const runAforaCrablineChannelDriverSmoke = runAforaCrablineProviderReadiness;
export function createAforaCrablineChannelReportNotes(selection) {
    if (!selection) {
        return [];
    }
    return [
        `Channel driver: ${selection.channelDriver} local provider for ${selection.channel}.`,
        `Channel artifact pointer: ${AFORA_CRABLINE_ARTIFACT_POINTER_PATH}.`,
        `Generation capability filename: ${selection.capabilityMatrixPath}.`,
        `Generation provider-readiness filename: ${selection.providerReadinessArtifactPath ?? selection.smokeArtifactPath}.`,
        "Crabline verifies the local provider API is ready; Afora channel behavior is proven separately by QA scenarios that run the real channel adapter.",
    ];
}
