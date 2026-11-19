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
 *
 * A value is honoured only while the call it was issued for is in flight in
 * this process, so a copy read from a log or a trace is useless: once the
 * call has answered, or from any other server, it reads as signed out.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "crypto";

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
  /** Makes each call's value its own, so ending one call never ends another. */
  n: string;
}

export interface McpPrincipalInFlight {
  /** The header value for the one loopback call. */
  readonly value: string;
  /** Ends the value. Call it when the loopback call has answered or failed. */
  release(): void;
}

// On `globalThis`, not a module variable: `/api/mcp` and the route the call
// reaches are separate bundles and may each hold their own copy of this module.
const IN_FLIGHT_KEY = Symbol.for("alpineclubbookings.mcp-principals-in-flight");

function inFlight(): Set<string> {
  const holder = globalThis as { [IN_FLIGHT_KEY]?: Set<string> };
  return (holder[IN_FLIGHT_KEY] ??= new Set());
}

function principalKey(): Buffer {
  return Buffer.from(
    hkdfSync("sha256", requireAuthSecret(MISSING_SECRET_ERROR), "", KEY_LABEL, 32),
  );
}

function sign(payloadPart: string): string {
  return createHmac("sha256", principalKey()).update(payloadPart).digest("base64url");
}

/** Issues the header value for one loopback call about to be sent. */
export function issueMcpPrincipal(grantId: string, nowMs: number): McpPrincipalInFlight {
  const payload: PrincipalPayload = {
    g: grantId,
    exp: Math.floor(nowMs / 1000) + MCP_PRINCIPAL_TTL_SECONDS,
    n: randomBytes(12).toString("base64url"),
  };
  const part = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const value = `${part}.${sign(part)}`;
  const issued = inFlight();
  issued.add(value);
  return { value, release: () => void issued.delete(value) };
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
  if (!inFlight().has(raw)) return null;
  return payload.g;
}
