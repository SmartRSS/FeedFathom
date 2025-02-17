import { createRequestHandler } from "$lib/create-request-handler";
import { registerHandler } from "./handler";
import { RegisterRequest } from "./validator";

export const POST = createRequestHandler(RegisterRequest, registerHandler);
