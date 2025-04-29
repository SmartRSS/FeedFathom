import { json } from "@sveltejs/kit";
import type { RequestHandler } from "@sveltejs/kit";

// POST endpoint to toggle maintenance mode
export const POST: RequestHandler = ({ locals }) => {
  try {
    locals.dependencies.maintenanceState.isMaintenanceMode = true;

    return json({
      status: "success",
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
