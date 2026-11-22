/**
 * Response helpers shared by the AI-connection endpoints (ALP-653).
 *
 * Every one of these routes re-checks the module itself: the proxy gate is the
 * first door, and a module gate that lived only there has shipped bypassed
 * before (#2780).
 */
import "server-only";

import { NextResponse } from "next/server";

import { readBoundedWebhookText } from "@/lib/webhook-body";

import { loadEffectiveModuleFlags } from "@/lib/module-settings";

import type { McpOAuthFailure } from "./oauth";
import { arrivesAsMcpConnection } from "@/lib/mcp-connection-request";

/** Registration permits five redirect URIs; 64 KiB also allows JSON escaping. */
export const MCP_OAUTH_BODY_MAX_BYTES = 64 * 1024;

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

/** The same body the proxy's module gate answers with, so off reads as absent. */
export async function mcpModuleOffResponse(): Promise<NextResponse | null> {
  const modules = await loadEffectiveModuleFlags();
  if (modules.mcpServer) return null;
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export function oauthJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function oauthError(failure: McpOAuthFailure, status = 400): NextResponse {
  return oauthJson({ error: failure.error, error_description: failure.description }, status);
}

/** Token and revocation requests arrive form-encoded (RFC 6749 §4.1.3). */
export async function readOAuthForm(request: Request): Promise<URLSearchParams | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return null;
  }
  try {
    return new URLSearchParams(await readBoundedWebhookText(request, MCP_OAUTH_BODY_MAX_BYTES));
  } catch {
    return null;
  }
}

/**
 * Refuses a request that arrives as an AI app connection. The screens that
 * approve, list and end connections, and the club's settings for them, are
 * for a person signed in to the website: a connection must never be able to
 * approve another, or widen what connections may do (`INV-MCP-002`).
 */
export function mcpConnectionMayNotManage(request: Request): NextResponse | null {
  if (!arrivesAsMcpConnection(request)) return null;
  return NextResponse.json(
    { error: "AI app connections are managed on the club website." },
    { status: 403 },
  );
}
