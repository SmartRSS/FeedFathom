import { type UnauthenticatedRequestEvent } from "../../app";
import { llog } from "../../util/log";
import { type RegisterRequest } from "./validator";
import { json } from "@sveltejs/kit";

export const registerHandler = async ({
  body,
  locals,
}: UnauthenticatedRequestEvent<RegisterRequest>) => {
  const userCount = await locals.dependencies.usersRepository.getUserCount();

  // eslint-disable-next-line n/no-process-env
  if (userCount > 0 && process.env["ENABLE_REGISTRATION"] !== "true") {
    return json(
      {
        error: "Registration is currently disabled",
        success: false,
      },
      { status: 403 },
    );
  }

  // Only check allowed emails if the list exists and isn't empty
  // eslint-disable-next-line n/no-process-env
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
