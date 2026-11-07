import type * as auth from "#features/auth/services.ts";
import { Elysia } from "elysia";
import { activationParams } from "#shared/contracts/requests.ts";
import { json, jsonError } from "#platform/http/json.ts";
import { successResponse } from "#shared/contracts/responses.ts";

export function createActivateRoute({
  usersDataService,
}: Pick<typeof auth, "usersDataService">) {
  return new Elysia().post(
    "/api/activate/:token",
    { params: activationParams },
    async ({ params: decoded }) => {
      if (!(await usersDataService.activate(decoded.token)))
        return jsonError("Invalid activation token.", 400);
      return json(successResponse, { success: true });
    },
  );
}
