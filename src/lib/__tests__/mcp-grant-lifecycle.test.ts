/**
 * The life of an AI app connection (ALP-653, `INV-MCP-004`, `INV-MCP-002`).
 *
 * `endMcpGrants` is the one way a connection ends: it reads the ACTIVE rows
 * its filter selects and claims them with an `updateMany` guarded on
 * `status: "ACTIVE"`, so the first writer's end status and reason stand and a
 * later writer changes nothing and is told so. `resolveMcpGrantUse` decides on
 * every use whether a connection may still act. The code and refresh-token
 * claims are pinned in `mcp-oauth.test.ts`; the session a connection carries,
 * in `mcp-principal.test.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMcpGrantStore,
  mcpGrant,
  type McpGrantStore,
  type StoredMcpGrant,
} from "./support/mcp-grant-store";

const { db, modules, buildSession, guards, audit } = vi.hoisted(() => ({
  db: {} as Record<string, unknown>,
  modules: vi.fn(),
  buildSession: vi.fn(),
  guards: {
    requireActiveSession: vi.fn(),
    requireActiveSessionUser: vi.fn(),
    requireAdmin: vi.fn(),
  },
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlags: modules }));
vi.mock("@/lib/mcp/grant-session", () => ({ buildMcpGrantSession: buildSession }));
vi.mock("@/lib/session-guards", () => guards);
vi.mock("@/lib/mcp/audit", () => ({ recordMcpAudit: audit }));
vi.mock("@/lib/audit", () => ({ getAuditRequestContext: () => ({}) }));

import { DELETE as adminDelete } from "@/app/api/admin/mcp/grants/[id]/route";
import { DELETE as memberDelete } from "@/app/api/member/mcp-grants/[id]/route";
import {
  MCP_APP_NOT_APPROVED_MESSAGE,
  MCP_CONNECTION_REFUSAL_MESSAGES,
  resolveMcpGrantUse,
} from "@/lib/mcp/connection-gate";
import type { McpGrantForSession } from "@/lib/mcp/grant-session";
import { endMcpGrant, endMcpGrants, MCP_GRANT_END_REASONS } from "@/lib/mcp/grants";
import { DEFAULT_MCP_SETTINGS, type McpSettingsValues } from "@/lib/mcp/settings";

const NOW = new Date("2026-07-01T00:00:00.000Z");

let store: McpGrantStore;
let clubSettings: McpSettingsValues;

beforeEach(() => {
  store = createMcpGrantStore({});
  clubSettings = { ...DEFAULT_MCP_SETTINGS };
  for (const key of Object.keys(db)) delete db[key];
  Object.assign(db, store.db, { mcpSettings: { findUnique: vi.fn(async () => clubSettings) } });

  modules.mockResolvedValue({ mcpServer: true });
  guards.requireActiveSession.mockResolvedValue({ ok: true, session: { user: { id: "member-1" } } });
  guards.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "officer-1" } } });
  guards.requireActiveSessionUser.mockResolvedValue(null);
  audit.mockResolvedValue(undefined);
});

function grantById(id: string): StoredMcpGrant | undefined {
  return store.state.grants.find((grant) => grant.id === id);
}

function seed() {
  store.state.grants.push(
    mcpGrant({ id: "a", memberId: "member-1", clientId: "client-1" }),
    mcpGrant({ id: "b", memberId: "member-1", clientId: "client-2" }),
    mcpGrant({ id: "c", memberId: "member-2", clientId: "client-1" }),
    mcpGrant({
      id: "over",
      memberId: "member-1",
      clientId: "client-1",
      status: "REVOKED",
      endedReason: "app-revoked",
      endedAt: new Date("2026-06-25T00:00:00.000Z"),
    }),
  );
  store.state.tokens.push(
    { id: "t-a", grantId: "a", kind: "ACCESS" },
    { id: "r-a", grantId: "a", kind: "REFRESH" },
    { id: "t-b", grantId: "b", kind: "ACCESS" },
    { id: "t-c", grantId: "c", kind: "ACCESS" },
  );
  store.state.codes.push(
    { id: "code-a", grantId: "a", expiresAt: NOW, redirectUri: "https://claude.ai/callback" },
    { id: "code-c", grantId: "c", expiresAt: NOW },
  );
}

/** The reason -> status table in docs/STATE_MACHINES.md, "AI app connection lifecycle". */
function documentedEndStatuses(): Map<string, string> {
  const doc = readFileSync(path.resolve(process.cwd(), "docs/STATE_MACHINES.md"), "utf8");
  const start = doc.indexOf("## AI app connection lifecycle");
  const section = doc.slice(start, doc.indexOf("\n## ", start + 1));
  const rows = new Map<string, string>();
  for (const match of section.matchAll(/^\| `([a-z-]+)` \| (REVOKED|EXPIRED) \|/gm)) {
    rows.set(match[1], match[2]);
  }
  return rows;
}

