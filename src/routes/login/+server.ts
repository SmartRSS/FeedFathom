import { createRequestHandler } from "$lib/create-request-handler";
import { loginHandler } from "./handler.ts";
import { LoginRequest } from "./validator.ts";

export const POST = createRequestHandler(LoginRequest, loginHandler);
