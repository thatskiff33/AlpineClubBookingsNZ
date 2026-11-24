/**
 * The approval screen's decision and the member's own connection routes
 * (ALP-653, `INV-MCP-002`, `INV-MCP-003`, `INV-MCP-004`).
 *
 * `resolveMcpApproval` runs for real against the real authorisation-request
 * check; the database is the in-memory connection store, and the connection's
 * session preview (`buildMcpGrantSession`, covered by `mcp-principal.test.ts`)
 * is a double so each refusal can be set up by the member state it names.
 */
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMcpGrantStore, liveRefreshToken, mcpGrant, type McpGrantStore } from "./support/mcp-grant-store";

const { db, modules, buildSession, requireActiveSession, checkLimit, audit, authMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  db: {} as Record<string, unknown>,
  modules: vi.fn(),
  buildSession: vi.fn(),
  requireActiveSession: vi.fn(),
  checkLimit: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/app-url", () => ({ getAppBaseUrl: () => "https://club.example.test" }));
vi.mock("@/lib/module-settings", () => ({ loadEffectiveModuleFlags: modules }));
vi.mock("@/lib/mcp/grant-session", () => ({
  buildMcpGrantSession: buildSession,
  MCP_GRANT_SESSION_SELECT: {},
}));
// Only the forced-password-change case below reaches the real guard, which reads the session here.
vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSession,
  requireActiveSessionUser: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: checkLimit,
  rateLimitedResponse: () => Response.json({ error: "Too many requests" }, { status: 429 }),
  rateLimiters: { mcpApprove: "mcp-approve" },
}));
vi.mock("@/lib/mcp/audit", () => ({ recordMcpAudit: audit }));
vi.mock("@/lib/audit", () => ({ getAuditRequestContext: () => ({ ip: "203.0.113.9" }) }));

import { DELETE } from "@/app/api/member/mcp-grants/[id]/route";
import { GET, POST } from "@/app/api/member/mcp-grants/route";
import { hashActionToken } from "@/lib/action-tokens";
import {
  approvedMcpScope,
  MCP_SIGN_IN_AGAIN_MESSAGE,
  mcpApprovingSignIn,
  mcpAuthorizeParamsFromQuery,
  resolveMcpApproval,
} from "@/lib/mcp/approval";
import { MCP_CONNECTION_REFUSAL_MESSAGES } from "@/lib/mcp/connection-gate";
import { MCP_AUTHORIZE_PARAM_NAMES } from "@/lib/mcp/oauth";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";
import { DEFAULT_MCP_SETTINGS, type McpSettingsValues } from "@/lib/mcp/settings";

const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const redirectUri = "https://claude.ai/callback";

const authorize = {
  response_type: "code",
  client_id: "client-1",
  redirect_uri: redirectUri,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "app-state",
};

const sessionIssuedAt = new Date("2026-06-30T22:00:00.000Z");

/** The signed-in member as the session carries them. */
const memberUser = {
  id: "member-1",
  email: "ana@example.test",
  name: "Ana",
  role: "USER",
  accessRoles: [],
  isEmailVerified: true,
  sessionIssuedAt: sessionIssuedAt.getTime(),
} as never;

const officerMatrix = { overview: "view", support: "edit" };

let store: McpGrantStore;
let clubSettings: McpSettingsValues;
let previewUser: Record<string, unknown>;
let kioskAccount: boolean;
/** The member row as the approval transaction reads it after taking the lock. */
let lockedMember: { deletedAt: Date | null; canLogin: boolean } | null;

beforeEach(() => {
  store = createMcpGrantStore({});
  clubSettings = { ...DEFAULT_MCP_SETTINGS };
  previewUser = { id: "member-1", accessRoles: [], isEmailVerified: true };
  kioskAccount = false;
  lockedMember = { deletedAt: null, canLogin: true };

  for (const key of Object.keys(db)) delete db[key];
  Object.assign(db, store.db, {
    mcpSettings: { findUnique: vi.fn(async () => clubSettings) },
    mcpClient: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "client-1"
          ? { id: "client-1", name: "Example Assistant", redirectUris: [redirectUri] }
          : null,
      ),
    },
    member: { findUnique: vi.fn(async () => lockedMember) },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)),
  });

  modules.mockResolvedValue({ mcpServer: true });
  buildSession.mockImplementation(async () => ({
    ok: true,
    session: { user: previewUser, expires: "2026-07-01T01:00:00.000Z" },
    kioskAccount,
  }));
  requireActiveSession.mockResolvedValue({ ok: true, session: { user: memberUser } });
  checkLimit.mockResolvedValue({ success: true });
  audit.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// The approval decision
