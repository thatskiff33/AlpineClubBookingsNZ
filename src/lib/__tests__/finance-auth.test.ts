import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuth, mockFindUnique, mockRedirect } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mockFindUnique,
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

import {
  hasFinanceManagerAccess,
  hasFinanceViewerAccess,
  loadFinanceAccessMember,
  requireFinanceManager,
  requireFinanceViewer,
} from "@/lib/finance-auth";

describe("finance auth helpers", () => {
  beforeEach(() => {
    mockAuth.mockReset();
    mockFindUnique.mockReset();
    mockRedirect.mockReset();
    mockRedirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
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

  it("returns the active finance viewer member", async () => {
    mockAuth.mockResolvedValue({ user: { id: "viewer-1", role: "MEMBER" } });
    mockFindUnique.mockResolvedValue({
      id: "viewer-1",
      email: "viewer@example.com",
      firstName: "View",
      lastName: "Only",
      role: "MEMBER",
      financeAccessLevel: "VIEWER",
      active: true,
      forcePasswordChange: false,
    });

    await expect(requireFinanceViewer("/finance")).resolves.toMatchObject({
      id: "viewer-1",
      financeAccessLevel: "VIEWER",
    });
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("redirects finance viewers away from manager-only actions", async () => {
    mockAuth.mockResolvedValue({ user: { id: "viewer-1", role: "MEMBER" } });
    mockFindUnique.mockResolvedValue({
      id: "viewer-1",
      email: "viewer@example.com",
      firstName: "View",
      lastName: "Only",
      role: "MEMBER",
      financeAccessLevel: "VIEWER",
      active: true,
      forcePasswordChange: false,
    });

    await expect(requireFinanceManager("/finance")).rejects.toThrow(
      "redirect:/finance"
    );
  });

  it("redirects non-finance members away from finance booking source drill-downs", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER" } });
    mockFindUnique.mockResolvedValue({
      id: "member-1",
      email: "member@example.com",
      firstName: "No",
      lastName: "Finance",
      role: "MEMBER",
      financeAccessLevel: "NONE",
      active: true,
      forcePasswordChange: false,
    });

    await expect(requireFinanceViewer("/finance/bookings/source")).rejects.toThrow(
      "redirect:/dashboard"
    );
  });
});
