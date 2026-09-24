import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuth, mockFindUnique, mockRedirect } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
  mockRedirect: vi.fn(),
}));

// Fixtures are projected through the loader's own `select` (#3603), so a field
// it stops selecting stops reaching the checks, as with the real client.
vi.mock("@/lib/prisma", async () => {
  const { honourSelect } = await import("@/lib/__tests__/helpers/prisma-mocks");
  return {
    prisma: {
      member: {
        findUnique: honourSelect(mockFindUnique, "Member"),
      },
    },
  };
});

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
      canLogin: true,
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
        // #3603: the finance checks clear on it.
        canLogin: true,
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
    expect(member?.canLogin).toBe(true);
  });

  // #3603: the finance layout and pages resolve access from this loader, so a
  // login-disabled treasurer is sent away like any member without finance
  // access. The control is the same fixture with login enabled.
  it("sends a login-disabled treasurer away from finance, and admits it with login enabled", async () => {
    mockAuth.mockResolvedValue({ user: { id: "treasurer-1", role: "USER", accessRoles: ["USER"] } });
    const treasurer = {
      id: "treasurer-1",
      email: "treasurer@example.com",
      firstName: "Tre",
      lastName: "Asurer",
      role: "USER",
      accessRoles: [{ role: "FINANCE_ADMIN" }],
      active: true,
      forcePasswordChange: false,
      twoFactorEnabled: false,
    };

    mockFindUnique.mockResolvedValue({ ...treasurer, canLogin: false });
    await expect(requireFinanceViewer("/finance")).rejects.toThrow("redirect:/dashboard");
    await expect(requireFinanceManager("/finance")).rejects.toThrow("redirect:/dashboard");

    mockFindUnique.mockResolvedValue({ ...treasurer, canLogin: true });
    await expect(requireFinanceViewer("/finance")).resolves.toMatchObject({ id: "treasurer-1" });
    await expect(requireFinanceManager("/finance")).resolves.toMatchObject({ id: "treasurer-1" });
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
