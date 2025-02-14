import type * as schema from "$lib/schema";

export type User = Omit<typeof schema.users.$inferSelect, "password">;
