import type { Static } from "typebox";
import type { passwordRequest } from "#shared/contracts/requests.ts";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import { type AuthedUser, json } from "../shared.ts";

type Password = {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
};

export type OptionsPasswordRouteDependencies = {
  password: Password;
  usersDataService: {
    findUser(email: string): ReturnType<UsersDataService["findUser"]>;
    updatePassword(userId: number, passwordHash: string): Promise<unknown>;
  };
};

export async function postOptionsPasswordHandler(
  { body, user }: { body: Static<typeof passwordRequest>; user: AuthedUser },
  { password, usersDataService }: OptionsPasswordRouteDependencies,
) {
  const account = await usersDataService.findUser(user.email);
  if (!account || !(await password.verify(body.oldPassword, account.password)))
    return json({ error: "Current password is incorrect." }, 400);
  await usersDataService.updatePassword(
    account.id,
    await password.hash(body.password1),
  );
  return json({ success: true });
}
