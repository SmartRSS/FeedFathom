import { Elysia } from "elysia";
import { Value } from "typebox/value";
import { activationParams } from "#shared/contracts/requests.ts";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import { json } from "../shared.ts";

export type ActivateRouteDependencies = {
  usersDataService: {
    activateUser(userId: number): Promise<unknown>;
    findUserByActivationToken(
      token: string,
    ): ReturnType<UsersDataService["findUserByActivationToken"]>;
  };
};

export function createActivateRoute({
  usersDataService,
}: ActivateRouteDependencies) {
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
