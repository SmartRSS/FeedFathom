import { type User } from "../types/user-type";
import { json, type RequestEvent } from "@sveltejs/kit";
import * as v from "valibot";

export type UnauthenticatedRequestEvent<T> = ValidatedRequestEvent<T> & {
  body: T;
  locals: Omit<App.Locals, "user">;
};

export type ValidatedRequestEvent<T> = RequestEvent & {
  body: T;
  locals: App.Locals & { user: User };
};

/**
 * Creates a type-safe request handler with automatic request body validation
 * @param schema - Valibot schema for request body validation
 * @param handler - Request handler function to process validated requests
 * @returns A request handler function with built-in validation
 * @example
 * const handler = createRequestHandler(
 *   v.object({ email: v.string(), password: v.string() }),
 *   async (event) => {
 *     // event.body is now typed and validated
 *     return json({ success: true });
 *   }
 * );
 */
export const createRequestHandler = function <T extends v.GenericSchema>(
  schema: T,
  handler: (
    event: ValidatedRequestEvent<v.InferOutput<T>>,
  ) => Promise<Response>,
): (event: RequestEvent) => Promise<Response> {
  return async (event: RequestEvent) => {
    const request = event.request;

    try {
      const body = await request.json();
      const parseResult = v.safeParse(schema, body);
      if (!parseResult.success) {
        return json(
          { details: parseResult.issues, error: "Invalid input" },
          { status: 400 },
        );
      }

      return await handler({
        ...event,
        body: parseResult.output,
      } as ValidatedRequestEvent<v.InferOutput<T>>);
    } catch {
      return json({ error: "Invalid JSON payload" }, { status: 400 });
    }
  };
};
