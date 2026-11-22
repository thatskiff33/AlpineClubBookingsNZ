import type { RateLimitResult } from "./rate-limit";

/**
 * The caller's address by the one rule (#5399): the LAST address in
 * `X-Forwarded-For`, else `X-Real-IP`, else null. Caddy (our reverse proxy)
 * appends the real client IP, so the first value is attacker-controllable but
 * the last one is trustworthy. This is the only module that reads either
 * header; a lint arm refuses the read anywhere else. It takes bare headers so a
 * layout holding only `ReadonlyHeaders` applies the same rule.
 */
export function clientIpFromHeaders(headers: Pick<Headers, "get">): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || null;
  }
  return headers.get("x-real-ip") || null;
}

/**
 * The caller's address for a rate-limit key or an audit row, `"unknown"` when
 * neither header names one.
 */
export function getClientIp(request: Request): string {
  return clientIpFromHeaders(request.headers) ?? "unknown";
}

/**
 * Build the standard 429 response for a rate-limit denial, with Retry-After and
 * X-RateLimit-* headers. Shared by applyRateLimit (per-IP) and any handler that
 * calls checkRateLimit directly (e.g. per-member / global limiters) so every
 * 429 carries identical headers.
 */
export function rateLimitedResponse(result: RateLimitResult): Response {
  const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
  return new Response(
    JSON.stringify({
      error: "Too many requests. Please try again later.",
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(result.resetAt),
      },
    }
  );
}
