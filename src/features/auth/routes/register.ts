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
        if (userCount > 0 && !config.ENABLE_REGISTRATION) {
          return json(
            { error: "Registration is currently disabled", success: false },
            403,
          );
        }
        if (!Value.Check(allowedEmailPolicy, request.email)) {
          return json({ error: "", success: false }, 403);
        }
        if (Value.Check(disposableEmailPolicy, request.email))
          return json({ success: true });

        // The only thing worth abusing here is the send: who may hold an
        // account is settled by the checks above, but every mail this route
        // can produce -- a fresh activation, an account-exists notice with a
        // reset link, a first activation -- goes to an address the caller
        // named, from this instance's domain. So the count sits ahead of all
        // of them, and ahead of the password hash an attempt would otherwise
        // make us pay for. On an empty instance there is nobody to send to
        // but the first operator, who has no second address to try and must
        // not be locked out of their own install, so the count does not
        // start until they exist.
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
          // Registering again answers success whatever the truth is, so the
          // address's own state decides what the mailbox receives (#810): a
          // still-pending registration whose link has expired gets a fresh
          // one -- otherwise the person is stuck outside an account that is
          // half-made and can never be activated -- and an active account
          // gets a reset link, the only way in that does not assume the
          // password still works. A pending registration whose link is still
          // good needs nothing: the first mail already covers it. None of
          // this exists on an install that cannot send mail, where account
          // recovery never had a channel to begin with.
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
                // Stored before it is sent, unlike a first registration
                // where a failed write leaves nothing to be locked out of:
                // here the mail would land on a token the row never took,
                // putting the address back in the dead end it just asked to
                // leave -- one throttle slot poorer.
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
        if (useEmailActivation) {
          const activationToken = randomUUID();
          const activationTokenExpiresAt = new Date(
            Date.now() + activationLifetimeMs,
          );
          await mailSender.sendActivationEmail(request.email, activationToken);
          await usersDataService.createUser({
            activationToken,
            activationTokenExpiresAt,
            email: request.email,
            name: request.username,
            passwordHash,
            status: "inactive",
          });
        } else {
          await usersDataService.createUser({
            email: request.email,
            name: request.username,
            passwordHash,
            status: "active",
          });
        }
        return json({ success: true });
      },
    );
}
