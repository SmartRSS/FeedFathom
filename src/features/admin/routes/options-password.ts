import { usersDataService } from "#features/auth/services.ts";
import { password } from "#platform/runtime.ts";
import type { Static } from "typebox";
import type { passwordRequest } from "#shared/contracts/requests.ts";
import { type AuthedUser } from "#features/auth/session-plugin.ts";
import { json } from "#platform/http/json.ts";

export async function postOptionsPasswordHandler({
  body,
  user,
}: {
  body: Static<typeof passwordRequest>;
  user: AuthedUser;
}) {
  const account = await usersDataService.findUser(user.email);
  if (!account || !(await password.verify(body.oldPassword, account.password)))
    return json({ error: "Current password is incorrect." }, 400);
  await usersDataService.updatePassword(
    account.id,
    await password.hash(body.password1),
  );
  return json({ success: true });
}
