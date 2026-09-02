//#region src/ghostty-assets.d.ts
type GhosttyAsset = {
  body: Uint8Array;
  contentType: string;
};
declare const GHOSTTY_ASSET_PATHS: {
  readonly module: "/vendor/ghostty-web.js";
  readonly wasm: "/vendor/ghostty-vt.wasm";
  readonly browserExternal: "/vendor/__vite-browser-external-2447137e.js";
};
//#endregion
export { GhosttyAsset as n, GHOSTTY_ASSET_PATHS as t };