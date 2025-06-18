import type * as schema from "../lib/db/schemas/users";

export type User = Omit<typeof schema.users.$inferSelect, "password">;
