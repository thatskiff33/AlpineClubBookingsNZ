import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const mockRequireActiveSessionUser = vi.fn(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) =>
    mockRequireActiveSessionUser(...args),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { PUT } from "@/app/api/admin/lodge/route";

const mockedAuth = vi.mocked(auth);

function makePutRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/admin/lodge", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("admin lodge route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes finance access to NONE when updating the lodge account", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN" },
    } as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      id: "lodge-1",
      email: "lodge@tokoroa.org.nz",
      firstName: "Lodge",
      lastName: "Kiosk",
      role: "LODGE",
      financeAccessLevel: "MANAGER",
    } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      id: "lodge-1",
      email: "lodge@tokoroa.org.nz",
      firstName: "Lodge Desk",
      lastName: "Kiosk",
      updatedAt: new Date("2026-04-11"),
    } as any);

    const res = await PUT(makePutRequest({ firstName: "Lodge Desk" }));

    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lodge-1" },
        data: expect.objectContaining({
          firstName: "Lodge Desk",
          financeAccessLevel: "NONE",
        }),
      })
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "LODGE_ACCOUNT_UPDATED",
        memberId: "admin-1",
        targetId: "lodge-1",
      })
    );
  });
});
