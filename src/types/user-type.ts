import type * as schema from "../db/schemas/users";

export type User = Omit<typeof schema.users.$inferSelect, "password">;
