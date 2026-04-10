import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockAuth = vi.fn();
const mockChoreCreate = vi.fn();
const mockChoreFindMany = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn() },
    choreTemplate: {
      create: mockChoreCreate,
      findMany: mockChoreFindMany,
    },
  },
}));

describe("POST /api/admin/chores", () => {
  let POST: typeof import("@/app/api/admin/chores/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin1", role: "ADMIN" } });
    mockChoreCreate.mockResolvedValue({ id: "ct1" });
    const mod = await import("@/app/api/admin/chores/route");
    POST = mod.POST;
  });

  it("rejects SPECIFIC_DAYS chores with no selected weekdays", async () => {
    const req = new NextRequest("http://localhost/api/admin/chores", {
      method: "POST",
      body: JSON.stringify({
        name: "Deep Clean",
        frequencyMode: "SPECIFIC_DAYS",
        frequencyDaysOfWeek: [],
      }),
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.frequencyDaysOfWeek?.[0]).toContain(
      "at least one day"
    );
    expect(mockChoreCreate).not.toHaveBeenCalled();
  });

  it("accepts SPECIFIC_DAYS chores when weekdays are provided", async () => {
    const req = new NextRequest("http://localhost/api/admin/chores", {
      method: "POST",
      body: JSON.stringify({
        name: "Deep Clean",
        frequencyMode: "SPECIFIC_DAYS",
        frequencyDaysOfWeek: [1, 4],
      }),
    });

    const res = await POST(req);

    expect(res.status).toBe(201);
    expect(mockChoreCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: "Deep Clean",
        frequencyMode: "SPECIFIC_DAYS",
        frequencyDaysOfWeek: [1, 4],
      }),
    });
  });
});
