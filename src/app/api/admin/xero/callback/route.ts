import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { handleXeroCallback } from "@/lib/xero";
import logger from "@/lib/logger";
import { getAuditRequestContext } from "@/lib/audit";
import {
  getExpiredXeroOAuthStateCookieOptions,
  isValidXeroOAuthState,
  sanitizeXeroOAuthReturnPath,
  XERO_OAUTH_RETURN_COOKIE,
  XERO_OAUTH_STATE_COOKIE,
} from "@/lib/xero-oauth-state";
import {
  toSafeXeroOAuthCallbackMessage,
  XERO_OAUTH_CALLBACK_GENERIC_MESSAGE,
  XERO_OAUTH_CALLBACK_INVALID_STATE_MESSAGE,
} from "@/lib/xero-oauth-callback-messages";

/**
 * The allow-list now lives in `xero-oauth-callback-messages.ts` so the READ side
 * (`use-xero-connection.ts`, which renders `?error=` in a danger box on two
 * admin pages) enforces exactly the same set (#2394 review, F9).
 */
function getSafeXeroCallbackErrorMessage(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : String(error ?? XERO_OAUTH_CALLBACK_GENERIC_MESSAGE);

  return (
    toSafeXeroOAuthCallbackMessage(message) ??
    XERO_OAUTH_CALLBACK_GENERIC_MESSAGE
  );
}

/**
 * GET /api/admin/xero/callback
 * Handles the OAuth2 callback from Xero after admin grants consent.
 */
export async function GET(request: NextRequest) {
  const baseUrl = process.env.NEXTAUTH_URL || request.url;
  const incomingUrl = new URL(request.url);
  const requestState = incomingUrl.searchParams.get("state");
  const cookieState = request.cookies.get(XERO_OAUTH_STATE_COOKIE)?.value;
  // Where to land after the round-trip: the sanitised return page (the setup
  // wizard) if the connect route set one, else the default admin Xero page.
  const returnPath =
    sanitizeXeroOAuthReturnPath(
      request.cookies.get(XERO_OAUTH_RETURN_COOKIE)?.value,
    ) ?? "/admin/xero";
  // Append our own query params with the right separator: a sanitised return
  // path may already carry a query (e.g. ?step=connect), so a bare "?" would
  // produce a malformed "…?a=b?connected=true" (#2080 hardening).
  const returnQuerySep = returnPath.includes("?") ? "&" : "?";

  // Browser-facing OAuth callback: send unauthenticated/non-admin users to
  // the login page instead of returning a JSON error.
  const loginRedirect = () => NextResponse.redirect(new URL("/login", baseUrl));
  const guard = await requireAdmin({
    unauthenticatedResponse: loginRedirect,
    forbiddenResponse: loginRedirect,
  });
  if (!guard.ok) {
    return guard.response;
  }

  try {
    if (!isValidXeroOAuthState(cookieState, requestState)) {
      throw new Error(XERO_OAUTH_CALLBACK_INVALID_STATE_MESSAGE);
    }

    // Reconstruct the callback URL using the public base URL so the host
    // matches the registered redirect URI (inside Docker, request.url
    // resolves to the container's internal address like 0.0.0.0:3000).
    const publicCallbackUrl = new URL(incomingUrl.pathname + incomingUrl.search, baseUrl).toString();
    logger.info(
      {
        callbackPath: incomingUrl.pathname,
        hasCode: incomingUrl.searchParams.has("code"),
        hasState: incomingUrl.searchParams.has("state"),
      },
      "Processing Xero OAuth callback"
    );
    // The connect is this administrator's act, and the token write records it
    // as theirs, on this request (#3454).
    await handleXeroCallback(publicCallbackUrl, requestState ?? undefined, {
      actor: { kind: "admin", memberId: guard.session.user.id },
      request: getAuditRequestContext(request),
    });
    const response = NextResponse.redirect(
      new URL(`${returnPath}${returnQuerySep}connected=true`, baseUrl)
    );
    response.cookies.set(
      XERO_OAUTH_STATE_COOKIE,
      "",
      getExpiredXeroOAuthStateCookieOptions(request.url)
    );
    response.cookies.set(
      XERO_OAUTH_RETURN_COOKIE,
      "",
      getExpiredXeroOAuthStateCookieOptions(request.url)
    );
    return response;
  } catch (error) {
    logger.error({ err: error }, "Xero callback error");
    const message = getSafeXeroCallbackErrorMessage(error);
    const response = NextResponse.redirect(
      new URL(
        `${returnPath}${returnQuerySep}error=${encodeURIComponent(message)}`,
        baseUrl,
      )
    );
    response.cookies.set(
      XERO_OAUTH_STATE_COOKIE,
      "",
      getExpiredXeroOAuthStateCookieOptions(request.url)
    );
    response.cookies.set(
      XERO_OAUTH_RETURN_COOKIE,
      "",
      getExpiredXeroOAuthStateCookieOptions(request.url)
    );
    return response;
  }
}
