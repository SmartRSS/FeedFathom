import { describe, expect, test } from "bun:test";
import {
  imageDimensions,
  isBetterFavicon,
  targetFaviconSize,
} from "./favicon-selection.ts";

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.write("\x89PNG\r\n\x1a\n", 0, "latin1");
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "latin1");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function gif(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(13);
  buffer.write("GIF89a", 0, "latin1");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

function ico(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(22);
  buffer.writeUInt16LE(0, 0);
  buffer.writeUInt16LE(1, 2);
  buffer.writeUInt16LE(1, 4);
  buffer[6] = width;
  buffer[7] = height;
  return buffer;
}

function bmp(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(26);
  buffer.write("BM", 0, "latin1");
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  return buffer;
}

// A minimal JPEG: SOI, then an APP0 segment to be skipped, then SOF0 carrying
// the dimensions. Exercises the marker walk rather than a lucky first hit.
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(6);
  app0.writeUInt16BE(0xff_e0, 0);
  app0.writeUInt16BE(4, 2);
  const sof0 = Buffer.alloc(11);
  sof0.writeUInt16BE(0xff_c0, 0);
  sof0.writeUInt16BE(8, 2);
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0]);
}

describe("imageDimensions", () => {
  test("reads a PNG header", () => {
    expect(imageDimensions(png(64, 32))).toEqual({ height: 32, width: 64 });
  });

  test("reads a GIF header", () => {
    expect(imageDimensions(gif(48, 16))).toEqual({ height: 16, width: 48 });
  });

  test("reads a BMP header", () => {
    expect(imageDimensions(bmp(64, 64))).toEqual({ height: 64, width: 64 });
  });

  // A bottom-up BMP stores a negative height.
  test("reads a bottom-up BMP as a positive height", () => {
    expect(imageDimensions(bmp(64, -64))).toEqual({ height: 64, width: 64 });
  });

  test("reads an ICO directory entry", () => {
    expect(imageDimensions(ico(32, 32))).toEqual({ height: 32, width: 32 });
  });

  // ICO stores each dimension in one byte, where 0 means 256.
  test("reads an ICO zero dimension as 256", () => {
    expect(imageDimensions(ico(0, 0))).toEqual({ height: 256, width: 256 });
  });

  test("walks JPEG segments to the frame header", () => {
    expect(imageDimensions(jpeg(96, 48))).toEqual({ height: 48, width: 96 });
  });

  // SVG is resolution-independent, so it always beats a raster candidate.
  test("treats SVG markup as unbounded", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(imageDimensions(svg)).toEqual({
      height: Infinity,
      width: Infinity,
    });
    expect(imageDimensions(Buffer.from("  \n<svg>"))).toEqual({
      height: Infinity,
      width: Infinity,
    });
  });

  // The reason this function exists: providers return HTML 404 pages with a
  // 200 status and a plausible content-type, and those must not be stored as
  // a site's favicon.
  test("rejects an HTML error page served as an image", () => {
    const html = Buffer.from("<!DOCTYPE html><html><body>404</body></html>");
    expect(imageDimensions(html)).toBeUndefined();
  });

  test("rejects a payload too short to carry a header", () => {
    expect(imageDimensions(Buffer.alloc(3))).toBeUndefined();
    expect(imageDimensions(Buffer.alloc(0))).toBeUndefined();
  });

  test("rejects bytes matching no known format", () => {
    expect(imageDimensions(Buffer.alloc(64, 0x7a))).toBeUndefined();
  });

  // A truncated JPEG must terminate the marker walk rather than loop.
  test("rejects a JPEG with no frame header", () => {
    const truncated = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.alloc(40),
    ]);
    expect(imageDimensions(truncated)).toBeUndefined();
  });
});

describe("favicon size preference", () => {
  test("prefers the smaller of two candidates that both clear the target", () => {
    expect(isBetterFavicon(64, 128, 64)).toBe(true);
    expect(isBetterFavicon(128, 64, 64)).toBe(false);
  });

  test("prefers any candidate that clears the target over one that doesn't", () => {
    expect(isBetterFavicon(64, 32, 64)).toBe(true);
    expect(isBetterFavicon(32, 64, 64)).toBe(false);
  });

  test("prefers the bigger of two candidates when neither clears the target", () => {
    expect(isBetterFavicon(32, 16, 64)).toBe(true);
    expect(isBetterFavicon(16, 32, 64)).toBe(false);
  });
});

describe("targetFaviconSize", () => {
  test("is the size providers are asked for and candidates judged against", () => {
    expect(targetFaviconSize).toBe(64);
  });
});
