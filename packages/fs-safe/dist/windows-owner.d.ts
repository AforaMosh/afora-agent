export type WindowsOwnerExec = (command: string, args: string[]) => Promise<{
    stdout: string;
    stderr: string;
}>;
export type WindowsOwnerSummary = {
    sid?: string;
    currentUserSid?: string;
    principalSids?: Record<string, string>;
    principalTranslationFailed?: boolean;
    remote?: boolean;
    trusted?: boolean;
    error?: string;
};
export declare function resolveWindowsPrincipalSids(params: {
    principals: string[];
    known?: Record<string, string>;
    env?: NodeJS.ProcessEnv;
    exec: WindowsOwnerExec;
}): Promise<Record<string, string>>;
export declare function resolveWindowsCurrentUserSid(params: {
    env?: NodeJS.ProcessEnv;
    exec: WindowsOwnerExec;
}): Promise<string | null>;
export declare function inspectWindowsOwner(params: {
    targetPath: string;
    env?: NodeJS.ProcessEnv;
    exec: WindowsOwnerExec;
}): Promise<WindowsOwnerSummary>;
