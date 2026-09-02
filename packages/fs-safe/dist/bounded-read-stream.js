import { pipeline, Transform } from "node:stream";
import { FsSafeError } from "./errors.js";
export function createMaxBytesTransform(maxBytes) {
    if (maxBytes !== Number.POSITIVE_INFINITY &&
        (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
        throw new RangeError("maxBytes must be a non-negative safe integer or Infinity");
    }
    let bytes = 0;
    return new Transform({
        transform(chunk, _encoding, callback) {
            const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
            bytes += buffer.byteLength;
            if (bytes > maxBytes) {
                callback(new FsSafeError("too-large", `file exceeds limit of ${maxBytes} bytes (got at least ${bytes})`));
                return;
            }
            callback(null, buffer);
        },
    });
}
export function createBoundedReadStream(opened, maxBytes) {
    const stream = opened.handle.createReadStream();
    if (maxBytes === undefined) {
        return stream;
    }
    const bounded = createMaxBytesTransform(maxBytes);
    // pipeline couples teardown in both directions: source failures reach the
    // returned stream, and an early consumer close destroys the file stream.
    pipeline(stream, bounded, () => undefined);
    return bounded;
}
