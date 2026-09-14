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
  isFullAdmin: vi.fn(),
  createAuditLog: vi.fn(),
  getAuditRequestContext: vi.fn(),
  getMirotalkConfigurationStatus: vi.fn(),
  readMirotalkStoredSettings: vi.fn(),
  writeMirotalkSettings: vi.fn(),
  clearMirotalkSecretsForAddressMove: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/access-roles", () => ({ isFullAdmin: mocks.isFullAdmin }));
vi.mock("@/lib/audit", () => ({
  createAuditLog: mocks.createAuditLog,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));
vi.mock("@/lib/mirotalk-config", () => ({
  getMirotalkConfigurationStatus: mocks.getMirotalkConfigurationStatus,
  readMirotalkStoredSettings: mocks.readMirotalkStoredSettings,
}));
vi.mock("@/lib/mirotalk-config-write", () => ({
  clearMirotalkSecretsForAddressMove: mocks.clearMirotalkSecretsForAddressMove,
  writeMirotalkSettings: mocks.writeMirotalkSettings,
}));

import { GET, PUT } from "../route";

function putRequest(body: unknown) {
  return new Request("https://club.example.com/api/admin/integrations/mirotalk", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function asAdmin(fullAdmin: boolean) {
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1", accessRoles: ["ADMIN"] } },
  });
  mocks.isFullAdmin.mockReturnValue(fullAdmin);
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

  it("clears the stored host sign-in when the address moves", async () => {
    // The three secrets only mean anything to the MiroTalk instance they were
    // paired with, so a genuine move invalidates them — and a redirected join
    // link is then left with no stored credential to carry. The Alpine Central
    // Server route makes the same trade for the same reason.
    mocks.readMirotalkStoredSettings.mockResolvedValue({
      ...STORED,
      baseUrl: "https://old.example.org",
    });
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
