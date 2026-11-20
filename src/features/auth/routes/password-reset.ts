import type * as runtime from "#platform/runtime.ts";
import type * as auth from "#features/auth/services.ts";
import type { AppConfig } from "#platform/config.ts";
import { mailConfigured, sendLater } from "#features/auth/mail-sender.ts";
import { Elysia } from "elysia";
import {
  passwordResetConfirmRequest,
  passwordResetRequest,
} from "#shared/contracts/requests.ts";
import { json, jsonError } from "#platform/http/json.ts";
import { successResponse } from "#shared/contracts/responses.ts";
import { clientAddress } from "#features/auth/routes/client-address.ts";
import { digestToken } from "#features/auth/account-tokens.ts";

const accepted = () => json(successResponse, { success: true });
const invalid = () => jsonError("This reset link is no longer valid.", 400);

export function createPasswordResetRoute({
  authThrottle,
  config,
  mailSender,
  password,
  usersDataService,
}: Pick<typeof auth, "authThrottle" | "mailSender" | "usersDataService"> &
  Pick<typeof runtime, "password"> & { config: AppConfig }) {
  const mailEnabled = mailConfigured(config);

  return new Elysia()
    .post(
      "/api/password-reset",
      { body: passwordResetRequest },
      async ({ body: { email }, request, server }) => {
        const address = clientAddress(
          request,
          server,
          config.TRUSTED_PROXY_HEADER,
        );
        if (
          !mailEnabled ||
          !(await authThrottle.attempt("password-reset", address, email))
        ) {
          return accepted();
        }

        const user = await usersDataService.findUser(email);
        if (user?.status !== "active") return accepted();

        const token = await usersDataService.startPasswordReset(user.id);
        sendLater("Password reset", () =>
          mailSender.sendPasswordResetEmail(user.email, token),
        );
        return accepted();
      },
    )
    .post(
      "/api/password-reset/confirm",
      { body: passwordResetConfirmRequest },
      async ({ body: parsed }) => {
        if (!mailEnabled) return invalid();

        const user = await usersDataService.findUserByPasswordResetToken(
          digestToken(parsed.token),
        );
        if (!user) return invalid();

        const spent = await usersDataService.completePasswordReset(
          user.id,
          digestToken(parsed.token),
          await password.hash(parsed.password1),
        );
        if (!spent) return invalid();
        return json(successResponse, { success: true });
      },
    );
}
