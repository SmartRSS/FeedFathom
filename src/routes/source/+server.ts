import { createRequestHandler } from "$lib/create-request-handler";
import type { RequestHandler } from "@sveltejs/kit";
import { deleteSourceHandler } from "./handler.ts";
import { DeleteSource } from "./validator.ts";

export const DELETE: RequestHandler = createRequestHandler(
  DeleteSource,
  deleteSourceHandler,
);
