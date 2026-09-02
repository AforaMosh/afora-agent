import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { captureDirectoryIdentity, publishPrivateFileAtomically, removeSecuredPrivateDirectory, securePrivateDirectory, syncParentDirectory, } from "./private-file.js";
import { AFORA_CRABLINE_ARTIFACT_POINTER_PATH, AFORA_CRABLINE_ARTIFACT_STORE_DIRECTORY, AFORA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH, AFORA_CRABLINE_CHANNEL_SMOKE_PATH, AFORA_CRABLINE_PROVIDER_READINESS_PATH, AFORA_CRABLINE_MANIFEST_PATH, } from "./shared.js";
const GENERATION_NAME_PATTERN = /^generation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const STAGING_NAME_PATTERN = /^\.staging-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const REMOVAL_TOMBSTONE_PATTERN = /^\.(.+)\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.remove$/iu;
function resolveProviderReadinessArtifactPath(selection) {
    const readinessPath = selection.providerReadinessArtifactPath ?? selection.smokeArtifactPath;
    if (selection.capabilityMatrixPath !== AFORA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH ||
        readinessPath !== AFORA_CRABLINE_PROVIDER_READINESS_PATH) {
        throw new Error("Afora Crabline artifact selection paths are malformed.");
    }
    return readinessPath;
}
function isMissingPathError(error) {
    return error.code === "ENOENT";
}
function assertGenerationName(value, field) {
    if (typeof value !== "string" || !GENERATION_NAME_PATTERN.test(value)) {
        throw new Error(`Afora Crabline artifact pointer ${field} is malformed.`);
    }
}
function generationArtifactPath(generation, fileName) {
    return path.join(AFORA_CRABLINE_ARTIFACT_STORE_DIRECTORY, generation, fileName);
}
function artifactRemovalTombstoneBaseName(name) {
    const originalName = REMOVAL_TOMBSTONE_PATTERN.exec(name)?.[1];
    return originalName !== undefined &&
        (GENERATION_NAME_PATTERN.test(originalName) || STAGING_NAME_PATTERN.test(originalName))
        ? originalName
        : null;
}
function withRecorderSnapshotPath(providerReadiness, recorderPath) {
    const result = providerReadiness.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("Afora Crabline provider readiness result is malformed.");
    }
    return {
        ...providerReadiness,
        result: {
            ...result,
            recorderPath,
        },
    };
}
function parseArtifactPointer(contents) {
    let value;
    try {
        value = JSON.parse(contents);
    }
    catch (error) {
        throw new Error("Afora Crabline artifact pointer is malformed.", { cause: error });
    }
    if (value.version !== 1) {
        throw new Error("Afora Crabline artifact pointer is malformed.");
    }
    assertGenerationName(value.generation, "generation");
    if (value.previousGeneration !== undefined) {
        assertGenerationName(value.previousGeneration, "previousGeneration");
        if (value.previousGeneration === value.generation) {
            throw new Error("Afora Crabline artifact pointer is malformed.");
        }
    }
    const expected = {
        capabilityMatrixPath: generationArtifactPath(value.generation, AFORA_CRABLINE_CHANNEL_CAPABILITY_MATRIX_PATH),
        manifestPath: generationArtifactPath(value.generation, AFORA_CRABLINE_MANIFEST_PATH),
        providerReadinessArtifactPath: generationArtifactPath(value.generation, AFORA_CRABLINE_PROVIDER_READINESS_PATH),
        smokeArtifactPath: generationArtifactPath(value.generation, AFORA_CRABLINE_CHANNEL_SMOKE_PATH),
    };
    if (typeof value.capabilityMatrixPath !== "string" ||
        value.capabilityMatrixPath !== expected.capabilityMatrixPath ||
        value.manifestPath !== expected.manifestPath ||
        (value.providerReadinessArtifactPath !== undefined &&
            value.providerReadinessArtifactPath !== expected.providerReadinessArtifactPath) ||
        (value.smokeArtifactPath !== undefined &&
            value.smokeArtifactPath !== expected.smokeArtifactPath) ||
        (value.providerReadinessArtifactPath === undefined && value.smokeArtifactPath === undefined)) {
        throw new Error("Afora Crabline artifact pointer is malformed.");
    }
    return {
        capabilityMatrixPath: value.capabilityMatrixPath,
        generation: value.generation,
        ...(value.previousGeneration ? { previousGeneration: value.previousGeneration } : {}),
        manifestPath: value.manifestPath,
        providerReadinessArtifactPath: value.providerReadinessArtifactPath ?? value.smokeArtifactPath,
        smokeArtifactPath: value.smokeArtifactPath ?? value.providerReadinessArtifactPath,
        version: 1,
    };
}
export async function readAforaCrablineArtifactPointer(outputDir) {
    try {
        return parseArtifactPointer(await fs.readFile(path.join(path.resolve(outputDir), AFORA_CRABLINE_ARTIFACT_POINTER_PATH), "utf8"));
    }
    catch (error) {
        if (isMissingPathError(error)) {
            return null;
        }
        throw error;
    }
}
async function assertCurrentGenerationExists(outputDir, pointer) {
    for (const artifactPath of [
        pointer.manifestPath,
        pointer.capabilityMatrixPath,
        pointer.providerReadinessArtifactPath,
    ]) {
        const stats = await fs.lstat(path.join(outputDir, artifactPath));
        if (!stats.isFile()) {
            throw new Error("Afora Crabline current artifact generation is incomplete.");
        }
    }
}
async function pruneArtifactStore(params) {
    const retainedGenerations = new Set(params.pointer
        ? [params.pointer.generation, params.pointer.previousGeneration].filter((generation) => generation !== undefined)
        : []);
    for (const entry of await fs.readdir(params.store.directoryPath, { withFileTypes: true })) {
        const isAbandonedStaging = entry.isDirectory() && STAGING_NAME_PATTERN.test(entry.name);
        const isObsoleteGeneration = entry.isDirectory() &&
            GENERATION_NAME_PATTERN.test(entry.name) &&
            !retainedGenerations.has(entry.name);
        const removalTombstoneBaseName = entry.isDirectory()
            ? artifactRemovalTombstoneBaseName(entry.name)
            : null;
        const isRemovalTombstone = removalTombstoneBaseName !== null;
        if (!isAbandonedStaging && !isObsoleteGeneration && !isRemovalTombstone) {
            continue;
        }
        await params.lock.assertOwned();
        await params.store.assertIdentityAt();
        const obsolete = await securePrivateDirectory(path.join(params.store.directoryPath, entry.name), params.directoryOptions);
        await removeSecuredPrivateDirectory(obsolete, undefined, removalTombstoneBaseName ?? entry.name);
        await params.store.assertIdentityAt();
    }
}
export async function publishAforaCrablineArtifactGeneration(params, dependencies = {}) {
    const providerReadinessArtifactPath = resolveProviderReadinessArtifactPath(params.selection);
    const outputDir = path.resolve(params.outputDir);
    await fs.mkdir(outputDir, { recursive: true });
    const output = await captureDirectoryIdentity(outputDir);
    await output.assertIdentityAt();
    const storePath = path.join(outputDir, AFORA_CRABLINE_ARTIFACT_STORE_DIRECTORY);
    const directoryOptions = {
        ...(dependencies.platform ? { platform: dependencies.platform } : {}),
        ...(dependencies.secureWindowsDirectory
            ? { secureWindowsDirectory: dependencies.secureWindowsDirectory }
            : {}),
        ...(dependencies.syncParent ? { syncParent: dependencies.syncParent } : {}),
    };
    const store = await securePrivateDirectory(storePath, directoryOptions);
    await output.assertIdentityAt();
    await store.assertIdentityAt();
    await params.lock.assertOwned();
    const currentPointer = await readAforaCrablineArtifactPointer(outputDir);
    await output.assertIdentityAt();
    await store.assertIdentityAt();
    if (currentPointer) {
        await assertCurrentGenerationExists(outputDir, currentPointer);
        await output.assertIdentityAt();
        await store.assertIdentityAt();
    }
    await pruneArtifactStore({
        directoryOptions,
        lock: params.lock,
        pointer: currentPointer,
        store,
    });
    await output.assertIdentityAt();
    await store.assertIdentityAt();
    const generationId = dependencies.createGenerationId?.() ?? randomUUID();
    const generation = `generation-${generationId}`;
    if (!GENERATION_NAME_PATTERN.test(generation)) {
        throw new Error("Afora Crabline artifact generation id is malformed.");
    }
    const stagingPath = path.join(storePath, `.staging-${generationId}`);
    const generationPath = path.join(storePath, generation);
    const staging = await securePrivateDirectory(stagingPath, directoryOptions);
    await output.assertIdentityAt();
    await store.assertIdentityAt();
    await staging.assertIdentityAt();
    const publishPrivateFile = dependencies.publishPrivateFile ?? publishPrivateFileAtomically;
    const fileOptions = {
        ...(dependencies.platform ? { platform: dependencies.platform } : {}),
        ...(dependencies.secureWindowsFile
            ? { secureWindowsFile: dependencies.secureWindowsFile }
            : {}),
        ...(dependencies.syncParent ? { syncParent: dependencies.syncParent } : {}),
    };
    let installed = false;
    let committed = false;
    let primaryError;
    let published;
    try {
        const pointer = {
            capabilityMatrixPath: generationArtifactPath(generation, params.selection.capabilityMatrixPath),
            generation,
            manifestPath: generationArtifactPath(generation, AFORA_CRABLINE_MANIFEST_PATH),
            ...(currentPointer ? { previousGeneration: currentPointer.generation } : {}),
            providerReadinessArtifactPath: generationArtifactPath(generation, providerReadinessArtifactPath),
            smokeArtifactPath: generationArtifactPath(generation, providerReadinessArtifactPath),
            version: 1,
        };
        if (params.recorderSnapshot &&
            (path.basename(params.recorderSnapshot.fileName) !== params.recorderSnapshot.fileName ||
                !params.recorderSnapshot.fileName.endsWith(".jsonl"))) {
            throw new Error("Afora Crabline recorder snapshot filename is malformed.");
        }
        const recorderSnapshotPath = params.recorderSnapshot
            ? generationArtifactPath(generation, params.recorderSnapshot.fileName)
            : undefined;
        const publishedManifest = recorderSnapshotPath
            ? { ...params.manifest, recorderPath: recorderSnapshotPath }
            : params.manifest;
        const providerReadinessBase = recorderSnapshotPath
            ? withRecorderSnapshotPath(params.providerReadiness, recorderSnapshotPath)
            : params.providerReadiness;
        const providerReadiness = {
            ...providerReadinessBase,
            manifestPath: pointer.manifestPath,
        };
        const artifactContents = [
            {
                contents: `${JSON.stringify(publishedManifest, null, 2)}\n`,
                fileName: AFORA_CRABLINE_MANIFEST_PATH,
            },
            {
                contents: `${JSON.stringify({
                    version: 1,
                    source: "afora/crabline",
                    channelDriver: params.selection.channelDriver,
                    selectedChannel: params.selection.channel,
                    manifestPath: pointer.manifestPath,
                    report: params.capabilityReport,
                }, null, 2)}\n`,
                fileName: params.selection.capabilityMatrixPath,
            },
            {
                contents: `${JSON.stringify({
                    version: 1,
                    source: "afora/crabline",
                    channelDriver: params.selection.channelDriver,
                    selectedChannel: params.selection.channel,
                    manifestPath: pointer.manifestPath,
                    providerReadiness,
                    smoke: providerReadiness,
                }, null, 2)}\n`,
                fileName: providerReadinessArtifactPath,
            },
            ...(params.recorderSnapshot
                ? [
                    {
                        contents: params.recorderSnapshot.contents,
                        fileName: params.recorderSnapshot.fileName,
                    },
                ]
                : []),
        ];
        await params.lock.assertOwned();
        for (const artifact of artifactContents) {
            await output.assertIdentityAt();
            await store.assertIdentityAt();
            await staging.assertIdentityAt();
            await publishPrivateFile(path.join(stagingPath, artifact.fileName), artifact.contents, fileOptions);
            await output.assertIdentityAt();
            await store.assertIdentityAt();
            await staging.assertIdentityAt();
        }
        await params.lock.assertOwned();
        await output.assertIdentityAt();
        await store.assertIdentityAt();
        await fs.rename(stagingPath, generationPath);
        installed = true;
        await (dependencies.syncParent ?? syncParentDirectory)(generationPath, dependencies.platform);
        await output.assertIdentityAt();
        await staging.assertIdentityAt(generationPath);
        await store.assertIdentityAt();
        await dependencies.beforePointerSwitch?.(pointer);
        await output.assertIdentityAt();
        await store.assertIdentityAt();
        await staging.assertIdentityAt(generationPath);
        await params.lock.commitFileAtomically({
            contents: `${JSON.stringify(pointer, null, 2)}\n`,
            destinationPath: path.join(outputDir, AFORA_CRABLINE_ARTIFACT_POINTER_PATH),
            stageDirectory: store.directoryPath,
            stageFile: async (filePath, contents) => {
                await output.assertIdentityAt();
                await store.assertIdentityAt();
                await staging.assertIdentityAt(generationPath);
                await publishPrivateFile(filePath, contents, fileOptions);
                await output.assertIdentityAt();
                await store.assertIdentityAt();
                await staging.assertIdentityAt(generationPath);
            },
        });
        committed = true;
        let warnings;
        try {
            const committedPointer = await readAforaCrablineArtifactPointer(outputDir);
            if (!committedPointer) {
                throw new Error("Afora Crabline artifact pointer is missing after publication.");
            }
            await pruneArtifactStore({
                directoryOptions,
                lock: params.lock,
                pointer: committedPointer,
                store,
            });
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            warnings = [`Afora Crabline artifact retention cleanup failed: ${detail}`];
        }
        published = {
            ...pointer,
            pointerPath: AFORA_CRABLINE_ARTIFACT_POINTER_PATH,
            providerReadiness,
            smoke: providerReadiness,
            ...(warnings ? { warnings } : {}),
        };
    }
    catch (error) {
        primaryError = error;
    }
    if (!committed) {
        const unpublishedPath = installed ? generationPath : stagingPath;
        let referencedByPointer = false;
        if (installed) {
            try {
                const livePointer = await readAforaCrablineArtifactPointer(outputDir);
                referencedByPointer =
                    livePointer?.generation === generation || livePointer?.previousGeneration === generation;
            }
            catch {
                referencedByPointer = true;
            }
        }
        if (!referencedByPointer) {
            try {
                await removeSecuredPrivateDirectory(staging, unpublishedPath);
            }
            catch (cleanupError) {
                if (primaryError !== undefined) {
                    const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
                    const aggregateError = new AggregateError([primaryError, cleanupError], `${primaryMessage} Afora Crabline artifact rollback cleanup also failed.`);
                    aggregateError.cause = primaryError;
                    const primaryCode = primaryError.code;
                    if (primaryCode) {
                        Object.assign(aggregateError, { code: primaryCode });
                    }
                    throw aggregateError;
                }
                throw cleanupError;
            }
        }
    }
    if (primaryError !== undefined) {
        throw primaryError;
    }
    return published;
}