// ---------------------------------------------------------------------------

describe("mcpAuthorizeParamsFromQuery", () => {
  it("keeps each OAuth parameter given once", () => {
    expect(mcpAuthorizeParamsFromQuery({ ...authorize, scope: "read write" })).toEqual({
      ...authorize,
      scope: "read write",
    });
  });

  it("drops a parameter given twice, so the screen cannot show one value while the app meant another", () => {
    const params = mcpAuthorizeParamsFromQuery({
      ...authorize,
      redirect_uri: [redirectUri, "https://attacker.example/cb"],
      scope: ["read", "read write"],
    });
    expect(params).not.toHaveProperty("redirect_uri");
    expect(params).not.toHaveProperty("scope");
    expect(params.client_id).toBe("client-1");
  });

  it("ignores names OAuth does not define here, and absent values", () => {
    const params = mcpAuthorizeParamsFromQuery({
      ...authorize,
      prompt: "none",
      memberId: "member-2",
      resource: undefined,
    });
    expect(Object.keys(params).sort()).toEqual(Object.keys(authorize).sort());
    for (const name of Object.keys(params)) {
      expect(MCP_AUTHORIZE_PARAM_NAMES).toContain(name);
    }
  });
});

describe("mcpApprovingSignIn", () => {
  it("carries when the approving sign-in happened", () => {
    expect(mcpApprovingSignIn(memberUser)).toEqual({ sessionIssuedAt, twoFactorVerified: false });
  });

  it("counts two-factor only when the sign-in both needed and passed it", () => {
    const user = (extra: object) => ({ ...(memberUser as object), ...extra }) as never;
    expect(mcpApprovingSignIn(user({ twoFactorRequired: true, twoFactorVerified: true }))?.twoFactorVerified).toBe(true);
    expect(mcpApprovingSignIn(user({ twoFactorRequired: false, twoFactorVerified: true }))?.twoFactorVerified).toBe(false);
    expect(mcpApprovingSignIn(user({ twoFactorRequired: true, twoFactorVerified: false }))?.twoFactorVerified).toBe(false);
  });

  it("is absent for a session that does not say when it signed in", () => {
    expect(mcpApprovingSignIn({ ...(memberUser as object), sessionIssuedAt: undefined } as never)).toBeNull();
  });
});

