import { Type, type StaticDecode, type TSchema } from "typebox";
import { Value } from "typebox/value";

const exact = { additionalProperties: false } as const;
const errorResponse = Type.Union([
  Type.Object(
    {
      // The raw reason behind `error`, where the server keeps one for an
      // admin's details.
      detail: Type.Optional(Type.String()),
      error: Type.String(),
      success: Type.Optional(Type.Literal(false)),
    },
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
    public readonly detail?: string,
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

// FeedFathom's own failure: an answer this bundle can't read, or a 5xx the
// server sent itself. A 504 with a readable error is the exception: the
// server's request to a feed site ran out of time, and its sentence says so.
const ownFailure = (cause: unknown) =>
  cause instanceof InvalidResponseError ||
  (cause instanceof ApiError && cause.status >= 500 && cause.status !== 504);

// The sentence a reader sees. `fallback` names the action as "Could not
// <action>.": it stands alone for anything thrown that isn't an Error, and
// becomes "FeedFathom couldn't <action>." when FeedFathom itself failed. Any
// other Error -- a refusal the server explained, or no connection -- carries
// its own sentence. Statuses and raw reasons stay out: they are for an
// admin's details (failureDetails).
export const messageOf = (cause: unknown, fallback: string) => {
  if (ownFailure(cause))
    return `FeedFathom couldn't ${fallback.replace(/^Could not /u, "").replace(/[.!?]?$/u, "")}. Try again in a moment.`;
  return cause instanceof Error ? cause.message : fallback;
};

// What an admin's Details show for a failure: the HTTP status, where there
// was an answer, and the raw reason.
export function failureDetails(cause: unknown): {
  reason: string;
  status: number | undefined;
} {
  const status =
    cause instanceof ApiError || cause instanceof InvalidResponseError
      ? cause.status
      : undefined;
  if (!(cause instanceof Error)) return { reason: String(cause), status };
  if (cause instanceof ApiError && cause.detail)
    return { reason: cause.detail, status };
  // No answer at all: the browser's own error is the only detail there is.
  if (!status && cause.cause instanceof Error)
    return { reason: String(cause.cause), status };
  return { reason: cause.message, status };
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
// fetch resource" in Firefox. Replaced once here, where every call passes,
// rather than at each call site; the original stays as the cause, for an
// admin's details.
const unreachable = (cause: unknown): Error =>
  new Error("Can't reach FeedFathom. Check your connection.", { cause });

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
        "detail" in payload ? payload.detail : undefined,
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
