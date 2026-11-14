import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockFindUnique,
  mockValidateMinimumStay,
  mockResolveOptionalActiveLodgeId,
  mockLoadCancellationPolicy,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockFindUnique: vi.fn(),
  mockValidateMinimumStay: vi.fn(),
  mockResolveOptionalActiveLodgeId: vi.fn(),
  mockLoadCancellationPolicy: vi.fn(),
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

vi.mock("@/lib/booking-policies", () => ({
  validateMinimumStay: mockValidateMinimumStay,
  formatViolationsDetail: () => "minimum stay violation",
  aggregatePolicyExceptionViolations: (
    violations: Array<{ capacityMode: "HOLD" | "NO_HOLD" }>,
  ) => ({
    violations,
    capacityMode:
      violations.length === 0
        ? null
        : violations.some((violation) => violation.capacityMode === "HOLD")
          ? "HOLD"
          : "NO_HOLD",
  }),
}));

vi.mock("@/lib/lodges", () => ({
  resolveOptionalActiveLodgeId: mockResolveOptionalActiveLodgeId,
}));

vi.mock("@/lib/cancellation", () => ({
  loadCancellationPolicy: mockLoadCancellationPolicy,
}));

vi.mock("@/lib/club-format-server", async () => {
  const { bindClubFormat } = await import("@/lib/club-format-bound");
  const { CLUB_FORMAT_TEST } = await import("./support/club-format-fixture");
  return { clubFormat: async () => bindClubFormat(CLUB_FORMAT_TEST) };
});

vi.mock("@/lib/logger", () => ({ default: { error: vi.fn() } }));

import { GET } from "@/app/api/booking-policies/check/route";

// Two lodges, two schedules: the route must read the lodge it resolved.
const DEFAULT_LODGE_RULES = [
  { daysBeforeStay: 14, refundPercentage: 100 },
  { daysBeforeStay: 0, refundPercentage: 0 },
];
const LODGE_B_RULES = [
  { daysBeforeStay: 30, refundPercentage: 100, fixedFeeCents: 2500 },
  { daysBeforeStay: 14, refundPercentage: 50, creditRefundPercentage: 100 },
  { daysBeforeStay: 0, refundPercentage: 0 },
];

function request(url = "https://example.test/api/booking-policies/check?checkIn=2026-07-01&checkOut=2026-07-03") {
  return new NextRequest(url);
}

