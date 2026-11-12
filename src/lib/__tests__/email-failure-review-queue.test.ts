/**
 * The Exhausted Email Failures queue (#4963): an honest total beside the capped
 * scan, the newer of Archive and Try again deciding a row's state, booking links
 * resolved in one batch, and what an operator can do about each row.
 *
 * `EmailLog` and `AuditLog` are in-memory stores answered through the shared
 * Prisma `where` evaluator, so the queue's filters are judged as PostgreSQL
 * would judge them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { matchesWhere } from "./support/prisma-where";

type EmailRow = {
  id: string;
  to: string;
  subject: string;
  templateName: string;
  status: string;
  attempts: number;
  lastAttemptAt: Date;
  errorMessage: string | null;
  createdAt: Date;
  htmlBody: string | null;
  bookingRetryHtmlBody: string | null;
  bookingId: string | null;
  bookingRecipientMemberId: string | null;
};
type AuditRow = {
  action: string;
  targetId: string;
  actorMemberId: string | null;
  memberId: string | null;
  createdAt: Date;
  metadata: unknown;
};

const { store, mockPrisma } = vi.hoisted(() => {
  const store = {
    emails: [] as EmailRow[],
    audits: [] as AuditRow[],
    bookingIds: new Set<string>(),
  };
  return { store, mockPrisma: {} as Record<string, unknown> };
});

function project<T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) {
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
}

Object.assign(mockPrisma, {
  emailLog: {
    findMany: vi.fn(
      async (args: { where: Record<string, unknown>; take?: number; select?: Record<string, boolean> }) =>
        store.emails
          .filter((row) => matchesWhere(row, args.where))
          .sort(
            (a, b) =>
              b.lastAttemptAt.getTime() - a.lastAttemptAt.getTime() ||
              b.createdAt.getTime() - a.createdAt.getTime(),
          )
          .slice(0, args.take ?? Infinity)
          .map((row) => project(row, args.select)),
    ),
    count: vi.fn(
      async (args: { where: Record<string, unknown> }) =>
        store.emails.filter((row) => matchesWhere(row, args.where)).length,
    ),
  },
  auditLog: {
    findMany: vi.fn(async (args: { where: Record<string, unknown> }) =>
      store.audits
        .filter((row) => matchesWhere(row, args.where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    ),
  },
  booking: {
    findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.filter((id) => store.bookingIds.has(id)).map((id) => ({ id })),
    ),
  },
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));

import { getExhaustedEmailFailureReviewQueue } from "@/lib/email-failure-review";

const BASE = Date.parse("2026-06-01T00:00:00.000Z");
const at = (minutes: number) => new Date(BASE + minutes * 60_000);

function exhausted(id: string, minutes: number, overrides: Partial<EmailRow> = {}): EmailRow {
  return {
    id,
    to: `${id}@example.com`,
    subject: "Booking cancelled",
    templateName: "booking-cancelled",
    status: "FAILED",
    attempts: 3,
    lastAttemptAt: at(minutes),
    errorMessage: "SMTP timeout",
    createdAt: at(minutes - 60),
    htmlBody: "<p>retained</p>",
    bookingRetryHtmlBody: null,
    bookingId: null,
    bookingRecipientMemberId: null,
    ...overrides,
  };
}

function audit(action: "archive" | "requeue", targetId: string, minutes: number): AuditRow {
  return {
    action: action === "archive" ? "email.failure.reviewed" : "email.failure.requeued",
    targetId,
    actorMemberId: "admin-1",
    memberId: "admin-1",
    createdAt: at(minutes),
    metadata: action === "archive" ? { reason: "handled" } : {},
  };
}

describe("getExhaustedEmailFailureReviewQueue (#4963)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.emails = [];
    store.audits = [];
    store.bookingIds = new Set();
  });

  it("reports the true total when archived rows fill the scan window, and says the window is capped", async () => {
    // 200 newer archived rows used to fill the whole scan, hiding the old
    // un-archived failure from both the list and every count.
    for (let index = 0; index < 200; index += 1) {
      store.emails.push(exhausted(`archived-${index}`, 1_000 + index));
      store.audits.push(audit("archive", `archived-${index}`, 2_000 + index));
    }
    store.emails.push(exhausted("old-active", 10));
    // Not exhausted: never counted.
    store.emails.push(exhausted("retrying", 5_000, { attempts: 2 }));
    store.emails.push(exhausted("sent", 5_000, { status: "SENT" }));

    const queue = await getExhaustedEmailFailureReviewQueue();

    expect(queue.summary).toEqual(
      expect.objectContaining({
        totalExhaustedCount: 201,
        scannedCount: 200,
        scanLimit: 200,
        scanCapped: true,
        activeCount: 0,
        reviewedCount: 200,
      }),
    );
  });

  it("is not capped when the scan reaches every exhausted row", async () => {
    store.emails.push(exhausted("a", 10), exhausted("b", 20));

    const queue = await getExhaustedEmailFailureReviewQueue();

    expect(queue.summary).toEqual(
      expect.objectContaining({ totalExhaustedCount: 2, scannedCount: 2, scanCapped: false }),
    );
  });

  it("shows each row in the state of the newer of Archive and Try again", async () => {
    // Archived, then requeued and exhausted again: active once more.
    store.emails.push(exhausted("requeued-after-archive", 300));
    store.audits.push(
      audit("archive", "requeued-after-archive", 100),
      audit("requeue", "requeued-after-archive", 200),
    );
    // Requeued, exhausted again, then archived: archived.
    store.emails.push(exhausted("archived-after-requeue", 300));
    store.audits.push(
      audit("requeue", "archived-after-requeue", 100),
      audit("archive", "archived-after-requeue", 400),
    );

    const queue = await getExhaustedEmailFailureReviewQueue();

    expect(queue.failures.map((failure) => failure.id)).toEqual(["requeued-after-archive"]);
    expect(queue.failures[0]?.reviewedAt).toBeNull();
    expect(queue.recentlyReviewed.map((failure) => failure.id)).toEqual([
      "archived-after-requeue",
    ]);
    expect(queue.recentlyReviewed[0]?.reviewNote).toBe("handled");
  });

  it("keeps a row active when an archive that raced Try again lands before the next failure", async () => {
    // Archive's check passed, Try again committed (requeue at 200), the archive's
    // audit row landed after it (250), then the cron's attempt failed (300).
    store.emails.push(exhausted("raced", 300));
    store.audits.push(audit("requeue", "raced", 200), audit("archive", "raced", 250));

    const queue = await getExhaustedEmailFailureReviewQueue();

    expect(queue.failures.map((failure) => failure.id)).toEqual(["raced"]);
    expect(queue.recentlyReviewed).toEqual([]);
  });

  it("resolves booking links in one batched lookup and marks a deleted booking", async () => {
    store.bookingIds.add("booking-live");
    store.emails.push(
      exhausted("live", 30, { bookingId: "booking-live", bookingRecipientMemberId: "member-1" }),
      exhausted("live-again", 20, { bookingId: "booking-live" }),
      exhausted("deleted", 10, { bookingId: "booking-gone" }),
      exhausted("account", 5),
    );

    const queue = await getExhaustedEmailFailureReviewQueue();
    const byId = new Map(queue.failures.map((failure) => [failure.id, failure]));

    const bookingFindMany = (mockPrisma.booking as { findMany: ReturnType<typeof vi.fn> }).findMany;
    expect(bookingFindMany).toHaveBeenCalledTimes(1);
    expect(bookingFindMany.mock.calls[0]?.[0].where.id.in.sort()).toEqual([
      "booking-gone",
      "booking-live",
    ]);
    expect(byId.get("live")).toEqual(
      expect.objectContaining({
        bookingId: "booking-live",
        bookingExists: true,
        bookingRecipientMemberId: "member-1",
      }),
    );
    expect(byId.get("deleted")).toEqual(
      expect.objectContaining({ bookingId: "booking-gone", bookingExists: false }),
    );
    expect(byId.get("account")).toEqual(
      expect.objectContaining({
        bookingId: null,
        bookingExists: false,
        bookingRecipientMemberId: null,
      }),
    );
  });

  it("offers Try again only for rows that still hold a body, and says where else to act", async () => {
    store.emails.push(
      exhausted("html", 60, { bookingId: "booking-1" }),
      exhausted("booking-body", 50, {
        bookingId: "booking-1",
        htmlBody: null,
        bookingRetryHtmlBody: "<p>b</p>",
      }),
      exhausted("account", 45, { templateName: "member-welcome" }),
      exhausted("token", 40, { templateName: "member-setup-invite", htmlBody: null }),
      exhausted("sensitive", 30, { templateName: "booking-confirmed", htmlBody: null }),
      exhausted("retired", 20, { htmlBody: null }),
      // A booking email with no booking keeps its body, but the cron retires it
      // on sight (#2258), so Try again would only loop it back here.
      exhausted("no-booking", 10),
    );

    const queue = await getExhaustedEmailFailureReviewQueue();

    expect(
      Object.fromEntries(queue.failures.map((failure) => [failure.id, failure.recovery])),
    ).toEqual({
      html: "retry",
      "booking-body": "retry",
      account: "retry",
      token: "token_reissue",
      sensitive: "sensitive",
      retired: "retired",
      "no-booking": "retired",
    });
  });

  it("never reads a retained body into the queue", async () => {
    store.emails.push(exhausted("html", 60));

    const queue = await getExhaustedEmailFailureReviewQueue();

    const emailFindMany = (mockPrisma.emailLog as { findMany: ReturnType<typeof vi.fn> }).findMany;
    for (const [args] of emailFindMany.mock.calls) {
      expect(args.select).not.toHaveProperty("htmlBody");
      expect(args.select).not.toHaveProperty("bookingRetryHtmlBody");
    }
    expect(JSON.stringify(queue)).not.toContain("retained");
  });
});
