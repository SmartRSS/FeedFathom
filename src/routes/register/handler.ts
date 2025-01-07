import type { UnauthenticatedRequestEvent } from "../../app";
import { json } from "@sveltejs/kit";
import { llog } from "../../util/log";

export const registerHandler = async ({
  request,
  locals,
}: UnauthenticatedRequestEvent) => {
  // Check if there are any existing users
  const userCount = await locals.dependencies.usersRepository.getUserCount();
  
  if (userCount > 0 && process.env["ENABLE_REGISTRATION"] !== "true") {
    return json(
      {
        success: false,
        error: "Registration is currently disabled",
      },
      { status: 403 },
    );
  }

  if (process.env["ALLOWED_EMAILS"]) {
    const allowedEmails = process.env["ALLOWED_EMAILS"].split(",");
    if (!allowedEmails.includes(request.body.email) && allowedEmails.length > 0) {
      return json(
        {
          success: false,
          error: "This email address is not allowed to register",
        },
        { status: 403 },
      );
    }
  }

  try {
    const hash = await Bun.password.hash(request.body.password);
    await locals.dependencies.usersRepository.createUser({
      name: request.body.username,
      email: request.body.email,
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
