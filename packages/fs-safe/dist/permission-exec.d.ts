export declare const DEFAULT_PERMISSION_EXEC_TIMEOUT_MS = 30000;
export declare function executePermissionCommand(command: string, args: string[], timeoutMs?: number): Promise<{
    stdout: string;
    stderr: string;
}>;
