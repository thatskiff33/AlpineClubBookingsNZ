/**
 * The internal header that carries an AI app connection across the loopback
 * call a tool makes (ALP-653, `INV-MCP-005`).
 *
 * `/api/mcp` authenticates the app's bearer token, then calls the site's own
 * route over `127.0.0.1` with this header in place of a session cookie.
 * `auth()` accepts it and builds the session from the connection, so the
 * route's own guards decide what the connection may do.
 *
 * The value names a connection and nothing else: `<payload>.<signature>`, an
 * HMAC-SHA-256 under a key derived from the auth secret with its own label, so
 * it is not interchangeable with any other value that secret signs. It lasts
 * 30 seconds and is never sent to the browser or the AI app. A caller who
 * could forge it would need the auth secret, which already forges a session
 * cookie.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "crypto";

import { requireAuthSecret } from "@/lib/runtime-config";

export const MCP_PRINCIPAL_HEADER = "x-mcp-principal";

/** Long enough for one loopback call; short enough that a copy is useless. */
export const MCP_PRINCIPAL_TTL_SECONDS = 30;

const KEY_LABEL = "mcp-principal-v1";
const MISSING_SECRET_ERROR =
  "AUTH_SECRET or NEXTAUTH_SECRET is required for AI app connections";

interface PrincipalPayload {
  /** The connection (`McpGrant.id`). */
  g: string;
  /** Expiry, unix seconds. */
  exp: number;
}

function principalKey(): Buffer {
  return Buffer.from(
    hkdfSync("sha256", requireAuthSecret(MISSING_SECRET_ERROR), "", KEY_LABEL, 32),
  );
}

function sign(payloadPart: string): string {
  return createHmac("sha256", principalKey()).update(payloadPart).digest("base64url");
}

export function signMcpPrincipal(grantId: string, nowMs: number): string {
  const payload: PrincipalPayload = {
    g: grantId,
    exp: Math.floor(nowMs / 1000) + MCP_PRINCIPAL_TTL_SECONDS,
  };
  const part = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${part}.${sign(part)}`;
}

/** The connection id a header value names, or null for anything not exactly valid. */
export function verifyMcpPrincipal(raw: string, nowMs: number): string | null {
  const [part, signature, extra] = raw.split(".");
  if (!part || !signature || extra !== undefined) return null;

  const expected = Buffer.from(sign(part), "utf8");
  const presented = Buffer.from(signature, "utf8");
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    return null;
  }

  let payload: Partial<PrincipalPayload>;
  try {
    payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Partial<PrincipalPayload>;
  } catch {
    return null;
  }
  if (typeof payload.g !== "string" || payload.g.length === 0) return null;
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
  if (payload.exp * 1000 <= nowMs) return null;
  return payload.g;
}
