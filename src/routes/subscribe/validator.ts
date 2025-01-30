import * as v from "valibot";

export const SubscribeRequest = v.strictObject({
  sourceUrl: v.string(),
  sourceName: v.string(),
  sourceFolder: v.union([v.number(), v.null()]),
});

export type SubscribeRequest = v.InferOutput<typeof SubscribeRequest>;
