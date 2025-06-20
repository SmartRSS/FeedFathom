import { json, type RequestEvent } from "@sveltejs/kit";

export async function POST({ params, locals }: RequestEvent) {
  const { token } = params;

  if (!token) {
    return json({ error: "Invalid activation token." }, { status: 400 });
  }

  const user =
    await locals.dependencies.usersDataService.findUserByActivationToken(token);

  if (!user) {
    return json({ error: "Invalid activation token." }, { status: 400 });
  }

  if (user.status === "active") {
    return json({ error: "Account already activated." }, { status: 400 });
  }

  if (
    !user.activationTokenExpiresAt ||
    user.activationTokenExpiresAt < new Date()
  ) {
    return json({ error: "Activation token has expired." }, { status: 400 });
  }

  await locals.dependencies.usersDataService.activateUser(user.id);

  return json({ success: true });
}
