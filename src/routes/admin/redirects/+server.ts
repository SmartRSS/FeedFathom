import { json, type RequestHandler } from "@sveltejs/kit";

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.isAdmin) {
    return json({ error: "Unauthorized" }, { status: 403 });
  }

  try {
    const redirects = await locals.dependencies.redirectMap.getAllRedirects();
    return json(redirects);
  } catch {
    return json({ error: "Failed to fetch redirects" }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
  if (!locals.user?.isAdmin) {
    return json({ error: "Unauthorized" }, { status: 403 });
  }

  try {
    const body = (await request.json()) as { oldUrl?: string };

    if (!body.oldUrl) {
      return json({ error: "oldUrl is required" }, { status: 400 });
    }

    await locals.dependencies.redirectMap.removeRedirect(body.oldUrl);
    return json({ success: true });
  } catch {
    return json({ error: "Failed to remove redirect" }, { status: 500 });
  }
};
