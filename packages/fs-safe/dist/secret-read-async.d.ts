import { type SecretFileReadOptions } from "./secret-file.js";
export declare function readSecretFile(filePath: string, label: string, options?: SecretFileReadOptions): Promise<string>;
export declare function tryReadSecretFile(filePath: string | undefined, label: string, options?: SecretFileReadOptions): Promise<string | undefined>;
