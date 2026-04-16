import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindUnique } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mockFindUnique,
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

import {
  hasFinanceManagerAccess,
  hasFinanceViewerAccess,
  loadFinanceAccessMember,
} from "@/lib/finance-auth";

describe("finance auth helpers", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
  });

  it("allows viewer access for VIEWER and MANAGER", () => {
    expect(hasFinanceViewerAccess("VIEWER")).toBe(true);
    expect(hasFinanceViewerAccess("MANAGER")).toBe(true);
    expect(hasFinanceViewerAccess("NONE")).toBe(false);
  });

  it("allows manager access only for MANAGER", () => {
    expect(hasFinanceManagerAccess("MANAGER")).toBe(true);
    expect(hasFinanceManagerAccess("VIEWER")).toBe(false);
    expect(hasFinanceManagerAccess("NONE")).toBe(false);
  });

  it("loads finance access state from Member", async () => {
    mockFindUnique.mockResolvedValue({
      id: "member-1",
      email: "finance@example.com",
      firstName: "Fin",
      lastName: "User",
      role: "ADMIN",
      financeAccessLevel: "MANAGER",
      active: true,
      forcePasswordChange: false,
    });

    const member = await loadFinanceAccessMember("member-1");

    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { id: "member-1" },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        financeAccessLevel: true,
        active: true,
        forcePasswordChange: true,
      },
    });
    expect(member?.financeAccessLevel).toBe("MANAGER");
    expect(member?.email).toBe("finance@example.com");
  });
});
