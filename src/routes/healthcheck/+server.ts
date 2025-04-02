import { type RequestHandler, json } from "@sveltejs/kit";

export const GET: RequestHandler = () => {
  return json({ status: "ok" });
};
