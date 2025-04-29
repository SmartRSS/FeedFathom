import { json } from "@sveltejs/kit";
import type { RequestHandler } from "@sveltejs/kit";

// POST endpoint to toggle maintenance mode
export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const body = (await request.json()) as { maintenance?: boolean };
    const newState = body.maintenance === true;

    // Update the maintenance mode state
    locals.dependencies.isMaintenanceMode = newState;

    return json({
      status: "success",
      maintenance: newState,
    });
  } catch {
    return json(
      {
        status: "error",
        message: "Invalid request body",
      },
      { status: 400 },
    );
  }
};
