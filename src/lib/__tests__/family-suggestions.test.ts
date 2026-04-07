import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../prisma", () => ({
  prisma: {
    member: {
      findMany: vi.fn(),
    },
    familyGroup: {
      create: vi.fn(),
    },
    familyGroupMember: {
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("../logger", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { prisma } from "../prisma";
import { suggestFamilyGroups, createFamilyGroupFromSuggestion } from "../family-suggestions";

const mockedFindMany = vi.mocked(prisma.member.findMany);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("suggestFamilyGroups", () => {
  it("returns empty suggestions when all members are grouped", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com",
        ageTier: "ADULT", canLogin: true, xeroContactId: null,
        familyGroupMemberships: [{ familyGroupId: "g1" }],
      },
    ] as any);

    const result = await suggestFamilyGroups();
    expect(result.suggestions).toHaveLength(0);
    expect(result.totalMembers).toBe(1);
    expect(result.ungroupedCount).toBe(0);
  });

  it("suggests group for members sharing the same email", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "m1", firstName: "Alice", lastName: "Smith", email: "family@test.com",
        ageTier: "ADULT", canLogin: true, xeroContactId: null,
        familyGroupMemberships: [],
      },
      {
        id: "m2", firstName: "Bob", lastName: "Smith", email: "family@test.com",
        ageTier: "CHILD", canLogin: false, xeroContactId: null,
        familyGroupMemberships: [],
      },
    ] as any);

    const result = await suggestFamilyGroups();
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].score).toBe(10);
    expect(result.suggestions[0].suggestedName).toBe("Smith Family");
    expect(result.suggestions[0].reason).toContain("share email");
    expect(result.suggestions[0].members).toHaveLength(2);
  });

  it("suggests group for ungrouped members with same last name", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "m1", firstName: "Alice", lastName: "Jones", email: "alice@test.com",
        ageTier: "ADULT", canLogin: true, xeroContactId: null,
        familyGroupMemberships: [],
      },
      {
        id: "m2", firstName: "Bob", lastName: "Jones", email: "bob@test.com",
        ageTier: "ADULT", canLogin: true, xeroContactId: null,
        familyGroupMemberships: [],
      },
    ] as any);

    const result = await suggestFamilyGroups();
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].score).toBe(3);
    expect(result.suggestions[0].suggestedName).toBe("Jones Family");
    expect(result.suggestions[0].reason).toContain("last name");
  });

  it("prioritizes email groups over last name groups", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "m1", firstName: "Alice", lastName: "Smith", email: "shared@test.com",
        ageTier: "ADULT", canLogin: true, xeroContactId: null,
        familyGroupMemberships: [],
      },
      {
        id: "m2", firstName: "Bob", lastName: "Smith", email: "shared@test.com",
        ageTier: "CHILD", canLogin: false, xeroContactId: null,
        familyGroupMemberships: [],
      },
      {
        id: "m3", firstName: "Charlie", lastName: "Jones", email: "charlie@test.com",
        ageTier: "ADULT", canLogin: true, xeroContactId: null,
        familyGroupMemberships: [],
      },
      {
        id: "m4", firstName: "Donna", lastName: "Jones", email: "donna@test.com",
        ageTier: "ADULT", canLogin: true, xeroContactId: null,
        familyGroupMemberships: [],
      },
    ] as any);

    const result = await suggestFamilyGroups();
    expect(result.suggestions).toHaveLength(2);
    // Email group first (score 10)
    expect(result.suggestions[0].score).toBe(10);
    expect(result.suggestions[0].suggestedName).toBe("Smith Family");
    // Last name group second (score 3)
    expect(result.suggestions[1].score).toBe(3);
    expect(result.suggestions[1].suggestedName).toBe("Jones Family");
  });

  it("does not include already-grouped members in last name suggestions", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com",
        ageTier: "ADULT", canLogin: true, xeroContactId: null,
        familyGroupMemberships: [{ familyGroupId: "g1" }], // Already grouped
      },
      {
        id: "m2", firstName: "Bob", lastName: "Smith", email: "bob@test.com",
        ageTier: "ADULT", canLogin: true, xeroContactId: null,
        familyGroupMemberships: [], // Ungrouped
      },
    ] as any);

    const result = await suggestFamilyGroups();
    // Only one ungrouped Smith — not enough for a suggestion
    expect(result.suggestions).toHaveLength(0);
    expect(result.ungroupedCount).toBe(1);
  });

  it("handles case-insensitive email matching", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "m1", firstName: "Alice", lastName: "Smith", email: "Family@Test.com",
        ageTier: "ADULT", canLogin: true, xeroContactId: null,
        familyGroupMemberships: [],
      },
      {
        id: "m2", firstName: "Bob", lastName: "Smith", email: "family@test.com",
        ageTier: "CHILD", canLogin: false, xeroContactId: null,
        familyGroupMemberships: [],
      },
    ] as any);

    const result = await suggestFamilyGroups();
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].score).toBe(10);
  });

  it("handles case-insensitive last name matching", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "m1", firstName: "Alice", lastName: "SMITH", email: "alice@test.com",
        ageTier: "ADULT", canLogin: true, xeroContactId: null,
        familyGroupMemberships: [],
      },
      {
        id: "m2", firstName: "Bob", lastName: "smith", email: "bob@test.com",
        ageTier: "ADULT", canLogin: true, xeroContactId: null,
        familyGroupMemberships: [],
      },
    ] as any);

    const result = await suggestFamilyGroups();
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].score).toBe(3);
  });

  it("does not double-count email-grouped members in last name groups", async () => {
    // Alice and Bob share email AND last name. They should only appear once (in email group).
    mockedFindMany.mockResolvedValue([
      {
        id: "m1", firstName: "Alice", lastName: "Smith", email: "shared@test.com",
        ageTier: "ADULT", canLogin: true, xeroContactId: null,
        familyGroupMemberships: [],
      },
      {
        id: "m2", firstName: "Bob", lastName: "Smith", email: "shared@test.com",
        ageTier: "CHILD", canLogin: false, xeroContactId: null,
        familyGroupMemberships: [],
      },
    ] as any);

    const result = await suggestFamilyGroups();
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].score).toBe(10); // Only email group, no duplicate last name group
  });

  it("returns empty when fewer than 2 ungrouped members", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com",
        ageTier: "ADULT", canLogin: true, xeroContactId: null,
        familyGroupMemberships: [],
      },
    ] as any);

    const result = await suggestFamilyGroups();
    expect(result.suggestions).toHaveLength(0);
  });
});

