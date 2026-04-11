import { randomBytes, timingSafeEqual } from "crypto";

export const XERO_OAUTH_STATE_COOKIE = "xero_oauth_state";
const XERO_OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const XERO_OAUTH_STATE_PATH = "/api/admin/xero";

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

  return {
    httpOnly: true,
    secure: !!isSecure,
    sameSite: "lax" as const,
    maxAge: XERO_OAUTH_STATE_MAX_AGE_SECONDS,
    path: XERO_OAUTH_STATE_PATH,
  };
}

export function getExpiredXeroOAuthStateCookieOptions(requestUrl?: string) {
  return {
    ...getXeroOAuthStateCookieOptions(requestUrl),
    maxAge: 0,
  };
}
