import { beforeEach, describe, expect, it, vi } from "vitest";

// C5 #1984: the admin club-identity API now accepts facebookUrl (URL-shape
// validated, clearable to null) alongside name / shortName / hutLeaderLabel.

const mocks = vi.hoisted(() => {
  const values = {
    requireAdmin: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    auditCreate: vi.fn(),
    revalidatePath: vi.fn(),
    invalidate: vi.fn(),
    prime: vi.fn(),
  };
  const prisma = {
    clubIdentitySettings: { findUnique: values.findUnique, upsert: values.upsert },
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
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: (value: unknown) => value,
  getAuditRequestContext: () => ({}),
}));
// Avoid the server-only import chain of club-identity-settings in this Node test.
vi.mock("@/lib/club-identity-settings", () => ({
  primeClubIdentitySync: mocks.prime,
}));
vi.mock("@/lib/public-layout-cache", () => ({
  invalidatePublicClubIdentity: mocks.invalidate,
}));

import { GET, PUT } from "@/app/api/admin/club-identity/route";

const existing = {
  name: "Existing Club",
  shortName: "EC",
  hutLeaderLabel: "Warden",
  facebookUrl: "https://facebook.com/existing",
};

function put(body: unknown) {
  return PUT(
    new Request("http://localhost/api/admin/club-identity", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  );
}

const validBody = {
  name: "New Club",
  shortName: "NC",
  hutLeaderLabel: "Duty Manager",
  facebookUrl: "https://www.facebook.com/new-club",
};

describe("admin club-identity route — facebookUrl (C5 #1984)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mocks.findUnique.mockResolvedValue(existing);
    mocks.upsert.mockImplementation(async ({ create, update }: {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => ({ ...create, ...update }));
  });

  it("GET serializes facebookUrl", async () => {
    const response = await GET();
    expect(await response.json()).toEqual({
      settings: {
        name: "Existing Club",
        shortName: "EC",
        hutLeaderLabel: "Warden",
        facebookUrl: "https://facebook.com/existing",
      },
    });
  });

  it("sets a valid facebookUrl, persists it, and audits the change", async () => {
    const response = await put(validBody);
    expect(response.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      permission: { area: "content", level: "edit" },
    });
    // The write carries the trimmed facebookUrl.
    const upsertArgs = mocks.upsert.mock.calls[0][0];
    expect(upsertArgs.update).toMatchObject({
      facebookUrl: "https://www.facebook.com/new-club",
    });
    // Audit metadata records the new value; caches invalidated + sync primed.
    expect(mocks.auditCreate).toHaveBeenCalledOnce();
    const audit = mocks.auditCreate.mock.calls[0][0];
    expect(audit.metadata.after.facebookUrl).toBe(
      "https://www.facebook.com/new-club",
    );
    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.prime).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({
      settings: { facebookUrl: "https://www.facebook.com/new-club" },
    });
  });

  it("clears facebookUrl to null on an empty string (restores the fallback)", async () => {
    const response = await put({ ...validBody, facebookUrl: "" });
    expect(response.status).toBe(200);
    expect(mocks.upsert.mock.calls[0][0].update.facebookUrl).toBeNull();
  });

  it("rejects a non-URL facebookUrl with 400 (no write)", async () => {
    const response = await put({ ...validBody, facebookUrl: "not-a-url" });
    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a non-http(s) scheme with 400", async () => {
    const response = await put({
      ...validBody,
      facebookUrl: "ftp://example.com/x",
    });
    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});

describe("admin club-identity route — invoice supplier (#5066)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
    mocks.findUnique.mockResolvedValue({ ...existing, legalName: "Existing Club Inc", postalAddress: "PO Box 1\nTown" });
    mocks.upsert.mockImplementation(async ({ create, update }: {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => ({ ...create, ...update }));
  });

  it("GET returns the legal name and postal address", async () => {
    const response = await GET();
    expect(await response.json()).toMatchObject({
      settings: { legalName: "Existing Club Inc", postalAddress: "PO Box 1\nTown" },
    });
  });

  it("stores a trimmed legal name and the address one trimmed line per line, blank lines dropped", async () => {
    const response = await put({ ...validBody, legalName: "  New Club Incorporated ", postalAddress: " PO Box 7 \r\n\n  Ohakune 4625 \n" });
    expect(response.status).toBe(200);
    expect(mocks.upsert.mock.calls[0][0].update).toMatchObject({
      legalName: "New Club Incorporated",
      postalAddress: "PO Box 7\nOhakune 4625",
    });
    expect(mocks.auditCreate.mock.calls[0][0].metadata.after).toMatchObject({
      legalName: "New Club Incorporated",
      postalAddress: "PO Box 7\nOhakune 4625",
    });
  });

  it("clears either to null when sent blank (the club name and no address are printed)", async () => {
    await put({ ...validBody, legalName: " ", postalAddress: "\n \n" });
    expect(mocks.upsert.mock.calls[0][0].update).toMatchObject({ legalName: null, postalAddress: null });
  });

  it("leaves both as stored when a body from before this release omits them", async () => {
    const response = await put(validBody);
    expect(response.status).toBe(200);
    const { update, create } = mocks.upsert.mock.calls[0][0];
    expect("legalName" in update).toBe(false);
    expect("postalAddress" in update).toBe(false);
    expect("legalName" in create).toBe(false);
  });

  it("refuses a legal name with a line break with 400 and writes nothing", async () => {
    for (const legalName of ["Alpine Club\nIncorporated", "Alpine Club\rIncorporated"]) {
      expect((await put({ ...validBody, legalName })).status).toBe(400);
    }
    expect((await put({ ...validBody, legalName: "x".repeat(201) })).status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses an over-long address with 400 and writes nothing", async () => {
    const response = await put({ ...validBody, postalAddress: "x".repeat(501) });
    expect(response.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
