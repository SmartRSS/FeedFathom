import { type RequestHandler, json } from "@sveltejs/kit";

export const GET: RequestHandler = ({ locals }) => {
  if (locals.dependencies.isMaintenanceMode) {
    return json({ status: "down for maintenance" }, { status: 503 });
  }

  return json({ status: "ok" });
};
