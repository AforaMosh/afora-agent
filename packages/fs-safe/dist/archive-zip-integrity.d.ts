import { Transform } from "node:stream";
import { type ZipEntry } from "./archive-zip-entry.js";
export declare function normalizeZipIntegrityError(error: unknown): Error;
export declare function createZipIntegrityTransform(entry: ZipEntry): Transform;
