import { afterEach, describe, expect, jest, test } from "bun:test";
import { Type } from "typebox";
import {
  folderResponse,
  sessionResponse,
} from "#shared/contracts/responses.ts";
import {
  api,
  ApiError,
  failureDetails,
  isUnauthorizedError,
  messageOf,
} from "../api.ts";

const exactMessage = Type.Object(
  { message: Type.String() },
  { additionalProperties: false },
);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type FetchImplementation = (
  ...arguments_: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

const setFetch = (implementation: FetchImplementation) => {
  globalThis.fetch = Object.assign(implementation, {
    preconnect: originalFetch.preconnect,
  });
};

const rejectedApiCall = async (): Promise<unknown> => {
  setFetch(() => Promise.reject(new TypeError("Failed to fetch")));
  return await api("/session", sessionResponse).catch(
    (cause: unknown) => cause,
  );
};

const aborted = () => {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
};

// navigator.onLine is a getter on the prototype; the property has to be
// redefined on the instance to fake it, and removed again so the online case
// reads the real one.
const withOnLine = async (value: boolean, body: () => Promise<void>) => {
  Object.defineProperty(globalThis.navigator, "onLine", {
    configurable: true,
    value,
  });
  try {
    await body();
  } finally {
    Reflect.deleteProperty(globalThis.navigator, "onLine");
  }
};

const returnResponse = (response: Response) => {
  setFetch(async () => response);
};

describe("schema-first SPA API", () => {
  test("names the connection when the request never reaches the server", async () => {
    await withOnLine(false, async () => {
      const failure = await rejectedApiCall();
      // Not an ApiError: there is no status, and the 401 check must not match.
      expect(isUnauthorizedError(failure)).toBe(false);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) return;
      expect(failure.message).toBe(
        "Can't reach FeedFathom. Check your connection.",
      );
      expect(failure.cause).toBeInstanceOf(TypeError);
    });
  });

  test("says the same when the browser thinks it is online", async () => {
    await withOnLine(true, async () => {
      const failure = await rejectedApiCall();
      expect(messageOf(failure, "Could not load your feeds.")).toBe(
        "Can't reach FeedFathom. Check your connection.",
      );
    });
  });

  test("owns fetch details and returns the schema-decoded value", async () => {
    let input: Parameters<typeof fetch>[0] | undefined;
    let init: Parameters<typeof fetch>[1];
    setFetch(async (nextInput, nextInit) => {
      input = nextInput;
      init = nextInit;
      return Response.json("42");
    });
    const numberString = Type.Codec(Type.String())
      .Decode((value) => Number(value))
      .Encode((value) => value.toString());

    const result = await api("/value", numberString, { method: "POST" });

    expect(result).toBe(42);
    expect(input).toBe("/api/value");
    expect(init).toEqual({ method: "POST" });
  });

  test("rejects invalid response dates", async () => {
    returnResponse(
      Response.json({
        createdAt: "not a date",
        id: 1,
        name: "Folder",
        updatedAt: "2026-07-29T12:34:56.789Z",
        userId: 1,
      }),
    );

    await expect(api("/folder", folderResponse)).rejects.toThrow(
      "Invalid response from /api/folder (200)",
    );
  });

  test.each([
    ["missing", {}],
    ["malformed", { message: 1 }],
  ])("rejects a %s successful payload", async (_name, payload) => {
    returnResponse(Response.json(payload));
    await expect(api("/message", exactMessage)).rejects.toThrow(
      "Invalid response from /api/message (200)",
    );
  });

  test("drops fields a newer server added", async () => {
    returnResponse(
      Response.json({
        added: true,
        items: [{ added: 1, message: "ok" }],
        message: "ok",
      }),
    );
    await expect(
      api(
        "/message",
        Type.Object(
          { items: Type.Array(exactMessage), message: Type.String() },
          { additionalProperties: false },
        ),
      ),
    ).resolves.toEqual({ items: [{ message: "ok" }], message: "ok" });
  });

  test("reports non-JSON successful responses", async () => {
    returnResponse(new Response("not json"));
    await expect(api("/message", exactMessage)).rejects.toThrow(
      "Invalid response from /api/message (200): expected JSON",
    );
  });

  test("uses a validated server error message", async () => {
    returnResponse(Response.json({ error: "Denied" }, { status: 403 }));
    await expect(api("/message", exactMessage)).rejects.toThrow("Denied");
  });

  test("preserves validated server error status", async () => {
    returnResponse(Response.json({ error: "Unauthorized" }, { status: 401 }));
    const cause = await api("/message", exactMessage).catch(
      (error: unknown) => error,
    );

    expect(cause).toBeInstanceOf(ApiError);
    if (!(cause instanceof ApiError)) throw new Error("Expected ApiError");
    expect(cause.status).toBe(401);
    expect(isUnauthorizedError(cause)).toBe(true);
  });

  test("uses a validated Elysia validation message", async () => {
    returnResponse(
      Response.json(
        {
          errors: [],
          found: { name: "" },
          message: "Expected string length greater or equal to 1",
          on: "body",
          property: "/name",
          type: "validation",
        },
        { status: 422 },
      ),
    );

    await expect(api("/message", exactMessage)).rejects.toThrow(
      "Expected string length greater or equal to 1",
    );
  });

  test.each([
    ["missing", { message: "Denied" }],
    ["malformed", { error: 1 }],
    ["extra", { error: "Denied", extra: true }],
    ["validation on wrong status", { message: "Denied", type: "validation" }],
  ])("rejects a %s error payload", async (_name, payload) => {
    returnResponse(Response.json(payload, { status: 400 }));
    await expect(api("/message", exactMessage)).rejects.toThrow(
      "Invalid response from /api/message (400): malformed error payload",
    );
  });

  // An edge proxy sometimes holds a request for seconds before passing it on;
  // a second copy sent meanwhile usually takes another path and answers.
  describe("racing a slow GET", () => {
    type Attempt = {
      answer(response: Response): void;
      init: Parameters<typeof fetch>[1];
    };
    const pendingFetches = () => {
      const attempts: Attempt[] = [];
      setFetch(
        (_input, init) =>
          new Promise((resolve, reject) => {
            attempts.push({ answer: resolve, init });
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      );
      return attempts;
    };

    afterEach(() => {
      jest.useRealTimers();
    });

    test("starts a second request after a second and takes the first answer", async () => {
      jest.useFakeTimers();
      const attempts = pendingFetches();
      const result = api("/message", exactMessage);
      jest.advanceTimersByTime(999);
      expect(attempts).toHaveLength(1);
      jest.advanceTimersByTime(1);
      expect(attempts).toHaveLength(2);

      attempts[1]?.answer(Response.json({ message: "second" }));

      await expect(result).resolves.toEqual({ message: "second" });
      expect(attempts[0]?.init?.signal?.aborted).toBe(true);
      expect(attempts[1]?.init?.signal?.aborted).toBe(false);
    });

    test("sends one request when the answer comes within a second", async () => {
      jest.useFakeTimers();
      const attempts = pendingFetches();
      const result = api("/message", exactMessage);
      attempts[0]?.answer(Response.json({ message: "first" }));
      await expect(result).resolves.toEqual({ message: "first" });
      jest.advanceTimersByTime(5000);
      expect(attempts).toHaveLength(1);
    });

    test("never repeats a request that is not a GET", () => {
      jest.useFakeTimers();
      const attempts = pendingFetches();
      void api("/message", exactMessage, { method: "DELETE" }).catch(() => {});
      jest.advanceTimersByTime(5000);
      expect(attempts).toHaveLength(1);
    });

    test("a caller's abort cancels every copy and stays unwrapped", async () => {
      jest.useFakeTimers();
      const attempts = pendingFetches();
      const controller = new AbortController();
      const result = api("/message", exactMessage, {
        signal: controller.signal,
      }).catch((cause: unknown) => cause);
      jest.advanceTimersByTime(1000);
      controller.abort();

      expect(await result).toBe(controller.signal.reason);
      expect(attempts.map(({ init }) => init?.signal?.aborted)).toEqual([
        true,
        true,
      ]);
    });
  });

  describe("cancellation", () => {
    test("passes a fetch cancellation through unwrapped", async () => {
      const signal = aborted();
      setFetch(() => Promise.reject(signal.reason));
      const failure = await api("/session", sessionResponse, { signal }).catch(
        (cause: unknown) => cause,
      );
      expect(failure).toBe(signal.reason);
      expect(failure).toBeInstanceOf(DOMException);
    });

    test("passes a cancellation during body reading through unwrapped", async () => {
      const controller = new AbortController();
      const body = new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"user":'));
          controller.signal.addEventListener("abort", () =>
            stream.error(controller.signal.reason),
          );
        },
      });
      returnResponse(new Response(body));
      const pending = api("/session", sessionResponse, {
        signal: controller.signal,
      }).catch((cause: unknown) => cause);
      controller.abort();
      const failure = await pending;
      expect(failure).toBeInstanceOf(DOMException);
      if (!(failure instanceof DOMException)) return;
      expect(failure.name).toBe("AbortError");
    });

    test.each([
      [
        "a network failure",
        () => Promise.reject(new TypeError("Failed to fetch")),
        "Can't reach FeedFathom. Check your connection.",
      ],
      [
        "invalid JSON",
        async () => new Response("not json"),
        "Invalid response from /api/message (200): expected JSON",
      ],
      [
        "a schema mismatch",
        async () => Response.json({}),
        "Invalid response from /api/message (200)",
      ],
    ])(
      "still reports %s after the signal aborted",
      async (_case, answer, error) => {
        setFetch(answer);
        await expect(
          api("/message", exactMessage, { signal: aborted() }),
        ).rejects.toThrow(error);
      },
    );
  });
});

