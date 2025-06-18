import { json, type RequestEvent } from "@sveltejs/kit";
import { type Type, type } from "arktype";
import type { User } from "../types/user-type.ts";

export type UnauthenticatedRequestEvent<T> = ValidatedRequestEvent<T> & {
  body: T;
  locals: Omit<App.Locals, "user">;
};

export type ValidatedRequestEvent<T> = RequestEvent & {
  body: T;
  locals: App.Locals & { user: User };
};

export const createRequestHandler = <T extends Type>(
  schema: T,
  handler: (event: ValidatedRequestEvent<T["infer"]>) => Promise<Response>,
): ((event: RequestEvent) => Promise<Response>) => {
  return async (event: RequestEvent) => {
    const request = event.request;

    const parseResult = schema(await request.json());
    if (parseResult instanceof type.errors) {
      return json(
        { details: parseResult.summary, error: "Invalid input" },
        { status: 400 },
      );
    }

    return await handler({
      ...event,
      body: parseResult,
    } as ValidatedRequestEvent<T["infer"]>);
  };
};
