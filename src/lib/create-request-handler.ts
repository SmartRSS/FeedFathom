import { type RequestEvent, json } from "@sveltejs/kit";
import { type GenericSchema, type InferOutput, safeParse } from "valibot";
import type { User } from "../types/user-type.ts";

export type UnauthenticatedRequestEvent<T> = ValidatedRequestEvent<T> & {
  body: T;
  locals: Omit<App.Locals, "user">;
};

export type ValidatedRequestEvent<T> = RequestEvent & {
  body: T;
  locals: App.Locals & { user: User };
};

export const createRequestHandler = <T extends GenericSchema>(
  schema: T,
  handler: (event: ValidatedRequestEvent<InferOutput<T>>) => Promise<Response>,
): ((event: RequestEvent) => Promise<Response>) => {
  return async (event: RequestEvent) => {
    const request = event.request;

    const parseResult = safeParse(schema, await request.json());
    if (!parseResult.success) {
      return json(
        { details: parseResult.issues, error: "Invalid input" },
        { status: 400 },
      );
    }

    return await handler({
      ...event,
      body: parseResult.output,
    } as ValidatedRequestEvent<InferOutput<T>>);
  };
};
