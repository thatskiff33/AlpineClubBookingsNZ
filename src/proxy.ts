import { NextResponse, type NextRequest } from "next/server";
import { featureFlags } from "./config/features";
import { getDisabledFeatureForPath } from "./config/feature-routes";
import type { FeatureFlags } from "./config/schema";
import {
  buildContentSecurityPolicy,
  createCspNonce,
  CSP_HEADER,
  CSP_NONCE_HEADER,
} from "./lib/csp";

export function getFeatureFlagBlockResponse(
  pathname: string,
  flags: FeatureFlags = featureFlags
): NextResponse | null {
  const disabledFeature = getDisabledFeatureForPath(
    pathname,
    flags
  );

  if (!disabledFeature) {
    return null;
  }

  return pathname.startsWith("/api/")
    ? NextResponse.json({ error: "Not found" }, { status: 404 })
    : new NextResponse(null, { status: 404 });
}

export function proxy(request: NextRequest) {
  const featureFlagBlockResponse = getFeatureFlagBlockResponse(
    request.nextUrl.pathname
  );

  if (featureFlagBlockResponse) {
    return featureFlagBlockResponse;
  }

  const nonce = createCspNonce();
  const csp = buildContentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);

  requestHeaders.set(CSP_NONCE_HEADER, nonce);
  requestHeaders.set(CSP_HEADER, csp);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.headers.set(CSP_HEADER, csp);

  return response;
}

export default proxy;

export const config = {
  matcher: [
    {
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|logo.png|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
    "/api/admin/chores/:path*",
    "/api/admin/lodge/:path*",
    "/api/admin/members/:id/xero-link",
    "/api/admin/members/:id/xero-push",
    "/api/admin/members/:id/xero-unlink",
    "/api/admin/roster/:path*",
    "/api/admin/waitlist/:path*",
    "/api/admin/xero/:path*",
    "/api/bookings/:id/waitlist-confirm",
    "/api/admin/bookings/:id/force-confirm",
    "/api/chores/:path*",
    "/api/cron/xero",
    "/api/finance/:path*",
    "/api/lodge/:path*",
    "/api/webhooks/xero",
  ],
};
