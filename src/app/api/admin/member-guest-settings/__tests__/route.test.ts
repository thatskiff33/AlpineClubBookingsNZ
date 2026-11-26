import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route tests for GET/PUT /api/admin/member-guest-settings (epic #2305, MG2
// #2307, owner decision D-17). Mock shape copied from the precedent route's suite
// (src/app/api/admin/ai-assistant/settings/__tests__/route.test.ts): the guard,
// the audit builder, and the singleton delegate are stubbed, and $transaction
// runs its callback against the same delegate mocks so the read-then-write inside
// the transaction is genuinely exercised.

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  hasAdminAreaAccess: vi.fn(),
  settingsFindUnique: vi.fn(),
  settingsUpsert: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  buildAudit: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/admin-permissions", () => ({
  hasAdminAreaAccess: mocks.hasAdminAreaAccess,
}));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: mocks.buildAudit,
  getAuditRequestContext: () => ({ id: null, ipAddress: "1.2.3.4", userAgent: "t" }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    memberGuestSettings: {
      findUnique: mocks.settingsFindUnique,
      upsert: mocks.settingsUpsert,
    },
    auditLog: { create: mocks.auditCreate },
    $transaction: mocks.transaction,
  },
}));

import { GET, PUT } from "../route";

const SAVED_AT = new Date("2026-08-03T21:15:00.000Z");

/** A full, valid form post — the card always sends all four fields. */
const VALID_BODY = {
  approvalRequired: false,
  pendingHoldExpiryDays: 14,
  openMemberSearchEnabled: true,
  openMemberSearchIncludesMinors: false,
};

function makeReq(body: unknown, raw?: string) {
  return new Request("https://club.example.com/api/admin/member-guest-settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

function getReq() {
  return new NextRequest("https://club.example.com/api/admin/member-guest-settings");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  // Default: a full bookings:edit admin.
  mocks.hasAdminAreaAccess.mockReturnValue(true);
  mocks.buildAudit.mockReturnValue({ data: {} });
  mocks.settingsFindUnique.mockResolvedValue(null);
  mocks.settingsUpsert.mockImplementation(async (args: { create: Record<string, unknown> }) => ({
    ...args.create,
    updatedAt: SAVED_AT,
  }));
  mocks.auditCreate.mockResolvedValue("AUDIT_OP");
  mocks.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      memberGuestSettings: {
        findUnique: mocks.settingsFindUnique,
        upsert: mocks.settingsUpsert,
      },
      auditLog: { create: mocks.auditCreate },
    }),
  );
});

describe("GET /api/admin/member-guest-settings", () => {
  it("returns 401 for an unauthenticated caller, exactly as the guard decides", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    const res = await GET(getReq());
    expect(res.status).toBe(401);
    expect(mocks.settingsFindUnique).not.toHaveBeenCalled();
  });

  it("returns 403 for an admin with no bookings access", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await GET(getReq());
    expect(res.status).toBe(403);
  });

  it("gates on bookings:view", async () => {
    await GET(getReq());
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "bookings", level: "view" },
    });
  });

  it("returns the shipped defaults when the club has never saved, and creates no row", async () => {
    mocks.settingsFindUnique.mockResolvedValue(null);
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      settings: {
        // D-3: ask-first is the shipped default.
        approvalRequired: true,
        pendingHoldExpiryDays: 7,
        // Both privacy toggles ship OFF (D-18 / MG3-D-b).
        openMemberSearchEnabled: false,
        openMemberSearchIncludesMinors: false,
      },
      updatedAt: null,
      updatedByMemberId: null,
      access: "manage",
      bounds: { pendingHoldExpiryDaysMin: 1, pendingHoldExpiryDaysMax: 60 },
    });
    // The row is created LAZILY: a read must never materialise it, because the
    // config-transfer exporter and the setup checklist key on row existence.
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("returns the saved values with both audit columns", async () => {
    mocks.settingsFindUnique.mockResolvedValue({
      approvalRequired: false,
      pendingHoldExpiryDays: 21,
      openMemberSearchEnabled: true,
      openMemberSearchIncludesMinors: true,
      updatedAt: SAVED_AT,
      updatedByMemberId: "admin-9",
    });
    const json = await (await GET(getReq())).json();
    expect(json.settings).toEqual({
      approvalRequired: false,
      pendingHoldExpiryDays: 21,
      openMemberSearchEnabled: true,
      openMemberSearchIncludesMinors: true,
    });
    expect(json.updatedAt).toBe("2026-08-03T21:15:00.000Z");
    expect(json.updatedByMemberId).toBe("admin-9");
  });

  it("signals `manage` to a bookings:edit admin", async () => {
    mocks.hasAdminAreaAccess.mockReturnValue(true);
    const json = await (await GET(getReq())).json();
    expect(json.access).toBe("manage");
    expect(mocks.hasAdminAreaAccess).toHaveBeenCalledWith(
      { id: "admin-1" },
      { area: "bookings", level: "edit" },
    );
  });

  it("signals `view` to a view-only admin, so the card renders no Save button", async () => {
    // The tri-state's whole point: view-only is a state the GET REPORTS, never a
    // write path the admin discovers by being 403'd.
    mocks.hasAdminAreaAccess.mockReturnValue(false);
    const json = await (await GET(getReq())).json();
    expect(json.access).toBe("view");
    // ...and it is still a real 200 with the real values, not a stub.
    expect(json.settings.approvalRequired).toBe(true);
  });
});

