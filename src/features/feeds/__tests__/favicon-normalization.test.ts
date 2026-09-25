import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { normalizeFavicon } from "../favicon-normalization.ts";

type Rgba = [number, number, number, number];
type Paint = (x: number, y: number) => Rgba;

// Opaque red in the top-left quadrant, fully transparent everywhere else, so
// both the alpha and the row order (BMP rows run bottom-up) are checked.
const quadrant: Paint = (x, y) =>
  x < 8 && y < 8 ? [255, 0, 0, 255] : [0, 0, 0, 0];

const noise: Paint = (x, y) => {
  const n = (Math.imul(x + 1, 2_654_435_761) ^ Math.imul(y + 1, 40_503)) >>> 0;
  return [n & 255, (n >> 8) & 255, (n >> 16) & 255, 255];
};

// A 32-bit BMP with a V4 header, the one BMP flavour Bun.Image decodes with
// alpha: the source for the PNG and JPEG fixtures.
function v4Bmp(width: number, height: number, paint: Paint): Buffer {
  const header = Buffer.alloc(122);
  header.write("BM", 0, "latin1");
  header.writeUInt32LE(122 + width * height * 4, 2);
  header.writeUInt32LE(122, 10);
  header.writeUInt32LE(108, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(-height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  header.writeUInt32LE(3, 30);
  header.writeUInt32LE(0x00_ff_00_00, 54);
  header.writeUInt32LE(0x00_00_ff_00, 58);
  header.writeUInt32LE(0x00_00_00_ff, 62);
  header.writeUInt32LE(0xff_00_00_00, 66);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      pixels.set([b, g, r, a], (y * width + x) * 4);
    }
  }
  return Buffer.concat([header, pixels]);
}

function png(size: number, paint: Paint = noise): Promise<Buffer> {
  return new Bun.Image(v4Bmp(size, size, paint)).png().buffer();
}

function jpeg(size: number): Promise<Buffer> {
  return new Bun.Image(v4Bmp(size, size, noise)).jpeg().buffer();
}

// An ICO BMP frame: BITMAPINFOHEADER with a doubled height, a palette for
// <= 8 bpp, the bottom-up XOR bitmap, then the 1-bit AND mask (1 = transparent).
// Palette frames index a two-colour palette: 0 = black, 1 = red.
function icoBmpFrame(size: number, bpp: 4 | 8 | 32, paint: Paint): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(bpp, 14);
  const palette = Buffer.alloc(bpp === 32 ? 0 : (1 << bpp) * 4);
  if (palette.length > 0) palette.set([0, 0, 255, 0], 4);
  const xorStride = Math.floor((bpp * size + 31) / 32) * 4;
  const andStride = Math.floor((size + 31) / 32) * 4;
  const xor = Buffer.alloc(xorStride * size);
  const and = Buffer.alloc(andStride * size);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = paint(x, y);
      if (bpp === 32) {
        xor.set([b, g, r, a], row * xorStride + x * 4);
      } else {
        const index = r > 0 ? 1 : 0;
        const bit = x * bpp;
        xor[row * xorStride + (bit >> 3)]! |= index << (8 - bpp - (bit & 7));
        if (a === 0) and[row * andStride + (x >> 3)]! |= 0x80 >> (x & 7);
      }
    }
  }
  return Buffer.concat([header, palette, xor, and]);
}

