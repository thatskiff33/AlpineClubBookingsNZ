import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    emailLog: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    booking: {
      findMany: vi.fn(),
    },
    auditLog: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));

import { getExhaustedEmailFailureReviewQueue } from "@/lib/email-failure-review";

const SECURITY_RETIREMENT_REASON =
  "Not retried: this booking email predates retry-time recipient authorization context (#2362). Re-send it by hand if the recipient still needs it.";

describe("exhausted email failure reasons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.auditLog.findMany.mockResolvedValue([]);
    mockPrisma.emailLog.count.mockResolvedValue(1);
    mockPrisma.booking.findMany.mockResolvedValue([]);
  });

  it("returns the authoritative security-retirement instruction to the UI", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([
      {
        id: "legacy-booking-email",
        to: "member@example.com",
        subject: "Booking confirmation",
        templateName: "booking-confirmation",
        attempts: 3,
        lastAttemptAt: new Date("2026-08-01T01:00:00.000Z"),
        errorMessage: SECURITY_RETIREMENT_REASON,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    ]);

    const queue = await getExhaustedEmailFailureReviewQueue();

    expect(mockPrisma.emailLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ errorMessage: true }),
      }),
    );
    expect(queue.failures).toHaveLength(1);
    expect(queue.failures[0]?.errorMessage).toBe(SECURITY_RETIREMENT_REASON);
  });
});
