import { type } from "arktype";

export const SubscribeRequest = type({
  sourceFolder: "number | null",
  sourceName: "string",
  sourceUrl: "string",
  "+": "reject",
});

export type SubscribeRequest = typeof SubscribeRequest.infer;