function ico(frames: { size: number; bpp: number; data: Buffer }[]): Buffer {
  const directory = Buffer.alloc(6 + frames.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  frames.forEach(({ size, bpp, data }, index) => {
    const entry = 6 + index * 16;
    directory[entry] = size % 256;
    directory[entry + 1] = size % 256;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(bpp, entry + 6);
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([directory, ...frames.map(({ data }) => data)]);
}

// Reads back an image's RGBA pixels, via Bun.Image's PNG encoder, so a test can
// check what a browser would draw.
async function rgba(image: Buffer) {
  const encoded = await new Bun.Image(image).png().buffer();
  const width = encoded.readUInt32BE(16);
  const height = encoded.readUInt32BE(20);
  const channels = encoded[25] === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let at = 8; at < encoded.length;) {
    const length = encoded.readUInt32BE(at);
    if (encoded.toString("latin1", at + 4, at + 8) === "IDAT") {
      idat.push(encoded.subarray(at + 8, at + 8 + length));
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i]!;
      const left = i >= channels ? pixels[y * stride + i - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const upLeft =
        y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels]! : 0;
      const p = left + up - upLeft;
      const [pa, pb, pc] = [p - left, p - up, p - upLeft].map(Math.abs);
      const predictor = [
        0,
        left,
        up,
        (left + up) >> 1,
        pa! <= pb! && pa! <= pc! ? left : pb! <= pc! ? up : upLeft,
      ][filter]!;
      pixels[y * stride + i] = (value + predictor) & 255;
    }
  }
  return (x: number, y: number) => {
    const at = y * stride + x * channels;
    return [
      ...pixels.subarray(at, at + 3),
      channels === 4 ? pixels[at + 3]! : 255,
    ];
  };
}

async function dimensions(image: Buffer) {
  const { width, height } = await new Bun.Image(image).metadata();
  return { height, width };
}

const resize = spyOn(Bun.Image.prototype, "resize");
afterEach(() => resize.mockClear());

describe("normalizeFavicon", () => {
  test("uses an ICO's exact 64px frame without resizing it", async () => {
    const source = ico([
      { bpp: 32, data: icoBmpFrame(16, 32, noise), size: 16 },
      { bpp: 32, data: await png(64), size: 64 },
      { bpp: 32, data: await png(128), size: 128 },
    ]);

    const result = await normalizeFavicon(source, "image/x-icon");

    expect(resize).not.toHaveBeenCalled();
    expect(await dimensions(result.buffer)).toEqual({ height: 64, width: 64 });
  });

  test("picks the largest ICO frame under 64px and does not upscale it", async () => {
    const source = ico([
      { bpp: 32, data: icoBmpFrame(16, 32, noise), size: 16 },
      { bpp: 32, data: icoBmpFrame(48, 32, noise), size: 48 },
      { bpp: 32, data: icoBmpFrame(32, 32, noise), size: 32 },
    ]);

    const result = await normalizeFavicon(source, "image/x-icon");

    expect(resize).not.toHaveBeenCalled();
    expect(result.contentType).toBe("image/webp");
    expect(await dimensions(result.buffer)).toEqual({ height: 48, width: 48 });
  });

  test.each([32, 8, 4] as const)(
    "keeps the transparency of a %d bpp ICO BMP frame",
    async (bpp) => {
      const source = ico([
        { bpp, data: icoBmpFrame(16, bpp, quadrant), size: 16 },
      ]);

      const result = await normalizeFavicon(source, "image/x-icon");

      expect(result.contentType).toBe("image/webp");
      const pixel = await rgba(result.buffer);
      const [r, g, b, a] = pixel(2, 2);
      expect(a).toBe(255);
      expect(r).toBeGreaterThan(200);
      expect(g! + b!).toBeLessThan(60);
      expect(pixel(12, 2)[3]).toBe(0);
      expect(pixel(2, 12)[3]).toBe(0);
      expect(pixel(12, 12)[3]).toBe(0);
    },
  );

  test("downsizes an oversized PNG to 64px WebP", async () => {
    const source = await png(180);

    const result = await normalizeFavicon(source, "image/png");

    expect(resize).toHaveBeenCalledWith(64, 64, { fit: "inside" });
    expect(result.contentType).toBe("image/webp");
    expect(await dimensions(result.buffer)).toEqual({ height: 64, width: 64 });
    expect(result.buffer.length).toBeLessThan(source.length);
  });

  test.each([
    ["PNG", "image/png", () => png(32)],
    ["JPEG", "image/jpeg", () => jpeg(32)],
  ])("neither upscales nor grows a small %s", async (_, type, make) => {
    const source = await make();

    const result = await normalizeFavicon(source, type);

    expect(resize).not.toHaveBeenCalled();
    expect(await dimensions(result.buffer)).toEqual({ height: 32, width: 32 });
    expect(result.buffer.length).toBeLessThanOrEqual(source.length);
  });

  test("stores an SVG as it came", async () => {
    const source = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
    );

    expect(await normalizeFavicon(source, "image/svg+xml")).toEqual({
      buffer: source,
      contentType: "image/svg+xml",
    });
  });

  test.each([
    ["PNG", "image/png", async () => (await png(64)).subarray(0, 60)],
    [
      "ICO",
      "image/x-icon",
      async () => ico([{ bpp: 32, data: Buffer.alloc(40), size: 16 }]),
    ],
  ])("keeps a corrupt %s as it came", async (_, type, make) => {
    const source = await make();

    expect(await normalizeFavicon(source, type)).toEqual({
      buffer: source,
      contentType: type,
    });
  });
});
