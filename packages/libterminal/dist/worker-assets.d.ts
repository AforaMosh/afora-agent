import { n as GhosttyAsset, t as GHOSTTY_ASSET_PATHS } from "./ghostty-assets-BTTeteW3.js";
//#region src/worker-assets.d.ts
declare function readGhosttyWorkerAsset(pathname: string): GhosttyAsset | null;
declare function createGhosttyAssetResponse(pathname: string, init?: ResponseInit): Response | null;
//#endregion
export { GHOSTTY_ASSET_PATHS, type GhosttyAsset, createGhosttyAssetResponse, readGhosttyWorkerAsset };