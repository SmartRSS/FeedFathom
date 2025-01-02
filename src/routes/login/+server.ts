import { createRequestHandler } from "$lib/create-request-handler";
import { loginRequestValidator } from "./validator";
import { loginHandler } from "./handler";

export const POST = createRequestHandler(loginRequestValidator, loginHandler);
