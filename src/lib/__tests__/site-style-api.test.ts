import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CLUB_THEME_VALUES } from "@/lib/club-theme-schema";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  clubThemeFindUnique: vi.fn(),
  clubThemeUpsert: vi.fn(),
  auditLogCreate: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: mocks.requireAdmin,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTheme: {
      findUnique: mocks.clubThemeFindUnique,
      upsert: mocks.clubThemeUpsert,
    },
    auditLog: {
      create: mocks.auditLogCreate,
    },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
  },
}));

import { PUT } from "@/app/api/admin/site-style/route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/site-style", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("site style admin API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1", role: "ADMIN" } },
    });
    mocks.clubThemeFindUnique.mockResolvedValue(null);
    mocks.clubThemeUpsert.mockImplementation(({ create, update }) =>
      Promise.resolve({
        ...(create ?? update),
        completedAt: create?.completedAt ?? update?.completedAt ?? null,
      }),
    );
    mocks.auditLogCreate.mockResolvedValue({});
  });

  it("rejects unsafe colour values before storage", async () => {
    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        brandGold: "#ffcb05; color:red",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid input");
    expect(mocks.clubThemeUpsert).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("saves completion and revalidates the website layout", async () => {
    const response = await PUT(
      request({
        ...DEFAULT_CLUB_THEME_VALUES,
        completeSetup: true,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.theme.completedAt).toEqual(expect.any(String));
    expect(mocks.clubThemeUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        create: expect.objectContaining({
          id: "default",
          completedAt: expect.any(Date),
        }),
      }),
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/(website)", "layout");
    expect(mocks.auditLogCreate).toHaveBeenCalled();
  });
});
