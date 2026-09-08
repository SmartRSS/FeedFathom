import { afterEach, describe, expect, test } from "bun:test";
import { Type } from "typebox";
import {
  folderResponse,
  sessionResponse,
} from "#shared/contracts/responses.ts";
import { api, ApiError, isUnauthorizedError } from "../api.ts";

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
  const rejectedApiCall = async (): Promise<unknown> => {
    setFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    return await api("/session", sessionResponse).catch(
      (cause: unknown) => cause,
    );
  };

  test("names the offline case when the request never reaches the server", async () => {
    await withOnLine(false, async () => {
      const failure = await rejectedApiCall();
      // Not an ApiError: there is no status, and the 401 check must not match.
      expect(isUnauthorizedError(failure)).toBe(false);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) return;
      expect(failure.message).toBe("You are offline. This could not be sent.");
      expect(failure.cause).toBeInstanceOf(TypeError);
    });
  });

  test("does not blame the network when the browser thinks it is online", async () => {
    await withOnLine(true, async () => {
      const failure = await rejectedApiCall();
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) return;
      expect(failure.message).toBe(
        "Could not reach the server. It may be restarting.",
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

  test("accepts the public session user projection", async () => {
    const user = {
      email: "reader@example.com",
      id: 1,
      isAdmin: false,
      name: "Reader",
      status: "active" as const,
    };
    returnResponse(Response.json({ user }));

    await expect(api("/session", sessionResponse)).resolves.toEqual({ user });
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
    ["extra", { extra: true, message: "ok" }],
  ])("rejects a %s successful payload", async (_name, payload) => {
    returnResponse(Response.json(payload));
    await expect(api("/message", exactMessage)).rejects.toThrow(
      "Invalid response from /api/message (200)",
    );
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
});
