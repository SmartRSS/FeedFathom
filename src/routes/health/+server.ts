import { json } from "@sveltejs/kit";

export const GET = async () => {
  return json({ status: "healthy" }, { status: 200 });
};
