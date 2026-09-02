export function numericNativeId(value) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
        return undefined;
    }
    return value.toString();
}
