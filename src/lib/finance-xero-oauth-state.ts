import {
  createXeroOAuthState,
  isValidXeroOAuthState,
} from "@/lib/xero-oauth-state";

export const FINANCE_XERO_OAUTH_STATE_COOKIE = "finance_xero_oauth_state";
const FINANCE_XERO_OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const FINANCE_XERO_OAUTH_STATE_PATH = "/api/finance/xero";

export function createFinanceXeroOAuthState(): string {
  return createXeroOAuthState();
}

export function isValidFinanceXeroOAuthState(
  expectedState?: string | null,
  receivedState?: string | null
): boolean {
  return isValidXeroOAuthState(expectedState, receivedState);
}

export function getFinanceXeroOAuthStateCookieOptions(requestUrl?: string) {
  const nextAuthUrl = process.env.NEXTAUTH_URL;
  const isSecure =
    nextAuthUrl?.startsWith("https://") ||
    requestUrl?.startsWith("https://") ||
    process.env.NODE_ENV === "production";

  return {
    httpOnly: true,
    secure: !!isSecure,
    sameSite: "lax" as const,
    maxAge: FINANCE_XERO_OAUTH_STATE_MAX_AGE_SECONDS,
    path: FINANCE_XERO_OAUTH_STATE_PATH,
  };
}

export function getExpiredFinanceXeroOAuthStateCookieOptions(
  requestUrl?: string
) {
  return {
    ...getFinanceXeroOAuthStateCookieOptions(requestUrl),
    maxAge: 0,
  };
}
