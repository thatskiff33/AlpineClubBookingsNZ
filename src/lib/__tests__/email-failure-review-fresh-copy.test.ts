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
    emailLog: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    auditLog: { findMany: vi.fn() },
    booking: { findMany: vi.fn() },
  },
  mockCreateAuditLog: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mockCreateAuditLog }));

import { BOOKING_FRESH_COPY_TEMPLATES } from "@/lib/booking-fresh-email-copy-templates";
import { SENSITIVE_EMAIL_LOG_TEMPLATES } from "@/lib/email/internal";
import { EMAIL_RETRY_MAX_ATTEMPTS } from "@/lib/email/retry-selection";
import {
  archiveSupersededEmailFailures,
  getExhaustedEmailFailureReviewQueue,
  markExhaustedEmailFailureReviewed,
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
  it("links only booking-scoped failures of the fresh-copy emails whose booking still exists", async () => {
    const rows = [
      failure(),
      failure({ id: "log-2", templateName: "split-guest-payment-link", bookingId: "child 1" }),
      failure({ id: "log-3", templateName: "member-welcome" }),
      failure({ id: "log-4", templateName: "pre-arrival-reminder", bookingId: null }),
      failure({ id: "log-5", templateName: "booking-confirmed", bookingId: "deleted-booking" }),
      failure({ id: "log-6", templateName: "booking-confirmed", bookingId: "soft-deleted" }),
    ];
    // The window scan, then the requeueable-body filter: these emails keep no body.
    mockPrisma.emailLog.findMany.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    mockPrisma.emailLog.count.mockResolvedValue(rows.length);
    mockPrisma.booking.findMany.mockResolvedValue([
      { id: "booking-1", deletedAt: null },
      { id: "child 1", deletedAt: null },
      { id: "soft-deleted", deletedAt: new Date("2026-06-30T00:00:00.000Z") },
    ]);

    const queue = await getExhaustedEmailFailureReviewQueue();

    expect(queue.failures.map((row) => [row.id, row.freshCopyHref, row.recovery])).toEqual([
      ["log-1", "/bookings/booking-1#fresh-email-copies", "fresh_copy"],
      ["log-2", "/bookings/child%201#fresh-email-copies", "fresh_copy"],
      ["log-3", null, "retired"],
      ["log-4", null, "sensitive"],
      // A deleted booking has no page to send from (#4963's dangling bookingId).
      ["log-5", null, "sensitive"],
      // A soft-deleted booking still has a row, but its page refuses a fresh copy.
      ["log-6", null, "sensitive"],
    ]);
  });

  // Try again is safe for these emails only because they keep no body. That
  // rests on each one being on the sensitive list: drop one from it and its
  // body would be kept, the row would read as retryable, and Try again would
  // replay a door code or a payment link.
  it("every fresh-copy email is one whose body is never kept", () => {
    for (const template of BOOKING_FRESH_COPY_TEMPLATES) {
      expect(SENSITIVE_EMAIL_LOG_TEMPLATES.has(template), template).toBe(true);
    }
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
          // Only rows at the retry ceiling: one still being retried is not superseded.
          attempts: { gte: EMAIL_RETRY_MAX_ATTEMPTS },
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
    expect(Object.keys(mockPrisma.emailLog)).toEqual(["findMany", "findUnique", "count"]);
    expect(mockPrisma.emailLog.findUnique).not.toHaveBeenCalled();
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

describe("one email.failure.reviewed row (INV-SSOT)", () => {
  it("writes the same row as the Archive button, apart from the note, wording and booking", async () => {
    mockPrisma.emailLog.findUnique.mockResolvedValue({ ...failure(), status: "FAILED" });
    await markExhaustedEmailFailureReviewed("log-1", {
      reviewedByMemberId: "officer-1",
      reason: "Handled by phone.",
    });
    mockPrisma.emailLog.findMany.mockResolvedValue([failure()]);
    await archiveSupersededEmailFailures({
      bookingId: "booking-1",
      templateName: "booking-confirmed",
      createdBefore: new Date("2026-07-01T00:00:00.000Z"),
      reviewedByMemberId: "officer-1",
    });

    expect(mockCreateAuditLog).toHaveBeenCalledTimes(2);
    const [button, superseded] = mockCreateAuditLog.mock.calls.map(([row]) => row);
    const { details: buttonDetails, metadata: buttonMetadata, ...buttonRest } = button;
    const { details: supersededDetails, metadata: supersededMetadata, ...supersededRest } = superseded;
    expect(supersededRest).toEqual(buttonRest);
    expect(buttonMetadata).toEqual({
      reason: "Handled by phone.",
      templateName: "booking-confirmed",
      attempts: 3,
      lastError: "SMTP timeout",
    });
    expect(supersededMetadata).toEqual({
      ...buttonMetadata,
      reason: "Superseded by a fresh copy sent from the booking.",
      bookingId: "booking-1",
    });
    expect(buttonDetails).toBe("Archived exhausted booking-confirmed email failure for owner@example.org.");
    expect(supersededDetails).toBe(
      "Archived exhausted booking-confirmed email failure for owner@example.org after a fresh copy was sent from the booking.",
    );
  });
});
