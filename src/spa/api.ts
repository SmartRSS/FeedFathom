import { Type, type StaticDecode, type TSchema } from "typebox";
import { Value } from "typebox/value";

const exact = { additionalProperties: false } as const;
const errorResponse = Type.Union([
  Type.Object(
    { error: Type.String(), success: Type.Optional(Type.Literal(false)) },
    exact,
  ),
  Type.Object({ success: Type.Literal(false) }, exact),
  Type.Object({}, exact),
]);
const validationErrorResponse = Type.Object(
  { message: Type.String(), type: Type.Literal("validation") },
  { additionalProperties: true },
);

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const isUnauthorizedError = (cause: unknown): cause is ApiError =>
  cause instanceof ApiError && cause.status === 401;

// A response this bundle could not read. Its message names the path and the
// parse failure, which is for the console and the tests, not the reader; the
// HTTP status it came with is for both.
class InvalidResponseError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
  }
}

// An error status the server answered with, if the answer was unreadable.
const answeredStatus = (cause: unknown) =>
  cause instanceof InvalidResponseError &&
  cause.status !== undefined &&
  cause.status >= 400
    ? cause.status
    : undefined;

// An Error carries its own message for the user; anything else thrown, and a
// response that could not be read, does not, so the caller names what
// failed -- adding the status the server answered with, where there is one.
export const messageOf = (cause: unknown, fallback: string) => {
  const status = answeredStatus(cause);
  if (status !== undefined)
    return `${fallback.replace(/[.!?]?$/u, ".")} The server answered ${status}.`;
  return cause instanceof Error && !(cause instanceof InvalidResponseError)
    ? cause.message
    : fallback;
};

// Why a request failed, as a sentence of its own, for a message that already
// names what failed ("Feeds couldn't load."): the status the server answered
// with, an answer that could not be read, or the reason no answer came.
export function failureReason(cause: unknown): string {
  const status = answeredStatus(cause);
  if (status !== undefined) return `The server answered ${status}.`;
  if (cause instanceof InvalidResponseError)
    return "The server's answer could not be read.";
  return cause instanceof Error ? cause.message : "The server did not answer.";
}

const invalidResponse = (
  path: string,
  message: string,
  status?: number,
): Error =>
  new InvalidResponseError(
    `Invalid response from /api${path}${status === undefined ? "" : ` (${status})`}: ${message}`,
    status,
  );

// Aborting a request is the caller's own decision, not a failure to report:
// the caller's AbortError has to reach it unwrapped so it can tell a
// superseded request from a real one. Only while its signal is aborted, so a
// genuine failure that merely coincides with a later abort still surfaces.
const isCancellation = (
  cause: unknown,
  signal: AbortSignal | null | undefined,
) =>
  signal?.aborted === true &&
  (cause === signal.reason ||
    (cause instanceof DOMException && cause.name === "AbortError"));

async function responseJson(
  path: string,
  response: Response,
  signal: AbortSignal | null | undefined,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    if (isCancellation(cause, signal)) throw cause;
    throw invalidResponse(path, "expected JSON", response.status);
  }
}

// A request that never reaches the server rejects with a browser-specific
// TypeError -- "Failed to fetch" in Chrome, "NetworkError when attempting to
// fetch resource" in Firefox -- and that string is what the dashboard's alert
// puts in front of the user. Replaced once here, where every call passes,
// rather than at each call site. navigator.onLine is only trustworthy in the
// negative: true means an interface is up, not that anything is reachable, so
// a false reading is allowed to name the cause and a true one is not.
const unreachable = (cause: unknown): Error =>
  new Error(
    navigator.onLine
      ? "Could not reach the server. It may be restarting."
      : "You are offline. This could not be sent.",
    { cause },
  );

// Cloudflare now and then holds a request for seconds to a minute before it
// reaches the origin, which answers in milliseconds; a copy sent meanwhile
// usually takes another path. A GET still waiting after this long races a
// second copy, the first answer wins, and the other is aborted. Only a GET:
// repeating a write could apply it twice.
const raceGetAfterMs = 1000;

function raceGet(url: string, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = [];
    let pending = 0;
    const send = () => {
      const controller = new AbortController();
      controllers.push(controller);
      pending++;
      const signal = init?.signal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal;
      fetch(url, { ...init, signal }).then(
        (response) => {
          clearTimeout(timer);
          for (const other of controllers)
            if (other !== controller) other.abort();
          resolve(response);
        },
        (cause: unknown) => {
          if (--pending > 0) return;
          clearTimeout(timer);
          reject(cause);
        },
      );
    };
    const timer = setTimeout(send, raceGetAfterMs);
    send();
  });
}

export async function api<T extends TSchema>(
  path: string,
  schema: T,
  init?: RequestInit,
): Promise<StaticDecode<T>> {
  let response: Response;
  try {
    response =
      (init?.method ?? "GET") === "GET"
        ? await raceGet(`/api${path}`, init)
        : await fetch(`/api${path}`, init);
  } catch (cause) {
    if (isCancellation(cause, init?.signal)) throw cause;
    throw unreachable(cause);
  }
  const payload = await responseJson(path, response, init?.signal);

  if (!response.ok) {
    if (Value.Check(errorResponse, payload))
      throw new ApiError(
        "error" in payload && payload.error
          ? payload.error
          : response.statusText || `Request failed (${response.status})`,
        response.status,
      );
    if (
      response.status === 422 &&
      Value.Check(validationErrorResponse, payload)
    ) {
      const message = Reflect.get(Object(payload), "message");
      if (typeof message === "string")
        throw new ApiError(message, response.status);
    }
    throw invalidResponse(path, "malformed error payload", response.status);
  }

  // A deploy that adds a response field reaches pages still running the
  // previous bundle -- the worker serves its cached shell first -- so fields
  // this bundle does not know are dropped rather than rejected.
  Value.Clean(schema, payload);
  if (!Value.Check(schema, payload)) {
    const issue = Value.Errors(schema, payload)[0];
    throw invalidResponse(
      path,
      issue
        ? `${issue.instancePath || "/"} ${issue.message}`
        : "schema mismatch",
      response.status,
    );
  }
  return Value.Decode(schema, payload);
}
