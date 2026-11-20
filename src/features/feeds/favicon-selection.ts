export const targetFaviconSize = 64;

export function imageDimensions(
  buffer: Buffer,
): { width: number; height: number } | undefined {
  if (
    buffer.length >= 24 &&
    buffer.subarray(1, 4).toString("latin1") === "PNG"
  ) {
    return { height: buffer.readUInt32BE(20), width: buffer.readUInt32BE(16) };
  }
  if (
    buffer.length >= 10 &&
    buffer.subarray(0, 3).toString("latin1") === "GIF"
  ) {
    return { height: buffer.readUInt16LE(8), width: buffer.readUInt16LE(6) };
  }
  if (isIco(buffer)) {
    return {
      height: buffer[7] === 0 ? 256 : buffer[7]!,
      width: buffer[6] === 0 ? 256 : buffer[6]!,
    };
  }
  if (
    buffer.length >= 26 &&
    buffer.subarray(0, 2).toString("latin1") === "BM"
  ) {
    return {
      height: Math.abs(buffer.readInt32LE(22)),
      width: buffer.readInt32LE(18),
    };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 8) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1]!;
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
    return undefined;
  }
  if (/^\s*<svg[\s>]/i.test(buffer.toString("utf8", 0, 500))) {
    return { height: Infinity, width: Infinity };
  }
  return undefined;
}

export function isIco(buffer: Buffer): boolean {
  return (
    buffer.length >= 22 &&
    buffer.readUInt16LE(0) === 0 &&
    buffer.readUInt16LE(2) === 1
  );
}

export function isBetterFavicon(
  candidateSize: number,
  bestSize: number,
  target: number,
): boolean {
  const candidateMeetsTarget = candidateSize >= target;
  const bestMeetsTarget = bestSize >= target;
  if (candidateMeetsTarget && bestMeetsTarget) return candidateSize < bestSize;
  if (candidateMeetsTarget) return true;
  if (bestMeetsTarget) return false;
  return candidateSize > bestSize;
}
