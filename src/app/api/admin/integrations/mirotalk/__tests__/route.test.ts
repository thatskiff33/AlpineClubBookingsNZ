import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The non-secret MiroTalk settings route (#2940).
 *
 * What is worth pinning here is the gate and the two "empty means fall back"
 * rules, because both are places where a reasonable-looking change quietly
 * removes the fallback contract: refusing an empty address would strand a club
 * that set one by mistake, and treating `presenterEnabled: null` as `false`
 * would override an environment variable the club never touched.
 */

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createAuditLog: vi.fn(),
  getAuditRequestContext: vi.fn(),
  getMirotalkConfigurationStatus: vi.fn(),
  readMirotalkStoredSettings: vi.fn(),
  mirotalkMeetingServerMoved: vi.fn(),
  writeMirotalkSettings: vi.fn(),
  clearMirotalkSecretsForAddressMove: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
// `@/lib/access-roles` is DELIBERATELY NOT MOCKED. A stubbed `isFullAdmin`
// returns what the test told it to regardless of the argument it was handed, so
// the route could read the roles off anything at all — a literal `["ADMIN"]`
// included — and every case here still passed. The gate is the whole point of
// this route, so the real predicate runs on a real role token and the session
// below carries the role that makes the answer come out differently.
vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));
vi.mock("@/lib/mirotalk-config", () => ({
  getMirotalkConfigurationStatus: mocks.getMirotalkConfigurationStatus,
  readMirotalkStoredSettings: mocks.readMirotalkStoredSettings,
  mirotalkMeetingServerMoved: mocks.mirotalkMeetingServerMoved,
}));
vi.mock("@/lib/mirotalk-config-write", () => ({
  clearMirotalkSecretsForAddressMove: mocks.clearMirotalkSecretsForAddressMove,
  writeMirotalkSettings: mocks.writeMirotalkSettings,
}));

import { MIROTALK_SETTINGS_ID } from "@/lib/mirotalk-settings-shared";
import { GET, PUT } from "../route";

function putRequest(body: unknown) {
  return new Request("https://club.example.com/api/admin/integrations/mirotalk", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * A session that has already passed `finance: edit`, holding a REAL role token.
 *
 * The non-Full-Admin case is a Treasurer (`FINANCE_ADMIN`), which is exactly the
 * role the route's own docblock names: `finance: edit` admits it, and it is the
 * role that must NOT be able to change a capability setting. Passing the real
 * token means `isFullAdmin` computes the answer from the session rather than
 * from a mock's instruction, so a route that read the roles from anywhere else
 * fails here instead of passing.
 */
function asAdmin(fullAdmin: boolean) {
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: {
      user: {
        id: "admin-1",
        accessRoles: fullAdmin ? ["ADMIN"] : ["FINANCE_ADMIN"],
      },
    },
  });
}

const STORED = {
  baseUrl: null,
  presenterEnabled: null,
  tokenLifetime: null,
  updatedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  asAdmin(true);
  mocks.readMirotalkStoredSettings.mockResolvedValue({ ...STORED });
  mocks.writeMirotalkSettings.mockResolvedValue({ ...STORED });
  mocks.clearMirotalkSecretsForAddressMove.mockResolvedValue([]);
  mocks.mirotalkMeetingServerMoved.mockReturnValue(false);
  mocks.getAuditRequestContext.mockReturnValue({ id: "req-1" });
  mocks.getMirotalkConfigurationStatus.mockResolvedValue({
    baseUrl: { effective: "https://meet.lwtc.org.nz", source: "environment", problem: null },
    presenter: { effective: "on", source: "derived", problem: null },
    tokenLifetime: { effective: "1h", source: "derived", problem: null },
    secrets: [],
    tokenMintable: false,
  });
});

