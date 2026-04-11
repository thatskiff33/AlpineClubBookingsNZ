import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { handleXeroCallback } from "@/lib/xero";
import logger from "@/lib/logger";
import {
  getExpiredXeroOAuthStateCookieOptions,
  isValidXeroOAuthState,
  XERO_OAUTH_STATE_COOKIE,
} from "@/lib/xero-oauth-state";

/**
 * GET /api/admin/xero/callback
 * Handles the OAuth2 callback from Xero after admin grants consent.
 */
export async function GET(request: NextRequest) {
  const baseUrl = process.env.NEXTAUTH_URL || request.url;
  const incomingUrl = new URL(request.url);
  const requestState = incomingUrl.searchParams.get("state");
  const cookieState = request.cookies.get(XERO_OAUTH_STATE_COOKIE)?.value;

  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.redirect(new URL("/login", baseUrl));
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  try {
    if (!isValidXeroOAuthState(cookieState, requestState)) {
      throw new Error("Invalid Xero OAuth state. Please reconnect from the admin page.");
    }

    // Reconstruct the callback URL using the public base URL so the host
    // matches the registered redirect URI (inside Docker, request.url
    // resolves to the container's internal address like 0.0.0.0:3000).
    const publicCallbackUrl = new URL(incomingUrl.pathname + incomingUrl.search, baseUrl).toString();
    logger.info({ publicCallbackUrl }, "Processing Xero OAuth callback");
    await handleXeroCallback(publicCallbackUrl, requestState ?? undefined);
    const response = NextResponse.redirect(new URL("/admin/xero?connected=true", baseUrl));
    response.cookies.set(
      XERO_OAUTH_STATE_COOKIE,
      "",
      getExpiredXeroOAuthStateCookieOptions(request.url)
    );
    return response;
  } catch (error) {
    logger.error({ err: error }, "Xero callback error");
    const message = error instanceof Error ? error.message : String(error ?? "Xero connection failed");
    const response = NextResponse.redirect(
      new URL(`/admin/xero?error=${encodeURIComponent(message)}`, baseUrl)
    );
    response.cookies.set(
      XERO_OAUTH_STATE_COOKIE,
      "",
      getExpiredXeroOAuthStateCookieOptions(request.url)
    );
    return response;
  }
}
