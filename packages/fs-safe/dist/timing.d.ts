export declare function sleep(ms: number): Promise<void>;
export declare function sleepSync(ms: number): void;
export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, labelOrOptions?: string | {
    label?: string;
    message?: string;
    createError?: () => Error;
}): Promise<T>;
