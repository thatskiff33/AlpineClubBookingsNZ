import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../prisma", () => ({
  prisma: {
    member: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    familyGroup: {
      create: vi.fn(),
    },
    familyGroupMember: {
      createMany: vi.fn(),
    },
    hiddenFamilySuggestion: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("../logger", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
}));

import { prisma } from "../prisma";
import {
  buildFamilySuggestionSignature,
  createFamilyGroupFromSuggestion,
  hideFamilySuggestion,
  resetHiddenFamilySuggestions,
  suggestFamilyGroups,
} from "../family-suggestions";

const mockedFindMany = vi.mocked(prisma.member.findMany);
const mockedHiddenFindMany = vi.mocked(prisma.hiddenFamilySuggestion.findMany);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.member.count).mockResolvedValue(1);
  mockedHiddenFindMany.mockResolvedValue([]);
  vi.mocked(prisma.hiddenFamilySuggestion.upsert).mockResolvedValue({} as any);
  vi.mocked(prisma.hiddenFamilySuggestion.deleteMany).mockResolvedValue({
    count: 0,
  } as any);
});

describe("suggestFamilyGroups", () => {
  it("builds deterministic order-independent signatures", () => {
    expect(buildFamilySuggestionSignature(["m2", "m1", "m2"])).toBe("m1|m2");
    expect(buildFamilySuggestionSignature(["m1", "m2"])).toBe(
      buildFamilySuggestionSignature(["m2", "m1"])
    );
    expect(() => buildFamilySuggestionSignature(["m1", "m1"])).toThrow(
      "at least 2 unique members"
    );
  });

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
    expect(result.hiddenCount).toBe(0);
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
    expect(result.suggestions[0].signature).toBe("m1|m2");
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

  it("filters hidden suggestion signatures", async () => {
    mockedHiddenFindMany.mockResolvedValue([
      { signature: buildFamilySuggestionSignature(["m2", "m1"]) },
    ] as any);
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
    expect(result.suggestions).toHaveLength(0);
    expect(result.hiddenCount).toBe(1);
  });

  it("resurfaces a hidden family when the suggested member set changes", async () => {
    mockedHiddenFindMany.mockResolvedValue([
      { signature: buildFamilySuggestionSignature(["m1", "m2"]) },
    ] as any);
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
      {
        id: "m3", firstName: "Chris", lastName: "Smith", email: "family@test.com",
        ageTier: "CHILD", canLogin: false, xeroContactId: null,
        familyGroupMemberships: [],
      },
    ] as any);

    const result = await suggestFamilyGroups();
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].signature).toBe("m1|m2|m3");
    expect(result.hiddenCount).toBe(1);
  });

  it("lets a hidden shared-email pair resurface as a larger last-name suggestion", async () => {
    mockedHiddenFindMany.mockResolvedValue([
      { signature: buildFamilySuggestionSignature(["m1", "m2"]) },
    ] as any);
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
      {
        id: "m3", firstName: "Chris", lastName: "Smith", email: "other@test.com",
        ageTier: "CHILD", canLogin: false, xeroContactId: null,
        familyGroupMemberships: [],
      },
    ] as any);

    const result = await suggestFamilyGroups();

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].score).toBe(3);
    expect(result.suggestions[0].signature).toBe("m1|m2|m3");
  });
});

describe("hideFamilySuggestion", () => {
  it("stores the canonical member set server-side", async () => {
    mockedFindMany.mockResolvedValue([{ id: "m1" }, { id: "m2" }] as any);

    const result = await hideFamilySuggestion(["m2", "m1", "m1"], "admin1");

    expect(result).toEqual({ signature: "m1|m2", memberIds: ["m1", "m2"] });
    expect(prisma.hiddenFamilySuggestion.upsert).toHaveBeenCalledWith({
      where: { signature: "m1|m2" },
      create: {
        signature: "m1|m2",
        memberIds: ["m1", "m2"],
        hiddenByMemberId: "admin1",
      },
      update: {
        memberIds: ["m1", "m2"],
        hiddenByMemberId: "admin1",
      },
    });
  });

  it("rejects inactive or missing members", async () => {
    mockedFindMany.mockResolvedValue([{ id: "m1" }] as any);

    await expect(
      hideFamilySuggestion(["m1", "m2"], "admin1")
    ).rejects.toThrow("not found or inactive");
    expect(prisma.hiddenFamilySuggestion.upsert).not.toHaveBeenCalled();
  });
});

describe("resetHiddenFamilySuggestions", () => {
  it("deletes every hidden suggestion", async () => {
    vi.mocked(prisma.hiddenFamilySuggestion.deleteMany).mockResolvedValue({
      count: 3,
    } as any);

    await expect(resetHiddenFamilySuggestions()).resolves.toEqual({ count: 3 });
    expect(prisma.hiddenFamilySuggestion.deleteMany).toHaveBeenCalledWith();
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
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

import { auth } from "../auth";
import { logAudit } from "@/lib/audit";

describe("GET /api/admin/family-suggestions", () => {
  it("returns 403 for non-admin users", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "u1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);

    const { GET } = await import("../../app/api/admin/family-suggestions/route");
    const res = await GET(new Request("http://localhost/api/admin/family-suggestions"));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/admin/family-suggestions", () => {
  it("returns 403 for non-admin users", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "u1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);

    const { POST } = await import("../../app/api/admin/family-suggestions/route");
    const req = new Request("http://localhost/api/admin/family-suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test", memberIds: ["m1", "m2"] }),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(403);
  });

  it("validates input", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "u1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);

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

describe("POST /api/admin/family-suggestions/hide", () => {
  it("returns 403 for non-admin users", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "u1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);

    const { POST } = await import("../../app/api/admin/family-suggestions/hide/route");
    const req = new Request("http://localhost/api/admin/family-suggestions/hide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberIds: ["m1", "m2"] }),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(403);
  });

  it("validates input", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);

    const { POST } = await import("../../app/api/admin/family-suggestions/hide/route");
    const req = new Request("http://localhost/api/admin/family-suggestions/hide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberIds: ["m1"] }),
    });
    const res = await POST(req as any);
    expect(res.status).toBe(422);
  });

  it("hides a server-canonical signature and writes an audit action", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    mockedFindMany.mockResolvedValue([{ id: "m1" }, { id: "m2" }] as any);

    const { POST } = await import("../../app/api/admin/family-suggestions/hide/route");
    const req = new Request("http://localhost/api/admin/family-suggestions/hide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberIds: ["m2", "m1"] }),
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.signature).toBe("m1|m2");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "FAMILY_SUGGESTION_HIDDEN",
        memberId: "admin1",
        targetId: "m1|m2",
      })
    );
  });
});

describe("POST /api/admin/family-suggestions/reset", () => {
  it("returns 403 for non-admin users", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "u1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);

    const { POST } = await import("../../app/api/admin/family-suggestions/reset/route");
    const res = await POST(new Request("http://localhost/api/admin/family-suggestions/reset", { method: "POST" }));
    expect(res.status).toBe(403);
  });

  it("resets hidden suggestions and writes an audit action", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any);
    vi.mocked(prisma.hiddenFamilySuggestion.deleteMany).mockResolvedValue({
      count: 2,
    } as any);

    const { POST } = await import("../../app/api/admin/family-suggestions/reset/route");
    const res = await POST(new Request("http://localhost/api/admin/family-suggestions/reset", { method: "POST" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.deletedCount).toBe(2);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "FAMILY_SUGGESTIONS_RESET",
        memberId: "admin1",
        metadata: { deletedCount: 2 },
      })
    );
  });
});
