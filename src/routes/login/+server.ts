import { createRequestHandler } from "$lib/create-request-handler";
import { LoginRequest } from "./validator";
import { loginHandler } from "./handler";

export const POST = createRequestHandler(LoginRequest, loginHandler);
