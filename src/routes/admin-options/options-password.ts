import { Elysia } from "elysia";
import { passwordRequest } from "../../contracts/requests.ts";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import { createAuthPlugin, json } from "../shared.ts";

type Password = {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
};

export type OptionsPasswordRouteDependencies = {
  password: Password;
  usersDataService: {
    findUser(email: string): ReturnType<UsersDataService["findUser"]>;
    getUserBySid(sid: string): ReturnType<UsersDataService["getUserBySid"]>;
    updatePassword(userId: number, passwordHash: string): Promise<unknown>;
  };
};

export function createOptionsPasswordRoute({
  password,
  usersDataService,
}: OptionsPasswordRouteDependencies) {
  return new Elysia().use(createAuthPlugin(usersDataService)).post(
    "/api/options/password",
    { body: passwordRequest },
    async ({ body, user }) => {
      const account = await usersDataService.findUser(user.email);
      if (
        !account ||
        !(await password.verify(body.oldPassword, account.password))
      )
        return json({ success: false }, 400);
      await usersDataService.updatePassword(
        account.id,
        await password.hash(body.password1),
      );
      return json({ success: true });
    },
  );
}
