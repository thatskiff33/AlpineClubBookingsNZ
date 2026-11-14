import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroConsentUrl } from "@/lib/xero-oauth";
import {
  createXeroOAuthState,
  getXeroOAuthStateCookieOptions,
  sanitizeXeroOAuthReturnPath,
  XERO_OAUTH_RETURN_COOKIE,
  XERO_OAUTH_STATE_COOKIE,
} from "@/lib/xero-oauth-state";
import logger from "@/lib/logger";

/**
 * GET /api/admin/xero/connect
 * Redirects the admin to Xero's OAuth2 consent page.
 *
 * An optional `?return=/admin/...` names the internal admin page to come back to
 * after consent (the setup wizard passes /admin/xero/setup so step 3 resumes on
 * the wizard). It is sanitised to a same-origin admin path to prevent an open
 * redirect, stored in a short-lived cookie, and read by the callback (#2080).
 */
export async function GET(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const returnPath = sanitizeXeroOAuthReturnPath(
    new URL(request.url).searchParams.get("return"),
  );
  try {
    const state = createXeroOAuthState();
    const consentUrl = await getXeroConsentUrl(state);
    const response = NextResponse.redirect(consentUrl);
    response.cookies.set(
      XERO_OAUTH_STATE_COOKIE,
      state,
      getXeroOAuthStateCookieOptions(request.url)
    );
    if (returnPath) {
      response.cookies.set(
        XERO_OAUTH_RETURN_COOKIE,
        returnPath,
        getXeroOAuthStateCookieOptions(request.url)
      );
    }
    return response;
  } catch (error) {
    logger.error({ err: error }, "Failed to generate Xero consent URL");
    return NextResponse.json({ error: "Failed to generate Xero consent URL" }, { status: 500 });
  }
}
