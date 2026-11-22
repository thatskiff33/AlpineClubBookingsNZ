import { mcpModuleOffResponse, oauthError, oauthJson, readOAuthForm } from "@/lib/mcp/http";
import { exchangeMcpAuthorizationCode, refreshMcpTokens } from "@/lib/mcp/oauth";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

/**
 * POST /api/mcp/oauth/token (ALP-653, `INV-MCP-003`)
 *
 * Exchanges a member's approval for tokens, and renews them. No session and no
 * client secret: the app proves itself with the PKCE verifier (first exchange)
 * or the single-use refresh token (renewal). A used code or refresh token
 * presented again ends the connection.
 */
export async function POST(request: Request) {
  const off = await mcpModuleOffResponse();
  if (off) return off;

  const rateLimited = await applyRateLimit(rateLimiters.mcpToken, request);
  if (rateLimited) return rateLimited;

  const form = await readOAuthForm(request);
  if (!form) {
    return oauthError({
      ok: false,
      error: "invalid_request",
      description: "Send the request as application/x-www-form-urlencoded.",
    });
  }

  const clientId = form.get("client_id");
  if (!clientId) {
    return oauthError({ ok: false, error: "invalid_client", description: "client_id is required." });
  }
  const resource = form.get("resource") ?? undefined;
  const grantType = form.get("grant_type");

  if (grantType === "authorization_code") {
    const code = form.get("code");
    const codeVerifier = form.get("code_verifier");
    const redirectUri = form.get("redirect_uri");
    if (!code || !codeVerifier || !redirectUri) {
      return oauthError({
        ok: false,
        error: "invalid_request",
        description: "code, code_verifier and redirect_uri are required.",
      });
    }
    const result = await exchangeMcpAuthorizationCode({
      code,
      codeVerifier,
      clientId,
      redirectUri,
      resource,
    });
    return result.ok ? oauthJson(result.body) : oauthError(result);
  }

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token");
    if (!refreshToken) {
      return oauthError({
        ok: false,
        error: "invalid_request",
        description: "refresh_token is required.",
      });
    }
    const result = await refreshMcpTokens({ refreshToken, clientId, resource });
    return result.ok ? oauthJson(result.body) : oauthError(result);
  }

  return oauthError({
    ok: false,
    error: "unsupported_grant_type",
    description: "Only authorization_code and refresh_token are supported.",
  });
}
