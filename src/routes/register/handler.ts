import type { UnauthenticatedRequestEvent } from "$lib/create-request-handler";
import crypto from "node:crypto";
import { json } from "@sveltejs/kit";
import { isDisposableEmail } from "disposable-email-domains-js";
import type { Dependencies } from "../../container.ts";
import type { RegisterRequest } from "./validator.ts";

async function validateCaptcha(
  turnstileToken: string,
  turnstileSecretKey: string,
): Promise<boolean> {
  if (!turnstileToken) {
    return false;
  }
  const turnstileResponse = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: turnstileSecretKey,
        response: turnstileToken,
      }),
    },
  );
  const turnstileData = (await turnstileResponse.json()) as {
    success: boolean;
  };
  return turnstileData.success;
}

async function registerUser(
  locals: { dependencies: Dependencies },
  body: RegisterRequest,
  hash: string,
  useEmailActivation: boolean,
  existingUser: { id: number; status: string } | undefined,
): Promise<void> {
  if (useEmailActivation) {
    const activationToken = crypto.randomUUID();
    const activationTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    if (existingUser && existingUser.status === "inactive") {
      // TODO: Resend activation email logic here
      // For now, we'll just let the user know to check their email
      return;
    }

    await locals.dependencies.usersRepository.createUser({
      email: body.email,
      name: body.username,
      passwordHash: hash,
      activationToken,
      activationTokenExpiresAt,
    });

    await locals.dependencies.mailSender.sendActivationEmail(
      body.email,
      activationToken,
    );
    return;
  }

  if (existingUser) {
    // User exists and is inactive, update their password and activate them
    await locals.dependencies.usersRepository.updatePassword(
      existingUser.id,
      hash,
    );
    await locals.dependencies.usersRepository.activateUser(existingUser.id);
    return;
  }

  // Create a new, active user
  await locals.dependencies.usersRepository.createUser({
    email: body.email,
    name: body.username,
    passwordHash: hash,
    status: "active",
  });
  return;
}

export const registerHandler = async ({
  body,
  locals,
}: UnauthenticatedRequestEvent<RegisterRequest>) => {
  const { TURNSTILE_SECRET_KEY, MAILJET_API_KEY, MAILJET_API_SECRET } =
    locals.dependencies.appConfig;
  const turnstileToken = body["cf-turnstile-response"] ?? "";

  // 1. Conditionally validate Turnstile
  if (
    TURNSTILE_SECRET_KEY &&
    !(await validateCaptcha(turnstileToken, TURNSTILE_SECRET_KEY))
  ) {
    return json({ error: "Invalid CAPTCHA", success: false }, { status: 400 });
  }

  const userCount = await locals.dependencies.usersRepository.getUserCount();

  if (userCount > 0 && !locals.dependencies.appConfig["ENABLE_REGISTRATION"]) {
    return json(
      {
        error: "Registration is currently disabled",
        success: false,
      },
      { status: 403 },
    );
  }

  // Only check allowed emails if the list exists and isn't empty
  const allowedEmails = locals.dependencies.appConfig["ALLOWED_EMAILS"];
  if (
    allowedEmails &&
    allowedEmails.length > 0 &&
    !allowedEmails.includes(body.email)
  ) {
    return json(
      {
        error: "",
        success: false,
      },
      { status: 403 },
    );
  }

  // 2. Check for disposable email
  if (isDisposableEmail(body.email)) {
    return json({ success: true });
  }

  const existingUser = await locals.dependencies.usersRepository.findUser(
    body.email,
  );

  if (existingUser && existingUser.status === "active") {
    return json(
      {
        error: "An account with this email already exists",
        success: false,
      },
      { status: 409 },
    );
  }

  const hash = await Bun.password.hash(body.password);
  const useEmailActivation = Boolean(MAILJET_API_KEY && MAILJET_API_SECRET);

  await registerUser(locals, body, hash, useEmailActivation, existingUser);

  return json({ success: true });
};
