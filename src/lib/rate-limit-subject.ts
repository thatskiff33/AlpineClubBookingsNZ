import { MCP_PRINCIPAL_HEADER, verifyMcpPrincipal } from "@/lib/mcp/principal";

import { getClientIp } from "./rate-limit-http";

/**
 * The key a per-address limiter counts a request against: the client IP, or
 * `mcp:<connection id>` for an AI app's loopback call (ALP-653).
 *
 * `/api/mcp` calls the site's own routes with the AI provider's address in
 * `x-forwarded-for`. Every member using one provider arrives from that
 * provider's few addresses, so keyed by address they would spend each other's
 * budget: twenty draft bookings an hour across the whole club would exhaust
 * `bookingCreate`. A loopback call is therefore counted per connection, the
 * same reason `mcpCall` is. Only a principal header that verifies (signed, in
 * date, and in flight in this process) changes the key; anything else, a
 * forged or replayed header included, is counted by address as before.
 */
export function rateLimitSubject(request: Request): string {
  const principal = request.headers.get(MCP_PRINCIPAL_HEADER);
  if (principal) {
    let grantId: string | null = null;
    try {
      grantId = verifyMcpPrincipal(principal, Date.now());
    } catch {
      // No auth secret configured: nothing can verify, so count by address.
      grantId = null;
    }
    if (grantId) return `mcp:${grantId}`;
  }
  return getClientIp(request);
}
