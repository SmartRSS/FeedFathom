import { Elysia } from "elysia";
import { Value } from "typebox/value";
import { loginRequest } from "../../contracts/requests.ts";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import { json } from "../shared.ts";
import { sessionHeader } from "./session-header.ts";

type Password = {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
};

export type LoginRouteDependencies = {
  password: Password;
  secureCookies: boolean;
  usersDataService: {
    createSession(userId: number, userAgent?: null | string): Promise<string>;
    findUser(email: string): ReturnType<UsersDataService["findUser"]>;
  };
};

export function createLoginRoute({
  password,
  secureCookies,
  usersDataService,
}: LoginRouteDependencies) {
  return new Elysia().post(
    "/api/login",
    { body: loginRequest },
    async ({ body }) => {
      // Elysia 2.0-beta doesn't run Codec .Decode() transforms on bodies.
      const request = Value.Decode(loginRequest, body);
      const user = await usersDataService.findUser(request.email);
      if (
        !user ||
        !(await password.verify(request.password, user.password)) ||
        user.status !== "active"
      ) {
        if (!user) await password.hash(request.password);
        return json({ error: "Wrong login data" }, 401);
      }

      const sid = await usersDataService.createSession(user.id, "");
      return json({ sid }, 200, {
        "set-cookie": sessionHeader(sid, secureCookies),
      });
    },
  );
}