describe("endMcpGrants", () => {
  it("ends only the ACTIVE connections its filter selects, with their tokens and codes", async () => {
    seed();
    const ended = await endMcpGrants({ memberId: "member-1", clientId: "client-1" }, "replaced");
    expect(ended).toBe(1);
    expect(grantById("a")).toMatchObject({ status: "REVOKED", endedReason: "replaced", endedAt: NOW });
    expect(grantById("b")?.status).toBe("ACTIVE");
    expect(grantById("c")?.status).toBe("ACTIVE");
    expect(store.state.tokens.map((token) => token.id)).toEqual(["t-b", "t-c"]);
    expect(store.state.codes.map((code) => code.id)).toEqual(["code-c"]);
  });

  it("leaves a connection that has already ended exactly as its first end wrote it", async () => {
    seed();
    const before = { ...grantById("over") };
    expect(await endMcpGrant("over", "admin-revoked")).toBe(0);
    expect(grantById("over")).toEqual(before);
    // Nothing selected, so nothing is claimed and nothing is deleted.
    expect(store.db.mcpGrant.updateMany).not.toHaveBeenCalled();
    expect(store.db.mcpToken.deleteMany).not.toHaveBeenCalled();
    expect(store.db.mcpAuthCode.deleteMany).not.toHaveBeenCalled();
  });

  it("does not overwrite the end another writer claimed between the read and the claim", async () => {
    seed();
    const claim = store.db.mcpGrant.updateMany.getMockImplementation();
    store.db.mcpGrant.updateMany.mockImplementationOnce(async (args) => {
      // The app revoked the connection a moment before this claim ran.
      Object.assign(grantById("a") as StoredMcpGrant, {
        status: "REVOKED",
        endedReason: "app-revoked",
        endedAt: new Date("2026-06-30T23:59:59.000Z"),
      });
      return (claim as NonNullable<typeof claim>)(args);
    });

    expect(await endMcpGrant("a", "member-revoked")).toBe(0);
    expect(grantById("a")).toMatchObject({ status: "REVOKED", endedReason: "app-revoked" });
    expect(store.db.mcpGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: "ACTIVE" }) }),
    );
  });

  it("gives each reason the end status the state-machine table documents", async () => {
    const documented = documentedEndStatuses();
    const reasons = Object.values(MCP_GRANT_END_REASONS);
    expect([...documented.keys()].sort()).toEqual([...reasons].sort());

    for (const reason of reasons) {
      store.state.grants.push(mcpGrant({ id: `grant-${reason}` }));
      expect(await endMcpGrant(`grant-${reason}`, reason)).toBe(1);
      expect(grantById(`grant-${reason}`), reason).toMatchObject({
        status: documented.get(reason),
        endedReason: reason,
      });
    }
  });
});

