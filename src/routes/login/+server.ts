import { createRequestHandler } from "$lib/create-request-handler";
import { loginHandler } from "./handler";
import { LoginRequest } from "./validator";

export const POST = createRequestHandler(LoginRequest, loginHandler);
