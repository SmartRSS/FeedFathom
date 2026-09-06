import { createHash, randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import { Value } from "typebox/value";
import {
  passwordResetConfirmRequest,
  passwordResetRequest,
} from "#shared/contracts/requests.ts";
import type { AppConfig } from "#platform/config.ts";
import { json } from "#platform/http/json.ts";
import type { UsersDataService } from "#features/auth/user-data-service.ts";
import type { LoginThrottle } from "#features/auth/login-throttle.ts";
import type { MailSender } from "#features/auth/mail-sender.ts";
import { clientAddress } from "#features/auth/routes/client-address.ts";

const tokenLifetimeMs = 60 * 60 * 1_000;

// Only the digest is stored, so what arrives in a link has to be reduced the
// same way to look it up. SHA-256 unsalted and unstretched: the token is 122
// random bits from randomUUID, so there is no dictionary to defend against.
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export type PasswordResetRouteDependencies = {
  config: Pick<
    AppConfig,
    "MAILJET_API_KEY" | "MAILJET_API_SECRET" | "TRUSTED_PROXY_HEADER"
  >;
  loginThrottle: Pick<LoginThrottle, "blocked" | "recordFailure">;
  mailSender: Pick<MailSender, "sendPasswordResetEmail">;
  password: { hash(password: string): Promise<string> };
  usersDataService: {
    completePasswordReset(userId: number, passwordHash: string): Promise<void>;
    findUser(email: string): ReturnType<UsersDataService["findUser"]>;
    findUserByPasswordResetToken(
      tokenHash: string,
    ): ReturnType<UsersDataService["findUserByPasswordResetToken"]>;
    startPasswordReset(
      userId: number,
      tokenHash: string,
      expiresAt: Date,
    ): Promise<void>;
  };
};

export function createPasswordResetRoute({
  config,
  loginThrottle,
  mailSender,
  password,
  usersDataService,
}: PasswordResetRouteDependencies) {
  // Gated on outgoing mail the same way public registration is: with no way
  // to deliver a link there is no flow, and the routes answer as they would
  // for an account that does not exist rather than admitting the difference.
  const mailConfigured = Boolean(
    config.MAILJET_API_KEY && config.MAILJET_API_SECRET,
  );

  return new Elysia()
    .post(
      "/api/password-reset",
      { body: passwordResetRequest },
      async ({ body, request, server }) => {
        const { email } = Value.Decode(passwordResetRequest, body);
        // Always the same answer, whether or not the account exists, the
        // instance can send mail, or the request was throttled. Telling the
        // caller which would hand back the account list login already
        // withholds.
        const accepted = json({ success: true });
        const address = clientAddress(
          request,
          server,
          config.TRUSTED_PROXY_HEADER,
        );
        // This endpoint sends mail to an address the caller names, so it is
        // worth as much to an abuser as the login form is. The same counters
        // bound both: a run of resets from one place stops for the same
        // fifteen minutes a run of guesses does.
        if (!mailConfigured || (await loginThrottle.blocked(address, email))) {
          return accepted;
        }
        await loginThrottle.recordFailure(address, email);

        const user = await usersDataService.findUser(email);
        if (user?.status !== "active") return accepted;

        const token = randomUUID();
        await usersDataService.startPasswordReset(
          user.id,
          digest(token),
          new Date(Date.now() + tokenLifetimeMs),
        );
        await mailSender.sendPasswordResetEmail(user.email, token);
        return accepted;
      },
    )
    .post(
      "/api/password-reset/confirm",
      { body: passwordResetConfirmRequest },
      async ({ body }) => {
        const parsed = Value.Decode(passwordResetConfirmRequest, body);
        const invalid = json(
          { error: "This reset link is no longer valid." },
          400,
        );
        if (!mailConfigured) return invalid;

        const user = await usersDataService.findUserByPasswordResetToken(
          digest(parsed.token),
        );
        if (
          user?.status !== "active" ||
          !user.passwordResetTokenExpiresAt ||
          user.passwordResetTokenExpiresAt < new Date()
        ) {
          return invalid;
        }

        // Clearing the token and dropping every session happen with the write
        // itself, so the link is single-use and whoever knew the old password
        // is logged out by the same commit.
        await usersDataService.completePasswordReset(
          user.id,
          await password.hash(parsed.password1),
        );
        return json({ success: true });
      },
    );
}
