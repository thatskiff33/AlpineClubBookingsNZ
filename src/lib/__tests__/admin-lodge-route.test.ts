import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    memberAccessRole: {
      createMany: vi.fn(),
    },
    memberSubscription: {
      upsert: vi.fn(),
    },
    memberLodgeAccess: {
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
    lodge: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) =>
    mockRequireActiveSessionUser(...args),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { GET, POST, PUT } from "@/app/api/admin/lodge/route";
import {
  adminSession,
  jsonRequest,
  memberFactory,
} from "@/lib/__tests__/helpers";

const mockedAuth = vi.mocked(auth);

function makePutRequest(body: Record<string, unknown>) {
  return jsonRequest("/api/admin/lodge", body, { method: "PUT" });
}

// Build a KIOSK_SELECT-shaped row with the given STAFF lodge grants, then
// stub GET to return exactly that one account so serializeKioskAccount can be
// asserted directly.
function stubGetWithGrants(
  grants: Array<{ lodgeId: string; lodge: { name: string } }>,
) {
  mockedAuth.mockResolvedValue(adminSession({ id: "admin-1" }));
  vi.mocked(prisma.member.findMany).mockResolvedValue([
    {
      ...memberFactory({
        id: "kiosk-1",
        email: "kiosk@example.org",
        role: "LODGE",
        financeAccessLevel: "NONE",
        canLogin: true,
        createdAt: new Date("2026-04-11"),
        updatedAt: new Date("2026-04-11"),
      }),
      lodgeAccess: grants,
    },
  ] as never);
  vi.mocked(prisma.memberAccessRole.createMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.memberSubscription.upsert).mockResolvedValue({} as never);
  // GET resolves the default lodge name for the unbound-account warning (#23).
  vi.mocked(prisma.lodge.findFirst).mockResolvedValue({ id: "default-lodge" } as never);
  vi.mocked(prisma.lodge.findUnique).mockResolvedValue({ name: "Default Lodge" } as never);
}

