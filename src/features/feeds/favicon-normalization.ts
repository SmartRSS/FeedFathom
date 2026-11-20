import {
  imageDimensions,
  isBetterFavicon,
  isIco,
  targetFaviconSize,
} from "#features/feeds/favicon-selection.ts";

export interface StoredFavicon {
  buffer: Buffer;
  contentType: string;
}

const maxSourcePixels = 4096 * 4096;

export async function normalizeFavicon(
  buffer: Buffer,
  contentType: string,
): Promise<StoredFavicon> {
  const original = { buffer, contentType };
  const dimensions = imageDimensions(buffer);
  if (!dimensions || dimensions.width === Infinity) return original;

  try {
    const source = isIco(buffer) ? icoFrame(buffer) : original;
    const image = new Bun.Image(source.buffer, { maxPixels: maxSourcePixels });
    const { width, height } = await image.metadata();
    if (Math.max(width, height) > targetFaviconSize) {
      image.resize(targetFaviconSize, targetFaviconSize, { fit: "inside" });
    }
    const webp = await image.webp().buffer();
    return webp.length < source.buffer.length
      ? { buffer: webp, contentType: "image/webp" }
      : source;
  } catch {
    return original;
  }
}

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
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  header.writeUInt32LE(3, 30);
  header.writeUInt32LE(pixels.length, 34);
  header.writeUInt32LE(0x00_ff_00_00, 54);
  header.writeUInt32LE(0x00_00_ff_00, 58);
  header.writeUInt32LE(0x00_00_00_ff, 62);
  header.writeUInt32LE(0xff_00_00_00, 66);
  return Buffer.concat([header, pixels]);
}
