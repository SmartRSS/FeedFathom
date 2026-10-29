import type * as auth from "#features/auth/services.ts";
import { Elysia } from "elysia";
import { activationParams } from "#shared/contracts/requests.ts";
import { json } from "#platform/http/json.ts";

export function createActivateRoute({
  usersDataService,
}: Pick<typeof auth, "usersDataService">) {
  return new Elysia().post(
    "/api/activate/:token",
    { params: activationParams },
    async ({ params: decoded }) => {
      const user = await usersDataService.findUserByActivationToken(
        decoded.token,
      );
      if (
        !user ||
        user.status === "active" ||
        !user.activationTokenExpiresAt ||
        user.activationTokenExpiresAt < new Date()
      ) {
        return json({ error: "Invalid activation token." }, 400);
      }
      await usersDataService.activateUser(user.id);
      return json({ success: true });
    },
  );
}
