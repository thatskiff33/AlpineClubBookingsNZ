import type { RateLimitResult } from "./rate-limit";

/**
 * Get the client IP from a request, considering common proxy headers.
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // Use the LAST IP in the chain — Caddy (our reverse proxy) appends the real client IP,
    // so the first value is attacker-controllable but the last one is trustworthy.
    const parts = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }
  return "unknown";
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

