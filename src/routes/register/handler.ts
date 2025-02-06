import type { UnauthenticatedRequestEvent } from "../../app";
import { json } from "@sveltejs/kit";
import { llog } from "../../util/log";
import type { RegisterRequest } from "./validator";

export const registerHandler = async ({
  body,
  locals,
}: UnauthenticatedRequestEvent<RegisterRequest>) => {
  const userCount = await locals.dependencies.usersRepository.getUserCount();

  console.log("Environment variables:", {
    ALLOWED_EMAILS: process.env["ALLOWED_EMAILS"],
    ENABLE_REGISTRATION: process.env["ENABLE_REGISTRATION"],
    NODE_ENV: process.env["NODE_ENV"],
  });

  if (userCount > 0 && process.env["ENABLE_REGISTRATION"] !== "true") {
    return json(
      {
        success: false,
        error: "Registration is currently disabled",
      },
      { status: 403 },
    );
  }
  console.log(process.env["ALLOWED_EMAILS"], "asdf");
  // Only check allowed emails if the list exists and isn't empty
  const allowedEmails = process.env["ALLOWED_EMAILS"]
    ?.split(",")
    .filter(Boolean);
  if (
    allowedEmails &&
    allowedEmails.length > 0 &&
    !allowedEmails.includes(body.email)
  ) {
    return json(
      {
        success: false,
        error: process.env["ALLOWED_EMAILS"],
      },
      { status: 403 },
    );
  }

  try {
    const hash = await Bun.password.hash(body.password);
    await locals.dependencies.usersRepository.createUser({
      name: body.username,
      email: body.email,
      passwordHash: hash,
    });

    return json({ success: true });
  } catch (e) {
    llog(e);
    return json(
      {
        success: false,
        error: "An account with this email already exists",
      },
      { status: 409 },
    );
  }
};
