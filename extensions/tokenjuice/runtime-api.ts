// Tokenjuice API module exposes the plugin public contract.
// afora-compat: "tokenjuice" is a third-party package; its host adapter lives at the ./openclaw
// export subpath and exports createTokenjuiceOpenClawEmbeddedExtension. Renaming either breaks
// resolution, so this seam is where the upstream name becomes the Afora one.
export { createTokenjuiceOpenClawEmbeddedExtension as createTokenjuiceAforaEmbeddedExtension } from "tokenjuice/openclaw";
