import { registerRequestValidator } from "./validator";
import { createRequestHandler } from "$lib/create-request-handler";
import { registerHandler } from "./handler";

export const POST = createRequestHandler(
  registerRequestValidator,
  registerHandler,
);
