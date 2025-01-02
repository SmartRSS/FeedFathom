import { type RequestHandler } from "@sveltejs/kit";
import { createRequestHandler } from "$lib/create-request-handler";
import { deleteSourceValidator } from "./validator";
import { deleteSourceHandler } from "./handler";

export const DELETE: RequestHandler = createRequestHandler(
  deleteSourceValidator,
  deleteSourceHandler,
);
