import { usersDataService } from "#features/auth/services.ts";
import { Elysia } from "elysia";
import { Value } from "typebox/value";
import { activationParams } from "#shared/contracts/requests.ts";
import { json } from "#platform/http/json.ts";

export function createActivateRoute() {
  return new Elysia().post(
    "/api/activate/:token",
    { params: activationParams },
    async ({ params }) => {
      const decoded = Value.Decode(activationParams, params);
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
