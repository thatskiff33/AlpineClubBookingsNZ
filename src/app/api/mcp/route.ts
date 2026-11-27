import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NextResponse } from "next/server";

import { getAppBaseUrl } from "@/lib/app-url";
import logger from "@/lib/logger";
import { resolveMcpGrantUse } from "@/lib/mcp/connection-gate";
import { touchMcpGrantLastUsed } from "@/lib/mcp/grants";
import { mcpModuleOffResponse } from "@/lib/mcp/http";
import { findMcpGrantByAccessToken, mcpProtectedResourceMetadataUrl } from "@/lib/mcp/oauth";
import { buildMcpServer } from "@/lib/mcp/server";
import {
  applyRateLimit,
  checkRateLimit,
  getClientIp,
  rateLimitedResponse,
  rateLimiters,
} from "@/lib/rate-limit";
import {
  isWebhookBodyInvalidContentLengthError,
  isWebhookBodyTooLargeError,
  readBoundedWebhookText,
} from "@/lib/webhook-body";

/** Far larger than any action's arguments; a longer body is refused unparsed. */
const MAX_REQUEST_BYTES = 256 * 1024;

function rpcRefusal(status: number, code: number, message: string): NextResponse {
  return NextResponse.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

/**
 * The one JSON-RPC message a request carries. An array of messages is refused:
 * the per-connection limit is charged per request, so a batch would run up to
 * a hundred actions at once for the price of one.
 */
async function readSingleMessage(
  request: Request,
): Promise<{ message: unknown } | { refusal: NextResponse }> {
  let text: string;
  try {
    text = await readBoundedWebhookText(request, MAX_REQUEST_BYTES);
  } catch (err) {
    if (isWebhookBodyTooLargeError(err)) {
      return { refusal: rpcRefusal(413, -32000, "The request is too large.") };
    }
    if (isWebhookBodyInvalidContentLengthError(err)) {
      return { refusal: rpcRefusal(400, -32600, "The request's Content-Length is not valid.") };
    }
    throw err;
  }
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return { refusal: rpcRefusal(400, -32700, "The request is not valid JSON.") };
  }
  if (Array.isArray(message)) {
    return { refusal: rpcRefusal(400, -32600, "Send one message per request; batches are not supported.") };
  }
  return { message };
}

/** Tells an AI app where to send the member to sign in (RFC 9728 §5.1). */
function unauthorised(description: string): NextResponse {
  return NextResponse.json(
    { error: "invalid_token", error_description: description },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${mcpProtectedResourceMetadataUrl()}"`,
        "Cache-Control": "no-store",
      },
    },
  );
}

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

/**
 * POST /api/mcp (ALP-653, `INV-MCP-006`, `INV-MCP-007`)
 *
 * The one address an AI app talks to. Each request stands alone: it carries
 * the connection's access token, is answered as JSON, and keeps no session on
 * the server. There is no GET (no event stream to open) and no cookie is read,
 * so a web page in the member's browser cannot use it. A browser's `Origin`
 * from any other site is refused before the token is looked at. A request is
 * one message: a batch is refused, so the per-connection limit counts actions.
 */
export async function POST(request: Request) {
  const off = await mcpModuleOffResponse();
  if (off) return off;

  const origin = request.headers.get("origin");
  if (origin !== null && origin !== getAppBaseUrl()) {
    return NextResponse.json({ error: "Origin not allowed" }, { status: 403 });
  }

  const token = bearerToken(request);
  const grant = token ? await findMcpGrantByAccessToken(token) : null;
  if (!grant) {
    // Only a request without a working token counts against the address, so a
    // shared office address is not locked out by one busy connection.
    const limited = await applyRateLimit(rateLimiters.mcpUnauthenticated, request);
    if (limited) return limited;
    return unauthorised(
      token ? "The access token is not valid or has expired." : "Sign in to the club website to connect.",
    );
  }

  const callLimit = await checkRateLimit(rateLimiters.mcpCall, grant.id);
  if (!callLimit.success) return rateLimitedResponse(callLimit);

  const use = await resolveMcpGrantUse(grant);
  if (!use.ok) return unauthorised(use.message);

  const body = await readSingleMessage(request);
  if ("refusal" in body) return body.refusal;

  try {
    await touchMcpGrantLastUsed(grant.id, new Date());
  } catch (err) {
    logger.warn({ err }, "Could not record when an AI app connection was last used");
  }

  const server = buildMcpServer({
    session: use.session,
    caller: {
      grantId: grant.id,
      memberId: grant.memberId,
      clientName: grant.client.name,
      scope: use.scope,
      // Fails closed: only a recorded date is an officer's approval (`INV-MCP-009`).
      officerConsent: grant.officerConsentAt instanceof Date,
      clientIp: getClientIp(request),
      userAgent: request.headers.get("user-agent"),
    },
  });
  // Stateless: no session id is issued, and the answer is one JSON body.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody: body.message });
  } catch (err) {
    logger.error({ err }, "AI app request failed");
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  } finally {
    await server.close().catch(() => undefined);
  }
}