describe("GET", () => {
  it("returns what is in force and what is stored, separately", async () => {
    mocks.readMirotalkStoredSettings.mockResolvedValue({
      ...STORED,
      presenterEnabled: false,
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    // A blank box with "using MIROTALK_URL" beside it is exactly the state this
    // separation renders — the stored value is empty, the effective one is not.
    expect(body.settings.baseUrl).toBe("");
    expect(body.status.baseUrl.effective).toBe("https://meet.lwtc.org.nz");
    expect(body.settings.presenterEnabled).toBe(false);
  });

  it("says when the section was last saved", async () => {
    // #2940 review, C2. The row's `updatedAt` was read and consumed by nothing
    // while each secret rendered "Last changed" from the same request — so the
    // page said when a signing key moved and not when the address did. Outside
    // `settings`, because that object is the form's draft.
    mocks.readMirotalkStoredSettings.mockResolvedValue({
      ...STORED,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const body = await (await GET()).json();
    expect(body.settingsUpdatedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(body.settings.settingsUpdatedAt).toBeUndefined();
  });

  it("is readable by an admin who may not change it", async () => {
    asAdmin(false);
    const res = await GET();
    expect(res.status).toBe(200);
  });
});

describe("PUT", () => {
  it("refuses a non-Full-Admin, and records the refusal", async () => {
    asAdmin(false);
    const res = await PUT(
      putRequest({ baseUrl: "", presenterEnabled: null, tokenLifetime: "" }),
    );
    expect(res.status).toBe(403);
    expect(mocks.writeMirotalkSettings).not.toHaveBeenCalled();
    const row = mocks.createAuditLog.mock.calls[0][0];
    expect(row.action).toBe("mirotalk.settings.denied");
    expect(row.category).toBe("security");
    expect(row.outcome).toBe("failure");
    // The constant, not a second spelling of "default" (#2940 review, T4).
    expect(row.entityId).toBe(MIROTALK_SETTINGS_ID);
  });

  it("refuses a custom role matrix that carries finance: edit", async () => {
    // The docblock's claim, made testable: `finance: edit` admits any custom
    // role, whose token is an AccessRoleDefinition id rather than an enum
    // value. Such a token is privileged but is not `ADMIN`, so it reaches this
    // gate and must be turned away by it.
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: {
        user: { id: "admin-2", accessRoles: ["cmcustomroledefinitionid0001"] },
      },
    });
    const res = await PUT(
      putRequest({ baseUrl: "", presenterEnabled: null, tokenLifetime: "" }),
    );
    expect(res.status).toBe(403);
    expect(mocks.writeMirotalkSettings).not.toHaveBeenCalled();
  });

  it("accepts an empty address as 'clear it and use the environment again'", async () => {
    const res = await PUT(
      putRequest({ baseUrl: "", presenterEnabled: null, tokenLifetime: "" }),
    );
    expect(res.status).toBe(200);
    const call = mocks.writeMirotalkSettings.mock.calls[0][0];
    expect(call.draft.baseUrl).toBe("");
    expect(call.draft.presenterEnabled).toBeNull();
  });

  it("keeps null distinct from false for the presenter flag", async () => {
    await PUT(
      putRequest({ baseUrl: "", presenterEnabled: false, tokenLifetime: "" }),
    );
    expect(mocks.writeMirotalkSettings.mock.calls[0][0].draft.presenterEnabled).toBe(
      false,
    );
  });

  it("normalises an address before storing it", async () => {
    await PUT(
      putRequest({
        baseUrl: "meet.lwtc.org.nz/",
        presenterEnabled: null,
        tokenLifetime: "",
      }),
    );
    expect(mocks.writeMirotalkSettings.mock.calls[0][0].draft.baseUrl).toBe(
      "https://meet.lwtc.org.nz",
    );
  });

  it("refuses an address a join token must not be sent to", async () => {
    const res = await PUT(
      putRequest({
        baseUrl: "http://192.168.1.10:3010",
        presenterEnabled: null,
        tokenLifetime: "",
      }),
    );
    expect(res.status).toBe(400);
    expect(mocks.writeMirotalkSettings).not.toHaveBeenCalled();
  });

  it("refuses a lifetime it cannot read", async () => {
    const res = await PUT(
      putRequest({ baseUrl: "", presenterEnabled: null, tokenLifetime: "soon" }),
    );
    expect(res.status).toBe(400);
    expect(mocks.writeMirotalkSettings).not.toHaveBeenCalled();
  });

  it("names the fields that moved, so the audit row is readable", async () => {
    mocks.readMirotalkStoredSettings.mockResolvedValue({
      ...STORED,
      baseUrl: "https://old.example.org",
    });
    await PUT(
      putRequest({
        baseUrl: "https://meet.lwtc.org.nz",
        presenterEnabled: true,
        tokenLifetime: "",
      }),
    );
    const call = mocks.writeMirotalkSettings.mock.calls[0][0];
    expect(call.changedFields).toEqual(["meeting server address", "presenter"]);
    expect(call.memberId).toBe("admin-1");
  });

  it("does NOT clear the secrets when the box only writes down the address already in force", async () => {
    // #2940 review, C1. `before.baseUrl` is null on every install that has only
    // ever set MIROTALK_URL, so a column-level comparison read this as a move
    // and deleted three secrets nobody can read back — a Full Admin who stored
    // the signing key and the host credentials and then typed the address they
    // were already using would simply lose all three, and be told afterwards.
    // The clear is driven by the resolver's answer instead.
    mocks.mirotalkMeetingServerMoved.mockReturnValue(false);
    const res = await PUT(
      putRequest({
        baseUrl: "https://meet.lwtc.org.nz",
        presenterEnabled: null,
        tokenLifetime: "",
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.clearMirotalkSecretsForAddressMove).not.toHaveBeenCalled();
    expect((await res.json()).secretsCleared).toBeNull();

    // The audit row still says the admin edited the box, because that is what
    // they did — the two questions are separate, and only the second one is
    // allowed to delete anything.
    const call = mocks.writeMirotalkSettings.mock.calls[0][0];
    expect(call.changedFields).toEqual(["meeting server address"]);
    expect(call.addressChange).toEqual({
      from: null,
      to: "https://meet.lwtc.org.nz",
    });
    expect(call.secretsCleared).toEqual([]);
  });

  it("asks the resolver about the EFFECTIVE address, not the stored column", async () => {
    // The predicate is handed the row as stored and the row as it will be, so
    // every precedence rule is applied by the one resolver rather than restated
    // in the route.
    mocks.readMirotalkStoredSettings.mockResolvedValue({
      ...STORED,
      presenterEnabled: true,
    });
    await PUT(
      putRequest({
        baseUrl: "https://meet.lwtc.org.nz",
        presenterEnabled: true,
        tokenLifetime: "",
      }),
    );
    expect(mocks.mirotalkMeetingServerMoved).toHaveBeenCalledWith(
      { ...STORED, presenterEnabled: true },
      { ...STORED, presenterEnabled: true, baseUrl: "https://meet.lwtc.org.nz" },
    );
  });

  it("clears the stored host sign-in when the address moves", async () => {
    // The three secrets only mean anything to the MiroTalk instance they were
    // paired with, so a genuine move invalidates them — and a redirected join
    // link is then left with no stored credential to carry. The Alpine Central
    // Server route makes the same trade for the same reason.
    mocks.readMirotalkStoredSettings.mockResolvedValue({
      ...STORED,
      baseUrl: "https://old.example.org",
    });
    mocks.mirotalkMeetingServerMoved.mockReturnValue(true);
    mocks.clearMirotalkSecretsForAddressMove.mockResolvedValue([
      "jwt_key",
      "meeting_password",
    ]);

    const res = await PUT(
      putRequest({
        baseUrl: "https://meet.lwtc.org.nz",
        presenterEnabled: null,
        tokenLifetime: "",
      }),
    );

    expect(mocks.clearMirotalkSecretsForAddressMove).toHaveBeenCalledWith({
      actor: { kind: "admin", memberId: "admin-1" },
      request: { id: "req-1" },
    });
    // BEFORE the settings write, not after: clearing first can only produce the
    // old address with no stored credentials, whereas writing first leaves the
    // new address paired with the old server's credentials if the clear throws.
    expect(
      mocks.clearMirotalkSecretsForAddressMove.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.writeMirotalkSettings.mock.invocationCallOrder[0]);

    const call = mocks.writeMirotalkSettings.mock.calls[0][0];
    expect(call.addressChange).toEqual({
      from: "https://old.example.org",
      to: "https://meet.lwtc.org.nz",
    });
    expect(call.secretsCleared).toEqual(["jwt_key", "meeting_password"]);

    // The person who moved the address is the only one who can put the new
    // server's values in, so they have to be told.
    const body = await res.json();
    expect(body.secretsCleared).toMatch(/signing key/i);
    expect(body.secretsCleared).toMatch(/host password/i);
  });

  it("leaves the secrets alone when only the presenter flag moves", async () => {
    mocks.readMirotalkStoredSettings.mockResolvedValue({
      ...STORED,
      baseUrl: "https://meet.lwtc.org.nz",
    });
    const res = await PUT(
      putRequest({
        baseUrl: "https://meet.lwtc.org.nz",
        presenterEnabled: false,
        tokenLifetime: "",
      }),
    );
    expect(res.status).toBe(200);
    expect(mocks.clearMirotalkSecretsForAddressMove).not.toHaveBeenCalled();
    expect(
      mocks.writeMirotalkSettings.mock.calls[0][0].addressChange,
    ).toBeUndefined();
    expect((await res.json()).secretsCleared).toBeNull();
  });
});
