import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAuth, mockFindUnique } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mockFindUnique,
    },
  },
}));

vi.mock("@/lib/health-check", () => ({
  getRuntimeStatus: () => ({
    cronEnabled: true,
    role: "web-blue",
    // Kept complete against RuntimeStatusReport, as above.
    environmentRole: "production",
  }),
}));

import { GET } from "@/app/api/admin/runtime-status/route";

describe("admin runtime status route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "ADMIN" }],
    });
  });

  it("rejects unauthenticated callers", async () => {
    mockAuth.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects non-admin callers", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: false,
      accessRoles: [{ role: "USER" }],
    });

    const response = await GET();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "member-1" } }),
    );
  });

  it("rejects inactive admin callers", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockFindUnique.mockResolvedValue({
      active: false,
      forcePasswordChange: false,
      accessRoles: [{ role: "ADMIN" }],
    });

    const response = await GET();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Account is deactivated",
    });
  });

  it("rejects admins who must change their password", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockFindUnique.mockResolvedValue({
      active: true,
      forcePasswordChange: true,
      accessRoles: [{ role: "ADMIN" }],
    });

    const response = await GET();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Password change required",
    });
  });

  it("returns runtime status for active admins", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cronEnabled: true,
      role: "web-blue",
      environmentRole: "production",
    });
  });
});