describe("PUT /api/admin/member-guest-settings", () => {
  it("gates on bookings:edit", async () => {
    await PUT(makeReq(VALID_BODY));
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "bookings", level: "edit" },
    });
  });

  it("rejects a view-only admin with 403 and touches the database not at all", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await PUT(makeReq(VALID_BODY));
    expect(res.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.settingsFindUnique).not.toHaveBeenCalled();
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller with 401 and writes nothing", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    const res = await PUT(makeReq(VALID_BODY));
    expect(res.status).toBe(401);
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
  });

  it("persists all four fields and stamps the audit columns", async () => {
    const res = await PUT(makeReq(VALID_BODY));
    expect(res.status).toBe(200);
    expect(mocks.settingsUpsert).toHaveBeenCalledTimes(1);
    const args = mocks.settingsUpsert.mock.calls[0][0];
    expect(args.where).toEqual({ id: "default" });
    expect(args.update).toEqual({
      approvalRequired: false,
      pendingHoldExpiryDays: 14,
      openMemberSearchEnabled: true,
      openMemberSearchIncludesMinors: false,
      updatedByMemberId: "admin-1",
    });
    // Upsert, because MG1 creates the row lazily: the first save has to create it,
    // with the same data the update branch would have written.
    expect(args.create).toEqual({ id: "default", ...args.update });
  });

  it("returns the same payload shape as the GET, with access always `manage`", async () => {
    const json = await (await PUT(makeReq(VALID_BODY))).json();
    expect(json).toEqual({
      settings: VALID_BODY,
      updatedAt: "2026-08-03T21:15:00.000Z",
      updatedByMemberId: "admin-1",
      access: "manage",
      bounds: { pendingHoldExpiryDaysMin: 1, pendingHoldExpiryDaysMax: 60 },
    });
  });

  it("writes one structured audit entry carrying the previous and new settings", async () => {
    mocks.settingsFindUnique.mockResolvedValue({
      approvalRequired: true,
      pendingHoldExpiryDays: 7,
      openMemberSearchEnabled: false,
      openMemberSearchIncludesMinors: false,
      updatedAt: SAVED_AT,
      updatedByMemberId: "admin-0",
    });
    await PUT(makeReq(VALID_BODY));
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    const audit = mocks.buildAudit.mock.calls[0][0];
    expect(audit.action).toBe("MEMBER_GUEST_SETTINGS_UPDATED");
    expect(audit.actor).toEqual({ memberId: "admin-1" });
    expect(audit.entity).toEqual({ type: "MemberGuestSettings", id: "default" });
    expect(audit.category).toBe("admin");
    expect(audit.severity).toBe("important");
    expect(audit.metadata.previousSettings).toEqual({
      approvalRequired: true,
      pendingHoldExpiryDays: 7,
      openMemberSearchEnabled: false,
      openMemberSearchIncludesMinors: false,
    });
    expect(audit.metadata.newSettings).toEqual(VALID_BODY);
    // The privacy-widening flag an auditor can grep for (D-18's concern).
    expect(audit.metadata.openMemberSearchWidened).toBe(true);
  });

  it("records the shipped defaults as the `previous` values on a first save", async () => {
    // A missing row does not mean "no settings" — the club was running on the
    // defaults, so those are the honest before-values.
    mocks.settingsFindUnique.mockResolvedValue(null);
    await PUT(makeReq({ ...VALID_BODY, openMemberSearchEnabled: false }));
    expect(mocks.buildAudit.mock.calls[0][0].metadata.previousSettings).toEqual({
      approvalRequired: true,
      pendingHoldExpiryDays: 7,
      openMemberSearchEnabled: false,
      openMemberSearchIncludesMinors: false,
    });
  });

  it("does not flag a widening when neither privacy toggle moved", async () => {
    mocks.settingsFindUnique.mockResolvedValue({
      approvalRequired: true,
      pendingHoldExpiryDays: 7,
      openMemberSearchEnabled: true,
      openMemberSearchIncludesMinors: false,
      updatedAt: SAVED_AT,
      updatedByMemberId: "admin-0",
    });
    await PUT(makeReq(VALID_BODY));
    expect(mocks.buildAudit.mock.calls[0][0].metadata.openMemberSearchWidened).toBe(
      false,
    );
  });

  it("still audits a save that changes nothing", async () => {
    // Deliberate: re-affirming a privacy posture is an administrative act, and
    // "who pressed Save, and what were the toggles then" is exactly what this
    // trail exists to answer. See the comment on the audit call in the route.
    mocks.settingsFindUnique.mockResolvedValue({
      ...VALID_BODY,
      updatedAt: SAVED_AT,
      updatedByMemberId: "admin-1",
    });
    const res = await PUT(makeReq(VALID_BODY));
    expect(res.status).toBe(200);
    expect(mocks.settingsUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });

  it("reads the previous values, upserts, and audits inside ONE transaction", async () => {
    await PUT(makeReq(VALID_BODY));
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    // Reading the old row outside the transaction would let two racing writers
    // record the same stale "previous" values.
    expect(mocks.settingsFindUnique).toHaveBeenCalledTimes(1);
  });

  it("rejects an unparseable body with 400", async () => {
    const res = await PUT(makeReq(undefined, "{ not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["0 (below the minimum)", 0],
    ["61 (above the maximum)", 61],
    ["7.5 (not a whole number)", 7.5],
    ['the string "7"', "7"],
    ["null", null],
    ["a missing field", undefined],
  ])(
    "rejects pendingHoldExpiryDays = %s with 400, a plain-English message, and no write",
    async (_label, value) => {
      const body: Record<string, unknown> = { ...VALID_BODY };
      if (value === undefined) delete body.pendingHoldExpiryDays;
      else body.pendingHoldExpiryDays = value;

      const res = await PUT(makeReq(body));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Invalid input");
      expect(json.details.fieldErrors.pendingHoldExpiryDays).toEqual([
        "Hold expiry must be a whole number of days between 1 and 60.",
      ]);
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    },
  );

  it.each([1, 60])("accepts the inclusive bound %i", async (days) => {
    const res = await PUT(makeReq({ ...VALID_BODY, pendingHoldExpiryDays: days }));
    expect(res.status).toBe(200);
    expect(mocks.settingsUpsert.mock.calls[0][0].update.pendingHoldExpiryDays).toBe(
      days,
    );
  });

  it.each([
    "approvalRequired",
    "openMemberSearchEnabled",
    "openMemberSearchIncludesMinors",
  ])("requires %s to be a strict boolean, never a truthy string", async (field) => {
    // No coercion: "true"/1/"on" are rejected. Coercing them would let a typo in
    // a form post turn a privacy toggle on.
    for (const value of ["true", 1, null, undefined]) {
      vi.clearAllMocks();
      mocks.requireAdmin.mockResolvedValue({
        ok: true,
        session: { user: { id: "admin-1" } },
      });
      const body: Record<string, unknown> = { ...VALID_BODY };
      if (value === undefined) delete body[field];
      else body[field] = value;

      const res = await PUT(makeReq(body));
      expect(res.status, `${field} = ${JSON.stringify(value)}`).toBe(400);
      const json = await res.json();
      expect(json.details.fieldErrors[field]?.[0]).toMatch(/must be true or false\./);
      expect(mocks.transaction).not.toHaveBeenCalled();
    }
  });

  it("rejects an unknown key rather than ignoring it", async () => {
    // `.strict()`: a renamed or mistyped field must not look like a successful
    // save. Reported here so the card's contract is explicit — this route
    // REJECTS unknown keys, it does not strip them.
    const res = await PUT(
      makeReq({ ...VALID_BODY, openMemberSearchIncludesMinorz: true }),
    );
    expect(res.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
