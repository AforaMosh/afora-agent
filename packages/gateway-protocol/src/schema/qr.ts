// Gateway Protocol QR schemas share the established PNG data-URL contract.
import { Type } from "typebox";

export const QR_PNG_DATA_URL_MAX_LENGTH = 16_384;
export const QR_PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const QR_PNG_MAX_DIMENSION = 2_048;
// At the PNG maximum of eight decoded bytes per pixel, this caps the image at 16 MiB.
const QR_PNG_MAX_PIXELS = 2_097_152;

// The first ten characters plus `o-r` encode the eight-byte PNG signature. If
// the payload ends there, only `o=` has canonical zero pad bits. Longer values
// complete that quartet before using the canonical padded Base64 tail grammar.
const QR_PNG_BASE64_SIGNATURE_PATTERN = "iVBORw0KGg";
const QR_PNG_BASE64_CANONICAL_TAIL_PATTERN =
  "(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?";
const QR_PNG_DATA_URL_PATTERN = `^${QR_PNG_DATA_URL_PREFIX}${QR_PNG_BASE64_SIGNATURE_PATTERN}(?:o=|[o-r][A-Za-z0-9+/]${QR_PNG_BASE64_CANONICAL_TAIL_PATTERN})$`;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PNG_IHDR = 0x49484452;
const PNG_PLTE = 0x504c5445;
const PNG_IDAT = 0x49444154;
const PNG_IEND = 0x49454e44;

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeQrPngDataUrl(value: string): Uint8Array | undefined {
  if (!value.startsWith(QR_PNG_DATA_URL_PREFIX)) {
    return undefined;
  }
  try {
    const decoded = atob(value.slice(QR_PNG_DATA_URL_PREFIX.length));
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function isValidPngIhdr(bytes: Uint8Array, dataOffset: number, length: number): boolean {
  if (length !== 13) {
    return false;
  }
  const width = readUint32Be(bytes, dataOffset);
  const height = readUint32Be(bytes, dataOffset + 4);
  const bitDepth = bytes[dataOffset + 8];
  const colorType = bytes[dataOffset + 9];
  const validColorFormat =
    (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth ?? -1)) ||
    ((colorType === 2 || colorType === 4 || colorType === 6) &&
      (bitDepth === 8 || bitDepth === 16)) ||
    (colorType === 3 && [1, 2, 4, 8].includes(bitDepth ?? -1));
  return (
    width > 0 &&
    height > 0 &&
    width <= QR_PNG_MAX_DIMENSION &&
    height <= QR_PNG_MAX_DIMENSION &&
    width * height <= QR_PNG_MAX_PIXELS &&
    validColorFormat &&
    bytes[dataOffset + 10] === 0 &&
    bytes[dataOffset + 11] === 0 &&
    (bytes[dataOffset + 12] === 0 || bytes[dataOffset + 12] === 1)
  );
}

function isValidPngPalette(colorType: number, bitDepth: number, length: number): boolean {
  const entries = length / 3;
  return (
    length >= 3 &&
    length <= 3 * 256 &&
    Number.isInteger(entries) &&
    colorType !== 0 &&
    colorType !== 4 &&
    (colorType !== 3 || entries <= 2 ** bitDepth)
  );
}

function isCriticalPngChunk(bytes: Uint8Array, typeOffset: number): boolean {
  return ((bytes[typeOffset] ?? 0) & 0x20) === 0;
}

/** Validates the bounded PNG structure that QR-capable protocol clients consume. */
function isValidQrPngDataUrl(value: string): boolean {
  const bytes = decodeQrPngDataUrl(value);
  if (!bytes || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return false;
  }

  let offset: number = PNG_SIGNATURE.length;
  let bitDepth = -1;
  let colorType = -1;
  let sawPlte = false;
  let sawIdat = false;
  let finishedIdat = false;
  while (offset + 12 <= bytes.length) {
    const length = readUint32Be(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const crcOffset = dataOffset + length;
    const nextOffset = crcOffset + 4;
    if (crcOffset > bytes.length - 4) {
      return false;
    }

    const type = readUint32Be(bytes, typeOffset);
    if (pngCrc32(bytes, typeOffset, crcOffset) !== readUint32Be(bytes, crcOffset)) {
      return false;
    }

    if (offset === PNG_SIGNATURE.length) {
      if (type !== PNG_IHDR || !isValidPngIhdr(bytes, dataOffset, length)) {
        return false;
      }
      bitDepth = bytes[dataOffset + 8] ?? -1;
      colorType = bytes[dataOffset + 9] ?? -1;
    } else if (type === PNG_IHDR) {
      return false;
    }

    if (type === PNG_IHDR) {
      // The first-chunk branch above already validated the only legal IHDR.
    } else if (type === PNG_PLTE) {
      if (sawPlte || sawIdat || !isValidPngPalette(colorType, bitDepth, length)) {
        return false;
      }
      sawPlte = true;
    } else if (type === PNG_IDAT) {
      // PNG decoders require one contiguous IDAT run, and indexed pixels cannot
      // be interpreted until their palette has appeared.
      if (finishedIdat || (colorType === 3 && !sawPlte)) {
        return false;
      }
      sawIdat = true;
    } else {
      finishedIdat = sawIdat;
      if (type === PNG_IEND) {
        return length === 0 && sawIdat && nextOffset === bytes.length;
      }
      if (isCriticalPngChunk(bytes, typeOffset)) {
        return false;
      }
    }
    offset = nextOffset;
  }
  return false;
}

export const QrPngDataUrlSchema = Type.Refine(
  Type.String({
    maxLength: QR_PNG_DATA_URL_MAX_LENGTH,
    pattern: QR_PNG_DATA_URL_PATTERN,
  }),
  isValidQrPngDataUrl,
  () => "Expected a structurally valid PNG QR data URL",
);
