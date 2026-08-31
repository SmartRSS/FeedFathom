const defaultLimit = 1_024;

export async function readResponseDiagnostic(
  response: Response,
  limit = defaultLimit,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let remaining = limit;
  let text = "";
  try {
    /* eslint-disable no-await-in-loop -- Each chunk depends on the previous read. */
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, remaining);
      remaining -= chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (chunk.byteLength < value.byteLength) break;
    }
    /* eslint-enable no-await-in-loop */
    return (text + decoder.decode()).trim();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
