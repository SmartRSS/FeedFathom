import { z } from "zod";

export const subscribeRequestBodyValidator = z.object({
  sourceUrl: z.string(),
  sourceName: z.string(),
  sourceFolder: z.union([z.number(), z.null()]),
});
