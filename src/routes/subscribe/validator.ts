import {
  type InferOutput,
  null as n,
  number,
  strictObject,
  string,
  union,
} from "valibot";

export const SubscribeRequest = strictObject({
  sourceFolder: union([number(), n()]),
  sourceName: string(),
  sourceUrl: string(),
});

export type SubscribeRequest = InferOutput<typeof SubscribeRequest>;
