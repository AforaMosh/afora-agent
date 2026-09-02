export declare const EXIT_CODES: {
    readonly SUCCESS: 0;
    readonly FAILURE: 1;
    readonly USAGE: 2;
    readonly CONFIG: 10;
    readonly AUTH: 11;
    readonly CONNECTIVITY: 12;
    readonly OUTBOUND: 13;
    readonly INBOUND: 14;
    readonly TIMEOUT: 15;
    readonly ASSERTION: 16;
};
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
