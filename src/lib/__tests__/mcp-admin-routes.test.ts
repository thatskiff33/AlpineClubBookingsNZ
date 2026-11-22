/**
 * The officers' AI connection routes (ALP-653, `INV-MCP-002`, `INV-MCP-004`):
 * the club's policy at `/api/admin/mcp/settings` and every connection at
 * `/api/admin/mcp/grants`. Support view reads; support edit changes, and a
 * settings change also needs a fresh proof of who the officer is
 * (`INV-AUTH-010`). None of them answers a request made through an AI app
 * connection.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMcpGrantStore, liveRefreshToken, mcpGrant, type McpGrantStore } from "./support/mcp-grant-store";

const { db, modules, requireAdmin, requireRecentAuth, audit } = vi.hoisted(() => ({
  db: {} as Record<string, unknown>,
  modules: vi.fn(),
  requireAdmin: vi.fn(),
  requireRecentAuth: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlags: modules }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin }));
vi.mock("@/lib/require-recent-auth", () => ({ requireRecentAuth }));
vi.mock("@/lib/mcp/audit", () => ({ recordMcpAudit: audit }));
vi.mock("@/lib/audit", () => ({ getAuditRequestContext: () => ({ ip: "203.0.113.9" }) }));

import { DELETE as deleteGrant } from "@/app/api/admin/mcp/grants/[id]/route";
import { GET as listGrants } from "@/app/api/admin/mcp/grants/route";
import { GET as getSettings, PUT as putSettings } from "@/app/api/admin/mcp/settings/route";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";
import { DEFAULT_MCP_SETTINGS, MCP_SETTINGS_ID, type McpSettingsValues } from "@/lib/mcp/settings";

type Level = "none" | "view" | "edit";
const RANK: Record<Level, number> = { none: 0, view: 1, edit: 2 };

let store: McpGrantStore;
let supportLevel: Level;
let savedRow: McpSettingsValues | null;
const upsert = vi.fn();
const transaction = vi.fn();

beforeEach(() => {
  store = createMcpGrantStore({});
  supportLevel = "edit";
  savedRow = null;

  for (const key of Object.keys(db)) delete db[key];
  upsert.mockImplementation(async ({ create, update }: { create: McpSettingsValues; update: McpSettingsValues }) => {
    const { membersMayConnect, officersMayConnect, maxScope, allowedRedirectHosts } = savedRow
      ? { ...savedRow, ...update }
      : create;
    savedRow = { membersMayConnect, officersMayConnect, maxScope, allowedRedirectHosts };
    return savedRow;
  });
  transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(db));
  Object.assign(db, store.db, {
    mcpSettings: { findUnique: vi.fn(async () => savedRow), upsert },
    $transaction: transaction,
  });

  modules.mockResolvedValue({ mcpServer: true });
  // The guard admits by the support area level the caller holds, as the real one does.
  requireAdmin.mockImplementation(
    async ({ permission }: { permission: { area: string; level: Level } }) =>
      permission.area === "support" && RANK[supportLevel] >= RANK[permission.level]
        ? { ok: true, session: { user: { id: "officer-1" } } }
        : { ok: false, response: Response.json({ error: "Forbidden" }, { status: 403 }) },
  );
  requireRecentAuth.mockResolvedValue({ ok: true });
  audit.mockResolvedValue(undefined);
});

const viaConnection = { [MCP_PRINCIPAL_HEADER]: "anything" };

function settingsRequest(method: "GET" | "PUT", body?: unknown, headers: Record<string, string> = {}) {
  return new Request("https://club.example.test/api/admin/mcp/settings", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const update = {
  membersMayConnect: true,
  officersMayConnect: true,
  maxScope: "READ_WRITE",
  allowedRedirectHosts: ["", "https://Claude.ai/", "claude.ai", "chatgpt.com"],
};

describe("GET /api/admin/mcp/settings", () => {
  it("answers the defaults to a support viewer when nothing was saved", async () => {
    supportLevel = "view";
    const response = await getSettings(settingsRequest("GET"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DEFAULT_MCP_SETTINGS);
    expect(requireAdmin).toHaveBeenCalledWith({ permission: { area: "support", level: "view" } });
  });

  it("refuses an officer without support access", async () => {
    supportLevel = "none";
    expect((await getSettings(settingsRequest("GET"))).status).toBe(403);
  });

  it("refuses a request arriving through an AI app connection", async () => {
    const response = await getSettings(settingsRequest("GET", undefined, viaConnection));
    expect(response.status).toBe(403);
    expect(requireAdmin).not.toHaveBeenCalled();
  });
});

describe("PUT /api/admin/mcp/settings", () => {
  it("saves the four settings with the approved apps reduced to hosts, and records what it replaced", async () => {
    const response = await putSettings(settingsRequest("PUT", update));
    expect(response.status).toBe(200);
    const next = {
      membersMayConnect: true,
      officersMayConnect: true,
      maxScope: "READ_WRITE",
      allowedRedirectHosts: ["claude.ai", "chatgpt.com"],
    };
    expect(await response.json()).toEqual(next);
    expect(requireAdmin).toHaveBeenCalledWith({ permission: { area: "support", level: "edit" } });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MCP_SETTINGS_ID },
        create: { id: MCP_SETTINGS_ID, ...next, updatedByMemberId: "officer-1" },
        update: { ...next, updatedByMemberId: "officer-1" },
      }),
    );
    // The audit row is written inside the same transaction as the change.
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MCP_SETTINGS_UPDATED",
        actorMemberId: "officer-1",
        metadata: { previous: DEFAULT_MCP_SETTINGS, next },
      }),
      db,
    );
  });

  it("claims the settings row before recording the previous values", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const concurrent = { ...DEFAULT_MCP_SETTINGS, membersMayConnect: false };
    upsert.mockImplementationOnce(async () => {
      entered();
      await held;
      savedRow = concurrent;
      return concurrent;
    });
    const pending = putSettings(settingsRequest("PUT", update));
    await waiting;
    expect(upsert.mock.calls[0]?.[0].update).toEqual({ id: MCP_SETTINGS_ID });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(audit).not.toHaveBeenCalled();
    release();
    expect((await pending).status).toBe(200);
    expect(audit.mock.calls[0]?.[0].metadata.previous).toEqual(concurrent);
  });

  it("records the saved values, not the defaults, as what a second save replaced", async () => {
    await putSettings(settingsRequest("PUT", update));
    audit.mockClear();
    await putSettings(settingsRequest("PUT", { ...update, membersMayConnect: false }));
    expect(audit.mock.calls[0]?.[0].metadata.previous).toMatchObject({ membersMayConnect: true });
    expect(audit.mock.calls[0]?.[0].metadata.next).toMatchObject({ membersMayConnect: false });
  });

  it("refuses a support viewer and writes nothing", async () => {
    supportLevel = "view";
    const response = await putSettings(settingsRequest("PUT", update));
    expect(response.status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses without a fresh proof of who the officer is, and writes nothing", async () => {
    const refusal = Response.json({ error: "Confirm it's you", code: "RECENT_AUTH_REQUIRED" }, { status: 403 });
    requireRecentAuth.mockResolvedValue({ ok: false, response: refusal });
    const request = settingsRequest("PUT", update);
    const response = await putSettings(request);
    expect(response).toBe(refusal);
    expect(request.bodyUsed).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(savedRow).toBeNull();
  });

  it("names the one approved-app entry it cannot read and saves none of the change", async () => {
    const response = await putSettings(
      settingsRequest("PUT", { ...update, allowedRedirectHosts: ["claude.ai", "not a host"] }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('"not a host"');
    expect(upsert).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ["a body that is not JSON", "{oops"],
    ["a key the settings do not have", { ...update, updatedByMemberId: "someone-else" }],
    ["a scope that does not exist", { ...update, maxScope: "ADMIN" }],
    ["a missing switch", { ...update, officersMayConnect: undefined }],
  ])("refuses %s with 400 and writes nothing", async (_name, body) => {
    const response = await putSettings(settingsRequest("PUT", body));
    expect(response.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses a request arriving through an AI app connection before any guard runs", async () => {
    const response = await putSettings(settingsRequest("PUT", update, viaConnection));
    expect(response.status).toBe(403);
    expect(requireAdmin).not.toHaveBeenCalled();
    expect(requireRecentAuth).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});

function mcpGrantTokenSpent(grantId: string) {
  return { ...liveRefreshToken(`r-${grantId}`, grantId), usedAt: new Date("2026-06-01T00:00:00.000Z") };
}

function seedClub() {
  store.state.grants.push(
    mcpGrant({ id: "ana", memberId: "member-1", member: { firstName: "Ana", lastName: "Reid" } }),
    mcpGrant({ id: "ben", memberId: "member-2", member: { firstName: "Ben", lastName: "Hale" } }),
    mcpGrant({ id: "uncollected", memberId: "member-3" }),
    mcpGrant({ id: "ended", memberId: "member-2", status: "EXPIRED", endedReason: "session-ended" }),
  );
  store.state.tokens.push(
    { id: "t-ana", grantId: "ana", kind: "ACCESS" },
    liveRefreshToken("r-ana", "ana"),
    liveRefreshToken("r-ben", "ben"),
    // An app that stopped renewing: only a spent refresh token is left.
    mcpGrantTokenSpent("stale"),
  );
  store.state.grants.push(mcpGrant({ id: "stale", memberId: "member-4" }));
}

function grantsRequest(headers: Record<string, string> = {}) {
  return new Request("https://club.example.test/api/admin/mcp/grants", { headers });
}

function deleteRequest(id: string, headers: Record<string, string> = {}) {
  return deleteGrant(
    new Request(`https://club.example.test/api/admin/mcp/grants/${id}`, { method: "DELETE", headers }),
    { params: Promise.resolve({ id }) },
  );
}

describe("GET /api/admin/mcp/grants", () => {
  it("reaches connections after the former 500-row cutoff and reports the total", async () => {
    for (let index = 0; index < 501; index++) {
      const id = `grant-${index}`;
      store.state.grants.push(mcpGrant({ id }));
      store.state.tokens.push(liveRefreshToken(`token-${index}`, id));
    }
    const response = await listGrants(new Request(
      "https://club.example.test/api/admin/mcp/grants?page=21&pageSize=25",
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connections: [{ id: "grant-500" }], total: 501, page: 21, pageSize: 25, totalPages: 21,
    });
    expect(store.db.mcpGrant.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 500, take: 25, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }));
  });

  it("refuses invalid page sizes", async () => {
    const response = await listGrants(new Request(
      "https://club.example.test/api/admin/mcp/grants?pageSize=501",
    ));
    expect(response.status).toBe(400);
    expect(store.db.mcpGrant.findMany).not.toHaveBeenCalled();
  });

  it("lists every member's live connection to a support viewer, with whose it is", async () => {
    supportLevel = "view";
    seedClub();
    const response = await listGrants(grantsRequest());
    expect(response.status).toBe(200);
    const { connections } = (await response.json()) as {
      connections: { id: string; memberId: string; memberName: string }[];
    };
    expect(connections.map((row) => [row.id, row.memberId, row.memberName])).toEqual([
      ["ana", "member-1", "Ana Reid"],
      ["ben", "member-2", "Ben Hale"],
    ]);
    expect(requireAdmin).toHaveBeenCalledWith({ permission: { area: "support", level: "view" } });
  });

  it("refuses an officer without support access", async () => {
    supportLevel = "none";
    expect((await listGrants(grantsRequest())).status).toBe(403);
  });

  it("refuses a request arriving through an AI app connection", async () => {
    const response = await listGrants(grantsRequest(viaConnection));
    expect(response.status).toBe(403);
    expect(requireAdmin).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/mcp/grants/[id]", () => {
  it("ends a member's connection as admin-revoked, deletes its tokens and records who did it", async () => {
    seedClub();
    const response = await deleteRequest("ben");
    expect(response.status).toBe(200);
    expect(store.state.grants.find((grant) => grant.id === "ben")).toMatchObject({
      status: "REVOKED",
      endedReason: "admin-revoked",
    });
    expect(store.state.tokens.map((token) => token.id)).toEqual(["t-ana", "r-ana", "r-stale"]);
    expect(requireAdmin).toHaveBeenCalledWith({ permission: { area: "support", level: "edit" } });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MCP_CONNECTION_REVOKED",
        actorMemberId: "officer-1",
        subjectMemberId: "member-2",
        grantId: "ben",
        metadata: { reason: "admin-revoked", clientName: "Example Assistant" },
      }),
    );
  });

  it.each([
    ["a connection that has already ended", "ended"],
    ["a connection that does not exist", "nobody"],
  ])("answers 404 for %s and records nothing", async (_name, id) => {
    seedClub();
    const before = JSON.stringify(store.state);
    const response = await deleteRequest(id);
    expect(response.status).toBe(404);
    expect(JSON.stringify(store.state)).toBe(before);
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses a support viewer and changes nothing", async () => {
    supportLevel = "view";
    seedClub();
    const response = await deleteRequest("ben");
    expect(response.status).toBe(403);
    expect(store.state.grants.find((grant) => grant.id === "ben")?.status).toBe("ACTIVE");
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses a request arriving through an AI app connection", async () => {
    seedClub();
    const response = await deleteRequest("ben", viaConnection);
    expect(response.status).toBe(403);
    expect(requireAdmin).not.toHaveBeenCalled();
    expect(store.state.grants.find((grant) => grant.id === "ben")?.status).toBe("ACTIVE");
  });
});
