import { beforeEach, describe, expect, it, vi } from "vitest";

const { modules, limit, exchange, refresh, register, revoke, settings } = vi.hoisted(() => ({
  modules: vi.fn(), limit: vi.fn(), exchange: vi.fn(), refresh: vi.fn(),
  register: vi.fn(), revoke: vi.fn(), settings: vi.fn(),
}));
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlags: modules }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: limit,
  rateLimiters: { mcpToken: "token", mcpClientRegister: "register" },
}));
vi.mock("@/lib/mcp/oauth", () => ({
  exchangeMcpAuthorizationCode: exchange, refreshMcpTokens: refresh,
  registerMcpClient: register, revokeMcpToken: revoke,
  buildAuthorizationServerMetadata: () => ({ issuer: "https://club.example.test" }),
  buildProtectedResourceMetadata: () => ({ resource: "https://club.example.test/api/mcp" }),
}));
vi.mock("@/lib/mcp/settings", () => ({ loadMcpSettings: settings }));

import { GET as authorizationMetadata } from "@/app/.well-known/oauth-authorization-server/route";
import { GET as resourceMetadata } from "@/app/.well-known/oauth-protected-resource/route";
import { POST as registration } from "@/app/api/mcp/oauth/register/route";
import { POST as revocation } from "@/app/api/mcp/oauth/revoke/route";
import { MCP_OAUTH_BODY_MAX_BYTES } from "@/lib/mcp/http";
import { POST as token } from "@/app/api/mcp/oauth/token/route";

function form(values: Record<string, string>) {
  return new Request("https://club.example.test/api/mcp/oauth/token", {
    method: "POST", body: new URLSearchParams(values),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  modules.mockResolvedValue({ mcpServer: true });
  limit.mockResolvedValue(null);
  settings.mockResolvedValue({ allowedRedirectHosts: ["claude.ai"] });
  exchange.mockResolvedValue({ ok: true, body: { access_token: "credential" } });
  refresh.mockResolvedValue({ ok: true, body: { access_token: "renewed" } });
  register.mockResolvedValue({ ok: true, body: { client_id: "client-1" } });
});

describe("MCP OAuth routes when the module is disabled", () => {
  it.each([
    ["authorization metadata", () => authorizationMetadata()],
    ["resource metadata", () => resourceMetadata()],
    ["registration", () => registration(form({}))],
    ["token", () => token(form({}))],
    ["revocation", () => revocation(form({}))],
  ] as const)("hides %s even without the proxy", async (_name, call) => {
    modules.mockResolvedValue({ mcpServer: false });
    const response = await call();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(limit).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("MCP token HTTP contract", () => {
  it("passes the proof and resource to exchange and prevents credential caching", async () => {
    const response = await token(form({
      grant_type: "authorization_code", client_id: "client-1", code: "approval",
      code_verifier: "verifier", redirect_uri: "https://claude.ai/cb",
      resource: "https://club.example.test/api/mcp",
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.json()).toEqual({ access_token: "credential" });
    expect(exchange).toHaveBeenCalledWith({
      clientId: "client-1", code: "approval", codeVerifier: "verifier",
      redirectUri: "https://claude.ai/cb", resource: "https://club.example.test/api/mcp",
    });
  });

  it.each([
    [{}, "invalid_client"],
    [{ client_id: "client-1", grant_type: "password" }, "unsupported_grant_type"],
    [{ client_id: "client-1", grant_type: "authorization_code", code: "approval" }, "invalid_request"],
    [{ client_id: "client-1", grant_type: "refresh_token" }, "invalid_request"],
  ])("refuses incomplete or unsupported requests: %j", async (values, error) => {
    const response = await token(form(values as Record<string, string>));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error });
    expect(exchange).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refuses JSON instead of form encoding", async () => {
    const response = await token(new Request("https://club.example.test/api/mcp/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }));
    expect(response.status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("rotates through the refresh flow", async () => {
    const response = await token(form({
      grant_type: "refresh_token", client_id: "client-1", refresh_token: "refresh",
    }));
    expect(response.status).toBe(200);
    expect(refresh).toHaveBeenCalledWith({ clientId: "client-1", refreshToken: "refresh", resource: undefined });
    expect(exchange).not.toHaveBeenCalled();
  });

  it.each([token, registration, revocation])("bounds both declared and streamed OAuth request bodies", async (route) => {
    const padding = "x".repeat(MCP_OAUTH_BODY_MAX_BYTES);
    const body = route === registration
      ? JSON.stringify({ client_name: "Example", redirect_uris: ["https://claude.ai/cb"], padding })
      : new URLSearchParams({
          grant_type: "refresh_token", client_id: "client-1", refresh_token: "refresh",
          token: "revocable-token", padding,
        }).toString();
    for (const declared of [false, true]) {
      const request = new Request("https://club.example.test/api/mcp/oauth/test", {
        method: "POST",
        headers: {
          "Content-Type": route === registration ? "application/json" : "application/x-www-form-urlencoded",
          ...(declared ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
        },
        body,
      });
      expect((await route(request)).status).toBe(400);
      expect(exchange).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    }
  });

  it.each([token, registration, revocation])("applies the rate limit before processing credentials", async (route) => {
    limit.mockResolvedValue(new Response(null, { status: 429 }));
    expect((await route(form({ token: "secret" }))).status).toBe(429);
    expect(exchange).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });
});
