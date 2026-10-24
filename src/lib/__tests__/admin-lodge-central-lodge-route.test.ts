import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET|PUT /api/admin/lodges/[id]/central-lodge` (#62).
 *
 * Pinned: the permission on each verb; only an OWNED central lodge can be
 * linked; one central lodge links to one local lodge (the unique index, as a
 * 409 naming the holder); null unlinks; the audit row records before and after
 * under the lodge subsystem's `admin` category; and the GET reports the
 * explicit publication link for THIS lodge only.
 */

const { mockPrisma, mockRequireAdmin, mockCreateAuditLog, mockSettings, mockSecret, mockSettingsLock } = vi.hoisted(() => ({
  mockPrisma: (() => {
    const client = {
      lodge: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
      // The owned lodges' local copies, for the options' labels (#69).
      otherLodge: { findMany: vi.fn() },
      $transaction: vi.fn(),
      $executeRaw: vi.fn().mockResolvedValue(1),
    };
    client.$transaction.mockImplementation(async (fn: (tx: typeof client) => unknown) => fn(client));
    return client;
  })(),
  mockRequireAdmin: vi.fn(),
  mockCreateAuditLog: vi.fn().mockResolvedValue(undefined),
  mockSettings: vi.fn(),
  mockSecret: vi.fn(),
  mockSettingsLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
}));
vi.mock("@/lib/audit", () => ({
  createAuditLog: (...args: unknown[]) => mockCreateAuditLog(...args),
}));
vi.mock("@/lib/servernz-settings", () => ({
  loadServerNzSettings: (...args: unknown[]) => mockSettings(...args),
  lockServerNzSettings: (...args: unknown[]) => mockSettingsLock(...args),
}));
vi.mock("@/lib/integration-credentials", () => ({
  getIntegrationCredentialValue: (...args: unknown[]) => mockSecret(...args),
}));
vi.mock("@/lib/club-post-mirror", () => ({ SERVERNZ_PUSH_SECRET_KEY: "push_secret" }));

import { GET, PUT } from "@/app/api/admin/lodges/[id]/central-lodge/route";

const A = { id: "ol_a", name: "Aorangi Ski Club" };
const B = { id: "ol_b", name: "Boomerang Ski Club" };
const LODGE = { id: "lodge_1", name: "Whakapapa", active: true, centralLodgeId: null as string | null };

const params = (id = "lodge_1") => ({ params: Promise.resolve({ id }) });
const put = (body: unknown) =>
  new Request("http://localhost/api/admin/lodges/lodge_1/central-lodge", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma));
  mockSettingsLock.mockResolvedValue(undefined);
  mockCreateAuditLog.mockResolvedValue(undefined);
  mockRequireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  // A lookup BY ID is the page's own lodge; a lookup by central id is the
  // resolver asking who holds a link (nobody, unless a test says so).
  mockPrisma.lodge.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
    where.id ? { ...LODGE } : null,
  );
  mockPrisma.lodge.findMany.mockResolvedValue([{ id: "lodge_1", centralLodgeId: null }]);
  mockPrisma.lodge.update.mockResolvedValue({});
  mockPrisma.otherLodge.findMany.mockResolvedValue([]);
  mockSettings.mockResolvedValue({ otherLodgesEnabled: true, otherLodgesOwnedLodges: [A, B] });
  mockSecret.mockResolvedValue("secret");
});

describe("GET /api/admin/lodges/[id]/central-lodge", () => {
  it("labels two owned lodges of the same name with their locations (#69)", async () => {
    const twin = { id: "ol_c", name: A.name };
    mockSettings.mockResolvedValue({ otherLodgesEnabled: true, otherLodgesOwnedLodges: [A, twin, B] });
    mockPrisma.otherLodge.findMany.mockResolvedValue([
      { centralId: "ol_a", location: "Whakapapa" },
      { centralId: "ol_c", location: "Turoa" },
      { centralId: "ol_b", location: "Mt Hutt" },
    ]);
    const body = await (await GET(new Request("http://localhost"), params())).json();
    expect(body.ownedLodges.map((l: { label: string }) => l.label)).toEqual([
      "Aorangi Ski Club (Whakapapa)",
      "Aorangi Ski Club (Turoa)",
      "Boomerang Ski Club",
    ]);
    expect(mockPrisma.otherLodge.findMany.mock.calls[0][0].where).toEqual({
      centralId: { in: ["ol_a", "ol_c", "ol_b"] },
    });
  });

  it("needs lodge:view and reports the link, the owned lodges and whether sharing is on", async () => {
    const res = await GET(new Request("http://localhost"), params());
    expect(mockRequireAdmin).toHaveBeenCalledWith({ permission: { area: "lodge", level: "view" } });
    expect(await res.json()).toEqual({
      lodgeId: "lodge_1",
      lodgeName: "Whakapapa",
      lodgeActive: true,
      centralLodgeId: null,
      ownedLodges: [
        { ...A, label: A.name },
        { ...B, label: B.name },
      ],
      answersForCentralLodgeId: null,
      linkHeldBy: null,
      otherLodgesEnabled: true,
      registeredWithCentralServer: true,
    });
  });

  // Which lodge answers is decided by the endpoint's own resolver
  // (central-lodge-link.test.ts pins it, including a link held by an inactive
  // lodge); here only that the page reports the resolver's verdict.
  it("reports what the endpoint's resolver answers for", async () => {
    mockSettings.mockResolvedValue({ otherLodgesEnabled: true, otherLodgesOwnedLodges: [A] });
    // The page's own lodge read, then the resolver's explicit-link lookup
    // on this active lodge.
    mockPrisma.lodge.findUnique
      .mockResolvedValueOnce({ ...LODGE, centralLodgeId: "ol_a" })
      .mockResolvedValueOnce({ ...LODGE, centralLodgeId: "ol_a" });
    const body = await (await GET(new Request("http://localhost"), params())).json();
    expect(body.answersForCentralLodgeId).toBe("ol_a");
    expect(body.linkHeldBy).toBeNull();
  });

  it("reports no publication for an unlinked single-lodge club", async () => {
    mockSettings.mockResolvedValue({ otherLodgesEnabled: true, otherLodgesOwnedLodges: [A] });
    const body = await (await GET(new Request("http://localhost"), params())).json();
    expect(body.centralLodgeId).toBeNull();
    expect(body.answersForCentralLodgeId).toBeNull();
  });

  it("reports whether this site holds the push secret", async () => {
    mockSecret.mockResolvedValue(null);
    const body = await (await GET(new Request("http://localhost"), params())).json();
    expect(body.registeredWithCentralServer).toBe(false);
  });
});

describe("PUT /api/admin/lodges/[id]/central-lodge", () => {
  it("needs lodge:edit, links an owned lodge, and audits before and after", async () => {
    const res = await PUT(put({ centralLodgeId: "ol_b" }), params());
    expect(mockRequireAdmin).toHaveBeenCalledWith({ permission: { area: "lodge", level: "edit" } });
    expect(res.status).toBe(200);
    expect(mockPrisma.lodge.update).toHaveBeenCalledWith({
      where: { id: "lodge_1" },
      data: { centralLodgeId: "ol_b" },
    });
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "LODGE_CENTRAL_LINK_UPDATED",
        category: "admin",
        entityId: "lodge_1",
        metadata: { before: { centralLodgeId: null }, after: { centralLodgeId: "ol_b" } },
      }),
      mockPrisma,
    );
    expect(mockSettingsLock).toHaveBeenCalledWith(mockPrisma);
    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    expect(mockSettingsLock.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.$executeRaw.mock.invocationCallOrder[0]!,
    );
  });

  it("serializes concurrent saves so each audit names the committed predecessor", async () => {
    let value: string | null = null;
    let previous = Promise.resolve();
    const releases = new WeakMap<object, () => void>();
    mockSettingsLock.mockImplementation(async (tx: object) => {
      const wait = previous;
      previous = new Promise<void>((resolve) => releases.set(tx, resolve));
      await wait;
    });
    mockPrisma.$transaction.mockImplementation(async (work: (tx: typeof mockPrisma) => Promise<unknown>) => {
      const tx = { ...mockPrisma };
      try { return await work(tx); } finally { releases.get(tx)?.(); }
    });
    mockPrisma.lodge.findUnique.mockImplementation(async () => ({ ...LODGE, centralLodgeId: value }));
    mockPrisma.lodge.update.mockImplementation(async ({ data }: { data: { centralLodgeId: string | null } }) => {
      value = data.centralLodgeId;
      return {};
    });

    const responses = await Promise.all([
      PUT(put({ centralLodgeId: "ol_a" }), params()),
      PUT(put({ centralLodgeId: "ol_b" }), params()),
    ]);

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(mockCreateAuditLog.mock.calls.map(([row]) => row.metadata)).toEqual([
      { before: { centralLodgeId: null }, after: { centralLodgeId: "ol_a" } },
      { before: { centralLodgeId: "ol_a" }, after: { centralLodgeId: "ol_b" } },
    ]);
    expect(value).toBe("ol_b");
  });

  it("rolls back the link when its audit fails in the write transaction", async () => {
    let committed: string | null = "ol_a";
    mockPrisma.$transaction.mockImplementation(async (work: (tx: typeof mockPrisma) => Promise<unknown>) => {
      let pending = committed;
      const tx = { ...mockPrisma, lodge: { ...mockPrisma.lodge,
        findUnique: vi.fn(async () => ({ centralLodgeId: pending })),
        update: vi.fn(async ({ data }: { data: { centralLodgeId: string | null } }) => { pending = data.centralLodgeId; return {}; }),
      } };
      const result = await work(tx);
      committed = pending;
      return result;
    });
    mockCreateAuditLog.mockRejectedValueOnce(new Error("audit unavailable"));

    expect((await PUT(put({ centralLodgeId: "ol_b" }), params())).status).toBe(500);
    expect(committed).toBe("ol_a");
    expect(mockCreateAuditLog.mock.calls[0][1]).toHaveProperty("lodge.update");
  });

  it("unlinks with null", async () => {
    let centralLodgeId: string | null = "ol_a";
    mockSettings.mockResolvedValue({ otherLodgesEnabled: true, otherLodgesOwnedLodges: [A] });
    mockPrisma.lodge.findUnique.mockImplementation(async ({ where }: { where: { id?: string; centralLodgeId?: string } }) =>
      where.id || where.centralLodgeId === centralLodgeId ? { ...LODGE, centralLodgeId } : null,
    );
    mockPrisma.lodge.update.mockImplementation(async () => { centralLodgeId = null; return {}; });
    const res = await PUT(put({ centralLodgeId: null }), params());
    expect(res.status).toBe(200);
    expect((await res.json()).answersForCentralLodgeId).toBeNull();
    expect(mockPrisma.lodge.update).toHaveBeenCalledWith({ where: { id: "lodge_1" }, data: { centralLodgeId: null } });
  });

  it("refuses a lodge the central server has not said this club owns, writing nothing", async () => {
    const res = await PUT(put({ centralLodgeId: "ol_someone_else" }), params());
    expect(res.status).toBe(400);
    expect(mockPrisma.lodge.update).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("refuses any link while the owned list is unknown", async () => {
    mockSettings.mockResolvedValue({ otherLodgesEnabled: true, otherLodgesOwnedLodges: null });
    expect((await PUT(put({ centralLodgeId: "ol_a" }), params())).status).toBe(400);
  });

  it("is 409, naming the holder, when another lodge already holds that central lodge", async () => {
    mockPrisma.lodge.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "7" }),
    );
    mockPrisma.lodge.findUnique
      .mockResolvedValueOnce({ centralLodgeId: null })
      .mockResolvedValueOnce({ name: "Iwikau" });
    const res = await PUT(put({ centralLodgeId: "ol_a" }), params());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Iwikau");
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown key", { centralLodgeId: "ol_a", name: "x" }],
    ["a missing value", {}],
    ["an empty id", { centralLodgeId: "" }],
    ["an over-long id", { centralLodgeId: "x".repeat(65) }],
  ])("is 400 for %s", async (_label, body) => {
    expect((await PUT(put(body), params())).status).toBe(400);
    expect(mockPrisma.lodge.update).not.toHaveBeenCalled();
  });
});
