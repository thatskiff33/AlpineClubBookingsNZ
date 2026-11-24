import { beforeEach, describe, expect, it, vi } from "vitest";

const { modules, applyLimit, checkLimit, findGrant, grantUse, touch, run } = vi.hoisted(() => ({
  modules: vi.fn(), applyLimit: vi.fn(), checkLimit: vi.fn(), findGrant: vi.fn(),
  grantUse: vi.fn(), touch: vi.fn(), run: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlags: modules }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: applyLimit,
  checkRateLimit: checkLimit,
  getClientIp: () => "203.0.113.9",
  rateLimitedResponse: () => new Response("{}", { status: 429 }),
  rateLimiters: { mcpUnauthenticated: "unauthenticated", mcpCall: "call" },
}));
vi.mock("@/lib/mcp/oauth", () => ({
  findMcpGrantByAccessToken: findGrant,
  mcpProtectedResourceMetadataUrl: () =>
    "https://club.example.test/.well-known/oauth-protected-resource/api/mcp",
}));
vi.mock("@/lib/mcp/connection-gate", () => ({ resolveMcpGrantUse: grantUse }));
vi.mock("@/lib/mcp/grants", () => ({ touchMcpGrantLastUsed: touch }));
vi.mock("@/lib/mcp/dispatch", () => ({
  runMcpAction: run,
  websiteOnlyAnswer: () => ({ isError: false, text: "Nothing was done. Open the website." }),
}));

import * as mcpRoute from "@/app/api/mcp/route";
import { MCP_ACTIONS, mcpActionAdminRequirement } from "@/lib/mcp/catalogue";

const { POST } = mcpRoute;

const member = {
  id: "member-1", name: "Ana Reid", email: "ana@example.test", role: "USER",
  adminPermissionMatrix: undefined,
};
const grant = {
  id: "grant-1", memberId: "member-1", scope: "READ_WRITE", status: "ACTIVE",
  client: { id: "client-1", name: "Example Assistant" },
};

