import type {
  HttpRateLimiter,
  Priority,
} from "#platform/http/http-rate-limiter.ts";
import {
  HttpPolicyError,
  type NativeHttpResponse,
  type NativeHttpTransport,
} from "#platform/http/http-native-transport.ts";
import type { RequestDeadline } from "#platform/http/request-deadline.ts";

const redirectStatuses: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);
const maximumRedirects = 5;

export type FetchResult = {
  permanent: boolean;
  response: NativeHttpResponse;
};

export class RedirectPolicy {
  constructor(
    private readonly rateLimiter: Pick<HttpRateLimiter, "reserve">,
    private readonly transport: NativeHttpTransport,
  ) {}

  async follow(
    url: string,
    headers: Headers,
    priority: Priority,
    deadline: RequestDeadline,
  ): Promise<FetchResult> {
    let next = url;
    let permanent = true;
    /* eslint-disable no-await-in-loop -- Each redirect target comes from the previous response, and each is reserved on its own. */
    for (let redirects = 0; redirects <= maximumRedirects; redirects++) {
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
