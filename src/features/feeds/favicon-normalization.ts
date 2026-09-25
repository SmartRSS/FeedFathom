// Favicon normalization: turns whichever image a provider returned into the
// one copy that gets stored -- at most targetFaviconSize on the longer side,
// never enlarged, WebP when that is actually smaller. Pure: bytes in, bytes
// and MIME type out. See issue #937 for the size rule and the ICO handling.

import {
  imageDimensions,
  isBetterFavicon,
  targetFaviconSize,
} from "#features/feeds/favicon-selection.ts";

export interface StoredFavicon {
  buffer: Buffer;
  contentType: string;
}

// A favicon source claiming a larger canvas than this is refused before
// Bun.Image allocates its pixels.
const maxSourcePixels = 4096 * 4096;

/**
 * Downsizes a favicon to targetFaviconSize and re-encodes it as WebP. Keeps
 * the original bytes for SVG, for anything Bun.Image cannot decode, and
 * whenever the WebP would not be smaller than the image it came from.
 */
export async function normalizeFavicon(
  buffer: Buffer,
  contentType: string,
): Promise<StoredFavicon> {
  const original = { buffer, contentType };
  const dimensions = imageDimensions(buffer);
  // Unrecognised bytes, or an SVG (sized as Infinity): store as-is.
  if (!dimensions || dimensions.width === Infinity) return original;

  try {
    const source = isIco(buffer) ? icoFrame(buffer) : original;
    const image = new Bun.Image(source.buffer, { maxPixels: maxSourcePixels });
    const { width, height } = await image.metadata();
    // Only ever downsize: the resize target is below the source's longer side.
    if (Math.max(width, height) > targetFaviconSize) {
      image.resize(targetFaviconSize, targetFaviconSize, { fit: "inside" });
    }
    const webp = await image.webp().buffer();
    return webp.length < source.buffer.length
      ? { buffer: webp, contentType: "image/webp" }
      : source;
  } catch {
    // A favicon must never be lost to a failed normalization.
    return original;
  }
}

function isIco(buffer: Buffer): boolean {
  return (
    buffer.length >= 22 &&
    buffer.readUInt16LE(0) === 0 &&
    buffer.readUInt16LE(2) === 1
  );
}

// Picks one frame of an ICO with the size rule (exactly 64, else the smallest
// larger one, else the largest; higher bit depth on a tie) and returns it in a
// format Bun.Image decodes: a PNG frame as-is, a BMP frame rebuilt as a 32-bit
// BMP with an alpha channel.
function icoFrame(ico: Buffer): StoredFavicon {
  const count = ico.readUInt16LE(4);
  let best:
    | { size: number; bpp: number; offset: number; length: number }
    | undefined;
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    if (entry + 16 > ico.length) break;
    const size = Math.max(ico[entry]! || 256, ico[entry + 1]! || 256);
    const bpp = ico.readUInt16LE(entry + 6);
    const candidate = {
      bpp,
      length: ico.readUInt32LE(entry + 8),
      offset: ico.readUInt32LE(entry + 12),
      size,
    };
    if (
      !best ||
      (size === best.size
        ? bpp > best.bpp
        : isBetterFavicon(size, best.size, targetFaviconSize))
    ) {
      best = candidate;
    }
  }
  if (!best || best.offset + best.length > ico.length) {
    throw new Error("ICO frame out of range");
  }
  const frame = ico.subarray(best.offset, best.offset + best.length);
  if (frame.readUInt32BE(0) === 0x89_50_4e_47) {
    return { buffer: frame, contentType: "image/png" };
  }
  return { buffer: bmpFromIcoFrame(frame), contentType: "image/bmp" };
}

// An ICO BMP frame is a headerless DIB: a BITMAPINFOHEADER whose height covers
// the XOR image plus the 1-bit AND mask stacked on it, a palette for <= 8 bpp,
// then both bottom-up bitmaps with rows padded to 4 bytes. Bun.Image decodes
// only 24/32-bit BMPs and drops alpha unless a V4 header declares its mask,
// so every frame is expanded to BGRA behind a BITMAPV4HEADER.
function bmpFromIcoFrame(frame: Buffer): Buffer {
  const headerSize = frame.readUInt32LE(0);
  const width = frame.readInt32LE(4);
  const height = Math.abs(frame.readInt32LE(8)) / 2;
  const bpp = frame.readUInt16LE(14);
  const compression = frame.readUInt32LE(16);
  if (compression !== 0 || ![1, 4, 8, 24, 32].includes(bpp)) {
    throw new Error(
      `Unsupported ICO frame: ${bpp} bpp, compression ${compression}`,
    );
  }
  if (width <= 0 || height <= 0 || !Number.isInteger(height)) {
    throw new Error("Invalid ICO frame dimensions");
  }

  const paletteOffset = headerSize;
  const paletteSize = bpp <= 8 ? frame.readUInt32LE(32) || 1 << bpp : 0;
  const xorOffset = paletteOffset + paletteSize * 4;
  const xorStride = Math.floor((bpp * width + 31) / 32) * 4;
  const andOffset = xorOffset + xorStride * height;
  const andStride = Math.floor((width + 31) / 32) * 4;
  if (andOffset > frame.length) throw new Error("ICO frame truncated");

  const pixels = Buffer.alloc(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = xorOffset + y * xorStride;
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      if (bpp === 32 || bpp === 24) {
        const at = row + x * (bpp / 8);
        pixels[out] = frame[at]!;
        pixels[out + 1] = frame[at + 1]!;
        pixels[out + 2] = frame[at + 2]!;
        pixels[out + 3] = bpp === 32 ? frame[at + 3]! : 0;
      } else {
        const bit = x * bpp;
        const index =
          (frame[row + (bit >> 3)]! >> (8 - bpp - (bit & 7))) &
          ((1 << bpp) - 1);
        const color = paletteOffset + index * 4;
        pixels[out] = frame[color]!;
        pixels[out + 1] = frame[color + 1]!;
        pixels[out + 2] = frame[color + 2]!;
      }
      if (pixels[out + 3]) anyAlpha = true;
    }
  }

  // Only 32-bpp frames carry alpha of their own; the rest, and old 32-bpp
  // icons whose alpha is all zero, take it from the AND mask (1 = transparent).
  if (!anyAlpha) {
    for (let y = 0; y < height; y++) {
      const row = andOffset + y * andStride;
      for (let x = 0; x < width; x++) {
        const masked =
          row + (x >> 3) < frame.length &&
          (frame[row + (x >> 3)]! >> (7 - (x & 7))) & 1;
        pixels[(y * width + x) * 4 + 3] = masked ? 0 : 255;
      }
    }
  }

  const header = Buffer.alloc(14 + 108);
  header.write("BM", 0, "latin1");
  header.writeUInt32LE(header.length + pixels.length, 2);
  header.writeUInt32LE(header.length, 10);
  header.writeUInt32LE(108, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22); // positive: rows stay bottom-up
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  header.writeUInt32LE(3, 30); // BI_BITFIELDS
  header.writeUInt32LE(pixels.length, 34);
  header.writeUInt32LE(0x00_ff_00_00, 54); // red mask
  header.writeUInt32LE(0x00_00_ff_00, 58); // green mask
  header.writeUInt32LE(0x00_00_00_ff, 62); // blue mask
  header.writeUInt32LE(0xff_00_00_00, 66); // alpha mask
  return Buffer.concat([header, pixels]);
}
