export type ArchiveFormatErrorCode = "archive-header-invalid";
export type ArchiveSecurityErrorCode = "destination-not-directory" | "destination-symlink" | "destination-symlink-traversal" | "entry-filtered" | "entry-link" | "entry-path";
export declare class ArchiveSecurityError extends Error {
    readonly code: ArchiveSecurityErrorCode;
    constructor(code: ArchiveSecurityErrorCode, message: string, options?: ErrorOptions);
}
export declare class ArchiveFormatError extends Error {
    readonly code: ArchiveFormatErrorCode;
    constructor(message: string, options?: ErrorOptions);
}
export declare function isArchiveFormatErrorMessage(message: string): boolean;
