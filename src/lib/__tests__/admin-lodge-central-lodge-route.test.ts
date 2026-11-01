import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET|PUT /api/admin/lodges/[id]/central-lodge` (#62).
 *
 * Pinned: the permission on each verb; only an OWNED central lodge can be
 * linked; one central lodge links to one local lodge (the unique index, as a
 * 409 naming the holder); null unlinks; the audit row records before and after
 * under the lodge subsystem's `admin` category; and the GET reports what
 * THIS lodge answers for, by its saved link only, and the one-lodge club's
 * suggestion as a suggestion (#4262: no automatic link).
 */

const { mockPrisma, mockRequireAdmin, mockCreateAuditLog, mockSettings, mockSecret } = vi.hoisted(() => ({
  mockPrisma: (() => {
    const client = {
      lodge: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
      // The owned lodges' local copies, for the options' labels (#69).
      otherLodge: { findMany: vi.fn() },
      // The PUT's row lock (`SELECT 1 FROM "Lodge" ... FOR UPDATE`).
      $executeRaw: vi.fn(),
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
  SERVERNZ_TRANSACTION_OPTIONS: { timeout: 150_000, maxWait: 10_000 },
  loadServerNzSettings: (...args: unknown[]) => mockSettings(...args),
  lockServerNzSettings: (db: { $executeRaw: (...args: unknown[]) => unknown }) =>
    db.$executeRaw(["SELECT 1 FROM \"ServerNzSettings\" WHERE \"id\" = ", " FOR UPDATE"], "default"),
}));
vi.mock("@/lib/integration-credentials", () => ({
  getIntegrationCredentialValue: (...args: unknown[]) => mockSecret(...args),
}));

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
  mockPrisma.$executeRaw.mockResolvedValue(1);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma));
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
      suggestedCentralLodgeId: null,
      otherLodgesEnabled: true,
      registeredWithCentralServer: true,
    });
  });

  // Which lodge answers is decided by the endpoint's own resolver
  // (central-lodge-link.test.ts pins it, including a link held by an inactive
  // lodge); here only that the page reports the resolver's verdict.
  it("reports what the endpoint's resolver answers for", async () => {
    mockSettings.mockResolvedValue({ otherLodgesEnabled: true, otherLodgesOwnedLodges: [A] });
    mockPrisma.lodge.findUnique.mockImplementation(async ({ where }: { where: { id?: string; centralLodgeId?: string } }) =>
      where.id ? { ...LODGE, centralLodgeId: "ol_a" } : { id: "lodge_1", name: "Whakapapa", active: true },
    );
    const body = await (await GET(new Request("http://localhost"), params())).json();
    expect(body.answersForCentralLodgeId).toBe("ol_a");
    expect(body.suggestedCentralLodgeId).toBeNull();
  });

  it("answers for nothing in a one-lodge club until the link is saved, and only suggests it (#4262)", async () => {
    mockSettings.mockResolvedValue({ otherLodgesEnabled: true, otherLodgesOwnedLodges: [A] });
    const body = await (await GET(new Request("http://localhost"), params())).json();
    expect(body.answersForCentralLodgeId).toBeNull();
    expect(body.linkHeldBy).toBeNull();
    expect(body.suggestedCentralLodgeId).toBe("ol_a");
  });

  it("reports whether this site holds the push secret", async () => {
    mockSecret.mockResolvedValue(null);
    const body = await (await GET(new Request("http://localhost"), params())).json();
    expect(body.registeredWithCentralServer).toBe(false);
    expect(mockSecret).toHaveBeenCalledWith("servernz", "push_secret");
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
      // On the transaction client: the audit row commits or rolls back with
      // the transition it describes (#4262).
      mockPrisma,
    );
  });

  it("locks settings then the lodge row, then checks, reads, writes and audits inside that one transaction (#4262)", async () => {
    const order: string[] = [];
    mockPrisma.$executeRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      order.push(`lock ${strings.join("?").replace(/\s+/g, " ").trim()} [${values.join(",")}]`);
      return 1;
    });
    mockPrisma.lodge.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
      order.push("read");
      return where.id ? { ...LODGE } : null;
    });
    mockPrisma.lodge.update.mockImplementation(async () => {
      order.push("write");
      return {};
    });
    mockCreateAuditLog.mockImplementation(async () => {
      order.push("audit");
    });
    mockSettings.mockImplementation(async (db?: unknown) => {
      order.push(db ? "owned (in tx)" : "owned");
      return { otherLodgesEnabled: true, otherLodgesOwnedLodges: [A, B] };
    });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => {
      order.push("begin");
      const value = await fn(mockPrisma);
      order.push("commit");
      return value;
    });
    expect((await PUT(put({ centralLodgeId: "ol_b" }), params())).status).toBe(200);
    expect(order.slice(0, 8)).toEqual([
      "begin",
      'lock SELECT 1 FROM "ServerNzSettings" WHERE "id" = ? FOR UPDATE [default]',
      "owned (in tx)",
      'lock SELECT 1 FROM "Lodge" WHERE "id" = ? FOR UPDATE [lodge_1]',
      "read",
      "write",
      "audit",
      "commit",
    ]);
  });

  it("serialises two saves on the row lock, so each audit row records the transition that happened (#4262)", async () => {
    // One stored link, one row lock: a model of what PostgreSQL does, so two
    // saves issued together interleave the way two requests can.
    let stored: string | null = null;
    let held: Promise<void> = Promise.resolve();
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => {
      let release = () => {};
      let locked = false;
      const tx = {
        ...mockPrisma,
        // Settings then Lodge: the first lock statement queues the whole
        // transaction, as one row lock would; the second is already held.
        $executeRaw: async () => {
          if (locked) return 1;
          const previous = held;
          held = new Promise<void>((resolve) => { release = resolve; });
          locked = true;
          await previous;
          return 1;
        },
        lodge: {
          ...mockPrisma.lodge,
          findUnique: async ({ where }: { where: { id?: string } }) => {
            await Promise.resolve();
            return where.id ? { ...LODGE, centralLodgeId: stored } : null;
          },
          update: async ({ data }: { data: { centralLodgeId: string | null } }) => {
            await Promise.resolve();
            stored = data.centralLodgeId;
            return {};
          },
        },
      };
      try {
        return await fn(tx as typeof mockPrisma);
      } finally {
        if (locked) release();
      }
    });
    const [first, second] = await Promise.all([
      PUT(put({ centralLodgeId: "ol_a" }), params()),
      PUT(put({ centralLodgeId: "ol_b" }), params()),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const transitions = mockCreateAuditLog.mock.calls.map(([entry]) => entry.metadata);
    expect(transitions).toEqual([
      { before: { centralLodgeId: null }, after: { centralLodgeId: "ol_a" } },
      { before: { centralLodgeId: "ol_a" }, after: { centralLodgeId: "ol_b" } },
    ]);
  });

  it("unlinks with null", async () => {
    mockPrisma.lodge.findUnique.mockResolvedValue({ ...LODGE, centralLodgeId: "ol_a" });
    expect((await PUT(put({ centralLodgeId: null }), params())).status).toBe(200);
    expect(mockPrisma.lodge.update).toHaveBeenCalledWith({ where: { id: "lodge_1" }, data: { centralLodgeId: null } });
  });

  it("re-checks ownership under the settings lock: a list recorded meanwhile refuses the save (#4262)", async () => {
    // Outside any transaction the club still owns ol_b; under the lock, the
    // owned list a download has just recorded no longer names it.
    mockSettings.mockImplementation(async (db?: unknown) => ({
      otherLodgesEnabled: true,
      otherLodgesOwnedLodges: db ? [A] : [A, B],
    }));
    const res = await PUT(put({ centralLodgeId: "ol_b" }), params());
    expect(res.status).toBe(400);
    expect(mockPrisma.lodge.update).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
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
    // The refused write throws before the audit, inside the same transaction.
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
