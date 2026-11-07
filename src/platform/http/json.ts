import type { StaticEncode, TSchema } from "typebox";
import { errorResponse } from "#shared/contracts/responses.ts";

// What a value may hold before Response.json serialises it: a Date wherever
// the contract has a string, since that is what a JSON date becomes, and
// undefined for an optional field, which JSON drops.
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

/**
 * A JSON answer typed against its contract in #shared/contracts, so a handler
 * that drifts from what clients decode fails to compile. The schema is not
 * checked at runtime.
 */
export function json<Schema extends TSchema>(
  _schema: Schema,
  value: Serialisable<StaticEncode<Schema>>,
  status = 200,
  headers?: HeadersInit,
) {
  return Response.json(value, headers ? { headers, status } : { status });
}

// What a request the schema refuses is told, whatever check refused it.
export const invalidRequestMessage = "Invalid request.";

export function jsonError(
  error: string,
  status: number,
  headers?: HeadersInit,
) {
  return json(errorResponse, { error }, status, headers);
}
