import { z, ZodSchema } from "zod";
import { json, type RequestEvent } from "@sveltejs/kit";
import type { ValidatedRequestEvent } from "../app";

export function createRequestHandler<T extends ZodSchema>(
  schema: T,
  handler: (event: ValidatedRequestEvent<z.infer<T>>) => Promise<Response>,
): (event: RequestEvent) => Promise<Response> {
  return async (event: RequestEvent) => {
    const request = event.request;

    // Validate the request body
    const parseResult = schema.safeParse(await request.json());
    if (!parseResult.success) {
      return json(
        { error: "Invalid input", details: parseResult.error.errors },
        { status: 400 },
      );
    }
    return handler({
      ...event,
      request: { ...event.request, body: parseResult.data },
    } as ValidatedRequestEvent<z.infer<T>>);
  };
}
