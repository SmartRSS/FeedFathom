// What both redirect followers -- the server's HttpClient and the
// extension's reader fetch -- treat as a redirect, and how many hops they
// follow before giving up.
export const redirectStatuses: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);
export const maximumRedirects = 5;
