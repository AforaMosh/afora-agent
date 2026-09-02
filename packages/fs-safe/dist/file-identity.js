import { createHash } from "node:crypto";
function isZero(value) {
    return value === 0 || value === 0n;
}
function sameStatValue(left, right) {
    return typeof left === typeof right ? left === right : BigInt(left) === BigInt(right);
}
function isStatValueProvablyDifferent(left, right, platform) {
    if (sameStatValue(left, right)) {
        return false;
    }
    return platform !== "win32" || (!isZero(left) && !isZero(right));
}
export function sha256Hex(data, encoding) {
    const buffer = typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : data;
    return createHash("sha256").update(buffer).digest("hex");
}
export function sameFileIdentity(left, right, platform = process.platform) {
    // When Windows cannot open a path for stat, libuv's FindFirstFile fallback reports dev=0 and
    // ino=0. Treating either unknown value as a mismatch caused nondeterministic path-mismatch
    // failures on legitimate reads under antivirus or indexer contention.
    return (!isStatValueProvablyDifferent(left.dev, right.dev, platform) &&
        !isStatValueProvablyDifferent(left.ino, right.ino, platform));
}
