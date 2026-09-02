export const PROXYLINE_DISPATCHER_BRAND = Symbol.for("@afora/proxyline.dispatcher");
export function isProxylineDispatcher(dispatcher) {
    return typeof dispatcher === "object" &&
        dispatcher !== null &&
        dispatcher[PROXYLINE_DISPATCHER_BRAND] === true;
}