describe("admin lodge route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a missing lodge account with a normalized LODGE access role", async () => {
    mockedAuth.mockResolvedValue(adminSession({ id: "admin-1" }));
    const createdRow = {
      ...memberFactory({
        id: "lodge-1",
        email: "lodge@example.org",
        firstName: "Lodge",
        lastName: "Kiosk",
        role: "LODGE",
        financeAccessLevel: "NONE",
        canLogin: true,
        createdAt: new Date("2026-04-11"),
        updatedAt: new Date("2026-04-11"),
      }),
      // Kiosk lodge binding (multi-lodge): no STAFF grants = default lodge.
      lodgeAccess: [],
    };
    vi.mocked(prisma.member.findMany)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createdRow as never]);
    vi.mocked(prisma.member.create).mockResolvedValue(createdRow as never);
    vi.mocked(prisma.memberAccessRole.createMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.memberSubscription.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.lodge.findFirst).mockResolvedValue({ id: "default-lodge" } as never);
    vi.mocked(prisma.lodge.findUnique).mockResolvedValue({ name: "Default Lodge" } as never);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(prisma.memberAccessRole.createMany).toHaveBeenCalledWith({
      data: [{ memberId: "lodge-1", role: "LODGE", roleDefinitionId: null }],
      skipDuplicates: true,
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "LODGE_ACCOUNT_CREATED",
        memberId: "admin-1",
        targetId: "lodge-1",
      }),
    );
  });

  /**
   * The separation-of-duties half of #2984's follow-through. `POST` refuses a
   * scoped admin because creating a LODGE-role account is an access-role write;
   * this GET used to do the same thing on a plain page load at `lodge:view`.
   *
   * "Read-only Admin" is the role that made it real: view on all seven areas,
   * edit on none, described to clubs as "Can view admin areas without making
   * changes" — and it could bring a login-capable account into existence by
   * opening a screen.
   */
  it("does not provision a kiosk account for a scoped admin who may not create one", async () => {
    mockedAuth.mockResolvedValue(
      adminSession({ id: "readonly-1", accessRoles: ["ADMIN_READONLY"] }),
    );
    vi.mocked(prisma.member.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.lodge.findFirst).mockResolvedValue({ id: "default-lodge" } as never);
    vi.mocked(prisma.lodge.findUnique).mockResolvedValue({ name: "Default Lodge" } as never);

    const res = await GET();

    // The READ is still allowed — looking at kiosk details is legitimately a
    // read, and only the create was raised to Full Admin.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lodge).toBeNull();
    expect(body.accounts).toEqual([]);
    // Nothing was written: no account, no subscription seed, no audit row.
    expect(prisma.member.create).not.toHaveBeenCalled();
    expect(prisma.memberSubscription.upsert).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("still provisions for a Full Admin, so first-time kiosk setup keeps working", async () => {
    // The auto-create is the ONLY way a club's first kiosk account comes into
    // being — no seed, no setup wizard, no migration writes one — so raising it
    // to Full Admin must not remove it.
    mockedAuth.mockResolvedValue(adminSession({ id: "admin-1" }));
    const createdRow = {
      ...memberFactory({
        id: "lodge-1",
        email: "lodge@example.org",
        role: "LODGE",
        financeAccessLevel: "NONE",
        canLogin: true,
        createdAt: new Date("2026-04-11"),
        updatedAt: new Date("2026-04-11"),
      }),
      lodgeAccess: [],
    };
    vi.mocked(prisma.member.findMany)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createdRow as never]);
    vi.mocked(prisma.member.create).mockResolvedValue(createdRow as never);
    vi.mocked(prisma.memberAccessRole.createMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.memberSubscription.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.lodge.findFirst).mockResolvedValue({ id: "default-lodge" } as never);
    vi.mocked(prisma.lodge.findUnique).mockResolvedValue({ name: "Default Lodge" } as never);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(prisma.member.create).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "LODGE_ACCOUNT_CREATED" }),
    );
  });

  it("normalizes finance access to NONE when updating the lodge account", async () => {
    mockedAuth.mockResolvedValue(adminSession({ id: "admin-1" }));
    vi.mocked(prisma.member.findFirst).mockResolvedValue(
      memberFactory({
        id: "lodge-1",
        email: "lodge@example.org",
        firstName: "Lodge",
        lastName: "Kiosk",
        role: "LODGE",
        financeAccessLevel: "MANAGER",
      }),
    );
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...memberFactory({
        id: "lodge-1",
        email: "lodge@example.org",
        firstName: "Lodge Desk",
        lastName: "Kiosk",
        updatedAt: new Date("2026-04-11"),
      }),
      lodgeAccess: [],
    } as never);

    const res = await PUT(makePutRequest({ firstName: "Lodge Desk" }));

    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lodge-1" },
        data: expect.objectContaining({
          firstName: "Lodge Desk",
          financeAccessLevel: "NONE",
        }),
      }),
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "LODGE_ACCOUNT_UPDATED",
        memberId: "admin-1",
        targetId: "lodge-1",
      }),
    );
  });

  it("rebinds a kiosk account's lodge by replacing its STAFF grants", async () => {
    mockedAuth.mockResolvedValue(adminSession({ id: "admin-1" }));
    vi.mocked(prisma.member.findFirst).mockResolvedValue(
      memberFactory({ id: "lodge-1", role: "LODGE" }),
    );
    vi.mocked(prisma.lodge.findUnique).mockResolvedValue({ active: true } as never);
    const tx = {
      memberLodgeAccess: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({}),
      },
    };
    vi.mocked(prisma.$transaction).mockImplementation(
      (async (cb: (t: unknown) => Promise<unknown>) => cb(tx)) as unknown as typeof prisma.$transaction,
    );
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...memberFactory({ id: "lodge-1", role: "LODGE" }),
      lodgeAccess: [{ lodgeId: "lodge-b", lodge: { name: "River Lodge" } }],
    } as never);

    const res = await PUT(makePutRequest({ id: "lodge-1", lodgeId: "lodge-b" }));

    expect(res.status).toBe(200);
    expect(tx.memberLodgeAccess.deleteMany).toHaveBeenCalledWith({
      where: { memberId: "lodge-1", kind: "STAFF" },
    });
    expect(tx.memberLodgeAccess.create).toHaveBeenCalledWith({
      data: {
        memberId: "lodge-1",
        lodgeId: "lodge-b",
        kind: "STAFF",
        createdById: "admin-1",
      },
    });
    const body = await res.json();
    expect(body.account.boundLodgeId).toBe("lodge-b");
    expect(body.account.boundLodgeName).toBe("River Lodge");
  });

  it("rejects rebinding to an unknown or inactive lodge", async () => {
    mockedAuth.mockResolvedValue(adminSession({ id: "admin-1" }));
    vi.mocked(prisma.member.findFirst).mockResolvedValue(
      memberFactory({ id: "lodge-1", role: "LODGE" }),
    );
    vi.mocked(prisma.lodge.findUnique).mockResolvedValue({ active: false } as never);

    const res = await PUT(makePutRequest({ id: "lodge-1", lodgeId: "lodge-x" }));

    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("creates an additional kiosk account bound to a lodge", async () => {
    mockedAuth.mockResolvedValue(adminSession({ id: "admin-1" }));
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null); // email free
    vi.mocked(prisma.lodge.findUnique).mockResolvedValue({ active: true } as never);
    const tx = {
      member: { create: vi.fn().mockResolvedValue({ id: "kiosk-2" }) },
      memberLodgeAccess: { create: vi.fn().mockResolvedValue({}) },
    };
    vi.mocked(prisma.$transaction).mockImplementation(
      (async (cb: (t: unknown) => Promise<unknown>) => cb(tx)) as unknown as typeof prisma.$transaction,
    );
    vi.mocked(prisma.memberSubscription.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.memberAccessRole.createMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.member.findUniqueOrThrow).mockResolvedValue({
      ...memberFactory({ id: "kiosk-2", role: "LODGE", email: "turoa-kiosk@example.org" }),
      lodgeAccess: [{ lodgeId: "lodge-b", lodge: { name: "River Lodge" } }],
    } as never);

    const res = await POST(
      jsonRequest(
        "/api/admin/lodge",
        {
          email: "Turoa-Kiosk@example.org",
          password: "kiosk-pass",
          lodgeId: "lodge-b",
        },
        { method: "POST" },
      ),
    );

    expect(res.status).toBe(201);
    expect(tx.member.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "turoa-kiosk@example.org",
          role: "LODGE",
          financeAccessLevel: "NONE",
          canLogin: true,
        }),
      }),
    );
    expect(tx.memberLodgeAccess.create).toHaveBeenCalledWith({
      data: {
        memberId: "kiosk-2",
        lodgeId: "lodge-b",
        kind: "STAFF",
        createdById: "admin-1",
      },
    });
    const body = await res.json();
    expect(body.account.boundLodgeName).toBe("River Lodge");
  });

  it("rejects creating a kiosk account with an email already in use", async () => {
    mockedAuth.mockResolvedValue(adminSession({ id: "admin-1" }));
    vi.mocked(prisma.member.findFirst).mockResolvedValue(
      memberFactory({ id: "someone", email: "taken@example.org" }),
    );

    const res = await POST(
      jsonRequest(
        "/api/admin/lodge",
        { email: "taken@example.org", password: "kiosk-pass" },
        { method: "POST" },
      ),
    );

    expect(res.status).toBe(409);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // Item 5 (#1587): a kiosk account granted STAFF at two or more lodges is
  // ambiguous (the kiosk/PIN paths DENY it, M5). The admin list surfaces the
  // ambiguous state with a count instead of rendering it as an unbound account.
  it("serializes a two-grant kiosk account as ambiguous with a lodge count", async () => {
    stubGetWithGrants([
      { lodgeId: "lodge-a", lodge: { name: "Alpine Lodge" } },
      { lodgeId: "lodge-b", lodge: { name: "River Lodge" } },
    ]);

    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accounts[0]).toMatchObject({
      id: "kiosk-1",
      binding: "ambiguous",
      assignedLodgeCount: 2,
      boundLodgeId: null,
      boundLodgeName: null,
    });
  });

  it("serializes a single-grant kiosk account as bound, with no ambiguity fields", async () => {
    stubGetWithGrants([{ lodgeId: "lodge-a", lodge: { name: "Alpine Lodge" } }]);

    const res = await GET();

    expect(res.status).toBe(200);
    const account = (await res.json()).accounts[0];
    expect(account.boundLodgeId).toBe("lodge-a");
    expect(account.boundLodgeName).toBe("Alpine Lodge");
    // Byte-identical to the pre-#1587 shape: no ambiguity fields added.
    expect(account).not.toHaveProperty("binding");
    expect(account).not.toHaveProperty("assignedLodgeCount");
  });

  it("serializes a zero-grant kiosk account as default, with no ambiguity fields", async () => {
    stubGetWithGrants([]);

    const res = await GET();

    expect(res.status).toBe(200);
    const account = (await res.json()).accounts[0];
    expect(account.boundLodgeId).toBeNull();
    expect(account.boundLodgeName).toBeNull();
    // Byte-identical to the pre-#1587 shape: no ambiguity fields added.
    expect(account).not.toHaveProperty("binding");
    expect(account).not.toHaveProperty("assignedLodgeCount");
  });
});
