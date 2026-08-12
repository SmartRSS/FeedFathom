const defaultLimit = 1_024;

async function readChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  remaining: number,
): Promise<string> {
  if (remaining === 0) return decoder.decode();

  const { done, value } = await reader.read();
  if (done) return decoder.decode();

  const chunk = value.subarray(0, remaining);
  const text = decoder.decode(chunk, { stream: true });
  if (chunk.byteLength < value.byteLength || chunk.byteLength === remaining) {
    return text + decoder.decode();
  }

  return (
    text + (await readChunks(reader, decoder, remaining - chunk.byteLength))
  );
}

export async function readResponseDiagnostic(
  response: Response,
  limit = defaultLimit,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  try {
    return (await readChunks(reader, new TextDecoder(), limit)).trim();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