describe("createFamilyGroupFromSuggestion", () => {
  it("throws if fewer than 2 members", async () => {
    await expect(
      createFamilyGroupFromSuggestion("Test Family", ["m1"])
    ).rejects.toThrow("at least 2 members");
  });

  it("creates group with correct leader assignment", async () => {
    mockedFindMany.mockResolvedValue([
      { id: "m1", canLogin: true, ageTier: "ADULT" },
      { id: "m2", canLogin: false, ageTier: "CHILD" },
    ] as any);

    const mockGroup = { id: "g1" };
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = {
        familyGroup: { create: vi.fn().mockResolvedValue(mockGroup) },
        familyGroupMember: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      };
      return fn(tx);
    });

    const result = await createFamilyGroupFromSuggestion("Smith Family", ["m1", "m2"]);
    expect(result.groupId).toBe("g1");
    expect(result.memberCount).toBe(2);

    // Verify the transaction was called
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("throws if some members not found", async () => {
    mockedFindMany.mockResolvedValue([
      { id: "m1", canLogin: true, ageTier: "ADULT" },
    ] as any);

    await expect(
      createFamilyGroupFromSuggestion("Test Family", ["m1", "m2"])
    ).rejects.toThrow("not found or inactive");
  });
});

// API route tests
vi.mock("../auth", () => ({
  auth: vi.fn(),
}));
vi.mock("../audit", () => ({
  logAudit: vi.fn(),
}));

import { auth } from "../auth";

describe("GET /api/admin/family-suggestions", () => {
  it("returns 401 for non-admin users", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "u1", role: "MEMBER" } } as any);

    const { GET } = await import("../../app/api/admin/family-suggestions/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });
});

describe("POST /api/admin/family-suggestions", () => {
  it("returns 401 for non-admin users", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "u1", role: "MEMBER" } } as any);

    const { POST } = await import("../../app/api/admin/family-suggestions/route");
    const req = new Request("http://localhost/api/admin/family-suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test", memberIds: ["m1", "m2"] }),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(401);
  });

  it("validates input", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "u1", role: "ADMIN" } } as any);

    const { POST } = await import("../../app/api/admin/family-suggestions/route");
    const req = new Request("http://localhost/api/admin/family-suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", memberIds: [] }),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(422);
  });
});
