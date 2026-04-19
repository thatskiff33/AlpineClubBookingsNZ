import { NextRequest, NextResponse } from "next/server";
import { requireFinanceManagerApiAccess } from "@/lib/finance-api-auth";
import {
  FINANCE_XERO_OAUTH_STATE_COOKIE,
  getExpiredFinanceXeroOAuthStateCookieOptions,
  isValidFinanceXeroOAuthState,
} from "@/lib/finance-xero-oauth-state";
import { handleFinanceXeroCallback } from "@/lib/finance-xero";
import logger from "@/lib/logger";

export async function GET(request: NextRequest) {
  const baseUrl = process.env.NEXTAUTH_URL || request.url;
  const incomingUrl = new URL(request.url);
  const requestState = incomingUrl.searchParams.get("state");
  const cookieState =
    request.cookies.get(FINANCE_XERO_OAUTH_STATE_COOKIE)?.value;

  const authResult = await requireFinanceManagerApiAccess();

  if (!authResult.ok) {
    return NextResponse.redirect(new URL("/login", baseUrl));
  }

  try {
    if (!isValidFinanceXeroOAuthState(cookieState, requestState)) {
      throw new Error(
        "Invalid finance Xero OAuth state. Please reconnect from the finance page."
      );
    }

    const publicCallbackUrl = new URL(
      incomingUrl.pathname + incomingUrl.search,
      baseUrl
    ).toString();
    logger.info({ publicCallbackUrl }, "Processing finance Xero OAuth callback");
    await handleFinanceXeroCallback(publicCallbackUrl, requestState ?? undefined);

    const response = NextResponse.redirect(
      new URL("/finance?connected=true", baseUrl)
    );
    response.cookies.set(
      FINANCE_XERO_OAUTH_STATE_COOKIE,
      "",
      getExpiredFinanceXeroOAuthStateCookieOptions(request.url)
    );
    return response;
  } catch (error) {
    logger.error({ err: error }, "Finance Xero callback error");
    const message =
      error instanceof Error
        ? error.message
        : String(error ?? "Finance Xero connection failed");
    const response = NextResponse.redirect(
      new URL(`/finance?error=${encodeURIComponent(message)}`, baseUrl)
    );
    response.cookies.set(
      FINANCE_XERO_OAUTH_STATE_COOKIE,
      "",
      getExpiredFinanceXeroOAuthStateCookieOptions(request.url)
    );
    return response;
  }
}
