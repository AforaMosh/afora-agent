// Afora root resolution imports fs through this facade so tests can replace
// filesystem behavior without mocking node:fs globally.
export { default as aforaRootFsSync } from "node:fs"; // Sanctioned domain alias.
export { default as aforaRootFs } from "node:fs/promises"; // Sanctioned domain alias.
