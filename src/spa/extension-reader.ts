import {
  isReaderResponseForRequest,
  readerCapabilitiesRequest,
  readerFetchRequest,
  readerResponseTimeoutMs,
  type ReaderErrorCode,
  type ReaderRequest,
  type ReaderResponse,
} from "#shared/reader-bridge.ts";

const errorMessages: Record<ReaderErrorCode, string> = {
  FETCH_FAILED: "The Reader extension could not fetch this article.",
  INVALID_RESPONSE: "The Reader extension returned an invalid response.",
  INVALID_URL: "This article has an invalid URL.",
  NOT_HTML: "This article is not an HTML document.",
  PRIVATE_URL: "The Reader extension refused a private network address.",
  TIMEOUT: "The Reader extension timed out fetching this article.",
  TOO_LARGE: "This article is too large for Reader mode.",
  UNAUTHORIZED: "The Reader extension is configured for another instance.",
  UNAVAILABLE: "The Reader extension is unavailable.",
};

export class ReaderExtensionError extends Error {
  constructor(
    readonly code: ReaderErrorCode,
    message = errorMessages[code],
  ) {
    super(message);
  }

  get unavailable(): boolean {
    return (
      this.code === "TIMEOUT" ||
      this.code === "UNAUTHORIZED" ||
      this.code === "UNAVAILABLE"
    );
  }
}

type PendingRequest = {
  reject(error: Error): void;
  request: ReaderRequest;
  resolve(response: ReaderResponse): void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Reader flow: SPA window → content script → extension background → direct
 * extension fetch → validated response. Reader documents must never be
 * proxied through the FeedFathom backend; availability also proves that the
 * extension is configured for this SPA origin.
 */
export const createExtensionReaderBridge = (windowObject: Window = window) => {
  const pending = new Map<string, PendingRequest>();

  const receive = (event: MessageEvent<unknown>) => {
    if (
      event.source !== windowObject ||
      event.origin !== windowObject.location.origin
    )
      return;
    for (const [id, request] of pending)
      if (isReaderResponseForRequest(event.data, request.request)) {
        pending.delete(id);
        clearTimeout(request.timer);
        request.resolve(event.data);
        return;
      }
  };
  windowObject.addEventListener("message", receive);

  const send = (request: ReaderRequest): Promise<ReaderResponse> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request.id);
        reject(new ReaderExtensionError("UNAVAILABLE"));
      }, readerResponseTimeoutMs);
      pending.set(request.id, { reject, request, resolve, timer });
      windowObject.postMessage(request, windowObject.location.origin);
    });

  return {
    async available(): Promise<boolean> {
      try {
        const response = await send(readerCapabilitiesRequest());
        return response.ok && response.action === "capabilities";
      } catch {
        return false;
      }
    },
    dispose(): void {
      windowObject.removeEventListener("message", receive);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(errorMessages.UNAVAILABLE));
      }
      pending.clear();
    },
    async fetch(url: string): Promise<{ finalUrl: string; html: string }> {
      const response = await send(readerFetchRequest(url));
      if (!response.ok) throw new ReaderExtensionError(response.error);
      if (response.action !== "fetch")
        throw new ReaderExtensionError("INVALID_RESPONSE");
      return { finalUrl: response.finalUrl, html: response.html };
    },
  };
};
