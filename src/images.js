import { deflateSync, inflateSync } from "node:zlib";

// Hard limit for an uploaded image, per the acceptance criteria.
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

// Longest edge of a generated thumbnail. Images at or below this size are
// served as their own thumbnail; larger images are downscaled.
export const THUMBNAIL_MAX_DIMENSION = 256;

// Allowlist of accepted image MIME types (mime -> conventional extension).
export const ALLOWED_IMAGE_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Normalizes a `Content-Type` header value (ignoring parameters such as
 * `; charset=...`) to a lowercase MIME type, or returns null when it is not
 * on the allowlist.
 */
export function normalizeMimeType(value) {
  if (typeof value !== "string") return null;
  const type = value.split(";")[0].trim().toLowerCase();
  return ALLOWED_IMAGE_TYPES.has(type) ? type : null;
}

/**
 * Sniffs the actual image format from the leading bytes. Used to reject
 * uploads whose declared content type does not match the real payload.
 */
export function sniffImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (buffer.length >= 6) {
    const head = buffer.toString("ascii", 0, 6);
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) break;
    // SOF0..SOF15 (except DHT/JPG/RST-ish markers) carry the dimensions.
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof && offset + 9 <= buffer.length) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      if (width > 0 && height > 0) return { width, height };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function webpDimensions(buffer) {
  if (
    buffer.length < 20 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }
  const chunkType = buffer.toString("ascii", 12, 16);
  if (chunkType === "VP8X") {
    if (buffer.length < 30) return null;
    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    return { width, height };
  }
  if (chunkType === "VP8L") {
    if (buffer.length < 25) return null;
    const bits =
      buffer[20] | (buffer[21] << 8) | (buffer[22] << 16) | (buffer[23] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (chunkType === "VP8 ") {
    if (buffer.length < 30) return null;
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
}

/**
 * Reads the pixel dimensions from an image header without decoding the image.
 * Returns `{ width, height }` or null when the header cannot be parsed.
 */
export function imageDimensions(buffer, mimeType) {
  try {
    if (mimeType === "image/png") {
      if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
      }
      return null;
    }
    if (mimeType === "image/gif") {
      if (buffer.length < 10) return null;
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (mimeType === "image/jpeg") return jpegDimensions(buffer);
    if (mimeType === "image/webp") return webpDimensions(buffer);
    return null;
  } catch {
    return null;
  }
}

// --- Minimal PNG codec (used to build real thumbnails without dependencies) ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** Encodes a 32-bit RGBA pixel buffer as a non-interlaced 8-bit PNG. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor with alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decodes a non-interlaced 8- or 16-bit PNG into `{ width, height, data }`
 * where `data` is a normalized 8-bit RGBA buffer. Returns null for formats
 * outside that envelope (interlaced or sub-8-bit images are served as-is).
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return null;
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  const idatParts = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (width <= 0 || height <= 0) return null;
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (channels === undefined) return null;
  if (interlace !== 0) return null;
  if (bitDepth !== 8 && bitDepth !== 16) return null;
  const bytesPerSample = bitDepth === 8 ? 1 : 2;
  const bpp = channels * bytesPerSample;
  const stride = width * bpp;

  let raw;
  try {
    raw = inflateSync(Buffer.concat(idatParts));
  } catch {
    return null;
  }
  if (raw.length < (stride + 1) * height) return null;

  const readSample = (buf, base) =>
    bytesPerSample === 1 ? buf[base] : buf.readUInt16BE(base) >> 8;

  const out = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let srcOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[srcOffset];
    const line = raw.subarray(srcOffset + 1, srcOffset + 1 + stride);
    srcOffset += 1 + stride;
    if (filter > 4) return null;

    const recon = Buffer.alloc(stride);
    for (let i = 0; i < stride; i += 1) {
      const left = i >= bpp ? recon[i - bpp] : 0;
      const up = previous[i];
      const upLeft = i >= bpp ? previous[i - bpp] : 0;
      let value;
      if (filter === 0) value = line[i];
      else if (filter === 1) value = line[i] + left;
      else if (filter === 2) value = line[i] + up;
      else if (filter === 3) value = line[i] + Math.floor((left + up) / 2);
      else value = line[i] + paeth(left, up, upLeft);
      recon[i] = value & 0xff;
    }

    for (let x = 0; x < width; x += 1) {
      const base = x * bpp;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      if (colorType === 0) {
        r = g = b = readSample(recon, base);
      } else if (colorType === 2) {
        r = readSample(recon, base);
        g = readSample(recon, base + bytesPerSample);
        b = readSample(recon, base + bytesPerSample * 2);
      } else if (colorType === 3) {
        const index = readSample(recon, base);
        if (!palette || index * 3 + 2 >= palette.length) return null;
        r = palette[index * 3];
        g = palette[index * 3 + 1];
        b = palette[index * 3 + 2];
      } else if (colorType === 4) {
        r = g = b = readSample(recon, base);
        a = readSample(recon, base + bytesPerSample);
      } else {
        r = readSample(recon, base);
        g = readSample(recon, base + bytesPerSample);
        b = readSample(recon, base + bytesPerSample * 2);
        a = readSample(recon, base + bytesPerSample * 3);
      }
      const dst = (y * width + x) * 4;
      out[dst] = r;
      out[dst + 1] = g;
      out[dst + 2] = b;
      out[dst + 3] = a;
    }

    previous = recon;
  }

  return { width, height, data: out };
}

function downscaleRgba(src, srcWidth, srcHeight, dstWidth, dstHeight) {
  const out = Buffer.alloc(dstWidth * dstHeight * 4);
  for (let y = 0; y < dstHeight; y += 1) {
    const sy = Math.min(srcHeight - 1, Math.floor(((y + 0.5) * srcHeight) / dstHeight));
    for (let x = 0; x < dstWidth; x += 1) {
      const sx = Math.min(srcWidth - 1, Math.floor(((x + 0.5) * srcWidth) / dstWidth));
      const si = (sy * srcWidth + sx) * 4;
      const di = (y * dstWidth + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

/**
 * Builds a thumbnail for an uploaded image. PNG images larger than
 * `THUMBNAIL_MAX_DIMENSION` are downscaled into a smaller PNG; everything
 * else (including JPEG/GIF/WebP, which have no dependency-free decoder here)
 * is served as-is. Returns `{ bytes, mimeType }`.
 */
export function makeThumbnail(buffer, mimeType) {
  if (mimeType !== "image/png") {
    return { bytes: buffer, mimeType };
  }
  const decoded = decodePng(buffer);
  if (!decoded) return { bytes: buffer, mimeType };
  if (
    decoded.width <= THUMBNAIL_MAX_DIMENSION &&
    decoded.height <= THUMBNAIL_MAX_DIMENSION
  ) {
    return { bytes: buffer, mimeType };
  }
  const scale = Math.min(
    THUMBNAIL_MAX_DIMENSION / decoded.width,
    THUMBNAIL_MAX_DIMENSION / decoded.height,
  );
  const dstWidth = Math.max(1, Math.round(decoded.width * scale));
  const dstHeight = Math.max(1, Math.round(decoded.height * scale));
  const downscaled = downscaleRgba(
    decoded.data,
    decoded.width,
    decoded.height,
    dstWidth,
    dstHeight,
  );
  return { bytes: encodePng(dstWidth, dstHeight, downscaled), mimeType: "image/png" };
}
