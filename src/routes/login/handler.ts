import type { UnauthenticatedRequestEvent } from "../../app";
import { json } from "@sveltejs/kit";
import { cookiesConfig } from "../../util/cookies-config";

const message = "Wrong login data";

export const loginHandler = async ({
  request,
  locals,
  cookies,
}: UnauthenticatedRequestEvent) => {
  const user = await locals.dependencies.usersRepository.findUser(
    request.body.email,
  );
  if (!user) {
    await Bun.password.hash(request.body.password);
    return json(
      {
        error: message,
      },
      {
        status: 401,
      },
    );
  }
  const result = await Bun.password.verify(
    request.body.password,
    user.password,
  );
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
