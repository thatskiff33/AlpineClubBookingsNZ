/**
 * What the approval screen shows and what its two buttons do (ALP-653,
 * `INV-MCP-002`, `INV-MCP-003`).
 *
 * The page and the route that records the decision both come through
 * `resolveMcpApproval`, so the member cannot be shown one request and approve
 * another: the route checks the same query again, against the member's
 * session as it is at that moment.
 */
import "server-only";

import { McpGrantScope } from "@prisma/client";
import { z } from "zod";

import { hasAdminPortalAccess } from "@/lib/admin-permissions";

import { MCP_CONNECTION_REFUSAL_MESSAGES, mcpConnectionRefusal } from "./connection-gate";
import { buildMcpGrantSession } from "./grant-session";
import {
  checkMcpAuthorizeRequest,
  MCP_AUTHORIZE_PARAM_NAMES,
  type McpAuthorizeParams,
  type McpAuthorizeRequest,
} from "./oauth";
import { loadMcpSettings, type McpSettingsValues } from "./settings";

const authorizeParam = z.string().max(2048).optional();

/** The refusal for a sign-in that cannot carry a connection, or an account that changed meanwhile. */
export const MCP_SIGN_IN_AGAIN_MESSAGE = "Sign out, sign in again, and then connect the app.";

export const mcpApprovalDecisionSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  /** What the member chose. The club's limit is applied when it is recorded. */
  scope: z.enum(McpGrantScope),
  /**
   * The screen showed the officer line. An officer's approval counts for
   * officer actions only when the screen they answered said so, even if they
   * became an officer while it was open (`INV-MCP-009`).
   */
  officerNoticeShown: z.boolean().optional(),
  params: z.object(
    Object.fromEntries(MCP_AUTHORIZE_PARAM_NAMES.map((name) => [name, authorizeParam])) as Record<
      (typeof MCP_AUTHORIZE_PARAM_NAMES)[number],
      typeof authorizeParam
    >,
  ),
});

/**
 * The authorisation request as the approval page's query string carries it.
 * A parameter given twice is dropped, as OAuth requires (RFC 6749 §3.1), so
 * the screen never shows one value while the app meant another.
 */
export function mcpAuthorizeParamsFromQuery(
  query: Record<string, string | string[] | undefined>,
): McpAuthorizeParams {
  return Object.fromEntries(
    MCP_AUTHORIZE_PARAM_NAMES.flatMap((name) => {
      const value = query[name];
      return typeof value === "string" ? [[name, value]] : [];
    }),
  );
}

/** The sign-in facts a connection carries, read off the approving session. */
export interface McpApprovingSignIn {
  readonly sessionIssuedAt: Date;
  /** True only when this sign-in passed a second-factor challenge. */
  readonly twoFactorVerified: boolean;
}

export type McpApproval =
  /** Nothing about the request can be trusted, or this member may not connect. */
  | { readonly kind: "refuse"; readonly message: string }
  /** The app and its address check out, but the request is wrong: tell the app. */
  | { readonly kind: "redirect"; readonly location: string }
  | {
      readonly kind: "ask";
      readonly request: McpAuthorizeRequest;
      readonly settings: McpSettingsValues;
      readonly signIn: McpApprovingSignIn;
      /** Whether "view and change" is offered: the app asked and the club allows it. */
      readonly mayChange: boolean;
      /**
       * The member holds an admin area, so the screen says the app can also
       * act as an officer, and approving records that (`INV-MCP-009`).
       */
      readonly officer: boolean;
    };

/**
 * What an approval reads from the signed-in member's session. Named field by
 * field so both callers can supply it: the approval screen holds the whole
 * session, the decision route the user its session guard returns.
 */
export interface McpApprovingUser {
  readonly id: string;
  readonly email?: string | null;
  readonly name?: string | null;
  readonly sessionIssuedAt?: number;
  readonly twoFactorRequired?: boolean;
  readonly twoFactorVerified?: boolean;
}

export function mcpApprovingSignIn(user: McpApprovingUser): McpApprovingSignIn | null {
  if (typeof user.sessionIssuedAt !== "number") return null;
  return {
    sessionIssuedAt: new Date(user.sessionIssuedAt),
    twoFactorVerified: user.twoFactorRequired === true && user.twoFactorVerified === true,
  };
}

export async function resolveMcpApproval(
  params: McpAuthorizeParams,
  user: McpApprovingUser,
): Promise<McpApproval> {
  const settings = await loadMcpSettings();
  const check = await checkMcpAuthorizeRequest(params, settings);
  if (!check.ok) {
    return check.kind === "refuse"
      ? { kind: "refuse", message: check.message }
      : { kind: "redirect", location: check.location };
  }

  const signIn = mcpApprovingSignIn(user);
  if (!signIn) {
    return { kind: "refuse", message: MCP_SIGN_IN_AGAIN_MESSAGE };
  }

  // The connection is tried on before it exists: built from the member's row
  // by the code every later use runs, so nobody approves a connection that
  // would be refused the first time the app used it.
  const preview = await buildMcpGrantSession({
    id: "",
    memberId: user.id,
    scope: "READ",
    status: "ACTIVE",
    sessionIssuedAt: signIn.sessionIssuedAt,
    twoFactorVerified: signIn.twoFactorVerified,
    client: { id: check.request.clientId, name: check.request.clientName },
    // Display values only; the refresh reads everything it decides on from the row.
    member: { email: user.email ?? "", firstName: user.name ?? "", lastName: "" },
  });
  if (!preview.ok) {
    return { kind: "refuse", message: MCP_SIGN_IN_AGAIN_MESSAGE };
  }
  const refusal = mcpConnectionRefusal({
    user: preview.session.user,
    kioskAccount: preview.kioskAccount,
    settings,
  });
  if (refusal) {
    return { kind: "refuse", message: MCP_CONNECTION_REFUSAL_MESSAGES[refusal] };
  }

  return {
    kind: "ask",
    request: check.request,
    settings,
    signIn,
    mayChange: check.request.wantsWrite && settings.maxScope === "READ_WRITE",
    officer: hasAdminPortalAccess(preview.session.user),
  };
}

/**
 * Whether this approval lets the connection run officer actions: the member
 * holds an admin area now and the screen they answered told them so.
 */
export function approvalCoversOfficerActions(
  approval: { readonly officer: boolean },
  officerNoticeShown: boolean | undefined,
): boolean {
  return approval.officer && officerNoticeShown === true;
}

/** The scope recorded for a decision: never more than the screen offered. */
export function approvedMcpScope(chosen: McpGrantScope, approval: { mayChange: boolean }): McpGrantScope {
  return chosen === "READ_WRITE" && approval.mayChange ? "READ_WRITE" : "READ";
}
