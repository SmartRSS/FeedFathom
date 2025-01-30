import { type RequestHandler } from "@sveltejs/kit";
import { createRequestHandler } from "$lib/create-request-handler";
import { SubscribeRequest } from "./validator";
import { subscribeHandler } from "./handler";

export const POST: RequestHandler = createRequestHandler(
  SubscribeRequest,
  subscribeHandler,
);