describe("booking policy check route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
    mockFindUnique.mockResolvedValue({ active: true, forcePasswordChange: false });
    mockResolveOptionalActiveLodgeId.mockImplementation(
      async (_db: unknown, lodgeId: string | null | undefined) =>
        lodgeId ?? "lodge-default",
    );
    mockValidateMinimumStay.mockResolvedValue({ valid: true, violations: [] });
    mockLoadCancellationPolicy.mockImplementation(
      async (_checkIn: Date, lodgeId: string) =>
        lodgeId === "lodge-b" ? LODGE_B_RULES : DEFAULT_LODGE_RULES,
    );
  });

  it("rejects unauthenticated callers", async () => {
    mockAuth.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorised" });
    expect(mockValidateMinimumStay).not.toHaveBeenCalled();
  });

  it("rejects inactive members", async () => {
    mockFindUnique.mockResolvedValue({ active: false, forcePasswordChange: false });

    const response = await GET(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Account is deactivated",
    });
    expect(mockValidateMinimumStay).not.toHaveBeenCalled();
  });

  it("rejects members who must change their password", async () => {
    mockFindUnique.mockResolvedValue({ active: true, forcePasswordChange: true });

    const response = await GET(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Password change required",
    });
    expect(mockValidateMinimumStay).not.toHaveBeenCalled();
  });

  it("returns policy check results for active members", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      valid: true,
      violations: [],
      exceptionReview: { violations: [], capacityMode: null },
      message: null,
      cancellationSchedule: [
        "14+ days before stay: 100% refund",
        "Less than 14 days: 0% refund",
      ],
    });
    expect(mockResolveOptionalActiveLodgeId).toHaveBeenCalledWith(
      expect.anything(),
      null,
    );
    expect(mockValidateMinimumStay).toHaveBeenCalledWith(
      new Date("2026-07-01"),
      new Date("2026-07-03"),
      "lodge-default",
    );
  });

  it("resolves and validates an explicit active lodge", async () => {
    mockResolveOptionalActiveLodgeId.mockResolvedValue("lodge-b");

    const response = await GET(
      request(
        "https://example.test/api/booking-policies/check?checkIn=2026-07-01&checkOut=2026-07-03&lodgeId=lodge-b",
      ),
    );

    expect(response.status).toBe(200);
    expect(mockResolveOptionalActiveLodgeId).toHaveBeenCalledWith(
      expect.anything(),
      "lodge-b",
    );
    expect(mockValidateMinimumStay).toHaveBeenCalledWith(
      new Date("2026-07-01"),
      new Date("2026-07-03"),
      "lodge-b",
    );
  });

  it.each(["unknown-lodge", "inactive-lodge"])(
    "rejects the explicit %s before evaluating policy",
    async (lodgeId) => {
      mockResolveOptionalActiveLodgeId.mockResolvedValue(null);

      const response = await GET(
        request(
          `https://example.test/api/booking-policies/check?checkIn=2026-07-01&checkOut=2026-07-03&lodgeId=${lodgeId}`,
        ),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "Unknown or inactive lodgeId",
      });
      expect(mockValidateMinimumStay).not.toHaveBeenCalled();
    },
  );

  it("returns the frozen non-default-lodge violation and HOLD aggregate", async () => {
    const violation = {
      reasonCode: "MINIMUM_STAY",
      policyId: "policy-lodge-b",
      policyVersion: 8,
      policyName: "Lodge B winter weekends",
      resolvedScope: {
        kind: "LODGE",
        lodgeId: "lodge-b",
        effectiveLodgeId: "lodge-b",
      },
      affectedNights: ["2026-07-01", "2026-07-02"],
      exceptionEligible: true,
      capacityMode: "HOLD",
      message: "Lodge B requires three nights.",
      triggerDay: "Wednesday",
      minimumNights: 3,
      actualNights: 2,
      requirements: {
        kind: "MINIMUM_STAY",
        minimumNights: 3,
        actualNights: 2,
        triggerDays: [3],
      },
    } as const;
    mockResolveOptionalActiveLodgeId.mockResolvedValue("lodge-b");
    mockValidateMinimumStay.mockResolvedValue({
      valid: false,
      violations: [violation],
    });

    const response = await GET(
      request(
        "https://example.test/api/booking-policies/check?checkIn=2026-07-01&checkOut=2026-07-03&lodgeId=lodge-b",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      valid: false,
      violations: [violation],
      exceptionReview: { violations: [violation], capacityMode: "HOLD" },
      message: "minimum stay violation",
      cancellationSchedule: expect.any(Array),
    });
  });

  it("returns the non-default lodge's own cancellation schedule for the check-in (#4946)", async () => {
    mockResolveOptionalActiveLodgeId.mockResolvedValue("lodge-b");

    const response = await GET(
      request(
        "https://example.test/api/booking-policies/check?checkIn=2026-07-01&checkOut=2026-07-03&lodgeId=lodge-b",
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    // Card vs credit and the fixed fee come through in the club's currency,
    // exactly as the shared formatter writes them.
    expect(body.cancellationSchedule).toEqual([
      "30+ days before stay: 100% refund less $25.00 fee",
      "14-29 days: 50% card / 100% credit",
      "Less than 14 days: 0% refund",
    ]);
    expect(mockLoadCancellationPolicy).toHaveBeenCalledWith(
      new Date("2026-07-01"),
      "lodge-b",
    );
  });

  it("does not read a schedule for a refused lodge", async () => {
    mockResolveOptionalActiveLodgeId.mockResolvedValue(null);

    const response = await GET(
      request(
        "https://example.test/api/booking-policies/check?checkIn=2026-07-01&checkOut=2026-07-03&lodgeId=unknown-lodge",
      ),
    );

    expect(response.status).toBe(400);
    expect(mockLoadCancellationPolicy).not.toHaveBeenCalled();
  });

  it("keeps the minimum-stay answer and returns a null schedule when the schedule cannot be read", async () => {
    mockLoadCancellationPolicy.mockRejectedValue(new Error("db down"));

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      valid: true,
      violations: [],
      exceptionReview: { violations: [], capacityMode: null },
      message: null,
      cancellationSchedule: null,
    });
  });
});
