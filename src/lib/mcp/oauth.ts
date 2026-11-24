/**
 * How an AI app obtains and keeps a connection (ALP-653, `INV-MCP-003`).
 *
 * OAuth 2.1 as the MCP authorisation spec uses it, and nothing wider:
 *
 * - authorisation code with PKCE, S256 only; no implicit or password grant;
 * - public clients only (no client secret exists to leak), registered by the
 *   app itself through dynamic client registration;
 * - access tokens last one hour; refresh tokens are single use and rotate, and
 *   presenting a used one ends the connection, because two parties holding
 *   the same refresh token means one of them stole it;
 * - every token is bound to this site's `/api/mcp` and stored only as a
 *   SHA-256 hash (`docs/TOKEN_HASHING.md`).
 *
 * The member's approval creates the connection (`McpGrant`); everything here
 * only issues and renews credentials for a connection that is still ACTIVE
 * and still allowed (`resolveMcpGrantUse`).
 */
import "server-only";

import { createHash, timingSafeEqual } from "crypto";

import type { McpGrantScope } from "@prisma/client";
import { z } from "zod";

import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import { getAppBaseUrl } from "@/lib/app-url";
import { acquireMemberLifecycleLocks } from "@/lib/member-lifecycle-lock";
import { prisma } from "@/lib/prisma";

import { resolveMcpGrantUse } from "./connection-gate";
import { MCP_GRANT_SESSION_SELECT } from "./grant-session";
import { endMcpGrant, endMcpGrants, MCP_GRANT_END_REASONS } from "./grants";
import {
  checkMcpRedirectUri,
  isRegisteredRedirectUri,
  MCP_REDIRECT_URI_MAX_LENGTH,
} from "./redirect-uris";
import { effectiveMcpScope, type McpSettingsValues } from "./settings";

export const MCP_ENDPOINT_PATH = "/api/mcp";
export const MCP_AUTHORIZE_PATH = "/connect/authorize";

export const MCP_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/**
 * A ceiling only. A connection ends when the sign-in that approved it reaches
 * the club's maximum session age (`INV-MCP-005`), which is far sooner.
 */
export const MCP_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MCP_AUTH_CODE_TTL_SECONDS = 5 * 60;

const CLIENT_NAME_MAX_LENGTH = 120;
const DEFAULT_CLIENT_NAME = "AI app";
const MAX_REDIRECT_URIS = 5;
/** An app that registered and was never approved by anyone is dropped after a day. */
const UNUSED_CLIENT_RETENTION_MS = 24 * 60 * 60 * 1000;

const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/** The one address tokens issued here are good for. */
export function mcpResourceUrl(): string {
  return `${getAppBaseUrl()}${MCP_ENDPOINT_PATH}`;
}

export function mcpIssuerUrl(): string {
  return getAppBaseUrl();
}

export function mcpProtectedResourceMetadataUrl(): string {
  return `${getAppBaseUrl()}/.well-known/oauth-protected-resource${MCP_ENDPOINT_PATH}`;
}

const SCOPE_STRINGS: Record<McpGrantScope, string> = {
  READ: "read",
  READ_WRITE: "read write",
};

export function mcpScopeString(scope: McpGrantScope): string {
  return SCOPE_STRINGS[scope];
}

/** RFC 9728. */
export function buildProtectedResourceMetadata() {
  return {
    resource: mcpResourceUrl(),
    authorization_servers: [mcpIssuerUrl()],
    bearer_methods_supported: ["header"],
    scopes_supported: ["read", "write"],
  };
}

