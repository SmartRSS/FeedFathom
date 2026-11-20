import type { StaticEncode, TSchema } from "typebox";
import { errorResponse } from "#shared/contracts/responses.ts";

type Serialisable<T> = T extends string
  ? Date | T
  : T extends readonly unknown[]
    ? { [Index in keyof T]: Serialisable<T[Index]> }
    : T extends object
      ? {
          [Key in keyof T]:
            | Serialisable<T[Key]>
            | (object extends Pick<T, Key> ? undefined : never);
        }
      : T;

export function json<Schema extends TSchema>(
  _schema: Schema,
  value: Serialisable<StaticEncode<Schema>>,
  status = 200,
  headers?: HeadersInit,
) {
  return Response.json(value, headers ? { headers, status } : { status });
}

export const invalidRequestMessage = "Invalid request.";

export function jsonError(
  error: string,
  status: number,
  headers?: HeadersInit,
) {
  return json(errorResponse, { error }, status, headers);
}
