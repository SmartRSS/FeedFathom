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
  // Gated on outgoing mail the same way public registration is: with no way
  // to deliver a link there is no flow, and the routes answer as they would
  // for an account that does not exist rather than admitting the difference.
  const mailEnabled = mailConfigured(config);

  return new Elysia()
    .post(
      "/api/password-reset",
      { body: passwordResetRequest },
      async ({ body: { email }, request, server }) => {
        // Always the same answer, whether or not the account exists, the
        // instance can send mail, or the request was throttled. Telling the
        // caller which would hand back the account list login already
        // withholds.
        const address = clientAddress(
          request,
          server,
          config.TRUSTED_PROXY_HEADER,
        );
        // This endpoint sends mail to an address the caller names, so it is
        // worth as much to an abuser as the login form is, and is bounded the
        // same way. Its own counters, though: a user whose first reset mail
        // went to spam and who asked again a few times must still be able to
        // log in with the password they then set.
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

        // Clearing the token and dropping every session happen with the write
        // itself, so the link is single-use and whoever knew the old password
        // is logged out by the same commit. The spent token is part of the
        // write's WHERE clause, so of two confirmations racing on one link
        // the first commit wins and the second is told the link is gone
        // (#809) -- never two passwords with the last write deciding.
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
