/**
 * The session an AI app connection signs in with (ALP-653, `INV-MCP-005`).
 *
 * A connection is not a second kind of account. It carries the sign-in that
 * approved it: `sessionIssuedAt` and whether that sign-in passed two-factor.
 * This module turns those into a session through `refreshSessionToken` and
 * `applySessionTokenToUser`, the same two functions every browser session
 * read runs (`INV-SSOT`), so a switched-off login, a newer password, the
 * maximum session age (`INV-AUTH-007`), a role change and the two-factor rules
 * reach a connection on its next request and by the same code.
 *
 * `lastAuthenticatedAt` is never set here, so every fresh-proof check
 * (`INV-AUTH-008`) refuses a connection.
 */
import "server-only";

import type { McpGrantScope, McpGrantStatus } from "@prisma/client";
import type { Session } from "next-auth";
import type { JWT } from "next-auth/jwt";

import { prisma } from "@/lib/prisma";
import { applySessionTokenToUser, refreshSessionToken } from "@/lib/session-refresh";

import { MCP_PRINCIPAL_TTL_SECONDS, verifyMcpPrincipal } from "./principal";

export const MCP_GRANT_SESSION_SELECT = {
  id: true,
  memberId: true,
  scope: true,
  status: true,
  sessionIssuedAt: true,
  twoFactorVerified: true,
  // Not part of the session: `/api/mcp` hands it to the tool list as the
  // caller's `officerConsent` (`INV-MCP-009`).
  officerConsentAt: true,
  client: { select: { id: true, name: true } },
  member: { select: { email: true, firstName: true, lastName: true } },
} as const;

export interface McpGrantForSession {
  readonly id: string;
  readonly memberId: string;
  readonly scope: McpGrantScope;
  readonly status: McpGrantStatus;
  readonly sessionIssuedAt: Date;
  readonly twoFactorVerified: boolean;
  readonly client: { readonly id: string; readonly name: string };
  readonly member: {
    readonly email: string;
    readonly firstName: string;
    readonly lastName: string;
  };
}

export type McpGrantSessionResult =
  | { readonly ok: true; readonly session: Session; readonly kioskAccount: boolean }
  /** The sign-in behind the connection has ended; the connection ends with it. */
  | { readonly ok: false; readonly reason: "session-ended" };

/**
 * Builds the connection's session from the member's current row. Does not
 * check `status`: the caller has just read the connection as ACTIVE.
 */
export async function buildMcpGrantSession(
  grant: McpGrantForSession,
): Promise<McpGrantSessionResult> {
  // The three account fields are placeholders the refresh overwrites from the
  // member's row; a member it cannot find ends the session below instead.
  const token: JWT = {
    id: grant.memberId,
    role: "USER",
    forcePasswordChange: false,
    isEmailVerified: false,
    sessionIssuedAt: grant.sessionIssuedAt.getTime(),
    twoFactorVerifiedByChallenge: grant.twoFactorVerified,
  };

  await refreshSessionToken(token, { signIn: false, passwordSignIn: false });
  if (token.sessionInvalidated === true) {
    return { ok: false, reason: "session-ended" };
  }

  const user = {
    email: grant.member.email,
    name: `${grant.member.firstName} ${grant.member.lastName}`,
  } as Session["user"];
  applySessionTokenToUser(user, token);

  return {
    ok: true,
    session: {
      user,
      expires: new Date(Date.now() + MCP_PRINCIPAL_TTL_SECONDS * 1000).toISOString(),
    },
    kioskAccount: token.kioskAccount === true,
  };
}

/**
 * The session for an internal principal header value, or null. Null for a
 * value that does not verify, a connection that is not ACTIVE when re-read,
 * and a connection whose sign-in has ended: each reads as signed out.
 */
export async function resolveMcpPrincipalSession(
  headerValue: string,
): Promise<Session | null> {
  const grantId = verifyMcpPrincipal(headerValue, Date.now());
  if (grantId === null) return null;

  const grant = await prisma.mcpGrant.findUnique({
    where: { id: grantId },
    select: MCP_GRANT_SESSION_SELECT,
  });
  if (!grant || grant.status !== "ACTIVE") return null;

  const result = await buildMcpGrantSession(grant);
  return result.ok ? result.session : null;
}
