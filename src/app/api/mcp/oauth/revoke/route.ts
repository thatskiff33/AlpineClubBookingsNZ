import { mcpModuleOffResponse, oauthError, oauthJson, readOAuthForm } from "@/lib/mcp/http";
import { revokeMcpToken } from "@/lib/mcp/oauth";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

/**
 * POST /api/mcp/oauth/revoke (ALP-653, RFC 7009)
 *
 * An AI app gives up its connection. Whoever holds either of a connection's
 * tokens may end it; the answer is the same whether or not the token was
 * known, so the endpoint cannot be used to test tokens.
 */
export async function POST(request: Request) {
  const off = await mcpModuleOffResponse();
  if (off) return off;

  const rateLimited = await applyRateLimit(rateLimiters.mcpToken, request);
  if (rateLimited) return rateLimited;

  const form = await readOAuthForm(request);
  const token = form?.get("token");
  if (!token) {
    return oauthError({ ok: false, error: "invalid_request", description: "token is required." });
  }

  await revokeMcpToken(token);
  return oauthJson({});
}
