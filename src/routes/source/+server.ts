import { type RequestHandler } from "@sveltejs/kit";
import { createRequestHandler } from "$lib/create-request-handler";
import { DeleteSource } from "./validator";
import { deleteSourceHandler } from "./handler";

export const DELETE: RequestHandler = createRequestHandler(
  DeleteSource,
  deleteSourceHandler,
);
