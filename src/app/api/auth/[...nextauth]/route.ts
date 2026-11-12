import { handlers } from "@/lib/auth";
import { NextRequest } from "next/server";
import { applyRateLimit, authRateLimitedResponse, AUTH_RATE_LIMIT_EXEMPT_ACTIONS, rateLimiters } from "@/lib/rate-limit";

export const { GET } = handlers;

export async function POST(request: NextRequest) {
  // Match the entire action path, never a query/body/header supplied action.
  const action = request.nextUrl.pathname.replace(/^\/api\/auth\//, "");
  if (AUTH_RATE_LIMIT_EXEMPT_ACTIONS.includes(action)) return handlers.POST(request);

  const rateLimitResponse = await applyRateLimit(rateLimiters.login, request);
  if (rateLimitResponse) return authRateLimitedResponse(rateLimitResponse, request.url);

  return handlers.POST(request);
}
