export const cookiesConfig = {
  httpOnly: true,
  maxAge: 365 * 24 * 60 * 60,
  path: "/",
  sameSite: "lax" as const,
  secure: true,
};
