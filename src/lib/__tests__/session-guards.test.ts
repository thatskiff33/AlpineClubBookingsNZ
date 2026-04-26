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

import { requireActiveSessionUser } from "@/lib/session-guards";

describe("requireActiveSessionUser", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
  });

  it("rejects deactivated sessions", async () => {
    mockFindUnique.mockResolvedValue({ active: false, forcePasswordChange: false });

    const response = await requireActiveSessionUser("member-1");

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Account is deactivated",
    });
  });

  it("rejects members who must change their password", async () => {
    mockFindUnique.mockResolvedValue({ active: true, forcePasswordChange: true });

    const response = await requireActiveSessionUser("member-1");

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Password change required",
    });
  });

  it("allows the password change endpoint to opt out of the force-password block", async () => {
    mockFindUnique.mockResolvedValue({ active: true, forcePasswordChange: true });

    const response = await requireActiveSessionUser("member-1", {
      allowForcePasswordChange: true,
    });

    expect(response).toBeNull();
  });
});
