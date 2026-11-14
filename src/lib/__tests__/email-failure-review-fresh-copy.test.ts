import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The email-failure queue's half of the booking fresh-copy action: a
 * booking-scoped exhausted failure of an email whose body is never kept links
 * to that booking's fresh-copy panel, and a sent fresh copy archives only the
 * failures it replaced — never one already archived — while the FAILED rows
 * themselves stay as history.
 */

const { mockPrisma, mockCreateAuditLog } = vi.hoisted(() => ({
  mockPrisma: {
    emailLog: { findMany: vi.fn() },
    auditLog: { findMany: vi.fn() },
  },
  mockCreateAuditLog: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mockCreateAuditLog }));

import {
  archiveSupersededEmailFailures,
  getExhaustedEmailFailureReviewQueue,
} from "@/lib/email-failure-review";

function failure(overrides: Record<string, unknown> = {}) {
  return {
    id: "log-1",
    to: "owner@example.org",
    subject: "Your booking is confirmed",
    templateName: "booking-confirmed",
    attempts: 3,
    lastAttemptAt: new Date("2026-06-30T01:00:00.000Z"),
    errorMessage: "SMTP timeout",
    createdAt: new Date("2026-06-30T00:00:00.000Z"),
    bookingId: "booking-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auditLog.findMany.mockResolvedValue([]);
});

describe("exhausted failure queue fresh-copy link", () => {
  it("links only booking-scoped failures of the fresh-copy emails", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([
      failure(),
      failure({ id: "log-2", templateName: "split-guest-payment-link", bookingId: "child 1" }),
      failure({ id: "log-3", templateName: "member-welcome" }),
      failure({ id: "log-4", templateName: "pre-arrival-reminder", bookingId: null }),
    ]);

    const queue = await getExhaustedEmailFailureReviewQueue();

    expect(queue.failures.map((row) => [row.id, row.freshCopyHref])).toEqual([
      ["log-1", "/bookings/booking-1#fresh-email-copies"],
      ["log-2", "/bookings/child%201#fresh-email-copies"],
      ["log-3", null],
      ["log-4", null],
    ]);
  });
});

describe("archiveSupersededEmailFailures", () => {
  it("archives the unarchived failures created before the send, and leaves the rows alone", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([failure(), failure({ id: "log-2" })]);
    mockPrisma.auditLog.findMany.mockResolvedValue([{ targetId: "log-2" }]);
    const sendStartedAt = new Date("2026-07-01T00:00:00.000Z");

    const archived = await archiveSupersededEmailFailures({
      bookingId: "booking-1",
      templateName: "booking-confirmed",
      createdBefore: sendStartedAt,
      reviewedByMemberId: "officer-1",
    });

    expect(archived).toEqual(["log-1"]);
    expect(mockPrisma.emailLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          bookingId: { in: ["booking-1"] },
          templateName: { in: ["booking-confirmed"] },
          status: "FAILED",
          createdAt: { lt: sendStartedAt },
        }),
      }),
    );
    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "email.failure.reviewed",
        targetId: "log-1",
        actorMemberId: "officer-1",
        category: "communication",
        metadata: expect.objectContaining({
          reason: "Superseded by a fresh copy sent from the booking.",
          bookingId: "booking-1",
        }),
      }),
    );
    // History is kept: the archive is an audit row, never an EmailLog write.
    expect(Object.keys(mockPrisma.emailLog)).toEqual(["findMany"]);
  });

  it("writes nothing when there is nothing to archive", async () => {
    mockPrisma.emailLog.findMany.mockResolvedValue([]);

    const archived = await archiveSupersededEmailFailures({
      bookingId: "booking-1",
      templateName: "pre-arrival-reminder",
      createdBefore: new Date("2026-07-01T00:00:00.000Z"),
      reviewedByMemberId: "officer-1",
    });

    expect(archived).toEqual([]);
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });
});
