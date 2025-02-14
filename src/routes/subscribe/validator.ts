import * as v from "valibot";

export const SubscribeRequest = v.strictObject({
  sourceFolder: v.union([v.number(), v.null()]),
  sourceName: v.string(),
  sourceUrl: v.string(),
});

export type SubscribeRequest = v.InferOutput<typeof SubscribeRequest>;
