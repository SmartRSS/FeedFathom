import type * as runtime from "#platform/runtime.ts";
import type * as auth from "#features/auth/services.ts";
import type { AppConfig } from "#platform/config.ts";
import { mailConfigured, sendLater } from "#features/auth/mail-sender.ts";
import { Elysia } from "elysia";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { isDisposableEmail } from "disposable-email-domains-js";
import { registerRequest } from "#shared/contracts/requests.ts";
import { turnstileOrigin } from "#shared/contracts/turnstile.ts";
import { json, jsonError } from "#platform/http/json.ts";
import {
  registrationResponse,
  successResponse,
} from "#shared/contracts/responses.ts";
import { clientAddress } from "#features/auth/routes/client-address.ts";
import {
  activationLifetimeMs,
  issueToken,
} from "#features/auth/account-tokens.ts";

const turnstileResponse = Type.Object(
  { success: Type.Boolean() },
  { additionalProperties: true },
);
const turnstileResponseCheck = Schema.Compile(turnstileResponse);

async function validateCaptcha(
  token: string | undefined,
  secret: string,
  fetchFn: (typeof runtime)["fetcher"],
) {
  if (!token) return false;
  try {
    const response = await fetchFn(
      new URL("/turnstile/v0/siteverify", turnstileOrigin),
      {
        body: JSON.stringify({ response: token, secret }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const result: unknown = await response.json();
    return (
      response.ok && turnstileResponseCheck.Check(result) && result.success
    );
  } catch (error) {
    console.error("Turnstile verification failed:", error);
    return false;
  }
}

const registrationDisabled = () =>
  jsonError("Registration is currently disabled", 403);
const accepted = () => json(successResponse, { success: true });

export function createRegisterRoute({
  authThrottle,
  config,
  fetcher,
  mailSender,
  password,
  usersDataService,
}: Pick<typeof auth, "authThrottle" | "mailSender" | "usersDataService"> &
  Pick<typeof runtime, "fetcher" | "password"> & { config: AppConfig }) {
  const sendActivation = (email: string, token: string) => {
    sendLater(
      "Activation",
      () => mailSender.sendActivationEmail(email, token),
      () => usersDataService.withdrawActivationToken(token),
    );
  };

  const useEmailActivation = mailConfigured(config);

  return new Elysia()
    .get("/api/register", async () => {
      const count = await usersDataService.getUserCount();
      return json(registrationResponse, {
        passwordResetEnabled: useEmailActivation,
        registrationStatus:
          count === 0
            ? "FIRST_USER"
            : config.ENABLE_REGISTRATION
              ? "ENABLED"
              : "DISABLED",
        turnstileSiteKey: config.TURNSTILE_SITE_KEY ?? null,
      });
    })
    .post(
      "/api/register",
      { body: registerRequest },
      async ({ body: request, request: httpRequest, server }) => {
        if (
          config.TURNSTILE_SECRET_KEY &&
          !(await validateCaptcha(
            request["cf-turnstile-response"],
            config.TURNSTILE_SECRET_KEY,
            fetcher,
          ))
        ) {
          return jsonError("Invalid CAPTCHA", 400);
        }
        const userCount = await usersDataService.getUserCount();
        if (userCount > 0 && !config.ENABLE_REGISTRATION)
          return registrationDisabled();
        if (
          config.ALLOWED_EMAILS.length > 0 &&
          !config.ALLOWED_EMAILS.includes(request.email)
        ) {
          return jsonError("This email address may not register", 403);
        }
        if (isDisposableEmail(request.email)) return accepted();

        if (userCount > 0) {
          const address = clientAddress(
            httpRequest,
            server,
            config.TRUSTED_PROXY_HEADER,
          );
          if (!(await authThrottle.attempt("register", address, request.email)))
            return jsonError("Too many attempts. Try again later.", 429);
        }

        const passwordHash = await password.hash(request.password);
        const existing = await usersDataService.findUser(request.email);
        if (existing) {
          if (useEmailActivation) {
            if (existing.status === "inactive") {
              const { expiresAt, token } = issueToken(activationLifetimeMs);
              if (
                await usersDataService.refreshActivationToken(
                  existing.id,
                  token,
                  expiresAt,
                )
              )
                sendActivation(existing.email, token);
            } else {
              const resetToken = await usersDataService.startPasswordReset(
                existing.id,
              );
              sendLater("Account-exists", () =>
                mailSender.sendAccountExistsEmail(existing.email, resetToken),
              );
            }
          }
          return accepted();
        }

        const activation = useEmailActivation
          ? issueToken(activationLifetimeMs)
          : undefined;
        const outcome = await usersDataService.createUser(
          {
            email: request.email,
            name: request.username,
            passwordHash,
            ...(activation
              ? {
                  activationToken: activation.token,
                  activationTokenExpiresAt: activation.expiresAt,
                  status: "inactive",
                }
              : { status: "active" }),
          },
          config.ENABLE_REGISTRATION,
        );
        if (outcome === "closed") return registrationDisabled();
        if (outcome === "exists") return accepted();
        if (activation) sendActivation(request.email, activation.token);
        return accepted();
      },
    );
}
