import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "../shared.ts";

export function getOptionsHandler({ user }: { user: AuthedUser }) {
  return json({ user });
}
