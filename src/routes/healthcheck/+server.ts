import { json } from "@sveltejs/kit";

export const GET = () => {
  return json({ status: "healthy" }, { status: 200 });
};
