export function isBufferPlaintext(buffer: Buffer | string): buffer is string {
  if (typeof buffer === "string") {
    return true;
  }
  // Check if the buffer contains only printable characters
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (!byte) {
      return false;
    }
    // Check if the byte is outside the range of printable ASCII characters
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      return false; // Found a non-printable character
    }
  }
  return true; // All characters are printable
}
