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

  it("loads finance access state from Member", async () => {
    mockFindUnique.mockResolvedValue({
      id: "member-1",
      email: "finance@example.com",
      firstName: "Fin",
      lastName: "User",
      role: "ADMIN",
      accessRoles: [{ role: "FINANCE_ADMIN" }],
      active: true,
      forcePasswordChange: false,
      twoFactorEnabled: false,
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
        accessRoles: {
          select: {
            role: true,
            roleDefinitionId: true,
            roleDefinition: { select: expect.any(Object) },
          },
        },
        active: true,
        forcePasswordChange: true,
        twoFactorEnabled: true,
      },
    });
    expect(member?.email).toBe("finance@example.com");
    expect(member?.accessRoles).toEqual([{ role: "FINANCE_ADMIN" }]);
  });

  it("returns the active finance viewer member", async () => {
    mockAuth.mockResolvedValue({ user: { id: "viewer-1", role: "USER", accessRoles: [{ role: "USER" }] } });
    mockFindUnique.mockResolvedValue({
      id: "viewer-1",
      email: "viewer@example.com",
      firstName: "View",
      lastName: "Only",
      role: "USER",
      accessRoles: [{ role: "FINANCE_USER" }],
      active: true,
      forcePasswordChange: false,
      twoFactorEnabled: false,
    });

    await expect(requireFinanceViewer("/finance")).resolves.toMatchObject({
      id: "viewer-1",
      accessRoles: [{ role: "FINANCE_USER" }],
    });
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("redirects finance viewers away from manager-only actions", async () => {
    mockAuth.mockResolvedValue({ user: { id: "viewer-1", role: "USER", accessRoles: [{ role: "USER" }] } });
    mockFindUnique.mockResolvedValue({
      id: "viewer-1",
      email: "viewer@example.com",
      firstName: "View",
      lastName: "Only",
      role: "USER",
      financeAccessLevel: "MANAGER",
      accessRoles: [{ role: "FINANCE_USER" }],
      active: true,
      forcePasswordChange: false,
      twoFactorEnabled: false,
    });

    await expect(requireFinanceManager("/finance")).rejects.toThrow(
      "redirect:/finance"
    );
  });

  it("redirects non-finance members away from finance dashboard views", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1", role: "USER", accessRoles: [{ role: "USER" }] } });
    mockFindUnique.mockResolvedValue({
      id: "member-1",
      email: "member@example.com",
      firstName: "No",
      lastName: "Finance",
      role: "USER",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "USER" }],
      active: true,
      forcePasswordChange: false,
      twoFactorEnabled: false,
    });

    await expect(requireFinanceViewer("/finance?view=bookings")).rejects.toThrow(
      "redirect:/dashboard"
    );
  });

  it("redirects unverified two-factor sessions to the two-factor gate", async () => {
    mockAuth.mockResolvedValue({
      user: {
        id: "viewer-1",
        role: "USER",
        accessRoles: [{ role: "USER" }],
        twoFactorRequired: true,
        twoFactorVerified: false,
        twoFactorEnrolled: true,
      },
    });
    mockFindUnique.mockResolvedValue({
      id: "viewer-1",
      email: "viewer@example.com",
      firstName: "View",
      lastName: "Only",
      role: "USER",
      accessRoles: [{ role: "FINANCE_USER" }],
      active: true,
      forcePasswordChange: false,
      twoFactorEnabled: true,
    });

    await expect(requireFinanceViewer("/finance/reports")).rejects.toThrow(
      "redirect:/login/verify?callbackUrl=%2Ffinance%2Freports",
    );
  });
});
