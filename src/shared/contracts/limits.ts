// Server-owned numbers the clients also act on or tell the reader about.
// Dependency-free, so the service worker bundle can import them without the
// schema library.

// The article list is keyset-paged with at most this many rows. A full page
// can have more results; request the next page with the last row's ID as cursor.
export const articlePageSize = 200;

// The virtual "Today" view (#715) lists unread articles published this many
// hours back.
export const todayWindowHours = 24;

// How long a password-reset link stays valid. `words` is what the mail and the
// reset form promise.
export const passwordResetLifetime = { ms: 60 * 60 * 1000, words: "an hour" };
