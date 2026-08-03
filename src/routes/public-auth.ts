import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Type } from "typebox";
import Schema from "typebox/schema";
import { Value } from "typebox/value";
import { Elysia } from "elysia";
import type { AppConfig } from "../config.ts";
import {
  activationParams,
  incomingMailRequest,
  loginRequest,
  registerRequest,
} from "../contracts/requests.ts";
import type { UsersDataService } from "../db/data-services/user-data-service.ts";
import type { EmailHandler } from "../lib/email/email-handler.ts";
import type { MailSender } from "../lib/email/mail-sender.ts";
import { disposableEmailPolicy } from "../lib/typebox-policy.ts";
import { json, userFor } from "./shared.ts";
const turnstileResponse = Type.Object(
  { success: Type.Boolean() },
  { additionalProperties: true },
);
const turnstileResponseCheck = Schema.Compile(turnstileResponse);
const mailRelaySecretHeader = "x-feedfathom-mail-secret";
const maxRawEmailBytes = 5 * 1_024 * 1_024;

function matchesMailRelaySecret(
  expected: string | undefined,
  provided: string | null,
) {
  const expectedDigest = createHash("sha256")
    .update(expected ?? "")
    .digest();
  const providedDigest = createHash("sha256")
    .update(provided ?? "")
    .digest();
  const matches = timingSafeEqual(expectedDigest, providedDigest);
  return Boolean(expected && provided) && matches;
}

type Password = {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
};

export type PublicAuthRouteDependencies = {
  config: AppConfig;
  emailHandler: Pick<EmailHandler, "processEmail">;
  fetcher: (
    ...args: Parameters<typeof globalThis.fetch>
  ) => ReturnType<typeof globalThis.fetch>;
  mailSender: Pick<MailSender, "sendActivationEmail">;
  password: Password;
  secureCookies: boolean;
  usersDataService: {
    activateUser(userId: number): Promise<unknown>;
    createSession(userId: number, userAgent?: null | string): Promise<string>;
    deleteSession(sid: string): Promise<void>;
    createUser(
      payload: Parameters<UsersDataService["createUser"]>[0],
    ): Promise<unknown>;
    findUser(email: string): ReturnType<UsersDataService["findUser"]>;
    findUserByActivationToken(
      token: string,
    ): ReturnType<UsersDataService["findUserByActivationToken"]>;
    getUserCount(): Promise<number>;
    getUserBySid(sid: string): ReturnType<UsersDataService["getUserBySid"]>;
  };
};

async function validateCaptcha(
  token: string | undefined,
  secret: string,
  fetcher: (
    ...args: Parameters<typeof globalThis.fetch>
  ) => ReturnType<typeof globalThis.fetch>,
) {
  if (!token) return false;
  try {
    const response = await fetcher(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: token, secret }),
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

function sessionHeader(
  sid: string,
  secure: boolean,
  maxAge = 365 * 24 * 60 * 60,
) {
  return `sid=${sid}; HttpOnly; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export const createPublicAuthRoutes = ({
  config,
  emailHandler,
  fetcher,
  mailSender,
  password,
  secureCookies,
  usersDataService,
}: PublicAuthRouteDependencies) => {
  const allowedEmailPolicy = Type.String(
    config.ALLOWED_EMAILS.length ? { enum: config.ALLOWED_EMAILS } : {},
  );

  return new Elysia()
    .post("/api/login", { body: loginRequest }, async ({ body }) => {
      // Elysia 2.0-beta doesn't run Codec .Decode() transforms on bodies.
      const request = Value.Decode(loginRequest, body);
      const user = await usersDataService.findUser(request.email);
      if (
        !user ||
        !(await password.verify(request.password, user.password)) ||
        user.status !== "active"
      ) {
        if (!user) await password.hash(request.password);
        return json({ error: "Wrong login data" }, 401);
      }

      const sid = await usersDataService.createSession(user.id, "");
      return json({ sid }, 200, {
        "set-cookie": sessionHeader(sid, secureCookies),
      });
    })
    .get("/api/session", async ({ cookie }) => {
      const user = await userFor(cookie["sid"]?.value, usersDataService);
      return user ? json({ user }) : json({ user: null });
    })
    .post("/api/logout", async ({ cookie }) => {
      const sid = cookie["sid"]?.value;
      if (typeof sid === "string") await usersDataService.deleteSession(sid);
      return json({ success: true }, 200, {
        "set-cookie": sessionHeader("", secureCookies, 0),
      });
    })
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
          email: request.email,
          name: request.username,
          passwordHash,
          status: "inactive",
          activationToken,
          activationTokenExpiresAt,
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
    })
    .post(
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
    )
    .post(
      "/api/mail",
      { body: incomingMailRequest },
      async ({ body, request }) => {
        if (!config.MAIL_ENABLED) {
          return json({ error: "Mail ingestion is disabled" }, 404);
        }
        if (
          !matchesMailRelaySecret(
            config.MAIL_RELAY_SECRET,
            request.headers.get(mailRelaySecretHeader),
          )
        ) {
          return json({ error: "Unauthorized" }, 401);
        }

        const decoded = Value.Decode(incomingMailRequest, body);
        const raw = Buffer.from(decoded.raw, "utf8");
        if (raw.byteLength > maxRawEmailBytes) {
          return json({ error: "Raw email exceeds 5 MiB" }, 413);
        }

        try {
          await emailHandler.processEmail(raw, {
            from: decoded.from,
            to: decoded.to,
          });
          return json({ ok: true });
        } catch (cause) {
          return json(
            { error: cause instanceof Error ? cause.message : "Unknown error" },
            500,
          );
        }
      },
    );
};
