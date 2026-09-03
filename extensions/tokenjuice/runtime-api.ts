// Tokenjuice API module exposes the plugin public contract.
// "tokenjuice" is a third-party package whose host-adapter subpath and factory
// name are upstream's to choose, not ours. Renaming either breaks resolution,
// so this seam is where the upstream name becomes the Afora one and no other
// file in the tree has to know the upstream spelling.
// afora-compat: third-party export subpath ./openclaw.
// afora-compat: third-party export createTokenjuiceOpenClawEmbeddedExtension.
export { createTokenjuiceOpenClawEmbeddedExtension as createTokenjuiceAforaEmbeddedExtension } from "tokenjuice/openclaw"; // afora-compat
