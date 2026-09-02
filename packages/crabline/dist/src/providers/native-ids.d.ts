export type NativeIdRule = {
    example: string;
    name: string;
    pattern: RegExp;
};
export declare function numericNativeId(value: number | bigint): string | undefined;
