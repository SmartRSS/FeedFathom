import { Readable } from "node:stream";
import { describe, expect, test } from "bun:test";
import type { HttpRateLimiter } from "#platform/http/http-rate-limiter.ts";
import { RedirectPolicy } from "#platform/http/redirect-policy.ts";
import {
  HttpPolicyError,
  type NativeHttpResponse,
} from "#platform/http/http-native-transport.ts";
import { RequestDeadline } from "#platform/http/request-deadline.ts";

const nativeResponse = (
  status: number,
  location?: string,
  url = "https://a.test/start",
): NativeHttpResponse => {
  const body = Readable.from([]);
  return {
    body,
    destroy() {
      body.destroy();
    },
    headers: new Headers(location ? { location } : {}),
    status,
    url,
  };
};

const limiter = () => {
  const reserved: string[] = [];
  const fake: Pick<HttpRateLimiter, "reserve"> = {
    reserve: async (hostname: string) => {
      reserved.push(hostname);
    },
  };
  return { fake, reserved };
};

const policy = (responses: NativeHttpResponse[]) => {
  const { fake, reserved } = limiter();
  const requested: string[] = [];
  const transport = (url: string) => {
    requested.push(url);
    return Promise.resolve(responses.shift() ?? nativeResponse(200));
  };
  return {
    policy: new RedirectPolicy(fake, transport),
    requested,
    reserved,
  };
};

describe("RedirectPolicy", () => {
  test("a direct answer with no redirects reports not permanent", async () => {
    const { policy: subject } = policy([nativeResponse(200)]);

    const result = await subject.follow(
      "https://a.test/start",
      new Headers(),
      "interactive",
      new RequestDeadline(5_000),
    );
    expect(result.permanent).toBe(false);
    expect(result.response.status).toBe(200);
  });

  test("a chain of permanent hops reports permanent", async () => {
    const { policy: subject } = policy([
      nativeResponse(301, "https://b.test/moved", "https://a.test/start"),
      nativeResponse(308, "/final", "https://b.test/moved"),
      nativeResponse(200, undefined, "https://b.test/final"),
    ]);

    const result = await subject.follow(
      "https://a.test/start",
      new Headers(),
      "interactive",
      new RequestDeadline(5_000),
    );
    expect(result.permanent).toBe(true);
    expect(result.response.url).toBe("https://b.test/final");
  });

  test("one temporary hop makes the whole chain temporary", async () => {
    for (const temporary of [302, 303, 307]) {
      // Each status gets a fresh chain, asserted sequentially so a failure
      // is attributable to one status.
      const { policy: subject } = policy([
        nativeResponse(301, "https://a.test/wobble"),
        nativeResponse(temporary, "https://a.test/final"),
        nativeResponse(200),
      ]);

      // oxlint-disable-next-line eslint/no-await-in-loop
      const result = await subject.follow(
        "https://a.test/start",
        new Headers(),
        "interactive",
        new RequestDeadline(5_000),
      );
      expect(result.permanent).toBe(false);
    }
  });

  test("each hop is reserved against its own host, in order", async () => {
    const {
      policy: subject,
      reserved,
      requested,
    } = policy([
      nativeResponse(301, "https://b.test/here"),
      nativeResponse(200),
    ]);

    await subject.follow(
      "https://a.test/start",
      new Headers(),
      "interactive",
      new RequestDeadline(5_000),
    );
    expect(reserved).toEqual(["a.test", "b.test"]);
    expect(requested).toEqual(["https://a.test/start", "https://b.test/here"]);
  });

  test("a redirect hop's response is destroyed once followed", async () => {
    const destroyed: number[] = [];
    const first = nativeResponse(301, "https://a.test/final");
    const originalDestroy = first.destroy.bind(first);
    first.destroy = () => {
      destroyed.push(301);
      originalDestroy();
    };
    const { policy: subject } = policy([first, nativeResponse(200)]);

    await subject.follow(
      "https://a.test/start",
      new Headers(),
      "interactive",
      new RequestDeadline(5_000),
    );
    expect(destroyed).toEqual([301]);
  });

  test("a redirect without Location is a policy error, with the response disposed", async () => {
    const destroyed: number[] = [];
    const bare = nativeResponse(302);
    const originalDestroy = bare.destroy.bind(bare);
    bare.destroy = () => {
      destroyed.push(302);
      originalDestroy();
    };
    const { policy: subject } = policy([bare]);

    await expect(
      subject.follow(
        "https://a.test/start",
        new Headers(),
        "interactive",
        new RequestDeadline(5_000),
      ),
    ).rejects.toBeInstanceOf(HttpPolicyError);
    expect(destroyed).toEqual([302]);
  });

  test("a malformed Location is a policy error", async () => {
    const { policy: subject } = policy([nativeResponse(301, "http://[::1")]);

    await expect(
      subject.follow(
        "https://a.test/start",
        new Headers(),
        "interactive",
        new RequestDeadline(5_000),
      ),
    ).rejects.toBeInstanceOf(HttpPolicyError);
  });

  test("a chain longer than six hops gives up", async () => {
    const { policy: subject, requested } = policy([
      nativeResponse(301, "https://a.test/r2"),
      nativeResponse(301, "https://a.test/r3"),
      nativeResponse(301, "https://a.test/r4"),
      nativeResponse(301, "https://a.test/r5"),
      nativeResponse(301, "https://a.test/r6"),
      nativeResponse(301, "https://a.test/r7"),
    ]);

    await expect(
      subject.follow(
        "https://a.test/start",
        new Headers(),
        "interactive",
        new RequestDeadline(5_000),
      ),
    ).rejects.toBeInstanceOf(HttpPolicyError);
    expect(requested).toHaveLength(6);
  });
});
