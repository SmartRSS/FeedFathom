import { z } from "zod";

export const deleteSourceValidator = z.object({
  removeSourceId: z.number(),
});

export type DeleteSourceBody = z.infer<typeof deleteSourceValidator>;
