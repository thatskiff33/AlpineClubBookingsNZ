import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { getXeroConsentUrl } from "@/lib/xero";
import {
  createXeroOAuthState,
  getXeroOAuthStateCookieOptions,
  XERO_OAUTH_STATE_COOKIE,
} from "@/lib/xero-oauth-state";

/**
 * GET /api/admin/xero/connect
 * Redirects the admin to Xero's OAuth2 consent page.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  try {
    const state = createXeroOAuthState();
    const consentUrl = await getXeroConsentUrl(state);
    const response = NextResponse.redirect(consentUrl);
    response.cookies.set(
      XERO_OAUTH_STATE_COOKIE,
      state,
      getXeroOAuthStateCookieOptions(request.url)
    );
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate Xero consent URL";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
