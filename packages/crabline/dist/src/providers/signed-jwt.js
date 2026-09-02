import { verify } from "node:crypto";
const DEFAULT_KEY_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_UNKNOWN_KEY_COOLDOWN_MS = 30_000;
const MAX_NEGATIVE_KEY_IDS = 128;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
function decodeBase64UrlPart(value, label) {
    if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
        throw new Error(`${label} must use unpadded base64url encoding.`);
    }
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length === 0 || decoded.toString("base64url") !== value) {
        throw new Error(`${label} must use canonical base64url encoding.`);
    }
    return decoded;
}
function decodeJsonPart(value) {
    const decoded = JSON.parse(UTF8_DECODER.decode(decodeBase64UrlPart(value, "JWT part")));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new Error("JWT part must be a JSON object.");
    }
    return decoded;
}
function readHeader(value) {
    if (value.alg !== "RS256" || typeof value.kid !== "string" || !value.kid) {
        throw new Error("JWT must use RS256 and include a key id.");
    }
    return { alg: value.alg, kid: value.kid };
}
function hasAudience(claim, expected) {
    return claim === expected || (Array.isArray(claim) && claim.includes(expected));
}
function numericClaim(claims, name, required = false) {
    if (!(name in claims)) {
        if (required) {
            throw new Error(`JWT ${name} claim is required.`);
        }
        return undefined;
    }
    const value = claims[name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`JWT ${name} claim must be a finite number.`);
    }
    return value;
}
export function readBearerToken(request) {
    const authorization = request.headers.get("authorization");
    const match = /^Bearer\s+(\S+)$/iu.exec(authorization ?? "");
    return match?.[1];
}
export function resolveHttpCacheExpiry(response, now) {
    const cacheControl = response.headers.get("cache-control");
    if (/(?:^|,)\s*(?:no-cache|no-store)(?:\s*(?:=|,|$))/iu.test(cacheControl ?? "")) {
        return now;
    }
    const ageHeader = response.headers.get("age");
    const ageSeconds = ageHeader && /^\d+$/u.test(ageHeader) ? Number.parseInt(ageHeader, 10) : 0;
    const maxAge = /(?:^|,)\s*max-age=(\d+)/iu.exec(cacheControl ?? "");
    if (maxAge) {
        return now + Math.max(0, Number(maxAge[1]) - ageSeconds) * 1_000;
    }
    const expires = Date.parse(response.headers.get("expires") ?? "");
    return Number.isFinite(expires) && expires > now
        ? expires
        : now + Math.max(0, 60 * 60 - ageSeconds) * 1_000;
}
export function createCachedJwtKeyResolver(params) {
    const now = params.now ?? Date.now;
    const refreshCooldownMs = params.refreshCooldownMs ?? DEFAULT_UNKNOWN_KEY_COOLDOWN_MS;
    const timeoutMs = params.timeoutMs ?? DEFAULT_KEY_FETCH_TIMEOUT_MS;
    let cached;
    let fetchInFlight;
    let refreshInFlight;
    let refreshCooldownUntil = 0;
    let fetchFailureCooldownUntil = 0;
    let fetchFailureError;
    const negativeKeyIds = new Map();
    const rejectUnknownKey = (kid, expiresAt) => {
        for (const [candidate, candidateExpiry] of negativeKeyIds) {
            if (candidateExpiry <= now()) {
                negativeKeyIds.delete(candidate);
            }
        }
        if (negativeKeyIds.size >= MAX_NEGATIVE_KEY_IDS) {
            const oldest = negativeKeyIds.keys().next().value;
            if (oldest) {
                negativeKeyIds.delete(oldest);
            }
        }
        negativeKeyIds.set(kid, expiresAt);
        throw new Error(params.unknownKeyMessage);
    };
    const fetchKeys = async () => {
        if (fetchInFlight) {
            return await fetchInFlight;
        }
        if (fetchFailureCooldownUntil > now()) {
            throw fetchFailureError;
        }
        const controller = new AbortController();
        let timeout;
        const timedOut = new Promise((_, reject) => {
            timeout = setTimeout(() => {
                controller.abort();
                reject(new Error("JWT signing key fetch timed out."));
            }, timeoutMs);
        });
        fetchInFlight = Promise.race([params.fetchKeys(controller.signal), timedOut])
            .then((keySet) => {
            cached = keySet.expiresAt > now() ? keySet : undefined;
            fetchFailureCooldownUntil = 0;
            fetchFailureError = undefined;
            for (const value of keySet.values) {
                const keyId = params.keyId(value);
                if (keyId) {
                    negativeKeyIds.delete(keyId);
                }
            }
            return keySet;
        })
            .catch((error) => {
            fetchFailureCooldownUntil = now() + refreshCooldownMs;
            fetchFailureError = error;
            throw error;
        })
            .finally(() => {
            if (timeout) {
                clearTimeout(timeout);
            }
            fetchInFlight = undefined;
        });
        return await fetchInFlight;
    };
    return async (header) => {
        const currentTime = now();
        const negativeExpiry = negativeKeyIds.get(header.kid);
        if (negativeExpiry && negativeExpiry > currentTime) {
            throw new Error(params.unknownKeyMessage);
        }
        negativeKeyIds.delete(header.kid);
        const freshCache = cached && cached.expiresAt > currentTime ? cached : undefined;
        const keySet = freshCache ?? (await fetchKeys());
        const key = keySet.values.find((candidate) => params.keyId(candidate) === header.kid);
        if (key) {
            return key;
        }
        if (!freshCache) {
            return rejectUnknownKey(header.kid, now() + refreshCooldownMs);
        }
        let refreshed;
        if (refreshInFlight) {
            refreshed = await refreshInFlight;
        }
        else {
            const refreshTime = now();
            if (refreshCooldownUntil > refreshTime) {
                return rejectUnknownKey(header.kid, refreshCooldownUntil);
            }
            refreshCooldownUntil = refreshTime + refreshCooldownMs;
            refreshInFlight = fetchKeys().finally(() => {
                refreshInFlight = undefined;
            });
            refreshed = await refreshInFlight;
        }
        const rotatedKey = refreshed.values.find((candidate) => params.keyId(candidate) === header.kid);
        if (!rotatedKey) {
            return rejectUnknownKey(header.kid, refreshCooldownUntil);
        }
        return rotatedKey;
    };
}
export async function verifySignedJwt(params) {
    const parts = params.token.split(".");
    if (parts.length !== 3) {
        throw new Error("JWT must contain three parts.");
    }
    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    const header = readHeader(decodeJsonPart(encodedHeader));
    const claims = decodeJsonPart(encodedClaims);
    const key = await params.resolveKey(header);
    const signature = decodeBase64UrlPart(encodedSignature, "JWT signature");
    if (!verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), key, signature)) {
        throw new Error("JWT signature is invalid.");
    }
    if (!params.issuers.includes(String(claims.iss ?? ""))) {
        throw new Error("JWT issuer is invalid.");
    }
    if (!hasAudience(claims.aud, params.audience)) {
        throw new Error("JWT audience is invalid.");
    }
    const now = Math.floor((params.now?.() ?? Date.now()) / 1000);
    const skew = params.clockSkewSeconds ?? 300;
    const expiresAt = numericClaim(claims, "exp", true);
    if (expiresAt <= now - skew) {
        throw new Error("JWT is expired.");
    }
    const notBefore = numericClaim(claims, "nbf");
    if (notBefore !== undefined && notBefore > now + skew) {
        throw new Error("JWT is not active.");
    }
    return claims;
}