describe("resolveMcpApproval", () => {
  it("asks the member, previewing the connection from their own sign-in", async () => {
    const approval = await resolveMcpApproval(authorize, memberUser);
    expect(approval).toMatchObject({
      kind: "ask",
      request: { clientId: "client-1", redirectHost: "claude.ai", state: "app-state" },
      signIn: { sessionIssuedAt, twoFactorVerified: false },
      mayChange: false,
    });
    expect(buildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: "member-1",
        sessionIssuedAt,
        client: { id: "client-1", name: "Example Assistant" },
      }),
    );
  });

  it.each([
    ["a lodge kiosk account", () => { kioskAccount = true; }, "kiosk-account"],
    ["an unverified email address", () => { previewUser.isEmailVerified = false; }, "email-unverified"],
    ["a member when the club lets no member connect", () => { clubSettings = { ...clubSettings, membersMayConnect: false }; }, "not-permitted"],
    [
      "an officer when only members may connect",
      () => {
        previewUser.adminPermissionMatrix = officerMatrix;
        clubSettings = { ...clubSettings, membersMayConnect: true, officersMayConnect: false };
      },
      "not-permitted",
    ],
  ] as const)("refuses %s", async (_name, arrange, reason) => {
    arrange();
    await expect(resolveMcpApproval(authorize, memberUser)).resolves.toEqual({
      kind: "refuse",
      message: MCP_CONNECTION_REFUSAL_MESSAGES[reason],
    });
  });

  it("asks an officer when the club lets officers connect, with the officer line", async () => {
    previewUser.adminPermissionMatrix = officerMatrix;
    clubSettings = { ...clubSettings, membersMayConnect: false, officersMayConnect: true };
    await expect(resolveMcpApproval(authorize, memberUser)).resolves.toMatchObject({ kind: "ask", officer: true });
  });

  it("asks a member without the officer line", async () => {
    await expect(resolveMcpApproval(authorize, memberUser)).resolves.toMatchObject({ kind: "ask", officer: false });
  });

  it("refuses when the sign-in behind the screen has ended", async () => {
    buildSession.mockResolvedValue({ ok: false, reason: "session-ended" });
    await expect(resolveMcpApproval(authorize, memberUser)).resolves.toMatchObject({ kind: "refuse" });
  });

  it("refuses a session that does not say when it signed in, without previewing anything", async () => {
    const user = { ...(memberUser as object), sessionIssuedAt: undefined } as never;
    await expect(resolveMcpApproval(authorize, user)).resolves.toMatchObject({ kind: "refuse" });
    expect(buildSession).not.toHaveBeenCalled();
  });

  it.each([
    ["an app that is not registered", { client_id: "client-unknown" }],
    ["an address the app did not register", { redirect_uri: "https://claude.ai/other" }],
    ["a missing redirect address", { redirect_uri: undefined }],
  ])("refuses %s and sends nobody anywhere", async (_name, change) => {
    const approval = await resolveMcpApproval({ ...authorize, ...change }, memberUser);
    expect(approval.kind).toBe("refuse");
    expect(buildSession).not.toHaveBeenCalled();
  });

  it("refuses an app whose host the club has since removed from its approved list", async () => {
    clubSettings = { ...clubSettings, allowedRedirectHosts: ["chatgpt.com"] };
    await expect(resolveMcpApproval(authorize, memberUser)).resolves.toMatchObject({ kind: "refuse" });
  });

  it("sends a malformed request back to the app it came from", async () => {
    const approval = await resolveMcpApproval({ ...authorize, code_challenge_method: "plain" }, memberUser);
    expect(approval.kind).toBe("redirect");
    const location = new URL((approval as { location: string }).location);
    expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe("app-state");
  });

  it.each([
    ["the app asked to change things and the club allows it", "read write", "READ_WRITE", true],
    ["the app asked to change things but the club allows view only", "read write", "READ", false],
    ["the club allows change but the app only asked to view", "read", "READ_WRITE", false],
    ["the app asked for nothing in particular", undefined, "READ_WRITE", false],
  ] as const)("offers view and change only when both agree: %s", async (_name, scope, maxScope, offered) => {
    clubSettings = { ...clubSettings, maxScope };
    const approval = await resolveMcpApproval({ ...authorize, scope }, memberUser);
    expect(approval).toMatchObject({ kind: "ask", mayChange: offered });
  });
});

describe("approvedMcpScope", () => {
  it("records view and change only when the screen offered it and the member chose it", () => {
    expect(approvedMcpScope("READ_WRITE", { mayChange: true })).toBe("READ_WRITE");
    expect(approvedMcpScope("READ", { mayChange: true })).toBe("READ");
    expect(approvedMcpScope("READ_WRITE", { mayChange: false })).toBe("READ");
    expect(approvedMcpScope("READ", { mayChange: false })).toBe("READ");
  });
});

// ---------------------------------------------------------------------------
// POST /api/member/mcp-grants
// ---------------------------------------------------------------------------

function decisionRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://club.example.test/api/member/mcp-grants", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const approve = (scope: "READ" | "READ_WRITE" = "READ", params: object = authorize) => ({
  decision: "approve",
  scope,
  params,
});

