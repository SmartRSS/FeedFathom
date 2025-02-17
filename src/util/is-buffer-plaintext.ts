export const isBufferPlaintext = (
  buffer: Buffer | string,
): buffer is string => {
  if (typeof buffer === "string") {
    return true;
  }

  // Check if the buffer contains only printable characters
  for (const byte of buffer) {
    if (!byte) {
      return false;
    }

    // Check if the byte is outside the range of printable ASCII characters
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      // Found a non-printable character
      return false;
    }
  }

  // All characters are printable
  return true;
};
