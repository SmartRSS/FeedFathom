import type { UnauthenticatedRequestEvent } from "../../app";
import { json } from "@sveltejs/kit";
import { llog } from "../../util/log";

export const registerHandler = async ({
  request,
  locals,
}: UnauthenticatedRequestEvent) => {
  if (process.env["ENABLE_REGISTRATION"] !== "true") {
    return json(
      {
        error: "disabled",
      },
      { status: 400 },
    );
  }

  if (process.env["ALLOWED_EMAILS"]) {
    const allowedEmails = process.env["ALLOWED_EMAILS"].split(",");
    if (!allowedEmails.includes(request.body.email)) {
      return json(
        {
          error: "Email not allowed",
        },
        { status: 400 },
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

    return json({ ok: true });
  } catch (e) {
    llog(e);
    return json(
      {
        error: "User already exists",
      },
      { status: 400 },
    );
  }
};
