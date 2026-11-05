import { beforeEach, describe, expect, it, vi } from "vitest";

// Admin password-policy config API (#2033): support-area gating, audited writes,
// bounds enforcement (min 8–64), and the singleton upsert.

const mocks = vi.hoisted(() => {
  const values = {
    requireAdmin: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    auditCreate: vi.fn(),
  };
  const prisma = {
    loginSecuritySetting: { findUnique: values.findUnique, upsert: values.upsert },
    auditLog: { create: values.auditCreate },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
  );
  return { ...values, prisma };
});

vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: (value: unknown) => ({ data: value }),
  getAuditRequestContext: () => ({}),
}));

import { GET, PUT } from "@/app/api/admin/security/password-policy/route";

function put(body: unknown) {
  return PUT(
    new Request("http://localhost/api/admin/security/password-policy", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  );
}

const validBody = {
  minPasswordLength: 16,
  requireUppercase: true,
  requireLowercase: false,
  requireDigit: true,
  requireSymbol: false,
};

describe("admin security password-policy route (#2033)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({});
  });

  it("GET is gated on support:view and returns the effective policy", async () => {
    const res = await GET();
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "support", level: "view" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Absent row -> default policy.
    expect(body.policy.minPasswordLength).toBe(12);
  });

  it("PUT is gated on support:edit, upserts the singleton, and audits under security", async () => {
    const res = await put(validBody);
    expect(res.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "support", level: "edit" },
    });
    const upsertArgs = mocks.upsert.mock.calls[0][0];
    expect(upsertArgs.where).toEqual({ id: "default" });
    expect(upsertArgs.update).toMatchObject({
      minPasswordLength: 16,
      requireUppercase: true,
      requireDigit: true,
      updatedByMemberId: "admin-1",
    });
    // magicLinkTtlMinutes is NOT written by this endpoint (owned by #2034).
    expect(upsertArgs.update).not.toHaveProperty("magicLinkTtlMinutes");
    expect(mocks.auditCreate).toHaveBeenCalledOnce();
    const audit = mocks.auditCreate.mock.calls[0][0].data;
    expect(audit.category).toBe("security");
    expect(audit.action).toBe("LOGIN_SECURITY_PASSWORD_POLICY_UPDATED");
  });

  it("returns 403 when the guard denies access (no write)", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await put(validBody);
    expect(res.status).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a minimum length below the 8 floor (no write)", async () => {
    const res = await put({ ...validBody, minPasswordLength: 4 });
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a minimum length above the 64 ceiling (no write)", async () => {
    const res = await put({ ...validBody, minPasswordLength: 200 });
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("pins the minimum-length accept/reject boundary edges (7 rejected, 8 accepted, 64 accepted, 65 rejected)", async () => {
    // 7 rejected — below the floor, no write.
    expect((await put({ ...validBody, minPasswordLength: 7 })).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();

    // 8 accepted — the floor is inclusive.
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({});
    expect((await put({ ...validBody, minPasswordLength: 8 })).status).toBe(200);
    expect(mocks.upsert.mock.calls[0][0].update.minPasswordLength).toBe(8);

    // 64 accepted — the ceiling is inclusive.
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({});
    expect((await put({ ...validBody, minPasswordLength: 64 })).status).toBe(200);
    expect(mocks.upsert.mock.calls[0][0].update.minPasswordLength).toBe(64);

    // 65 rejected — above the ceiling, no write.
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({});
    expect((await put({ ...validBody, minPasswordLength: 65 })).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects an unknown field via the strict schema (no write)", async () => {
    const res = await put({ ...validBody, magicLinkTtlMinutes: 30 });
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  // #4610: the breached-password check switch (default on) is written here.
  describe("breachedPasswordCheck", () => {
    it("GET reports it on for an absent row", async () => {
      const body = await (await GET()).json();
      expect(body.policy.breachedPasswordCheck).toBe(true);
    });

    it("PUT writes it, audits before and after, and returns the stored value", async () => {
      mocks.findUnique
        .mockResolvedValueOnce({ ...validBody, breachedPasswordCheck: true }) // audit "before"
        .mockResolvedValueOnce({ ...validBody, breachedPasswordCheck: false }); // reload
      const res = await put({ ...validBody, breachedPasswordCheck: false });
      expect(res.status).toBe(200);
      expect(mocks.upsert.mock.calls[0][0].update).toMatchObject({ breachedPasswordCheck: false });
      expect(mocks.upsert.mock.calls[0][0].create).toMatchObject({ breachedPasswordCheck: false });
      const audit = mocks.auditCreate.mock.calls[0][0].data;
      expect(audit.metadata.before).toMatchObject({ breachedPasswordCheck: true });
      expect(audit.metadata.after).toMatchObject({ breachedPasswordCheck: false });
      expect((await res.json()).policy.breachedPasswordCheck).toBe(false);
    });

    it("leaves it untouched when a body from an older page omits it", async () => {
      expect((await put(validBody)).status).toBe(200);
      const upsertArgs = mocks.upsert.mock.calls[0][0];
      expect(upsertArgs.update.breachedPasswordCheck).toBeUndefined();
      expect(upsertArgs.create.breachedPasswordCheck).toBeUndefined();
    });

    it("rejects a non-boolean value (no write)", async () => {
      expect((await put({ ...validBody, breachedPasswordCheck: "off" })).status).toBe(400);
      expect(mocks.upsert).not.toHaveBeenCalled();
    });
  });
});
