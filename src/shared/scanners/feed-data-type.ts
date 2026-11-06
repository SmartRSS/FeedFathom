import { Type, type Static } from "typebox";

export const feedDataSchema = Type.Object(
  {
    title: Type.String(),
    url: Type.String(),
  },
  { additionalProperties: false },
);

export type FeedData = Static<typeof feedDataSchema>;
