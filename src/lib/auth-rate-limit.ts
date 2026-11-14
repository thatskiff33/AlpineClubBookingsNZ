/**
 * How the Auth.js route applies `rateLimiters.login` (#4917, INV-AUTH-011).
 */

import { ADDRESS_THROTTLED_CODE } from "@/lib/login-throttle-policy";

/** Only these exact Auth.js POST actions bypass the sign-in address budget. */
export const AUTH_RATE_LIMIT_EXEMPT_ACTIONS: readonly string[] = ["signout", "session"];

/** Keep the standard denial headers while giving next-auth's client its URL. */
export function authRateLimitedResponse(denial: Response, requestUrl: string): Response {
  const url = new URL("/login", requestUrl);
  url.searchParams.set("error", ADDRESS_THROTTLED_CODE);
  url.searchParams.set("code", ADDRESS_THROTTLED_CODE);
  return Response.json({ url: url.href }, { status: denial.status, headers: denial.headers });
}
