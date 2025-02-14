import { type ValidatedRequestEvent } from "../app";
import { json, type RequestEvent } from "@sveltejs/kit";
import * as v from "valibot";

export function createRequestHandler<T extends v.GenericSchema>(
  schema: T,
  handler: (
    event: ValidatedRequestEvent<v.InferOutput<T>>,
  ) => Promise<Response>,
): (event: RequestEvent) => Promise<Response> {
  return async (event: RequestEvent) => {
    const request = event.request;

    const parseResult = v.safeParse(schema, await request.json());
    if (!parseResult.success) {
      return json(
        { details: parseResult.issues, error: "Invalid input" },
        { status: 400 },
      );
    }

    return handler({
      ...event,
      body: parseResult.output,
    } as ValidatedRequestEvent<v.InferOutput<T>>);
  };
}
