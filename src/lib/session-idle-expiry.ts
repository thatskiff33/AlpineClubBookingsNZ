/**
 * How long a signed-in session survives WITHOUT USE (#4612). The one place
 * that decides it.
 *
 * - Every ordinary account: 8 hours.
 * - The lodge kiosk account (the `LODGE` access role): 30 days, so the shared
 *   lodge tablet is not signed out after a quiet night (owner decision,
 *   2 Nov 2026). Hut-leader actions on that tablet stay behind the separate
 *   10-minute PIN session (`HUT_LEADER_PIN_SESSION_IDLE_SECONDS`).
 *
 * This is the IDLE window only: each refresh of the session re-issues the
 * token and its cookie for another full window. The absolute ceiling measured
 * from `sessionIssuedAt` is a separate rule (#4611) and is not decided here.
 *
 * WHY THIS IS DECIDED PER REQUEST. Auth.js stamps a JWT's `exp` and the
 * session cookie's `Expires` from the same number, `session.maxAge`, every time
 * it writes the cookie (sign-in, `/api/auth/session` refresh, session update).
 * A per-token `exp` set in the `jwt` callback is overwritten by that re-encode
 * (the dead line #4612 removed), and there is no per-token hook for the
 * cookie. The supported lever is the request-scoped config the app already uses
 * (`buildRequestAuthConfig`), so `session.maxAge` is chosen per request from the
 * session token the request already carries. Both the new token's `exp` and the
 * cookie's `Expires` then come from that one number and can never disagree.
 *
 * Consequences, all failing towards the shorter window:
 * - A sign-in has no token yet, so the first cookie is the ordinary window; the
 *   kiosk's first `/api/auth/session` refresh (the page's `SessionProvider` makes
 *   one on load and on focus) re-issues it for 30 days.
 * - The decision reads the incoming token's role claim, which the `jwt` callback
 *   refreshed from the database on the previous request, so a role change takes
 *   effect one refresh later.
 * - A call with no request (`auth()` in a server component, a server-side
 *   session update) gets the ordinary window. `auth()` there never writes the
 *   cookie; an update is re-issued by the next refresh.
 * - An invalidated, unreadable or absent token gets the ordinary window.
 */
import { getToken } from "next-auth/jwt";
import { hasAccessRole } from "./access-roles";

/** Idle window of an ordinary account's session, in seconds. */
export const ACCOUNT_SESSION_IDLE_SECONDS = 8 * 60 * 60;

/** Idle window of the lodge kiosk account's session, in seconds (#4612). */
export const KIOSK_ACCOUNT_SESSION_IDLE_SECONDS = 30 * 24 * 60 * 60;

/**
 * A decoded session token. The decision reads `accessRoles`, `canLogin` and
 * `sessionInvalidated`, all stamped by `auth.ts`'s `jwt` callback.
 */
type SessionIdleClaims = Readonly<Record<string, unknown>>;

/**
 * The idle window for a session carrying these claims. The kiosk predicate is
 * the same one the removed line used — `hasAccessRole(…, "LODGE")` — read from
 * the token's refreshed role claim, which is empty once login is switched off.
 */
export function sessionIdleSecondsForClaims(
  claims: SessionIdleClaims | null | undefined,
): number {
  if (!claims || claims.sessionInvalidated === true) {
    return ACCOUNT_SESSION_IDLE_SECONDS;
  }
  const accessRoles = Array.isArray(claims.accessRoles)
    ? claims.accessRoles.filter((role): role is string => typeof role === "string")
    : [];
  const isKioskAccount = hasAccessRole(
    { accessRoles, canLogin: claims.canLogin === true },
    "LODGE",
  );
  return isKioskAccount
    ? KIOSK_ACCOUNT_SESSION_IDLE_SECONDS
    : ACCOUNT_SESSION_IDLE_SECONDS;
}

/**
 * The name Auth.js gives the session cookie for this request. Mirrors
 * `@auth/core`'s `init` (`useSecureCookies ?? url.protocol === "https:"`) over
 * the URL `next-auth`'s route handlers pass it (`reqWithEnvURL`: the
 * `AUTH_URL`/`NEXTAUTH_URL` origin when set, else the request's own). The name
 * is also the key-derivation salt, so a wrong guess decodes nothing and falls
 * back to the ordinary window rather than reading the wrong cookie.
 */
function sessionCookieName(
  request: Request,
  useSecureCookies: boolean | undefined,
): string {
  const envUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  const protocol = new URL(envUrl ?? request.url).protocol;
  const secure = useSecureCookies ?? protocol === "https:";
  return `${secure ? "__Secure-" : ""}authjs.session-token`;
}

/**
 * The idle window for this request's session: `session.maxAge` for the config
 * Auth.js runs it with. Reads ONLY the session cookie — never an
 * `Authorization: Bearer` header, which Auth.js's own session read ignores —
 * and fails to the ordinary window on any doubt.
 */
export async function resolveRequestSessionIdleSeconds(
  request: Request | undefined,
  config: { secret?: string | string[]; useSecureCookies?: boolean },
): Promise<number> {
  if (!request || !config.secret) return ACCOUNT_SESSION_IDLE_SECONDS;
  const cookie = request.headers.get("cookie");
  if (!cookie) return ACCOUNT_SESSION_IDLE_SECONDS;
  try {
    const cookieName = sessionCookieName(request, config.useSecureCookies);
    const claims = await getToken({
      req: { headers: new Headers({ cookie }) },
      secret: config.secret,
      cookieName,
      salt: cookieName,
    });
    return sessionIdleSecondsForClaims(claims);
  } catch {
    return ACCOUNT_SESSION_IDLE_SECONDS;
  }
}
