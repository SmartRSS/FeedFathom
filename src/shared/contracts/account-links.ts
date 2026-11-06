// The SPA routes the account mail links open. The server builds them into
// mail; the SPA routes them.
export const activationPath = (token: string) => `/activate/${token}`;
export const passwordResetPath = (token: string) => `/password-reset/${token}`;
