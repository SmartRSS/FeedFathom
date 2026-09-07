import type { HttpRateLimiter } from "#platform/http/http-rate-limiter.ts";
import {
  HttpPolicyError,
  type NativeHttpResponse,
  type NativeHttpTransport,
} from "#platform/http/http-native-transport.ts";
import type { RequestDeadline } from "#platform/http/request-deadline.ts";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export type FetchResult = {
  permanent: boolean;
  response: NativeHttpResponse;
};

// Manual redirect following: each hop is its own request, reserved against
// the host it targets, and a chain is permanent only if every hop is.
export class RedirectPolicy {
  constructor(
    private readonly rateLimiter: HttpRateLimiter,
    private readonly transport: NativeHttpTransport,
  ) {}

  async follow(
    url: string,
    headers: Headers,
    priority: "background" | "interactive",
    deadline: RequestDeadline,
  ): Promise<FetchResult> {
    let next = url;
    // A chain is permanent only if every hop is (301/308) -- one temporary hop
    // means the resolved URL could still change back.
    let permanent = true;
    /* eslint-disable no-await-in-loop -- Each redirect target comes from the previous response, and each is reserved on its own. */
    for (let redirects = 0; redirects <= 5; redirects++) {
      // A hop is a request like any other, and it is a request to a host of
      // its own. Reserving here rather than once per call is also what gives
      // a retry its interval, since every attempt re-enters this loop. The
      // hostname is safe to read: the first is already validated and every
      // later one was built by `new URL` below.
      await this.rateLimiter.reserve(
        new URL(next).hostname,
        priority,
        deadline,
      );
      const response = await deadline.run(
        this.transport(next, headers, deadline.controller.signal),
      );
      if (!redirectStatuses.has(response.status)) {
        return { permanent: redirects > 0 && permanent, response };
      }

      if (response.status !== 301 && response.status !== 308) {
        permanent = false;
      }
      const location = response.headers.get("location");
      response.destroy();
      if (!location) {
        throw new HttpPolicyError("Redirect response is missing Location");
      }
      try {
        next = new URL(location, next).toString();
      } catch {
        throw new HttpPolicyError("Redirect Location is malformed");
      }
    }
    /* eslint-enable no-await-in-loop */
    throw new HttpPolicyError("Too many redirects");
  }
}