function rpc(method: string, params: unknown, headers: Record<string, string> = {}) {
  return new Request("https://club.example.test/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer good-token",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function result(response: Response) {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result as Record<string, never>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_URL", "https://club.example.test");
  modules.mockResolvedValue({ mcpServer: true });
  applyLimit.mockResolvedValue(null);
  checkLimit.mockResolvedValue({ success: true });
  findGrant.mockImplementation(async (token: string) => (token === "good-token" ? grant : null));
  grantUse.mockResolvedValue({ ok: true, scope: "READ_WRITE", session: { user: member } });
  touch.mockResolvedValue(undefined);
  run.mockResolvedValue({ isError: false, text: "ran" });
});

describe("POST /api/mcp: who gets in", () => {
  it("is not there when the module is off, and offers no other method", async () => {
    modules.mockResolvedValue({ mcpServer: false });
    const response = await POST(rpc("tools/list", {}));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(findGrant).not.toHaveBeenCalled();
    expect(Object.keys(mcpRoute)).toEqual(["POST"]);
  });

  it("points an app with no token at the sign-in metadata", async () => {
    const response = await POST(rpc("tools/list", {}, { authorization: "" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://club.example.test/.well-known/oauth-protected-resource/api/mcp"',
    );
    expect(applyLimit).toHaveBeenCalledWith("unauthenticated", expect.anything());
    expect(run).not.toHaveBeenCalled();
  });

  it("answers a wrong token the same way, and ignores a session cookie", async () => {
    const response = await POST(
      rpc("tools/list", {}, { authorization: "Bearer stolen", cookie: "authjs.session-token=abc" }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(grantUse).not.toHaveBeenCalled();
  });

  it("refuses a browser on another site before looking at the token", async () => {
    const response = await POST(rpc("tools/list", {}, { origin: "https://evil.example.test" }));
    expect(response.status).toBe(403);
    expect(findGrant).not.toHaveBeenCalled();
  });

  it("accepts the club's own origin", async () => {
    const response = await POST(rpc("tools/list", {}, { origin: "https://club.example.test" }));
    expect(response.status).toBe(200);
  });

  it("answers 401 when the connection may no longer be used", async () => {
    grantUse.mockResolvedValue({ ok: false, message: "Connect the app again." });
    const response = await POST(rpc("tools/list", {}));
    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("limits calls per connection, not per address", async () => {
    checkLimit.mockResolvedValue({ success: false, resetAt: 0 });
    const response = await POST(rpc("tools/list", {}));
    expect(response.status).toBe(429);
    expect(checkLimit).toHaveBeenCalledWith("call", "grant-1");
    expect(applyLimit).not.toHaveBeenCalled();
  });
});

describe("POST /api/mcp: the tools", () => {
  it("lists the core actions with honest hints, then the four built-in tools", async () => {
    const { tools } = (await result(await POST(rpc("tools/list", {})))) as unknown as {
      tools: Array<{ name: string; inputSchema: { type: string }; annotations: Record<string, boolean> }>;
    };
    const names = tools.map((tool) => tool.name);
    // A member with no admin area is offered no officer action, core or not.
    const core = MCP_ACTIONS.filter((action) => action.core && mcpActionAdminRequirement(action) === null)
      .map((action) => action.id);
    expect(names).toEqual(["who_am_i", ...core, "find_actions", "describe_action", "run_action"]);
    expect(names).not.toContain("get_my_credit_balance");
    expect(names).not.toContain("search_bookings");

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("get_availability")?.annotations).toMatchObject({
      readOnlyHint: true, destructiveHint: false,
    });
    expect(byName.get("create_draft_booking")?.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: false,
    });
    expect(byName.get("cancel_my_booking")?.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: true,
    });
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
    expect(touch).toHaveBeenCalledWith("grant-1", expect.any(Date));
  });

  it("shows a view-only connection the reads only", async () => {
    grantUse.mockResolvedValue({ ok: true, scope: "READ", session: { user: member } });
    const { tools } = (await result(await POST(rpc("tools/list", {})))) as unknown as {
      tools: Array<{ name: string }>;
    };
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("list_my_bookings");
    expect(names).not.toContain("cancel_my_booking");
    expect(names).not.toContain("create_draft_booking");
  });

  it("runs a core action with the app's own arguments and the connection's identity", async () => {
    const body = await result(
      await POST(rpc("tools/call", { name: "get_availability", arguments: { year: 2026, month: 6 } })),
    );
    expect(body).toMatchObject({ isError: false, content: [{ type: "text", text: "ran" }] });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ id: "get_availability" }),
      { year: 2026, month: 6 },
      {
        grantId: "grant-1", memberId: "member-1", clientName: "Example Assistant",
        scope: "READ_WRITE", officerConsent: false, clientIp: "203.0.113.9", userAgent: null,
      },
    );
  });

  it("hands on an officer's approval for officer actions only when the connection records one", async () => {
    // INV-MCP-009: a connection approved before the officer screen has no date.
    findGrant.mockResolvedValue({ ...grant, officerConsentAt: new Date("2026-06-30T22:00:00.000Z") });
    await result(await POST(rpc("tools/call", { name: "get_availability", arguments: {} })));
    expect(run.mock.calls.at(-1)?.[2]).toMatchObject({ officerConsent: true });

    findGrant.mockResolvedValue({ ...grant, officerConsentAt: null });
    await result(await POST(rpc("tools/call", { name: "get_availability", arguments: {} })));
    expect(run.mock.calls.at(-1)?.[2]).toMatchObject({ officerConsent: false });
  });

  it("reaches the other actions through run_action", async () => {
    await result(
      await POST(rpc("tools/call", { name: "run_action", arguments: { id: "get_my_credit_balance" } })),
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ id: "get_my_credit_balance" }), {}, expect.anything(),
    );
  });

  it("answers a website-only action with the page and runs nothing", async () => {
    const body = await result(
      await POST(rpc("tools/call", {
        name: "run_action", arguments: { id: "pay_for_booking", arguments: { id: "booking-1" } },
      })),
    );
    expect(JSON.stringify(body)).toContain("Nothing was done");
    expect(run).not.toHaveBeenCalled();
  });

  it("says who the connection acts for", async () => {
    const body = (await result(
      await POST(rpc("tools/call", { name: "who_am_i", arguments: {} })),
    )) as unknown as { content: Array<{ text: string }> };
    expect(JSON.parse(body.content[0].text)).toMatchObject({
      name: "Ana Reid", connectedApp: "Example Assistant", access: "View and change",
      clubWebsite: "https://club.example.test", officer: false,
    });
  });

  it("describes an action's arguments as the app must send them", async () => {
    const body = (await result(
      await POST(rpc("tools/call", { name: "describe_action", arguments: { id: "create_draft_booking" } })),
    )) as unknown as { content: Array<{ text: string }> };
    const described = JSON.parse(body.content[0].text);
    expect(described.kind).toBe("write");
    expect(described.arguments.properties.checkIn.type).toBe("string");
    expect(described.arguments.properties).not.toHaveProperty("draft");
  });

  it("refuses a batch of messages, so one request is never more than one action", async () => {
    const call = { jsonrpc: "2.0", method: "tools/call", params: { name: "who_am_i", arguments: {} } };
    const request = rpc("tools/list", {});
    const response = await POST(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify([{ ...call, id: 1 }, { ...call, id: 2 }]),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32600 } });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON, or is longer than any action needs", async () => {
    const request = rpc("tools/list", {});
    const send = (body: string) =>
      POST(new Request(request.url, { method: "POST", headers: request.headers, body }));

    expect((await send("{not json")).status).toBe(400);
    expect((await send(JSON.stringify({ padding: "x".repeat(300_000) }))).status).toBe(413);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses an action that does not exist", async () => {
    const body = await result(await POST(rpc("tools/call", { name: "delete_everything", arguments: {} })));
    expect(body).toMatchObject({ isError: true });
    expect(run).not.toHaveBeenCalled();
  });
});
