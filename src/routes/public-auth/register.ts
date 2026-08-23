import { randomUUID } from "node:crypto";
import { Elysia } from "elysia";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { Value } from "typebox/value";
import { disposableEmailPolicy } from "#shared/validation/typebox-policy.ts";
import { registerRequest } from "#shared/contracts/requests.ts";
import type { AppConfig } from "#platform/config.ts";
import { json } from "#platform/http/json.ts";
import type { UsersDataService } from "../../db/data-services/user-data-service.ts";
import type { MailSender } from "../../lib/email/mail-sender.ts";

const turnstileResponse = Type.Object(
  { success: Type.Boolean() },
  { additionalProperties: true },
);
const turnstileResponseCheck = Schema.Compile(turnstileResponse);

export type RegisterRouteDependencies = {
  config: AppConfig;
  fetcher: (
    ...args: Parameters<typeof globalThis.fetch>
  ) => ReturnType<typeof globalThis.fetch>;
  mailSender: Pick<MailSender, "sendActivationEmail">;
  password: { hash(password: string): Promise<string> };
  usersDataService: {
    createUser(
      payload: Parameters<UsersDataService["createUser"]>[0],
    ): Promise<unknown>;
    findUser(email: string): ReturnType<UsersDataService["findUser"]>;
    getUserCount(): Promise<number>;
  };
};

async function validateCaptcha(
  token: string | undefined,
  secret: string,
  fetcher: RegisterRouteDependencies["fetcher"],
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

export function createRegisterRoute({
  config,
  fetcher,
  mailSender,
  password,
  usersDataService,
}: RegisterRouteDependencies) {
  const allowedEmailPolicy = Type.String(
    config.ALLOWED_EMAILS.length ? { enum: config.ALLOWED_EMAILS } : {},
  );

  return new Elysia()
    .get("/api/register", async () => {
      const count = await usersDataService.getUserCount();
      return json({
        registrationStatus:
          count === 0
            ? "FIRST_USER"
            : config.ENABLE_REGISTRATION
              ? "ENABLED"
              : "DISABLED",
        turnstileSiteKey: config.TURNSTILE_SITE_KEY ?? null,
      });
    })
    .post("/api/register", { body: registerRequest }, async ({ body }) => {
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
      if (
        (await usersDataService.getUserCount()) > 0 &&
        !config.ENABLE_REGISTRATION
      ) {
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

      const existing = await usersDataService.findUser(request.email);
      if (existing) return json({ success: true });

      const passwordHash = await password.hash(request.password);
      const useEmailActivation = Boolean(
        config.MAILJET_API_KEY && config.MAILJET_API_SECRET,
      );
      if (useEmailActivation) {
        const activationToken = randomUUID();
        const activationTokenExpiresAt = new Date(
          Date.now() + 24 * 60 * 60 * 1_000,
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
    });
}
