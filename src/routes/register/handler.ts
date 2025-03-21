import type { UnauthenticatedRequestEvent } from "$lib/create-request-handler";
import { json } from "@sveltejs/kit";
import { llog } from "../../util/log.ts";
import type { RegisterRequest } from "./validator.ts";

export const registerHandler = async ({
  body,
  locals,
}: UnauthenticatedRequestEvent<RegisterRequest>) => {
  const userCount = await locals.dependencies.usersRepository.getUserCount();

  if (userCount > 0 && !locals.dependencies.config["ENABLE_REGISTRATION"]) {
    return json(
      {
        error: "Registration is currently disabled",
        success: false,
      },
      { status: 403 },
    );
  }

  // Only check allowed emails if the list exists and isn't empty
  const allowedEmails = locals.dependencies.config["ALLOWED_EMAILS"];
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

  try {
    const hash = await Bun.password.hash(body.password);
    await locals.dependencies.usersRepository.createUser({
      email: body.email,
      name: body.username,
      passwordHash: hash,
    });

    return json({ success: true });
  } catch (error) {
    llog(error);
    return json(
      {
        error: "An account with this email already exists",
        success: false,
      },
      { status: 409 },
    );
  }
};
