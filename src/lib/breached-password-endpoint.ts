// The breached-password range endpoint (#4610, INV-AUTH-005), kept free of
// imports so the Sentry privacy options shared by the server, edge and browser
// inits can filter on it without pulling the lookup's server-only code into
// those bundles. `breached-password.ts` re-exports it; this is its one source.

/** The public range endpoint. The 5-character prefix is appended to it. */
export const BREACHED_PASSWORD_RANGE_URL = "https://api.pwnedpasswords.com/range/";