/** RFC 8414. */
export function buildAuthorizationServerMetadata() {
  const base = getAppBaseUrl();
  return {
    issuer: mcpIssuerUrl(),
    authorization_endpoint: `${base}${MCP_AUTHORIZE_PATH}`,
    token_endpoint: `${base}/api/mcp/oauth/token`,
    registration_endpoint: `${base}/api/mcp/oauth/register`,
    revocation_endpoint: `${base}/api/mcp/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read", "write"],
    authorization_response_iss_parameter_supported: true,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const mcpClientRegistrationSchema = z.object({
  client_name: z.string().max(500).optional(),
  redirect_uris: z
    .array(z.string().min(1).max(MCP_REDIRECT_URI_MAX_LENGTH))
    .min(1)
    .max(MAX_REDIRECT_URIS),
});

export type McpOAuthError =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_target"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "unsupported_grant_type";

export interface McpOAuthFailure {
  readonly ok: false;
  readonly error: McpOAuthError;
  readonly description: string;
}

function failure(error: McpOAuthError, description: string): McpOAuthFailure {
  return { ok: false, error, description };
}

/** The app's own name for itself, made safe to print: one line, bounded. */
function cleanClientName(raw: string | undefined): string {
  const cleaned = (raw ?? "")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CLIENT_NAME_MAX_LENGTH);
  return cleaned || DEFAULT_CLIENT_NAME;
}

export type McpClientRegistrationResult =
  | {
      readonly ok: true;
      readonly body: {
        client_id: string;
        client_id_issued_at: number;
        client_name: string;
        redirect_uris: string[];
        grant_types: string[];
        response_types: string[];
        token_endpoint_auth_method: "none";
      };
    }
  | McpOAuthFailure;

export async function registerMcpClient(
  input: unknown,
  settings: McpSettingsValues,
): Promise<McpClientRegistrationResult> {
  const parsed = mcpClientRegistrationSchema.safeParse(input);
  if (!parsed.success) {
    return failure(
      "invalid_client_metadata",
      `redirect_uris must list between 1 and ${MAX_REDIRECT_URIS} addresses.`,
    );
  }

  const redirectUris = [...new Set(parsed.data.redirect_uris)];
  for (const uri of redirectUris) {
    const check = checkMcpRedirectUri(uri, settings.allowedRedirectHosts);
    if (!check.ok) return failure("invalid_redirect_uri", check.reason);
  }

  const now = new Date();
  await prisma.mcpClient.deleteMany({
    where: {
      createdAt: { lt: new Date(now.getTime() - UNUSED_CLIENT_RETENTION_MS) },
      grants: { none: {} },
    },
  });

  const client = await prisma.mcpClient.create({
    data: { name: cleanClientName(parsed.data.client_name), redirectUris },
    select: { id: true, name: true, redirectUris: true, createdAt: true },
  });

  return {
    ok: true,
    body: {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  };
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

/** The authorisation request as it arrives in the approval page's query string. */
export interface McpAuthorizeParams {
  readonly response_type?: string;
  readonly client_id?: string;
  readonly redirect_uri?: string;
  readonly code_challenge?: string;
  readonly code_challenge_method?: string;
  readonly state?: string;
  readonly scope?: string;
  readonly resource?: string;
}

export const MCP_AUTHORIZE_PARAM_NAMES = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const satisfies readonly (keyof McpAuthorizeParams)[];

export interface McpAuthorizeRequest {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  /** What the approval screen shows as where the approval goes. */
  readonly redirectHost: string;
  readonly loopback: boolean;
  readonly codeChallenge: string;
  readonly state: string | null;
  /** Whether the app asked to make changes. A request, never a grant. */
  readonly wantsWrite: boolean;
}

export type McpAuthorizeCheck =
  | { readonly ok: true; readonly request: McpAuthorizeRequest }
  /** Nothing about the request can be trusted: show the reason, send nobody anywhere. */
  | { readonly ok: false; readonly kind: "refuse"; readonly message: string }
  /** The app and its address check out; the error goes back to the app. */
  | { readonly ok: false; readonly kind: "redirect"; readonly location: string };

function redirectWith(
  redirectUri: string,
  params: Record<string, string | null>,
): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) {
    if (value !== null) url.searchParams.set(name, value);
  }
  url.searchParams.set("iss", mcpIssuerUrl());
  return url.toString();
}

function isThisResource(resource: string | undefined): boolean {
  if (resource === undefined || resource === "") return true;
  return resource.replace(/\/$/, "") === mcpResourceUrl();
}

/**
 * Checks an authorisation request against the registered app and the club's
 * approved-app list as it is now. Run when the approval screen is shown and
 * again when the member presses Approve.
 */
export async function checkMcpAuthorizeRequest(
  params: McpAuthorizeParams,
  settings: McpSettingsValues,
): Promise<McpAuthorizeCheck> {
  const refuse = (message: string) => ({ ok: false, kind: "refuse", message }) as const;

  if (!params.client_id || !params.redirect_uri) {
    return refuse("This link is missing the details of the app that sent you here.");
  }

  const client = await prisma.mcpClient.findUnique({
    where: { id: params.client_id },
    select: { id: true, name: true, redirectUris: true },
  });
  if (!client) {
    // An app that registered and was never approved is dropped after a day,
    // and the app may keep offering its old registration. This refusal shows
    // in the browser, so the app never learns to register again: the member
    // has to remove the club from the app and add it again.
    return refuse(
      "This app's registration with the club has expired or was never made. In the app, remove the club's connector and add it again, then connect.",
    );
  }
  if (!isRegisteredRedirectUri(params.redirect_uri, client.redirectUris)) {
    return refuse("This app asked to be sent to an address it did not register.");
  }
  const redirect = checkMcpRedirectUri(params.redirect_uri, settings.allowedRedirectHosts);
  if (!redirect.ok) {
    return refuse(redirect.reason);
  }

  const state = params.state ?? null;
  const backToApp = (error: string, description: string) =>
    ({
      ok: false,
      kind: "redirect",
      location: redirectWith(params.redirect_uri as string, {
        error,
        error_description: description,
        state,
      }),
    }) as const;

  if (params.response_type !== "code") {
    return backToApp("unsupported_response_type", "Only response_type=code is supported.");
  }
  if (
    params.code_challenge_method !== "S256" ||
    !params.code_challenge ||
    !CODE_CHALLENGE_PATTERN.test(params.code_challenge)
  ) {
    return backToApp("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  if (!isThisResource(params.resource)) {
    return backToApp("invalid_target", "The resource is not this site's MCP endpoint.");
  }

  return {
    ok: true,
    request: {
      clientId: client.id,
      clientName: client.name,
      redirectUri: params.redirect_uri,
      redirectHost: redirect.host,
      loopback: redirect.loopback,
      codeChallenge: params.code_challenge,
      state,
      wantsWrite: (params.scope ?? "").split(/\s+/).includes("write"),
    },
  };
}

export function buildMcpDenyRedirect(request: McpAuthorizeRequest): string {
  return redirectWith(request.redirectUri, {
    error: "access_denied",
    error_description: "The member did not approve the connection.",
    state: request.state,
  });
}

/**
 * The member's account was erased, merged away or lost its login between the
 * approval check and the approval's lock. Nothing was written.
 */
export class McpApprovalAccountChangedError extends Error {
  constructor() {
    super("The member's account changed before the approval was recorded");
    this.name = "McpApprovalAccountChangedError";
  }
}

/**
 * Records a member's approval: one new ACTIVE connection carrying the sign-in
 * that approved it, and a single-use code for the app to collect. An earlier
 * connection of the same member to the same app is replaced, and any approval
 * of theirs that an app never collected is closed.
 */
export async function approveMcpConnection(input: {
  readonly request: McpAuthorizeRequest;
  readonly memberId: string;
  readonly scope: McpGrantScope;
  readonly settings: McpSettingsValues;
  readonly sessionIssuedAt: Date;
  readonly twoFactorVerified: boolean;
  /** The officer approved the screen that says the app can act as an officer (`INV-MCP-009`). */
  readonly officerConsent: boolean;
}): Promise<{ readonly grantId: string; readonly scope: McpGrantScope; readonly redirectTo: string }> {
  const { request, memberId } = input;
  const scope = effectiveMcpScope(input.scope, input.settings);
  const code = issueActionToken();
  const now = new Date();

  const grantId = await prisma.$transaction(async (tx) => {
    // Serialize approvals before reading the grants to replace. This is the
    // existing member tier, also used by merge and deletion (INV-LOCK-001/002).
    await acquireMemberLifecycleLocks(tx, [memberId]);
    // The account check the route ran happened before the lock. An erasure,
    // merge or disabled login that committed while this waited would
    // otherwise leave a new connection on an account meant to have none.
    const member = await tx.member.findUnique({
      where: { id: memberId },
      select: { deletedAt: true, canLogin: true },
    });
    if (!member || member.deletedAt !== null || !member.canLogin) {
      throw new McpApprovalAccountChangedError();
    }
    await endMcpGrants(
      { memberId, clientId: request.clientId },
      MCP_GRANT_END_REASONS.replaced,
      tx,
    );
    await endMcpGrants(
      {
        memberId,
        tokens: { none: {} },
        authCodes: { none: { expiresAt: { gt: now } } },
      },
      MCP_GRANT_END_REASONS.neverCompleted,
      tx,
    );

    const grant = await tx.mcpGrant.create({
      data: {
        memberId,
        clientId: request.clientId,
        scope,
        sessionIssuedAt: input.sessionIssuedAt,
        twoFactorVerified: input.twoFactorVerified,
        officerConsentAt: input.officerConsent ? now : null,
      },
      select: { id: true },
    });
    await tx.mcpAuthCode.create({
      data: {
        codeHash: code.tokenHash,
        grantId: grant.id,
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        expiresAt: new Date(now.getTime() + MCP_AUTH_CODE_TTL_SECONDS * 1000),
      },
    });
    return grant.id;
  });

  return {
    grantId,
    scope,
    redirectTo: redirectWith(request.redirectUri, { code: code.token, state: request.state }),
  };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface McpTokenResponseBody {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export type McpTokenResult =
  | { readonly ok: true; readonly body: McpTokenResponseBody }
  | McpOAuthFailure;

function pkceMatches(codeVerifier: string, codeChallenge: string): boolean {
  if (!CODE_VERIFIER_PATTERN.test(codeVerifier)) return false;
  const computed = Buffer.from(
    createHash("sha256").update(codeVerifier).digest("base64url"),
    "utf8",
  );
  const expected = Buffer.from(codeChallenge, "utf8");
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/**
 * Whether tokens may be issued for this connection right now. Asked BEFORE the
 * code or refresh token is spent, so a refusal the club can undo (officers'
 * connections switched off, say) does not burn the app's only credential.
 */
async function resolveGrantForIssue(
  grantId: string,
): Promise<{ readonly ok: true; readonly scope: McpGrantScope } | McpOAuthFailure> {
  const grant = await prisma.mcpGrant.findUnique({
    where: { id: grantId },
    select: MCP_GRANT_SESSION_SELECT,
  });
  if (!grant || grant.status !== "ACTIVE") {
    return failure("invalid_grant", "This connection has ended. Connect the app again.");
  }

  const use = await resolveMcpGrantUse(grant);
  return use.ok ? { ok: true, scope: use.scope } : failure("invalid_grant", use.message);
}

async function issueTokens(grantId: string, scope: McpGrantScope): Promise<McpTokenResult> {
  const access = issueActionToken();
  const refresh = issueActionToken();
  const now = Date.now();
  const stillActive = await prisma.$transaction(async (tx) => {
    // A status-guarded write that changes nothing. It holds the connection's
    // row, so a disconnect racing this either has already won (nothing is
    // written) or waits for it and then deletes the tokens written below
    // (`endMcpGrants`). No token outlives its connection (`INV-MCP-004`).
    const held = await tx.mcpGrant.updateMany({
      where: { id: grantId, status: "ACTIVE" },
      data: { status: "ACTIVE" },
    });
    if (held.count === 0) return false;

    await tx.mcpToken.deleteMany({ where: { grantId, expiresAt: { lt: new Date(now) } } });
    await tx.mcpToken.createMany({
      data: [
        {
          tokenHash: access.tokenHash,
          kind: "ACCESS",
          grantId,
          expiresAt: new Date(now + MCP_ACCESS_TOKEN_TTL_SECONDS * 1000),
        },
        {
          tokenHash: refresh.tokenHash,
          kind: "REFRESH",
          grantId,
          expiresAt: new Date(now + MCP_REFRESH_TOKEN_TTL_SECONDS * 1000),
        },
      ],
    });
    return true;
  });
  if (!stillActive) {
    return failure("invalid_grant", "This connection has ended. Connect the app again.");
  }

  return {
    ok: true,
    body: {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: MCP_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refresh.token,
      scope: mcpScopeString(scope),
    },
  };
}

export async function exchangeMcpAuthorizationCode(params: {
  readonly code: string;
  readonly codeVerifier: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource?: string;
}): Promise<McpTokenResult> {
  const invalid = failure("invalid_grant", "The authorisation code is not valid.");
  if (!isThisResource(params.resource)) {
    return failure("invalid_target", "The resource is not this site's MCP endpoint.");
  }

  const record = await prisma.mcpAuthCode.findUnique({
    where: { codeHash: hashActionToken(params.code) },
    select: {
      id: true,
      grantId: true,
      clientId: true,
      redirectUri: true,
      codeChallenge: true,
      expiresAt: true,
      usedAt: true,
    },
  });
  if (!record || record.clientId !== params.clientId) return invalid;

  if (record.usedAt !== null) {
    // A code presented twice: whoever redeemed it first may not be the app
    // the member approved, so the connection it opened does not survive.
    await endMcpGrant(record.grantId, MCP_GRANT_END_REASONS.codeReuse);
    return invalid;
  }
  if (record.expiresAt.getTime() <= Date.now()) return invalid;
  if (record.redirectUri !== params.redirectUri) return invalid;
  if (!pkceMatches(params.codeVerifier, record.codeChallenge)) return invalid;

  const grant = await resolveGrantForIssue(record.grantId);
  if (!grant.ok) return grant;

  const claimed = await prisma.mcpAuthCode.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) {
    await endMcpGrant(record.grantId, MCP_GRANT_END_REASONS.codeReuse);
    return invalid;
  }

  return issueTokens(record.grantId, grant.scope);
}

export async function refreshMcpTokens(params: {
  readonly refreshToken: string;
  readonly clientId: string;
  readonly resource?: string;
}): Promise<McpTokenResult> {
  const invalid = failure("invalid_grant", "The refresh token is not valid.");
  if (!isThisResource(params.resource)) {
    return failure("invalid_target", "The resource is not this site's MCP endpoint.");
  }

  const record = await prisma.mcpToken.findUnique({
    where: { tokenHash: hashActionToken(params.refreshToken) },
    select: {
      id: true,
      kind: true,
      grantId: true,
      expiresAt: true,
      usedAt: true,
      grant: { select: { clientId: true } },
    },
  });
  if (!record || record.kind !== "REFRESH" || record.grant.clientId !== params.clientId) {
    return invalid;
  }

  if (record.usedAt !== null) {
    await endMcpGrant(record.grantId, MCP_GRANT_END_REASONS.refreshReuse);
    return invalid;
  }
  if (record.expiresAt.getTime() <= Date.now()) return invalid;

  const grant = await resolveGrantForIssue(record.grantId);
  if (!grant.ok) return grant;

  const claimed = await prisma.mcpToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) {
    await endMcpGrant(record.grantId, MCP_GRANT_END_REASONS.refreshReuse);
    return invalid;
  }

  return issueTokens(record.grantId, grant.scope);
}

/**
 * RFC 7009: the app gives up its connection. Either of its tokens ends the
 * whole connection; an unknown token is not an error, so nothing is returned.
 */
export async function revokeMcpToken(token: string): Promise<void> {
  const record = await prisma.mcpToken.findUnique({
    where: { tokenHash: hashActionToken(token) },
    select: { grantId: true },
  });
  if (record) {
    await endMcpGrant(record.grantId, MCP_GRANT_END_REASONS.appRevoked);
  }
}

// ---------------------------------------------------------------------------
// Using a token
// ---------------------------------------------------------------------------

export async function findMcpGrantByAccessToken(token: string) {
  const record = await prisma.mcpToken.findUnique({
    where: { tokenHash: hashActionToken(token) },
    select: {
      kind: true,
      expiresAt: true,
      grant: { select: MCP_GRANT_SESSION_SELECT },
    },
  });
  if (
    !record ||
    record.kind !== "ACCESS" ||
    record.expiresAt.getTime() <= Date.now() ||
    record.grant.status !== "ACTIVE"
  ) {
    return null;
  }
  return record.grant;
}
