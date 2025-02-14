import { type UnauthenticatedRequestEvent } from "../../app";
import { cookiesConfig } from "../../util/cookies-config";
import { type LoginRequest } from "./validator";
import { json } from "@sveltejs/kit";

const message = "Wrong login data";

export const loginHandler = async ({
  body,
  cookies,
  locals,
}: UnauthenticatedRequestEvent<LoginRequest>) => {
  const user = await locals.dependencies.usersRepository.findUser(body.email);
  if (!user) {
    await Bun.password.hash(body.password);
    return json(
      {
        error: message,
      },
      {
        status: 401,
      },
    );
  }

  const result = await Bun.password.verify(body.password, user.password);
  if (!result) {
    return json(
      {
        error: message,
      },
      {
        status: 401,
      },
    );
  }

  const sid = await locals.dependencies.usersRepository.createSession(
    user.id,
    "",
  );

  cookies.set("sid", sid, cookiesConfig);
  return json({
    sid,
  });
};
