import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, resolveUse, endGrant } = vi.hoisted(() => ({
  db: {
    mcpClient: { findUnique: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    mcpAuthCode: { findUnique: vi.fn(), updateMany: vi.fn() },
    mcpToken: { findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    mcpGrant: { findUnique: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  resolveUse: vi.fn(),
  endGrant: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/app-url", () => ({ getAppBaseUrl: () => "https://club.example.test" }));
vi.mock("@/lib/mcp/connection-gate", () => ({ resolveMcpGrantUse: resolveUse }));
vi.mock("@/lib/mcp/grants", async (importOriginal) => ({
  ...(await importOriginal()) as typeof import("@/lib/mcp/grants"),
  endMcpGrant: endGrant,
}));

import { hashActionToken } from "@/lib/action-tokens";
import {
  checkMcpAuthorizeRequest,
  exchangeMcpAuthorizationCode,
  findMcpGrantByAccessToken,
  refreshMcpTokens,
  registerMcpClient,
  revokeMcpToken,
} from "@/lib/mcp/oauth";
import { DEFAULT_MCP_SETTINGS } from "@/lib/mcp/settings";

const verifier = "a".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirectUri = "https://claude.ai/callback";
const future = new Date("2026-07-01T00:05:00.000Z");
const exchange = {
  code: "approval-code",
  codeVerifier: verifier,
  clientId: "client-1",
  redirectUri,
  resource: "https://club.example.test/api/mcp",
};
const authorize = {
  client_id: "client-1",
  redirect_uri: redirectUri,
  response_type: "code",
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "app-state",
};

function codeRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "code-1", grantId: "grant-1", clientId: "client-1", redirectUri,
    codeChallenge: challenge, expiresAt: future, usedAt: null, ...overrides,
  };
}

function refreshRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "refresh-1", kind: "REFRESH", grantId: "grant-1", expiresAt: future,
    usedAt: null, grant: { clientId: "client-1" }, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.mcpClient.findUnique.mockResolvedValue({
    id: "client-1", name: "Example app", redirectUris: [redirectUri],
  });
  db.mcpAuthCode.findUnique.mockResolvedValue(codeRecord());
  db.mcpAuthCode.updateMany.mockResolvedValue({ count: 1 });
  db.mcpToken.findUnique.mockResolvedValue(refreshRecord());
  db.mcpToken.updateMany.mockResolvedValue({ count: 1 });
  db.mcpGrant.findUnique.mockResolvedValue({ id: "grant-1", status: "ACTIVE" });
  db.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation((run: (tx: typeof db) => Promise<unknown>) => run(db));
  resolveUse.mockResolvedValue({ ok: true, scope: "READ" });
});

describe("MCP approval destination and proof", () => {
  it("accepts a registered approved app with S256", async () => {
    expect(await checkMcpAuthorizeRequest(authorize, DEFAULT_MCP_SETTINGS)).toMatchObject({
      ok: true, request: { clientId: "client-1", redirectHost: "claude.ai", wantsWrite: false },
    });
  });

  it("does not redirect to an unregistered destination, even to report an error", async () => {
    expect(await checkMcpAuthorizeRequest({
      ...authorize, redirect_uri: "https://attacker.example/callback", response_type: "token",
    }, DEFAULT_MCP_SETTINGS)).toMatchObject({ ok: false, kind: "refuse" });
  });

  it("tells the member to re-add an app whose registration was dropped", async () => {
    db.mcpClient.findUnique.mockResolvedValue(null);
    const check = await checkMcpAuthorizeRequest(authorize, DEFAULT_MCP_SETTINGS);
    expect(check).toMatchObject({ ok: false, kind: "refuse" });
    expect(!check.ok && check.kind === "refuse" ? check.message : "").toMatch(/remove the club's connector and add it again/);
  });

  it("rechecks the club's approved hosts after registration", async () => {
    expect(await checkMcpAuthorizeRequest(authorize, {
      ...DEFAULT_MCP_SETTINGS, allowedRedirectHosts: [],
    })).toMatchObject({ ok: false, kind: "refuse" });
  });

  it.each([
    { code_challenge_method: "plain" },
    { code_challenge: "short" },
    { response_type: "token" },
    { resource: "https://other.example/api/mcp" },
  ])("returns an error only to the verified app for %j", async (override) => {
    const result = await checkMcpAuthorizeRequest({ ...authorize, ...override }, DEFAULT_MCP_SETTINGS);
    expect(result).toMatchObject({ ok: false, kind: "redirect" });
    if (result.ok || result.kind !== "redirect") throw new Error("Expected app error redirect");
    const location = new URL(result.location);
    expect(location.origin).toBe("https://claude.ai");
    expect(location.searchParams.get("state")).toBe("app-state");
    expect(location.searchParams.get("iss")).toBe("https://club.example.test");
    expect(location.searchParams.has("code")).toBe(false);
  });

  it("rejects registration outside the approved hosts without storing a client", async () => {
    expect(await registerMcpClient({ redirect_uris: ["https://claude.ai.attacker.example/cb"] },
      DEFAULT_MCP_SETTINGS)).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    expect(db.mcpClient.create).not.toHaveBeenCalled();
  });
});

describe("MCP authorization code exchange", () => {
  it("returns bearer credentials but persists only their hashes", async () => {
    const result = await exchangeMcpAuthorizationCode(exchange);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.description);
    expect(result.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read" });
    expect(result.body.access_token).not.toBe(result.body.refresh_token);
    expect(db.mcpAuthCode.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { codeHash: hashActionToken(exchange.code) },
    }));
    expect(db.mcpToken.createMany).toHaveBeenCalledWith({ data: [
      { tokenHash: hashActionToken(result.body.access_token), kind: "ACCESS", grantId: "grant-1",
        expiresAt: new Date("2026-07-01T01:00:00.000Z") },
      { tokenHash: hashActionToken(result.body.refresh_token), kind: "REFRESH", grantId: "grant-1",
        expiresAt: new Date("2026-07-31T00:00:00.000Z") },
    ] });
  });

  it("writes no token for a connection that ended while the code was being redeemed", async () => {
    db.mcpGrant.updateMany.mockResolvedValue({ count: 0 });

    expect(await exchangeMcpAuthorizationCode(exchange)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(db.mcpGrant.updateMany).toHaveBeenCalledWith({
      where: { id: "grant-1", status: "ACTIVE" },
      data: { status: "ACTIVE" },
    });
    expect(db.mcpToken.createMany).not.toHaveBeenCalled();
  });

  it.each([
    { codeVerifier: "b".repeat(43) },
    { codeVerifier: "short" },
    { clientId: "other-client" },
    { redirectUri: "https://claude.ai/other" },
    { resource: "https://other.example/api/mcp" },
  ])("refuses mismatched credentials without spending the code: %j", async (override) => {
    expect(await exchangeMcpAuthorizationCode({ ...exchange, ...override })).toMatchObject({ ok: false });
    expect(db.mcpAuthCode.updateMany).not.toHaveBeenCalled();
    expect(db.mcpToken.createMany).not.toHaveBeenCalled();
  });

  it("refuses a code at the exact expiry boundary", async () => {
    db.mcpAuthCode.findUnique.mockResolvedValue(codeRecord({ expiresAt: new Date("2026-07-01T00:00:00Z") }));
    expect(await exchangeMcpAuthorizationCode(exchange)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(db.mcpToken.createMany).not.toHaveBeenCalled();
  });

  it("ends the connection if a concurrent exchange already claimed the code", async () => {
    db.mcpAuthCode.updateMany.mockResolvedValue({ count: 0 });
    expect(await exchangeMcpAuthorizationCode(exchange)).toMatchObject({ ok: false });
    expect(endGrant).toHaveBeenCalledWith("grant-1", "code-reuse");
    expect(db.mcpToken.createMany).not.toHaveBeenCalled();
  });

  it("does not spend the code when the member's current policy blocks use", async () => {
    resolveUse.mockResolvedValue({ ok: false, message: "Sign in again" });
    expect(await exchangeMcpAuthorizationCode(exchange)).toMatchObject({ ok: false });
    expect(db.mcpAuthCode.updateMany).not.toHaveBeenCalled();
    expect(db.mcpToken.createMany).not.toHaveBeenCalled();
  });
});

describe("MCP refresh and revocation", () => {
  const params = { refreshToken: "refresh-token", clientId: "client-1" };

  it("rotates a refresh token using the current effective scope", async () => {
    const result = await refreshMcpTokens(params);
    expect(result).toMatchObject({ ok: true, body: { scope: "read" } });
    if (!result.ok) throw new Error(result.description);
    expect(result.body.refresh_token).not.toBe(params.refreshToken);
    expect(db.mcpToken.updateMany).toHaveBeenCalledWith({
      where: { id: "refresh-1", usedAt: null }, data: { usedAt: new Date("2026-07-01T00:00:00Z") },
    });
  });

  it("does not rotate or spend a refresh token while the connection gate refuses, such as a removed host", async () => {
    resolveUse.mockResolvedValue({ ok: false, message: "This app is no longer on the club's list of approved AI apps." });
    expect(await refreshMcpTokens(params)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(db.mcpToken.updateMany).not.toHaveBeenCalled();
    expect(db.mcpToken.createMany).not.toHaveBeenCalled();
    expect(endGrant).not.toHaveBeenCalled();
  });

  it.each(["already-used", "lost-claim"])("revokes the grant on refresh reuse (%s)", async (scenario) => {
    if (scenario === "already-used") {
      db.mcpToken.findUnique.mockResolvedValue(refreshRecord({ usedAt: new Date("2026-06-30T23:59:00Z") }));
    } else {
      db.mcpToken.updateMany.mockResolvedValue({ count: 0 });
    }
    expect(await refreshMcpTokens(params)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(endGrant).toHaveBeenCalledWith("grant-1", "refresh-reuse");
    expect(db.mcpToken.createMany).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "ACCESS" },
    { grant: { clientId: "another-client" } },
    { expiresAt: new Date("2026-07-01T00:00:00Z") },
  ])("does not rotate an invalid refresh credential: %j", async (override) => {
    db.mcpToken.findUnique.mockResolvedValue(refreshRecord(override));
    expect(await refreshMcpTokens(params)).toMatchObject({ ok: false });
    expect(db.mcpToken.updateMany).not.toHaveBeenCalled();
    expect(db.mcpToken.createMany).not.toHaveBeenCalled();
  });

  it("silently accepts an unknown revocation token", async () => {
    db.mcpToken.findUnique.mockResolvedValue(null);
    await expect(revokeMcpToken("unknown")).resolves.toBeUndefined();
    expect(endGrant).not.toHaveBeenCalled();
  });

  it("ends the whole grant when its token is revoked", async () => {
    await revokeMcpToken(params.refreshToken);
    expect(endGrant).toHaveBeenCalledWith("grant-1", "app-revoked");
  });

  it.each([
    { kind: "REFRESH" },
    { expiresAt: new Date("2026-07-01T00:00:00Z") },
    { grant: { id: "grant-1", status: "REVOKED" } },
  ])("rejects unusable bearer tokens: %j", async (override) => {
    db.mcpToken.findUnique.mockResolvedValue({
      kind: "ACCESS", expiresAt: future, grant: { id: "grant-1", status: "ACTIVE" }, ...override,
    });
    expect(await findMcpGrantByAccessToken("access-token")).toBeNull();
  });
});
