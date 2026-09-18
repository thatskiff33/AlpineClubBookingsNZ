import { randomBytes, timingSafeEqual } from "crypto";
import { isIP } from "net";

export const XERO_OAUTH_STATE_COOKIE = "xero_oauth_state";
// The internal admin page to return to after the OAuth round-trip (#2080): the
// setup wizard links here so step 3 resumes on the wizard, not the Sync page.
export const XERO_OAUTH_RETURN_COOKIE = "xero_oauth_return";
const XERO_OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const XERO_OAUTH_STATE_PATH = "/api/admin/xero";

/**
 * Sanitise a post-OAuth return path to a SAME-ORIGIN admin path, defeating an
 * open redirect: it must be an absolute `/admin/...` path, never a
 * protocol-relative `//host`, a full URL, a backslash path, contain a `..`
 * traversal segment, or carry control characters (CR/LF header-injection).
 * Returns null when it fails any check, so the caller falls back to the default
 * admin Xero page.
 */
export function sanitizeXeroOAuthReturnPath(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/admin/")) return null;
  if (raw.startsWith("//")) return null;
  if (raw.includes("\\")) return null;
  // Reject any control character (CR/LF header injection, NULs, etc.).
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) < 0x20) return null;
  }
  // Reject `..` path-traversal segments (defence in depth — a decoded `..` must
  // not walk the path out of /admin, e.g. `/admin/../login`). Only the PATH is
  // checked; a legitimate query value may contain `..`.
  // `split` with a limit of one always yields a first element, even for the
  // empty string; treating an absent one as an empty path keeps the traversal
  // check refusing nothing it did not already accept (#2800).
  const pathOnly = raw.split(/[?#]/, 1)[0] ?? "";
  if (pathOnly.split("/").some((segment) => segment === "..")) return null;
  return raw;
}

function getOAuthCookieDomain(requestUrl?: string): string | undefined {
  const candidates = [process.env.NEXTAUTH_URL, requestUrl];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      const hostname = new URL(candidate).hostname.trim().toLowerCase();
      if (!hostname || hostname === "localhost" || isIP(hostname) || !hostname.includes(".")) {
        continue;
      }

      return hostname;
    } catch {
      continue;
    }
  }

  return undefined;
}

export function createXeroOAuthState(): string {
  return randomBytes(32).toString("hex");
}

export function isValidXeroOAuthState(
  expectedState?: string | null,
  receivedState?: string | null
): boolean {
  if (!expectedState || !receivedState) {
    return false;
  }

  const expected = Buffer.from(expectedState, "utf8");
  const received = Buffer.from(receivedState, "utf8");

  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function getXeroOAuthStateCookieOptions(requestUrl?: string) {
  const nextAuthUrl = process.env.NEXTAUTH_URL;
  const isSecure =
    nextAuthUrl?.startsWith("https://") ||
    requestUrl?.startsWith("https://") ||
    process.env.NODE_ENV === "production";
  const domain = getOAuthCookieDomain(requestUrl);

  return {
    httpOnly: true,
    secure: !!isSecure,
    sameSite: "lax" as const,
    maxAge: XERO_OAUTH_STATE_MAX_AGE_SECONDS,
    path: XERO_OAUTH_STATE_PATH,
    ...(domain ? { domain } : {}),
  };
}

export function getExpiredXeroOAuthStateCookieOptions(requestUrl?: string) {
  return {
    ...getXeroOAuthStateCookieOptions(requestUrl),
    maxAge: 0,
  };
}
