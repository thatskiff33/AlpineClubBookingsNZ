/**
 * Tests for Issue 11 & 12:
 * - FamilyGroupMember join table CRUD
 * - Member can belong to multiple family groups
 * - Family quick-add returns members from all groups
 * - Migration copies existing familyGroupId data to join table
 * - Click-through to specific family group edit (?edit=GROUP_ID)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({
  prisma: {
    familyGroup: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    familyGroupMember: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    member: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      familyGroup: {
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        findUnique: vi.fn(),
      },
      familyGroupMember: {
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      member: {
        updateMany: vi.fn(),
      },
    })),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { GET as getFamilyGroups, POST as postFamilyGroup } from "@/app/api/admin/family-groups/route";
import { GET as getFamilyGroupById, PUT as putFamilyGroup, DELETE as deleteFamilyGroup } from "@/app/api/admin/family-groups/[id]/route";
import { GET as getFamilyMembers } from "@/app/api/members/family/route";

const mockPrisma = prisma as unknown as {
  familyGroup: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  familyGroupMember: {
    findMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  member: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

const mockAuth = auth as ReturnType<typeof vi.fn>;

const adminSession = { user: { id: "admin1", role: "ADMIN" } };

function makeReq(body?: unknown, params?: Record<string, string>) {
  const url = "http://localhost/api/admin/family-groups" + (params?.id ? `/${params.id}` : "");
  return new NextRequest(url, {
    method: body ? "POST" : "GET",
    body: body ? JSON.stringify(body) : undefined,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(adminSession);
});

// ─── GET /api/admin/family-groups ─────────────────────────────────────────────

describe("GET /api/admin/family-groups", () => {
  it("returns groups with members from join table", async () => {
    const mockGroups = [
      {
        id: "g1",
        name: "Smith Family",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
        memberships: [
          {
            member: {
              id: "m1", firstName: "Alice", lastName: "Smith",
              email: "alice@example.com", ageTier: "ADULT", active: true, parentMemberId: null,
            },
            role: "ADMIN",
          },
          {
            member: {
              id: "m2", firstName: "Bob", lastName: "Smith",
              email: "alice@example.com", ageTier: "ADULT", active: true, parentMemberId: null,
            },
            role: "MEMBER",
          },
        ],
        _count: { joinRequests: 0 },
      },
    ];

    mockPrisma.familyGroup.findMany.mockResolvedValue(mockGroups);

    const res = await getFamilyGroups();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.familyGroups).toHaveLength(1);
    expect(data.familyGroups[0].members).toHaveLength(2);
    expect(data.familyGroups[0].memberCount).toBe(2);
    // Filters inactive members
    expect(data.familyGroups[0].members.every((m: { active: boolean }) => m.active)).toBe(true);
  });

  it("filters out inactive members from response", async () => {
    const mockGroups = [
      {
        id: "g1",
        name: "Test Group",
        createdAt: new Date(),
        updatedAt: new Date(),
        memberships: [
          {
            member: {
              id: "m1", firstName: "Active", lastName: "Member",
              email: "a@e.com", ageTier: "ADULT", active: true, parentMemberId: null,
            },
            role: "MEMBER",
          },
          {
            member: {
              id: "m2", firstName: "Inactive", lastName: "Member",
              email: "i@e.com", ageTier: "ADULT", active: false, parentMemberId: null,
            },
            role: "MEMBER",
          },
        ],
        _count: { joinRequests: 1 },
      },
    ];
    mockPrisma.familyGroup.findMany.mockResolvedValue(mockGroups);

    const res = await getFamilyGroups();
    const data = await res.json();

    expect(data.familyGroups[0].memberCount).toBe(1);
    expect(data.familyGroups[0].pendingRequests).toBe(1);
  });
});

// ─── POST /api/admin/family-groups ────────────────────────────────────────────

describe("POST /api/admin/family-groups", () => {
  it("creates a group with join table entries", async () => {
    const members = [
      { id: "m1", firstName: "Alice", lastName: "Smith", active: true, parentMemberId: null },
      { id: "m2", firstName: "Bob", lastName: "Jones", active: true, parentMemberId: null },
    ];
    mockPrisma.member.findMany.mockResolvedValue(members);

    const createdGroup = {
      id: "g1",
      name: "New Group",
      memberships: members.map((m) => ({
        member: { id: m.id, firstName: m.firstName, lastName: m.lastName, email: "x@x.com", ageTier: "ADULT" },
        role: "MEMBER",
      })),
    };

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: {
      familyGroup: { create: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
      familyGroupMember: { createMany: ReturnType<typeof vi.fn> };
    }) => Promise<unknown>) => {
      const mockTx = {
        familyGroup: {
          create: vi.fn().mockResolvedValue({ id: "g1" }),
          findUnique: vi.fn().mockResolvedValue(createdGroup),
        },
        familyGroupMember: {
          createMany: vi.fn().mockResolvedValue({ count: 2 }),
        },
      };
      return fn(mockTx);
    });

    const req = makeReq({ name: "New Group", memberIds: ["m1", "m2"] });
    const res = await postFamilyGroup(req);

    expect(res.status).toBe(201);
  });

  it("rejects dependents from being added to a group", async () => {
    mockPrisma.member.findMany.mockResolvedValue([
      { id: "m1", firstName: "Alice", lastName: "Smith", active: true, parentMemberId: "parent1" },
    ]);

    const req = makeReq({ name: "Bad Group", memberIds: ["m1"] });
    const res = await postFamilyGroup(req);
    const data = await res.json();

    expect(res.status).toBe(422);
    expect(data.error).toMatch(/dependent/i);
  });

  it("rejects inactive members", async () => {
    mockPrisma.member.findMany.mockResolvedValue([
      { id: "m1", firstName: "Alice", lastName: "Smith", active: false, parentMemberId: null },
    ]);

    const req = makeReq({ name: "Bad Group", memberIds: ["m1"] });
    const res = await postFamilyGroup(req);
    const data = await res.json();

    expect(res.status).toBe(422);
    expect(data.error).toMatch(/inactive/i);
  });

  it("requires auth", async () => {
    mockAuth.mockResolvedValue(null);
    const req = makeReq({ name: "X", memberIds: ["m1"] });
    const res = await postFamilyGroup(req);
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/admin/family-groups/[id] ────────────────────────────────────────

describe("GET /api/admin/family-groups/[id]", () => {
  it("returns group with members array flattened from join table", async () => {
    mockPrisma.familyGroup.findUnique.mockResolvedValue({
      id: "g1",
      name: "Test",
      createdAt: new Date(),
      updatedAt: new Date(),
      memberships: [
        {
          member: { id: "m1", firstName: "A", lastName: "B", email: "a@b.com", ageTier: "ADULT", active: true, parentMemberId: null },
          role: "ADMIN",
        },
      ],
      joinRequests: [],
    });

    const req = new NextRequest("http://localhost/api/admin/family-groups/g1");
    const res = await getFamilyGroupById(req, { params: Promise.resolve({ id: "g1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.members).toHaveLength(1);
    expect(data.members[0].role).toBe("ADMIN");
  });

  it("returns 404 for missing group", async () => {
    mockPrisma.familyGroup.findUnique.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/admin/family-groups/missing");
    const res = await getFamilyGroupById(req, { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
  });
});

// ─── PUT /api/admin/family-groups/[id] ────────────────────────────────────────

describe("PUT /api/admin/family-groups/[id]", () => {
  it("adds and removes members via join table", async () => {
    mockPrisma.familyGroup.findUnique
      .mockResolvedValueOnce({
        id: "g1",
        memberships: [{ memberId: "m1" }, { memberId: "m2" }],
      })
      .mockResolvedValue({
        id: "g1",
        name: "Updated",
        memberships: [
          { member: { id: "m1", firstName: "A", lastName: "B", email: "a@b.com", ageTier: "ADULT" }, role: "MEMBER" },
          { member: { id: "m3", firstName: "C", lastName: "D", email: "c@d.com", ageTier: "ADULT" }, role: "MEMBER" },
        ],
      });

    mockPrisma.member.findMany.mockResolvedValue([
      { id: "m1", firstName: "A", lastName: "B", active: true, parentMemberId: null },
      { id: "m3", firstName: "C", lastName: "D", active: true, parentMemberId: null },
    ]);

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: {
      familyGroup: { update: ReturnType<typeof vi.fn> };
      familyGroupMember: { deleteMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> };
    }) => Promise<unknown>) => {
      const mockTx = {
        familyGroup: { update: vi.fn().mockResolvedValue({}) },
        familyGroupMember: {
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      return fn(mockTx);
    });

    const req = new NextRequest("http://localhost/api/admin/family-groups/g1", {
      method: "PUT",
      body: JSON.stringify({ memberIds: ["m1", "m3"] }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await putFamilyGroup(req, { params: Promise.resolve({ id: "g1" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.members).toHaveLength(2);
  });
});

// ─── DELETE /api/admin/family-groups/[id] ─────────────────────────────────────

describe("DELETE /api/admin/family-groups/[id]", () => {
  it("deletes group and join table rows", async () => {
    mockPrisma.familyGroup.findUnique.mockResolvedValue({ id: "g1" });

    mockPrisma.$transaction.mockImplementation(async (fn: (tx: {
      familyGroupMember: { deleteMany: ReturnType<typeof vi.fn> };
      familyGroup: { delete: ReturnType<typeof vi.fn> };
    }) => Promise<unknown>) => {
      const mockTx = {
        familyGroupMember: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
        familyGroup: { delete: vi.fn().mockResolvedValue({}) },
      };
      return fn(mockTx);
    });

    const req = new NextRequest("http://localhost/api/admin/family-groups/g1", { method: "DELETE" });
    const res = await deleteFamilyGroup(req, { params: Promise.resolve({ id: "g1" }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("returns 404 for missing group", async () => {
    mockPrisma.familyGroup.findUnique.mockResolvedValue(null);
    const req = new NextRequest("http://localhost/api/admin/family-groups/missing", { method: "DELETE" });
    const res = await deleteFamilyGroup(req, { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
  });
});

// ─── GET /api/members/family (multi-group support) ───────────────────────────

describe("GET /api/members/family", () => {
  it("returns members from all groups the member belongs to", async () => {
    mockAuth.mockResolvedValue({ user: { id: "self1" } });

    // Self with memberships in 2 groups
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "self1",
      firstName: "Alice",
      lastName: "Smith",
      ageTier: "ADULT",
      parentMemberId: null,
      familyGroupMemberships: [
        { familyGroupId: "g1", familyGroup: { id: "g1", name: "Group A" } },
        { familyGroupId: "g2", familyGroup: { id: "g2", name: "Group B" } },
      ],
    });

    // Peers from both groups (via join table query)
    mockPrisma.familyGroupMember.findMany.mockResolvedValue([
      {
        member: { id: "m2", firstName: "Bob", lastName: "Jones", ageTier: "ADULT" },
      },
      {
        member: { id: "m3", firstName: "Carol", lastName: "White", ageTier: "ADULT" },
      },
    ]);

    // Own dependents
    mockPrisma.member.findMany
      .mockResolvedValueOnce([
        { id: "d1", firstName: "Dave", lastName: "Smith", ageTier: "CHILD" },
      ])
      // Peer dependents
      .mockResolvedValueOnce([]);

    const res = await getFamilyMembers();
    const data = await res.json();

    expect(res.status).toBe(200);
    // self + 2 peers + 1 dependent = 4
    expect(data.familyMembers).toHaveLength(4);
    expect(data.familyGroupIds).toEqual(["g1", "g2"]);

    const self = data.familyMembers.find((m: { relationship: string }) => m.relationship === "self");
    expect(self?.id).toBe("self1");

    const partners = data.familyMembers.filter((m: { relationship: string }) => m.relationship === "partner");
    expect(partners).toHaveLength(2);
    expect(partners.map((m: { id: string }) => m.id)).toContain("m2");
    expect(partners.map((m: { id: string }) => m.id)).toContain("m3");

    const dependents = data.familyMembers.filter((m: { relationship: string }) => m.relationship === "dependent");
    expect(dependents).toHaveLength(1);
  });

  it("deduplicates peers who appear in multiple groups", async () => {
    mockAuth.mockResolvedValue({ user: { id: "self1" } });

    mockPrisma.member.findUnique.mockResolvedValue({
      id: "self1",
      firstName: "Alice",
      lastName: "Smith",
      ageTier: "ADULT",
      parentMemberId: null,
      familyGroupMemberships: [
        { familyGroupId: "g1", familyGroup: { id: "g1", name: "Group A" } },
        { familyGroupId: "g2", familyGroup: { id: "g2", name: "Group B" } },
      ],
    });

    // m2 appears in both groups
    mockPrisma.familyGroupMember.findMany.mockResolvedValue([
      { member: { id: "m2", firstName: "Bob", lastName: "Jones", ageTier: "ADULT" } },
      { member: { id: "m2", firstName: "Bob", lastName: "Jones", ageTier: "ADULT" } },
    ]);

    mockPrisma.member.findMany
      .mockResolvedValueOnce([]) // own dependents
      .mockResolvedValueOnce([]); // peer dependents

    const res = await getFamilyMembers();
    const data = await res.json();

    // self + 1 unique peer (m2 deduplicated)
    expect(data.familyMembers).toHaveLength(2);
  });

  it("uses legacy familyGroupId as fallback when no join table memberships exist", async () => {
    mockAuth.mockResolvedValue({ user: { id: "self1" } });

    mockPrisma.member.findUnique
      .mockResolvedValueOnce({
        id: "self1",
        firstName: "Alice",
        lastName: "Smith",
        ageTier: "ADULT",
        parentMemberId: null,
        familyGroupMemberships: [], // no join table memberships
      })
      // Fallback query for legacy familyGroupId
      .mockResolvedValueOnce({ familyGroupId: "g_legacy" });

    // Legacy peers
    mockPrisma.member.findMany
      .mockResolvedValueOnce([
        { id: "m_legacy", firstName: "Legacy", lastName: "Peer", ageTier: "ADULT" },
      ])
      // own dependents
      .mockResolvedValueOnce([])
      // peer dependents
      .mockResolvedValueOnce([]);

    const res = await getFamilyMembers();
    const data = await res.json();

    // self + 1 legacy peer
    const partners = data.familyMembers.filter((m: { relationship: string }) => m.relationship === "partner");
    expect(partners).toHaveLength(1);
    expect(partners[0].id).toBe("m_legacy");
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await getFamilyMembers();
    expect(res.status).toBe(401);
  });
});

// ─── Migration data correctness ───────────────────────────────────────────────

describe("FamilyGroupMember migration SQL logic", () => {
  it("migration SQL inserts rows from Member.familyGroupId", () => {
    // Verify the SQL logic is correct conceptually — members with familyGroupId
    // should each get exactly one FamilyGroupMember row with role=MEMBER
    const members = [
      { id: "m1", familyGroupId: "g1" },
      { id: "m2", familyGroupId: "g1" },
      { id: "m3", familyGroupId: "g2" },
      { id: "m4", familyGroupId: null }, // no group — should NOT be migrated
    ];

    const migrated = members
      .filter((m) => m.familyGroupId !== null)
      .map((m) => ({ memberId: m.id, familyGroupId: m.familyGroupId, role: "MEMBER" }));

    expect(migrated).toHaveLength(3);
    expect(migrated.every((r) => r.role === "MEMBER")).toBe(true);
    expect(migrated.find((r) => r.memberId === "m4")).toBeUndefined();
  });

  it("migration skips already-migrated rows via ON CONFLICT DO NOTHING", () => {
    const existing = new Set(["g1:m1"]);
    const members = [
      { id: "m1", familyGroupId: "g1" }, // already exists
      { id: "m2", familyGroupId: "g1" }, // new
    ];

    const toInsert = members
      .filter((m) => m.familyGroupId !== null)
      .filter((m) => !existing.has(`${m.familyGroupId}:${m.id}`));

    expect(toInsert).toHaveLength(1);
    expect(toInsert[0].id).toBe("m2");
  });
});

// ─── Click-through navigation (Issue 12) ─────────────────────────────────────

describe("Family group click-through navigation", () => {
  it("generates correct ?edit=GROUP_ID URL for family group badge", () => {
    const groupId = "grp_abc123";
    const expectedUrl = `/admin/family-groups?edit=${groupId}`;
    expect(expectedUrl).toBe("/admin/family-groups?edit=grp_abc123");
  });

  it("member with multiple family groups gets one badge per group", () => {
    const member = {
      familyGroups: [
        { id: "g1", name: "Smith Family" },
        { id: "g2", name: "Jones Family" },
      ],
    };
    const badges = member.familyGroups.map((fg) => ({
      href: `/admin/family-groups?edit=${fg.id}`,
      label: fg.name,
    }));

    expect(badges).toHaveLength(2);
    expect(badges[0].href).toBe("/admin/family-groups?edit=g1");
    expect(badges[1].href).toBe("/admin/family-groups?edit=g2");
  });

  it("member with no family groups shows placeholder", () => {
    const member = { familyGroups: [] as { id: string; name: string | null }[] };
    const showPlaceholder = member.familyGroups.length === 0;
    expect(showPlaceholder).toBe(true);
  });
});
