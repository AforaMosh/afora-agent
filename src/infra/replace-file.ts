// Wraps fs-safe atomic replacement and move helpers for Afora install flows.
import "./fs-safe-defaults.js";
import { replaceFileAtomic as replaceFileAtomicBase } from "@afora/fs-safe/atomic";

export {
  movePathWithCopyFallback,
  replaceDirectoryAtomic,
  replaceFileAtomicSync,
} from "@afora/fs-safe/atomic";

/** Atomic file replacement primitive re-exported through the fs-safe defaults shim. */
export const replaceFileAtomic = replaceFileAtomicBase;