// What a reader is told when FeedFathom's own API fails: a plain sentence
// naming what failed, no status code. The status and raw reason are kept for
// an admin's Details.
const failedWith = async (response: Response) => {
  returnResponse(response);
  return await api("/tree", exactMessage).catch((error: unknown) => error);
};

test.each([
  ["an unreadable 500", () => new Response("boom", { status: 500 })],
  ["a gateway's 502 page", () => new Response("<html>", { status: 502 })],
  [
    "the server's own 500",
    () => Response.json({ error: "Internal Server Error" }, { status: 500 }),
  ],
  ["an answer this bundle can't read", () => Response.json({})],
])("%s blames FeedFathom, not the reader", async (_case, response) => {
  const cause = await failedWith(response());
  expect(messageOf(cause, "Could not load your feeds.")).toBe(
    "FeedFathom couldn't load your feeds. Try again in a moment.",
  );
  expect(messageOf(cause, "Could not create the folder")).toBe(
    "FeedFathom couldn't create the folder. Try again in a moment.",
  );
});

test("keeps the server's own sentence for a request it refused", async () => {
  const cause = await failedWith(
    Response.json({ error: "Folder is not empty" }, { status: 400 }),
  );
  expect(messageOf(cause, "Could not delete the folder.")).toBe(
    "Folder is not empty",
  );
  expect(messageOf("thrown string", "Could not load articles.")).toBe(
    "Could not load articles.",
  );
});

test("details carry the status and the raw reason", async () => {
  expect(
    failureDetails(await failedWith(new Response("boom", { status: 500 }))),
  ).toEqual({
    reason: "Invalid response from /api/tree (500): expected JSON",
    status: 500,
  });
  expect(
    failureDetails(
      await failedWith(
        Response.json({ error: "Internal Server Error" }, { status: 500 }),
      ),
    ),
  ).toEqual({ reason: "Internal Server Error", status: 500 });
  expect(failureDetails(await rejectedApiCall())).toEqual({
    reason: "TypeError: Failed to fetch",
    status: undefined,
  });
});
