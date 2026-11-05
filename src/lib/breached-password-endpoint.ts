// The breached-password range endpoint (#4610, INV-AUTH-005), kept free of
// imports so the Sentry privacy options shared by the server, edge and browser
// inits can filter on it without pulling the lookup's server-only code into
// those bundles. `breached-password.ts` re-exports it; this is its one source.

/** The public range endpoint. The 5-character prefix is appended to it. */
export const BREACHED_PASSWORD_RANGE_URL = "https://api.pwnedpasswords.com/range/";

/**
 * True for a request to the range endpoint. The server init's Node fetch
 * integration takes it as `ignoreOutgoingRequests`, so that request gets no
 * span, no breadcrumb and no `sentry-trace`/`baggage` headers.
 */
export function isBreachedPasswordRangeUrl(url: string): boolean {
  return url.startsWith(BREACHED_PASSWORD_RANGE_URL);
}
