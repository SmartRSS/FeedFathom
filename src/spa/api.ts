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

const invalidResponse = (
  path: string,
  message: string,
  status?: number,
): Error =>
  new Error(
    `Invalid response from /api${path}${status === undefined ? "" : ` (${status})`}: ${message}`,
  );

async function responseJson(
  path: string,
  response: Response,
): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw invalidResponse(path, "expected JSON", response.status);
  }
}

export async function api<T extends TSchema>(
  path: string,
  schema: T,
  init?: RequestInit,
  preloaded?: Promise<Response>,
): Promise<StaticDecode<T>> {
  const response = await (preloaded ?? fetch(`/api${path}`, init));
  const payload = await responseJson(path, response);

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
