import { type AuthedUser, json } from "../shared.ts";

export function getOptionsHandler({ user }: { user: AuthedUser }) {
  return json({ user });
}
