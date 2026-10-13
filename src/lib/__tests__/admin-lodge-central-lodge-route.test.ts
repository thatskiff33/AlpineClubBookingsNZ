import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET|PUT /api/admin/lodges/[id]/central-lodge` (#62).
 *
 * Pinned: the permission on each verb; only an OWNED central lodge can be
 * linked; one central lodge links to one local lodge (the unique index, as a
 * 409 naming the holder); null unlinks; the audit row records before and after
 * under the lodge subsystem's `admin` category; and the GET reports the
 * one-lodge default for THIS lodge only.
 */

const { mockPrisma, mockRequireAdmin, mockCreateAuditLog, mockSettings, mockSecret } = vi.hoisted(() => ({
  mockPrisma: (() => {
    const client = {
      lodge: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
      $transaction: vi.fn(),
    };
    client.$transaction.mockImplementation(async (fn: (tx: typeof client) => unknown) => fn(client));
    return client;
  })(),
  mockRequireAdmin: vi.fn(),
  mockCreateAuditLog: vi.fn().mockResolvedValue(undefined),
  mockSettings: vi.fn(),
  mockSecret: vi.fn(),
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
  mockRequireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "admin-1" } } });
  // A lookup BY ID is the page's own lodge; a lookup by central id is the
  // resolver asking who holds a link (nobody, unless a test says so).
  mockPrisma.lodge.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
    where.id ? { ...LODGE } : null,
  );
  mockPrisma.lodge.findMany.mockResolvedValue([{ id: "lodge_1", centralLodgeId: null }]);
  mockPrisma.lodge.update.mockResolvedValue({});
  mockSettings.mockResolvedValue({ otherLodgesEnabled: true, otherLodgesOwnedLodges: [A, B] });
  mockSecret.mockResolvedValue("secret");
});

describe("GET /api/admin/lodges/[id]/central-lodge", () => {
  it("needs lodge:view and reports the link, the owned lodges and whether sharing is on", async () => {
    const res = await GET(new Request("http://localhost"), params());
    expect(mockRequireAdmin).toHaveBeenCalledWith({ permission: { area: "lodge", level: "view" } });
    expect(await res.json()).toEqual({
      lodgeId: "lodge_1",
      lodgeName: "Whakapapa",
      lodgeActive: true,
      centralLodgeId: null,
      ownedLodges: [A, B],
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
    // (none); the one-lodge default then applies to lodge_1.
    mockPrisma.lodge.findUnique.mockResolvedValueOnce({ ...LODGE }).mockResolvedValueOnce(null);
    const body = await (await GET(new Request("http://localhost"), params())).json();
    expect(body.answersForCentralLodgeId).toBe("ol_a");
    expect(body.linkHeldBy).toBeNull();
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
    );
  });

  it("unlinks with null", async () => {
    mockPrisma.lodge.findUnique.mockResolvedValue({ ...LODGE, centralLodgeId: "ol_a" });
    expect((await PUT(put({ centralLodgeId: null }), params())).status).toBe(200);
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
