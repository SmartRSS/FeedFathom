import { describe, expect, test } from "bun:test";
import {
  isReaderRequest,
  isReaderResponseForRequest,
  readerCapabilitiesRequest,
  readerErrorResponse,
  readerFetchRequest,
  readerFetchResponse,
} from "../reader-bridge.ts";

// The strict shapes are a security property: the extension acts only on a
// message it recognises exactly, and the page trusts only an answer to the
// request it sent.
describe("reader bridge protocol", () => {
  test("accepts only exact request shapes", () => {
    const request = readerFetchRequest("https://article.example/story");
    expect(isReaderRequest(request)).toBe(true);
    expect(isReaderRequest(readerCapabilitiesRequest())).toBe(true);
    expect(isReaderRequest({ ...request, extra: true })).toBe(false);
    expect(isReaderRequest({ ...request, id: "not-a-uuid" })).toBe(false);
  });

  test("accepts only an exact response to the request sent", () => {
    const request = readerFetchRequest("https://article.example/story");
    const response = readerFetchResponse(
      request,
      request.url,
      "<article>Story</article>",
    );
    expect(isReaderResponseForRequest(response, request)).toBe(true);
    expect(
      isReaderResponseForRequest(
        readerErrorResponse(request, "TIMEOUT"),
        request,
      ),
    ).toBe(true);
    expect(
      isReaderResponseForRequest({ ...response, extra: true }, request),
    ).toBe(false);
    expect(
      isReaderResponseForRequest(
        { ...response, id: crypto.randomUUID() },
        request,
      ),
    ).toBe(false);
    expect(
      isReaderResponseForRequest(
        { ...response, action: "capabilities", available: true },
        request,
      ),
    ).toBe(false);
    expect(
      isReaderResponseForRequest(
        { ...readerErrorResponse(request, "TIMEOUT"), error: "UNKNOWN" },
        request,
      ),
    ).toBe(false);
  });
});
