/**
 * Who may hold an AI app connection, asked in one place (ALP-653,
 * `INV-MCP-002`).
 *
 * `mcpConnectionRefusal` is the rule the approval screen applies before it
 * offers the Approve button, and `resolveMcpGrantUse` applies the same rule
 * again every time a connection is used or its tokens are renewed. A member
 * who could not approve a connection today cannot go on using one they
 * approved last week.
 */
import "server-only";

import type { McpGrantScope } from "@prisma/client";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { requireActiveSessionUser } from "@/lib/session-guards";

import { buildMcpGrantSession, type McpGrantForSession } from "./grant-session";
import { endMcpGrant, MCP_GRANT_END_REASONS } from "./grants";
import { checkMcpRedirectUri } from "./redirect-uris";
import {
  effectiveMcpScope,
  loadMcpSettings,
  mayHoldMcpConnection,
  type McpSettingsValues,
} from "./settings";

export type McpConnectionRefusal = "kiosk-account" | "email-unverified" | "not-permitted";

export const MCP_CONNECTION_REFUSAL_MESSAGES: Record<McpConnectionRefusal, string> = {
  "kiosk-account": "A lodge kiosk account cannot connect an AI app.",
  "email-unverified": "Verify your email address before connecting an AI app.",
  "not-permitted": "This club does not allow your account to connect an AI app.",
};

export const MCP_APP_NOT_APPROVED_MESSAGE =
  "This app is no longer on the club's list of approved AI apps.";

/**
 * The reason this person may not hold a connection, or null when they may.
 * A forced password change and an unmet two-factor requirement are not asked
 * here: the signed-in layout (approval) and `requireActiveSessionUser` (use)
 * already refuse those, and this must not become a second copy of either.
 */
export function mcpConnectionRefusal(input: {
  readonly user: Session["user"];
  readonly kioskAccount: boolean;
  readonly settings: McpSettingsValues;
}): McpConnectionRefusal | null {
  if (input.kioskAccount) return "kiosk-account";
  if (input.user.isEmailVerified !== true) return "email-unverified";
  if (!mayHoldMcpConnection(input.settings, input.user)) return "not-permitted";
  return null;
}

export type McpGrantUse =
  | {
      readonly ok: true;
      readonly session: Session;
      /** The lesser of what the member approved and what the club allows now. */
      readonly scope: McpGrantScope;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Decides whether an ACTIVE connection may be used right now, and as whom.
 * A connection whose sign-in has ended is marked EXPIRED here, so it also
 * leaves the member's and the officers' lists.
 */
export async function resolveMcpGrantUse(grant: McpGrantForSession): Promise<McpGrantUse> {
  const built = await buildMcpGrantSession(grant);
  if (!built.ok) {
    await endMcpGrant(grant.id, MCP_GRANT_END_REASONS.sessionEnded);
    return {
      ok: false,
      message: "The sign-in that approved this connection has ended. Connect the app again.",
    };
  }

  const blocked = await requireActiveSessionUser(grant.memberId, {
    sessionUser: built.session.user,
  });
  if (blocked) {
    return {
      ok: false,
      message: "This account needs attention on the club website before the app can be used.",
    };
  }

  const settings = await loadMcpSettings();
  const refusal = mcpConnectionRefusal({
    user: built.session.user,
    kioskAccount: built.kioskAccount,
    settings,
  });
  if (refusal) {
    return { ok: false, message: MCP_CONNECTION_REFUSAL_MESSAGES[refusal] };
  }

  // The host the approval was delivered to must still be on the club's list
  // (`INV-MCP-003`). Each approval writes one code and it is kept until the
  // connection ends, so its address is the approved one. Like a switched-off
  // group, a removed host refuses without ending: adding it back lets the
  // connection work again within its life. No code means no checkable
  // destination, so it is refused too. A loopback address is always allowed.
  const approval = await prisma.mcpAuthCode.findFirst({
    where: { grantId: grant.id },
    select: { redirectUri: true },
  });
  if (!approval || !checkMcpRedirectUri(approval.redirectUri, settings.allowedRedirectHosts).ok) {
    return { ok: false, message: MCP_APP_NOT_APPROVED_MESSAGE };
  }

  return {
    ok: true,
    session: built.session,
    scope: effectiveMcpScope(grant.scope, settings),
  };
}
