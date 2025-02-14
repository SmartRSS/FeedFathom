import { createRequestHandler } from "$lib/create-request-handler";
import { deleteSourceHandler } from "./handler";
import { DeleteSource } from "./validator";
import { type RequestHandler } from "@sveltejs/kit";

export const DELETE: RequestHandler = createRequestHandler(
  DeleteSource,
  deleteSourceHandler,
);