describe("POST /api/member/mcp-grants", () => {
  it("records an approval and sends the browser back to the app with a single-use code", async () => {
    const response = await POST(decisionRequest(approve()));
    expect(response.status).toBe(200);
    const { redirectTo } = (await response.json()) as { redirectTo: string };

    const back = new URL(redirectTo);
    expect(`${back.origin}${back.pathname}`).toBe(redirectUri);
    expect(back.searchParams.get("state")).toBe("app-state");
    expect(back.searchParams.get("iss")).toBe("https://club.example.test");
    const code = back.searchParams.get("code");
    expect(code).toBeTruthy();

    expect(store.state.grants).toHaveLength(1);
    const [grant] = store.state.grants;
    expect(grant).toMatchObject({
      memberId: "member-1",
      clientId: "client-1",
      status: "ACTIVE",
      scope: "READ",
      sessionIssuedAt,
    });
    // Only the code's hash is kept, bound to the address and the PKCE challenge.
    expect(store.state.codes).toEqual([
      expect.objectContaining({
        grantId: grant.id,
        codeHash: hashActionToken(code as string),
        redirectUri,
        codeChallenge: challenge,
      }),
    ]);
    expect(JSON.stringify(store.state.codes)).not.toContain(code as string);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MCP_CONNECTION_APPROVED",
        actorMemberId: "member-1",
        subjectMemberId: "member-1",
        grantId: grant.id,
      }),
    );
  });

  it.each([
    ["the club allows it and the app asked", "READ_WRITE", "read write", "READ_WRITE"],
    ["the club allows view only", "READ", "read write", "READ"],
    ["the app never asked to change things", "READ_WRITE", "read", "READ"],
  ] as const)("records view and change only when %s", async (_name, maxScope, scope, recorded) => {
    clubSettings = { ...clubSettings, maxScope };
    const response = await POST(decisionRequest(approve("READ_WRITE", { ...authorize, scope })));
    expect(response.status).toBe(200);
    expect(store.state.grants[0]?.scope).toBe(recorded);
  });

  // Owner decision, #5305 comment 7093303964, item 1 (`INV-MCP-009`).
  describe("approval for officer actions", () => {
    const officerApproval = (shown: boolean | undefined) => ({ ...approve(), officerNoticeShown: shown });

    beforeEach(() => {
      previewUser.adminPermissionMatrix = officerMatrix;
      clubSettings = { ...clubSettings, officersMayConnect: true };
    });

    it("records when an officer approved the screen that told them the app can act as an officer", async () => {
      const response = await POST(decisionRequest(officerApproval(true)));
      expect(response.status).toBe(200);
      expect(store.state.grants[0]?.officerConsentAt).toBeInstanceOf(Date);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "MCP_CONNECTION_APPROVED",
          metadata: expect.objectContaining({ officerActions: true }),
        }),
      );
    });

    it.each([
      ["did not show the officer line", false],
      ["predates the officer line", undefined],
    ] as const)("records no officer approval from a screen that %s", async (_name, shown) => {
      const response = await POST(decisionRequest(officerApproval(shown)));
      expect(response.status).toBe(200);
      expect(store.state.grants[0]?.officerConsentAt).toBeNull();
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ officerActions: false }) }),
      );
    });

    it("records none for a member, whatever the form says", async () => {
      previewUser.adminPermissionMatrix = undefined;
      clubSettings = { ...clubSettings, membersMayConnect: true };
      const response = await POST(decisionRequest(officerApproval(true)));
      expect(response.status).toBe(200);
      expect(store.state.grants[0]?.officerConsentAt).toBeNull();
    });
  });

  it("waits for the member lifecycle fence before reading grants to replace", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const lock = vi.fn<(...args: unknown[]) => Promise<void>>(() => { entered(); return held; });
    db.$executeRaw = lock;
    const pending = POST(decisionRequest(approve()));
    await waiting;
    expect(lock.mock.calls[0]?.[1]).toBe("member-lifecycle:member-1");
    expect(store.db.mcpGrant.findMany).not.toHaveBeenCalled();
    expect(store.state.grants).toEqual([]);
    // A competing approval committed while this transaction waited.
    store.state.grants.push(mcpGrant({ id: "racing-grant", scope: "READ_WRITE" }));
    release();
    expect((await pending).status).toBe(200);
    expect(store.state.grants.filter((grant) => grant.status === "ACTIVE")).toMatchObject([
      { scope: "READ" },
    ]);
    expect(store.state.grants.find((grant) => grant.id === "racing-grant")?.status).toBe("REVOKED");
  });

  it.each([
    ["erased", { deletedAt: new Date("2026-06-30T23:00:00.000Z"), canLogin: false }],
    ["merged away or had their login turned off", { deletedAt: null, canLogin: false }],
    ["removed", null],
  ] as const)(
    "records nothing when the member was %s while the approval waited for the lock",
    async (_name, afterwards) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      db.$executeRaw = vi.fn<(...args: unknown[]) => Promise<void>>(() => { entered(); return held; });
      const pending = POST(decisionRequest(approve()));
      await waiting;
      // The deletion, merge or login change commits while the approval waits.
      lockedMember = afterwards;
      release();
      const response = await pending;
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: MCP_SIGN_IN_AGAIN_MESSAGE });
      expect(store.state.grants).toEqual([]);
      expect(store.state.codes).toEqual([]);
      expect(audit).not.toHaveBeenCalled();
    },
  );

  it("replaces the member's earlier connection to the same app", async () => {
    store.state.grants.push(mcpGrant({ id: "grant-old" }));
    store.state.tokens.push({ id: "token-old", grantId: "grant-old", kind: "ACCESS" });
    await POST(decisionRequest(approve()));
    expect(store.state.grants.find((grant) => grant.id === "grant-old")).toMatchObject({
      status: "REVOKED",
      endedReason: "replaced",
    });
    expect(store.state.tokens).toEqual([]);
  });

  it("sends a refusal back to the app and records nothing", async () => {
    const response = await POST(decisionRequest({ ...approve(), decision: "deny" }));
    expect(response.status).toBe(200);
    const back = new URL(((await response.json()) as { redirectTo: string }).redirectTo);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("app-state");
    expect(back.searchParams.has("code")).toBe(false);
    expect(store.state.grants).toEqual([]);
    expect(store.state.codes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("checks the request again and refuses when the member may no longer connect", async () => {
    clubSettings = { ...clubSettings, membersMayConnect: false };
    const response = await POST(decisionRequest(approve()));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: MCP_CONNECTION_REFUSAL_MESSAGES["not-permitted"],
    });
    expect(store.state.grants).toEqual([]);
  });

  it("refuses a request arriving through an AI app connection before reading the session", async () => {
    const request = decisionRequest(approve(), { [MCP_PRINCIPAL_HEADER]: "anything" });
    const response = await POST(request);
    expect(response.status).toBe(403);
    expect(requireActiveSession).not.toHaveBeenCalled();
    expect(request.bodyUsed).toBe(false);
    expect(store.state.grants).toEqual([]);
  });

  it("does nothing for a member the session guard refuses, such as one who must change their password", async () => {
    requireActiveSession.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "Password change required" }, { status: 403 }),
    });
    const response = await POST(decisionRequest(approve()));
    expect(response.status).toBe(403);
    expect(store.state.grants).toEqual([]);
    expect(checkLimit).not.toHaveBeenCalled();
  });

  it("refuses, through the real session guard, a member who must change their password", async () => {
    // The route's own guard, unmocked: it must be called without
    // allowForcePasswordChange, so the member's forced change refuses the
    // approval before the body is read or anything is written.
    const actual = (await vi.importActual("@/lib/session-guards")) as typeof import("@/lib/session-guards");
    requireActiveSession.mockImplementation(actual.requireActiveSession);
    authMock.mockResolvedValue({ user: { ...(memberUser as object), forcePasswordChange: true } });
    (db.member as { findUnique: ReturnType<typeof vi.fn> }).findUnique = vi.fn(async () => ({
      active: true,
      canLogin: true,
      forcePasswordChange: true,
      twoFactorEnabled: false,
    }));
    const request = decisionRequest(approve());
    const response = await POST(request);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Password change required" });
    expect(request.bodyUsed).toBe(false);
    expect(store.state.grants).toEqual([]);
    expect(store.state.codes).toEqual([]);
    expect(checkLimit).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("limits approvals per member and records nothing over the limit", async () => {
    checkLimit.mockResolvedValue({ success: false });
    const response = await POST(decisionRequest(approve()));
    expect(response.status).toBe(429);
    expect(checkLimit).toHaveBeenCalledWith("mcp-approve", "member-1");
    expect(store.state.grants).toEqual([]);
  });

  it.each([
    ["a body that is not JSON", "{not json"],
    ["an unknown decision", { ...approve(), decision: "maybe" }],
    ["an unknown scope", { ...approve(), scope: "ADMIN" }],
    ["no request parameters", { decision: "approve", scope: "READ" }],
    ["an oversized parameter", approve("READ", { ...authorize, state: "s".repeat(2049) })],
  ])("refuses %s with 400 and records nothing", async (_name, body) => {
    const response = await POST(decisionRequest(body));
    expect(response.status).toBe(400);
    expect(store.state.grants).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/member/mcp-grants and DELETE /api/member/mcp-grants/[id]
// ---------------------------------------------------------------------------

function seedConnections() {
  store.state.codes.push({
    id: "code-mine", grantId: "mine", redirectUri,
    expiresAt: new Date("2026-06-20T00:05:00.000Z"),
  });
  store.state.grants.push(
    mcpGrant({ id: "mine", memberId: "member-1" }),
    mcpGrant({ id: "mine-uncollected", memberId: "member-1" }),
    mcpGrant({ id: "mine-ended", memberId: "member-1", status: "REVOKED", endedReason: "app-revoked" }),
    mcpGrant({ id: "theirs", memberId: "member-2" }),
  );
  store.state.tokens.push(
    { id: "t-mine", grantId: "mine", kind: "ACCESS" },
    liveRefreshToken("r-mine", "mine"),
    { id: "t-theirs", grantId: "theirs", kind: "ACCESS" },
    liveRefreshToken("r-theirs", "theirs"),
  );
}

function getRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://club.example.test/api/member/mcp-grants", { headers });
}

function deleteRequest(id: string, headers: Record<string, string> = {}) {
  return DELETE(
    new Request(`https://club.example.test/api/member/mcp-grants/${id}`, {
      method: "DELETE",
      headers,
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("GET /api/member/mcp-grants", () => {
  it("lists only the member's own connections that an app has collected", async () => {
    seedConnections();
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const { connections } = (await response.json()) as { connections: { id: string }[] };
    expect(connections.map((row) => row.id)).toEqual(["mine"]);
    expect(connections[0]).toMatchObject({ appName: "Example Assistant", appHost: "claude.ai" });
  });

  it("stops listing a connection once its app can no longer renew it", async () => {
    seedConnections();
    // The app stopped renewing: its last refresh token is spent or lapsed.
    const refresh = store.state.tokens.find((token) => token.id === "r-mine")!;
    refresh.expiresAt = new Date("2026-06-30T00:00:00.000Z");
    let response = await GET(getRequest());
    expect(await response.json()).toMatchObject({ connections: [] });

    refresh.expiresAt = new Date("2026-07-31T00:00:00.000Z");
    refresh.usedAt = new Date("2026-06-30T00:00:00.000Z");
    response = await GET(getRequest());
    expect(await response.json()).toMatchObject({ connections: [] });
  });

  it("shows the approved destination rather than the first registered alternative", async () => {
    seedConnections();
    store.state.codes[0]!.redirectUri = "http://localhost:54321/callback";
    const response = await GET(getRequest());
    expect(await response.json()).toMatchObject({
      connections: [{ id: "mine", appHost: "localhost" }],
    });
  });

  it("does not substitute a registered host when the approval record is absent", async () => {
    seedConnections();
    store.state.codes.length = 0;
    const response = await GET(getRequest());
    expect(await response.json()).toMatchObject({
      connections: [{ id: "mine", appHost: "" }],
    });
  });

  it("refuses a request arriving through an AI app connection", async () => {
    const response = await GET(getRequest({ [MCP_PRINCIPAL_HEADER]: "anything" }));
    expect(response.status).toBe(403);
    expect(requireActiveSession).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/member/mcp-grants/[id]", () => {
  it("ends the member's own connection as member-revoked and deletes its tokens", async () => {
    seedConnections();
    const response = await deleteRequest("mine");
    expect(response.status).toBe(200);
    expect(store.state.grants.find((grant) => grant.id === "mine")).toMatchObject({
      status: "REVOKED",
      endedReason: "member-revoked",
      endedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(store.state.tokens.map((token) => token.id)).toEqual(["t-theirs", "r-theirs"]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "MCP_CONNECTION_REVOKED",
        actorMemberId: "member-1",
        subjectMemberId: "member-1",
        grantId: "mine",
        metadata: { reason: "member-revoked" },
      }),
    );
  });

  it.each([
    ["someone else's connection", "theirs"],
    ["a connection that has already ended", "mine-ended"],
    ["a connection that does not exist", "nobody"],
  ])("answers 404 for %s and changes nothing", async (_name, id) => {
    seedConnections();
    const before = JSON.stringify(store.state);
    const response = await deleteRequest(id);
    expect(response.status).toBe(404);
    expect(JSON.stringify(store.state)).toBe(before);
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses a request arriving through an AI app connection", async () => {
    seedConnections();
    const response = await deleteRequest("mine", { [MCP_PRINCIPAL_HEADER]: "anything" });
    expect(response.status).toBe(403);
    expect(store.state.grants.find((grant) => grant.id === "mine")?.status).toBe("ACTIVE");
  });
});