describe("a disconnect that loses the claim to another writer", () => {
  function racedClaim() {
    const claim = store.db.mcpGrant.updateMany.getMockImplementation();
    store.db.mcpGrant.updateMany.mockImplementationOnce(async (args) => {
      Object.assign(grantById("a") as StoredMcpGrant, { status: "EXPIRED", endedReason: "session-ended" });
      return (claim as NonNullable<typeof claim>)(args);
    });
  }

  it("answers the member 404 and writes no audit row", async () => {
    seed();
    racedClaim();
    const response = await memberDelete(
      new Request("https://club.example.test/api/member/mcp-grants/a", { method: "DELETE" }),
      { params: Promise.resolve({ id: "a" }) },
    );
    expect(response.status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
    expect(grantById("a")?.endedReason).toBe("session-ended");
  });

  it("answers the officer 404 and writes no audit row", async () => {
    seed();
    racedClaim();
    const response = await adminDelete(
      new Request("https://club.example.test/api/admin/mcp/grants/a", { method: "DELETE" }),
      { params: Promise.resolve({ id: "a" }) },
    );
    expect(response.status).toBe(404);
    expect(audit).not.toHaveBeenCalled();
    expect(grantById("a")?.endedReason).toBe("session-ended");
  });
});

// ---------------------------------------------------------------------------
// resolveMcpGrantUse
// ---------------------------------------------------------------------------

function grantForSession(overrides: Partial<McpGrantForSession> = {}): McpGrantForSession {
  return {
    id: "a",
    memberId: "member-1",
    scope: "READ_WRITE",
    status: "ACTIVE",
    sessionIssuedAt: new Date("2026-06-30T00:00:00.000Z"),
    twoFactorVerified: false,
    client: { id: "client-1", name: "Example Assistant" },
    member: { email: "ana@example.test", firstName: "Ana", lastName: "Reid" },
    ...overrides,
  };
}

function sessionFor(user: Record<string, unknown>, kioskAccount = false) {
  return {
    ok: true,
    session: { user: { id: "member-1", accessRoles: [], isEmailVerified: true, ...user }, expires: "" },
    kioskAccount,
  };
}

const officerMatrix = { overview: "view", support: "edit" };

describe("resolveMcpGrantUse", () => {
  beforeEach(() => {
    seed();
    buildSession.mockResolvedValue(sessionFor({}));
  });

  it("acts as the member, at the lesser of the approved scope and the club's limit", async () => {
    clubSettings = { ...clubSettings, maxScope: "READ_WRITE" };
    await expect(resolveMcpGrantUse(grantForSession())).resolves.toMatchObject({
      ok: true,
      scope: "READ_WRITE",
      session: { user: { id: "member-1" } },
    });

    clubSettings = { ...clubSettings, maxScope: "READ" };
    await expect(resolveMcpGrantUse(grantForSession())).resolves.toMatchObject({ ok: true, scope: "READ" });
    expect(guards.requireActiveSessionUser).toHaveBeenCalledWith(
      "member-1",
      expect.objectContaining({ sessionUser: expect.objectContaining({ id: "member-1" }) }),
    );
  });

  it("ends the connection as session-ended when its approving sign-in has ended", async () => {
    buildSession.mockResolvedValue({ ok: false, reason: "session-ended" });
    const use = await resolveMcpGrantUse(grantForSession());
    expect(use.ok).toBe(false);
    expect(grantById("a")).toMatchObject({ status: "EXPIRED", endedReason: "session-ended" });
    expect(store.state.tokens.some((token) => token.grantId === "a")).toBe(false);
    expect(grantById("b")?.status).toBe("ACTIVE");
  });

  it("refuses an account the website itself would stop, such as one that must change its password", async () => {
    guards.requireActiveSessionUser.mockResolvedValue(
      Response.json({ error: "Password change required" }, { status: 403 }),
    );
    const use = await resolveMcpGrantUse(grantForSession());
    expect(use.ok).toBe(false);
    // Not an end: the member can put it right and the connection works again.
    expect(grantById("a")?.status).toBe("ACTIVE");
  });

  it.each([
    ["a lodge kiosk account", () => buildSession.mockResolvedValue(sessionFor({}, true)), "kiosk-account"],
    [
      "an account whose email is no longer verified",
      () => buildSession.mockResolvedValue(sessionFor({ isEmailVerified: false })),
      "email-unverified",
    ],
    [
      "a member once the club stops members connecting",
      () => { clubSettings = { ...clubSettings, membersMayConnect: false }; },
      "not-permitted",
    ],
    [
      "an officer while officers may not connect",
      () => {
        buildSession.mockResolvedValue(sessionFor({ adminPermissionMatrix: officerMatrix }));
        clubSettings = { ...clubSettings, membersMayConnect: true, officersMayConnect: false };
      },
      "not-permitted",
    ],
  ] as const)("refuses %s on its next use, without ending the connection", async (_name, arrange, reason) => {
    arrange();
    await expect(resolveMcpGrantUse(grantForSession())).resolves.toEqual({
      ok: false,
      message: MCP_CONNECTION_REFUSAL_MESSAGES[reason],
    });
    expect(grantById("a")?.status).toBe("ACTIVE");
    expect(store.state.tokens.some((token) => token.grantId === "a")).toBe(true);
  });

  it("refuses a connection whose approved host the club removed, keeps it, and lets it act if the host returns", async () => {
    clubSettings = { ...clubSettings, allowedRedirectHosts: ["chatgpt.com"] };
    await expect(resolveMcpGrantUse(grantForSession())).resolves.toEqual({
      ok: false,
      message: MCP_APP_NOT_APPROVED_MESSAGE,
    });
    // Refused, not ended, exactly like a switched-off group (INV-MCP-003).
    expect(grantById("a")?.status).toBe("ACTIVE");
    expect(store.state.tokens.some((token) => token.grantId === "a")).toBe(true);

    clubSettings = { ...clubSettings, allowedRedirectHosts: ["chatgpt.com", "claude.ai"] };
    await expect(resolveMcpGrantUse(grantForSession())).resolves.toMatchObject({ ok: true });
  });

  it("keeps a loopback connection working whatever the approved list holds", async () => {
    store.state.codes.find((code) => code.id === "code-a")!.redirectUri = "http://127.0.0.1:43123/callback";
    clubSettings = { ...clubSettings, allowedRedirectHosts: [] };
    await expect(resolveMcpGrantUse(grantForSession())).resolves.toMatchObject({ ok: true });
  });

  it("refuses a connection with no approval address to check", async () => {
    store.state.codes = store.state.codes.filter((code) => code.grantId !== "a");
    await expect(resolveMcpGrantUse(grantForSession())).resolves.toEqual({
      ok: false,
      message: MCP_APP_NOT_APPROVED_MESSAGE,
    });
  });

  it("lets an officer's connection act once the club lets officers connect again", async () => {
    buildSession.mockResolvedValue(sessionFor({ adminPermissionMatrix: officerMatrix }));
    clubSettings = { ...clubSettings, membersMayConnect: false, officersMayConnect: true };
    await expect(resolveMcpGrantUse(grantForSession())).resolves.toMatchObject({ ok: true });
  });
});
