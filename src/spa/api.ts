import type { StaticDecode, StaticEncode, TSchema } from "typebox";
import { Value } from "typebox/value";
import { errorResponse } from "#shared/contracts/responses.ts";

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

class InvalidResponseError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
  }
}

const ownFailure = (cause: unknown) =>
  cause instanceof InvalidResponseError ||
  (cause instanceof ApiError && cause.status >= 500 && cause.status !== 504);

export const messageOf = (cause: unknown, fallback: string) => {
  if (ownFailure(cause))
    return "The FeedFathom server ran into a problem. Try again in a moment.";
  return cause instanceof Error ? cause.message : fallback;
};

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

const unreachable = (cause: unknown): Error =>
  new Error("FeedFathom can't reach its server. Check your connection.", {
    cause,
  });

const raceGetAfterMs = 1000;

function raceGet(url: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = [];
    let pending = 0;
    const send = () => {
      const controller = new AbortController();
      controllers.push(controller);
      pending++;
      const signal = init.signal
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

type ApiInit<R extends TSchema> = Omit<RequestInit, "body"> & {
  onResponse?: (response: Response) => void;
  raceWhenStalled?: false;
} & (
    | { body?: BodyInit; json?: never; request?: never }
    | { json: StaticEncode<R>; request: R }
  );

function requestInit<R extends TSchema>(init: ApiInit<R>): RequestInit {
  const {
    json,
    onResponse: _onResponse,
    raceWhenStalled: _race,
    request: _request,
    ...rest
  } = init;
  if (json === undefined) return rest;
  const headers = new Headers(rest.headers);
  headers.set("Content-Type", "application/json");
  return { ...rest, body: JSON.stringify(json), headers };
}

const codecPresence = new WeakMap<TSchema, boolean>();

function containsCodec(node: unknown, seen: Set<object>): boolean {
  if (typeof node !== "object" || node === null || seen.has(node)) return false;
  seen.add(node);
  if ("~codec" in node) return true;
  if (Array.isArray(node))
    return node.some((item) => containsCodec(item, seen));
  for (const value of Object.values(node)) {
    if (containsCodec(value, seen)) return true;
  }
  return false;
}

function schemaHasCodec(schema: TSchema): boolean {
  const cached = codecPresence.get(schema);
  if (cached !== undefined) return cached;
  const result = containsCodec(schema, new Set());
  codecPresence.set(schema, result);
  return result;
}

export async function api<T extends TSchema, R extends TSchema = never>(
  path: string,
  schema: T,
  init: ApiInit<R> = {},
): Promise<StaticDecode<T>> {
  const sent = requestInit(init);
  let response: Response;
  try {
    response =
      (init.method ?? "GET") === "GET" && init.raceWhenStalled !== false
        ? await raceGet(`/api${path}`, sent)
        : await fetch(`/api${path}`, sent);
  } catch (cause) {
    if (isCancellation(cause, init.signal)) throw cause;
    throw unreachable(cause);
  }
  const payload = await responseJson(path, response, init.signal);

  if (!response.ok) {
    if (Value.Check(errorResponse, payload))
      throw new ApiError(
        payload.error ||
          response.statusText ||
          `Request failed (${response.status})`,
        response.status,
        payload.detail,
      );
    throw invalidResponse(path, "malformed error payload", response.status);
  }

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
  if (schemaHasCodec(schema)) {
    const decoded = Value.Decode(schema, payload);
    init.onResponse?.(response);
    return decoded;
  }
  init.onResponse?.(response);
  return payload;
}
