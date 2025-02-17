import { createRequestHandler } from "$lib/create-request-handler";
import { subscribeHandler } from "./handler";
import { SubscribeRequest } from "./validator";
import { type RequestHandler } from "@sveltejs/kit";

export const POST: RequestHandler = createRequestHandler(
  SubscribeRequest,
  subscribeHandler,
);
