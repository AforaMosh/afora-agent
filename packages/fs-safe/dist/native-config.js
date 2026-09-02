let overrideConfig = {};
let legacyWarningEmitted = false;
const legacyModeEnvKeys = ["FS_SAFE_PYTHON_MODE", "AFORA_FS_SAFE_PYTHON_MODE"];
const legacyPathEnvKeys = [
    "FS_SAFE_PYTHON",
    "AFORA_FS_SAFE_PYTHON",
    "AFORA_PINNED_PYTHON",
    "AFORA_PINNED_WRITE_PYTHON",
];
function parseMode(value) {
    if (!value) {
        return undefined;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "never") {
        return "off";
    }
    if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "auto") {
        return "auto";
    }
    if (normalized === "required" || normalized === "require") {
        return "require";
    }
    return undefined;
}
export function configureFsSafeNative(config) {
    overrideConfig = { ...overrideConfig, ...config };
}
function warnLegacyPythonConfiguration(source, mappedMode) {
    if (legacyWarningEmitted) {
        return;
    }
    legacyWarningEmitted = true;
    process.emitWarning(`${source} is a deprecated 0.4 compatibility bridge; mapped to native mode ` +
        `"${mappedMode}". Use configureFsSafeNative({ mode: "${mappedMode}" }) or ` +
        `FS_SAFE_NATIVE_MODE=${mappedMode}. Python interpreter paths are no longer used.`, { code: "FS_SAFE_PYTHON_DEPRECATED", type: "DeprecationWarning" });
}
function readLegacyPythonMode() {
    const configuredKeys = [...legacyModeEnvKeys, ...legacyPathEnvKeys].filter((key) => process.env[key] !== undefined);
    if (configuredKeys.length === 0) {
        return undefined;
    }
    const rawMode = legacyModeEnvKeys.map((key) => process.env[key]).find((value) => value !== undefined);
    const mappedMode = parseMode(rawMode) ?? "auto";
    warnLegacyPythonConfiguration(`Legacy ${configuredKeys.join(", ")}`, mappedMode);
    return mappedMode;
}
/**
 * @deprecated Compatibility bridge for 0.4 upgrades. Use configureFsSafeNative.
 */
export function configureFsSafePython(config) {
    const mappedMode = config.mode ?? "auto";
    warnLegacyPythonConfiguration("configureFsSafePython()", mappedMode);
    if (config.mode !== undefined) {
        configureFsSafeNative({ mode: config.mode });
    }
}
export function getFsSafeNativeConfig() {
    const legacyMode = readLegacyPythonMode();
    return {
        mode: overrideConfig.mode ??
            parseMode(process.env.FS_SAFE_NATIVE_MODE) ??
            parseMode(process.env.AFORA_FS_SAFE_NATIVE_MODE) ??
            legacyMode ??
            "auto",
    };
}
export function __resetFsSafeNativeConfigForTest() {
    overrideConfig = {};
    legacyWarningEmitted = false;
}
