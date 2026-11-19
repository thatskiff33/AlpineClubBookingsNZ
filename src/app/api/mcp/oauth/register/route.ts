import { mcpModuleOffResponse, oauthError, oauthJson } from "@/lib/mcp/http";
import { registerMcpClient } from "@/lib/mcp/oauth";
import { loadMcpSettings } from "@/lib/mcp/settings";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

/**
 * POST /api/mcp/oauth/register (ALP-653, RFC 7591)
 *
 * An AI app registers itself before it sends a member to approve it. Anonymous
 * by design: registering grants nothing. Every redirect address must be on the
 * club's approved-app list or be this device's loopback address
 * (`INV-MCP-003`), and the same check runs again when a member approves.
 */
export async function POST(request: Request) {
  const off = await mcpModuleOffResponse();
  if (off) return off;

  const rateLimited = await applyRateLimit(rateLimiters.mcpClientRegister, request);
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return oauthError({
      ok: false,
      error: "invalid_client_metadata",
      description: "The request body must be JSON.",
    });
  }

  const result = await registerMcpClient(body, await loadMcpSettings());
  return result.ok ? oauthJson(result.body, 201) : oauthError(result);
}
