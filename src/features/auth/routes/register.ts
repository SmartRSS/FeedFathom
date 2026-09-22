import { fetcher, password } from "#platform/runtime.ts";
import {
  authThrottle,
  mailSender,
  usersDataService,
} from "#features/auth/services.ts";
import { config } from "#platform/config.ts";
import { randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { Value } from "typebox/value";
import { disposableEmailPolicy } from "#shared/validation/typebox-policy.ts";
import { registerRequest } from "#shared/contracts/requests.ts";
import { json } from "#platform/http/json.ts";
import { clientAddress } from "#features/auth/routes/client-address.ts";
import { digestToken } from "#shared/util/token-digest.ts";

const turnstileResponse = Type.Object(
  { success: Type.Boolean() },
  { additionalProperties: true },
);
const turnstileResponseCheck = Schema.Compile(turnstileResponse);

// The same windows the links themselves promise: a day for activation, an
// hour for a reset.
const activationLifetimeMs = 24 * 60 * 60 * 1_000;
const resetLifetimeMs = 60 * 60 * 1_000;

async function validateCaptcha(
  token: string | undefined,
  secret: string,
  fetcher: typeof globalThis.fetch,
) {
  if (!token) return false;
  try {
    const response = await fetcher(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
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
  } catch {
    return false;
  }
}

const registrationDisabled = () =>
  json({ error: "Registration is currently disabled", success: false }, 403);

export function createRegisterRoute() {
  const allowedEmailPolicy = Type.String(
    config.ALLOWED_EMAILS.length ? { enum: config.ALLOWED_EMAILS } : {},
  );
  const useEmailActivation = Boolean(
    config.MAILJET_API_KEY && config.MAILJET_API_SECRET,
  );

  return new Elysia()
    .get("/api/register", async () => {
      const count = await usersDataService.getUserCount();
      return json({
        passwordResetEnabled: Boolean(
          config.MAILJET_API_KEY && config.MAILJET_API_SECRET,
        ),
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
      async ({ body, request: httpRequest, server }) => {
        const request = Value.Decode(registerRequest, body);
        if (
          config.TURNSTILE_SECRET_KEY &&
          !(await validateCaptcha(
            request["cf-turnstile-response"],
            config.TURNSTILE_SECRET_KEY,
            fetcher,
          ))
        ) {
          return json({ error: "Invalid CAPTCHA", success: false }, 400);
        }
        const userCount = await usersDataService.getUserCount();
        if (userCount > 0 && !config.ENABLE_REGISTRATION)
          return registrationDisabled();
        if (!Value.Check(allowedEmailPolicy, request.email)) {
          return json({ error: "", success: false }, 403);
        }
        if (Value.Check(disposableEmailPolicy, request.email))
          return json({ success: true });

        // With email activation enabled, throttle before any mail or password
        // hashing. Exempt first-user setup to avoid locking out the operator.
        if (useEmailActivation && userCount > 0) {
          const address = clientAddress(
            httpRequest,
            server,
            config.TRUSTED_PROXY_HEADER,
          );
          // Same generic body as a disposable address or an existing account,
          // so being throttled is not itself an answer about who exists.
          if (await authThrottle.blocked("register", address, request.email))
            return json({ success: true });
          await authThrottle.recordFailure("register", address, request.email);
        }

        const existing = await usersDataService.findUser(request.email);
        if (existing) {
          // Return generic success for existing accounts (#810). With mail
          // enabled, renew missing or expired activation links for inactive
          // accounts and send reset links for active accounts. Leave valid
          // activation links unchanged.
          if (useEmailActivation) {
            if (existing.status === "inactive") {
              const expired =
                !existing.activationTokenExpiresAt ||
                existing.activationTokenExpiresAt < new Date();
              if (expired) {
                const activationToken = randomUUID();
                const activationTokenExpiresAt = new Date(
                  Date.now() + activationLifetimeMs,
                );
                // Persist the replacement token before sending a link to it.
                await usersDataService.refreshActivationToken(
                  existing.id,
                  activationToken,
                  activationTokenExpiresAt,
                );
                await mailSender.sendActivationEmail(
                  existing.email,
                  activationToken,
                );
              }
            } else {
              const resetToken = randomUUID();
              await usersDataService.startPasswordReset(
                existing.id,
                digestToken(resetToken),
                new Date(Date.now() + resetLifetimeMs),
              );
              await mailSender.sendAccountExistsEmail(
                existing.email,
                resetToken,
              );
            }
          }
          return json({ success: true });
        }

        const passwordHash = await password.hash(request.password);
        const activationToken = useEmailActivation ? randomUUID() : null;
        const outcome = await usersDataService.createUser(
          {
            email: request.email,
            name: request.username,
            passwordHash,
            ...(activationToken
              ? {
                  activationToken,
                  activationTokenExpiresAt: new Date(
                    Date.now() + activationLifetimeMs,
                  ),
                  status: "inactive",
                }
              : { status: "active" }),
          },
          config.ENABLE_REGISTRATION,
        );
        if (outcome === "closed") return registrationDisabled();
        // Lost a same-address race: the same answer an existing account gets.
        if (outcome === "exists") return json({ success: true });
        // Mail only once the row holding its token is committed. If delivery
        // fails, withdraw the token so the next registration attempt for this
        // address is treated as an expired link and sends a fresh one.
        if (activationToken) {
          try {
            await mailSender.sendActivationEmail(
              request.email,
              activationToken,
            );
          } catch (error) {
            await usersDataService.withdrawActivationToken(activationToken);
            throw error;
          }
        }
        return json({ success: true });
      },
    );
}
