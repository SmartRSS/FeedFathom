import { z } from "zod";

export const loginRequestValidator = z.object({
  email: z.string().email(),
  password: z.string(),
});
