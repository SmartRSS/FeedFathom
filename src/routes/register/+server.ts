import { createRequestHandler } from "$lib/create-request-handler";
import { registerHandler } from "./handler.ts";
import { RegisterRequest } from "./validator.ts";

export const POST = createRequestHandler(RegisterRequest, registerHandler);
