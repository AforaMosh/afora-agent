export const DEFAULT_MAX_PENDING_INBOUND_EVENTS = 1_000;
export function resolveMaxPendingInboundEvents(value) {
    if (value === undefined) {
        return DEFAULT_MAX_PENDING_INBOUND_EVENTS;
    }
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error("maxPendingInboundEvents must be a positive safe integer.");
    }
    return value;
}
