/**
 * **Try again** on an exhausted email failure (#4963): `requeueExhaustedEmailFailure`
 * hands the row back to the email retry cron with ONE status-guarded write.
 *
 * The fake `EmailLog` store answers `updateMany` through the shared Prisma
 * `where` evaluator, so each guard clause is judged as PostgreSQL would judge
 * it: dropping any one of them from the production write turns a case here red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { matchesWhere } from "./support/prisma-where";

type Row = {
  id: string;
  to: string;
  templateName: string;
  status: string;
  attempts: number;
  lastAttemptAt: Date | null;
  htmlBody: string | null;
  bookingRetryHtmlBody: string | null;
  deliveryBlockReason: string | null;
};

const { store, mockCreateAuditLog } = vi.hoisted(() => ({
  store: { rows: [] as Row[] },
  mockCreateAuditLog: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const emailLog = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const row = store.rows.find((candidate) => candidate.id === where.id);
      return row ? { ...row } : null;
    }),
    updateMany: vi.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const matched = store.rows.filter((row) => matchesWhere(row, where));
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      },
    ),
  };
  const prisma = {
    emailLog,
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ emailLog })),
  };
  return { prisma };
});
vi.mock("@/lib/audit", () => ({ createAuditLog: mockCreateAuditLog }));

import {
  EmailFailureReviewError,
  requeueExhaustedEmailFailure,
} from "@/lib/email-failure-review";
import { EMAIL_RETRY_BACKOFF_MS } from "@/lib/email/retry-selection";

const EXHAUSTED_AT = new Date("2026-06-30T20:00:00.000Z");

function exhausted(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    to: `${id}@example.com`,
    templateName: "booking-cancelled",
    status: "FAILED",
    attempts: 3,
    lastAttemptAt: EXHAUSTED_AT,
    htmlBody: "<p>retained</p>",
    bookingRetryHtmlBody: null,
    deliveryBlockReason: null,
    ...overrides,
  };
}

const row = (id: string) => store.rows.find((candidate) => candidate.id === id)!;

async function refusal(id: string): Promise<EmailFailureReviewError> {
  const error = await requeueExhaustedEmailFailure(id, {
    requestedByMemberId: "admin-1",
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(EmailFailureReviewError);
  return error as EmailFailureReviewError;
}

describe("requeueExhaustedEmailFailure (#4963)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.rows = [];
  });

  it("puts the row back one attempt below the ceiling, dated past the cron's backoff, and audits it", async () => {
    store.rows = [exhausted("target"), exhausted("sibling")];

    await expect(
      requeueExhaustedEmailFailure("target", { requestedByMemberId: "admin-1" }),
    ).resolves.toEqual({ id: "target", requeued: true });

    const requeued = row("target");
    expect(requeued.status).toBe("FAILED");
    expect(requeued.attempts).toBe(2);
    // The cron selects `lastAttemptAt` older than now minus its backoff.
    expect(requeued.lastAttemptAt!.getTime()).toBeLessThan(
      Date.now() - EMAIL_RETRY_BACKOFF_MS,
    );
    expect(requeued.htmlBody).toBe("<p>retained</p>");
    // Only the pressed row moves: the write is keyed by id.
    expect(row("sibling")).toEqual(exhausted("sibling"));

    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "email.failure.requeued",
        category: "communication",
        actorMemberId: "admin-1",
        entityType: "EmailLog",
        entityId: "target",
        targetId: "target",
        metadata: { templateName: "booking-cancelled", attemptsBeforeRequeue: 3 },
      }),
      expect.anything(),
    );
  });

  it("requeues a booking email whose body is held only in bookingRetryHtmlBody", async () => {
    store.rows = [
      exhausted("booking", { htmlBody: null, bookingRetryHtmlBody: "<p>booking</p>" }),
    ];

    await requeueExhaustedEmailFailure("booking", { requestedByMemberId: "admin-1" });

    expect(row("booking").attempts).toBe(2);
  });

  it("leaves an environment block reason for the cron's next terminal write to clear", async () => {
    store.rows = [
      exhausted("withheld", { deliveryBlockReason: "ENVIRONMENT_DECLARATION_MISSING" }),
    ];

    await requeueExhaustedEmailFailure("withheld", { requestedByMemberId: "admin-1" });

    expect(row("withheld").deliveryBlockReason).toBe("ENVIRONMENT_DECLARATION_MISSING");
  });

  it.each([
    ["is no longer FAILED (the cron claimed it)", { status: "QUEUED" }],
    ["was sent", { status: "SENT" }],
    ["is still below the retry ceiling", { attempts: 2 }],
    ["keeps no copy of its message", { htmlBody: null, bookingRetryHtmlBody: null }],
  ])("refuses with 409 and writes no audit row when the row %s", async (_label, overrides) => {
    const before = exhausted("target", overrides);
    store.rows = [{ ...before }];

    const error = await refusal("target");

    expect(error.status).toBe(409);
    expect(row("target")).toEqual(before);
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it("requeues once when pressed twice: the second press is refused and only one audit row is written", async () => {
    store.rows = [exhausted("target")];

    await requeueExhaustedEmailFailure("target", { requestedByMemberId: "admin-1" });
    const error = await refusal("target");

    expect(error.status).toBe(409);
    expect(row("target").attempts).toBe(2);
    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for an unknown email log", async () => {
    const error = await refusal("missing");

    expect(error.status).toBe(404);
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });
});
