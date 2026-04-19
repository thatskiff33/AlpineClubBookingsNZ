import { NextResponse } from "next/server";
import { requireFinanceManagerApiAccess } from "@/lib/finance-api-auth";
import {
  createFinanceXeroOAuthState,
  FINANCE_XERO_OAUTH_STATE_COOKIE,
  getFinanceXeroOAuthStateCookieOptions,
} from "@/lib/finance-xero-oauth-state";
import {
  getFinanceXeroConsentUrl,
  getFinanceXeroRouteStatus,
} from "@/lib/finance-xero";

export async function GET(request: Request) {
  const authResult = await requireFinanceManagerApiAccess();

  if (!authResult.ok) {
    return authResult.response;
  }

  try {
    const status = await getFinanceXeroRouteStatus();

    if (!status.canConnect) {
      return NextResponse.json(
        {
          error: "Finance Xero is not configured",
          configIssues: status.configIssues,
          tokenStorageIssues: status.tokenStorageIssues,
        },
        { status: 503 }
      );
    }

    const state = createFinanceXeroOAuthState();
    const consentUrl = await getFinanceXeroConsentUrl(state);
    const response = NextResponse.redirect(consentUrl);
    response.cookies.set(
      FINANCE_XERO_OAUTH_STATE_COOKIE,
      state,
      getFinanceXeroOAuthStateCookieOptions(request.url)
    );
    return response;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to generate finance Xero consent URL";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
