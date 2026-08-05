import type { HttpDeferredError } from "../../lib/http-client.ts";
import { json } from "../shared.ts";

export function deferredResponse(error: HttpDeferredError) {
  // Clamped to an hour: retryAt can come from an upstream Retry-After
  // header with no sanity check of its own, so an unbounded/malicious
  // value shouldn't be echoed straight back to the client.
  const retryAfterSeconds = Math.min(
    Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000)),
    3_600,
  );
  return json(
    {
      error: `This feed's server was just checked — try again in ${retryAfterSeconds}s.`,
    },
    429,
    { "Retry-After": retryAfterSeconds.toString() },
  );
}
