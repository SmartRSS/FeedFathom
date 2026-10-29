import type * as auth from "#features/auth/services.ts";
import type * as runtime from "#platform/runtime.ts";
import type { Static } from "typebox";
import type { passwordRequest } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";

export async function postOptionsPasswordHandler(
  {
    body,
    user,
  }: {
    body: Static<typeof passwordRequest>;
    user: AuthedUser;
  },
  {
    password,
    usersDataService,
  }: Pick<typeof auth, "usersDataService"> & Pick<typeof runtime, "password">,
) {
  const account = await usersDataService.findUser(user.email);
  if (!account || !(await password.verify(body.oldPassword, account.password)))
    return json({ error: "Current password is incorrect." }, 400);
  const updated = await usersDataService.updatePassword(
    account.id,
    account.password,
    await password.hash(body.password1),
  );
  if (!updated) return json({ error: "Current password is incorrect." }, 400);
  return json({ success: true });
}
