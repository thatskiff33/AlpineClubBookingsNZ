/**
 * Real-PostgreSQL proof of **Try again** on an exhausted email failure (#4963).
 *
 * 1. Two officers pressing Try again on one row at once: the requeue is one
 *    status-guarded `updateMany`, so exactly one press moves the row and writes
 *    an audit row, and the other is refused with 409 and writes nothing. The
 *    interleaving is forced by holding the row's lock in a third transaction
 *    until PostgreSQL shows both presses queued behind it.
 * 2. A requeued row is picked up by the REAL `retryFailedEmails` on its next
 *    run, through the cron's own selection, claim and per-row checks: a plain
 *    row is sent, a recipient suppressed since is marked BOUNCED, a booking
 *    email is sent only once the recipient's authority is re-proved (#2362)
 *    and is retired otherwise, and a booking whose "No emails" switch is on is
 *    withheld. The route never sends.
 *
 * Only the two seams the cron cannot run without on a harness are replaced:
 * the delivery policy (a harness is never the club's live site, and the cron
 * refuses to send anywhere else) and the mail transport (no provider is ever
 * contacted). Both mocks are this file's own; it is not imported into the
 * shared race harness, so they reach no other suite.
 *
 * Ordinary Vitest runs skip the whole file. It needs the guarded, disposable
 * loopback PostgreSQL every realdb suite uses (`CONCURRENCY_RACE_DATABASE_URL`,
 * `RUN_CONCURRENCY_RACE_TESTS=1`), and owns and cleans its own `race-4963` rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { assertSafeRaceDbUrl } from "./support/race-db-url";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));

vi.mock("@/lib/environment-delivery-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/environment-delivery-policy")>()),
  resolveDeliveryPolicy: vi.fn(async () => ({
    kind: "allow",
    grounds: "production",
    clearance: {},
  })),
}));
vi.mock("@/lib/email/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/internal")>()),
  getEmailTransporter: vi.fn(async () => ({
    transporter: { sendMail },
    modeLabel: "race-4963 fake transport",
  })),
}));

const P = "race-4963";
const SUBJECT = `${P} exhausted email`;
const ADMIN_ID = `${P}-admin`;
const MEMBER_ID = `${P}-member`;
const LODGE_ID = `${P}-lodge`;
const BOOKING_ID = `${P}-booking`;
const REQUEUE_ACTION = "email.failure.requeued";

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let review: typeof import("@/lib/email-failure-review");
let retryFailedEmails: (typeof import("@/lib/cron-email-retry"))["retryFailedEmails"];
let recordSesEmailFeedback: (typeof import("@/lib/email-suppression"))["recordSesEmailFeedback"];

(RUN ? describe : describe.skip)("Try again on an exhausted email failure - real PostgreSQL (#4963)", { timeout: 120_000 }, () => {
  const deleteFixtures = async () => {
    await prisma.auditLog.deleteMany({ where: { action: REQUEUE_ACTION, actorMemberId: ADMIN_ID } });
    await prisma.emailLog.deleteMany({ where: { subject: SUBJECT } });
    await prisma.emailSuppression.deleteMany({ where: { email: { endsWith: `@${P}.test` } } });
    await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
  };

  /** A row as the cron leaves it after its last attempt failed. */
  const exhausted = (to: string, extra: Record<string, unknown> = {}) =>
    prisma.emailLog.create({
      data: {
        to,
        subject: SUBJECT,
        templateName: "admin-unrecognised-stripe-payment",
        htmlBody: `<p>message for ${to}</p>`,
        status: "FAILED",
        attempts: 3,
        errorMessage: "SMTP throttled",
        lastAttemptAt: new Date(Date.now() - 60_000),
        ...extra,
      },
    });

  const read = (id: string) => prisma.emailLog.findUniqueOrThrow({ where: { id } });
  const press = (id: string) =>
    review.requeueExhaustedEmailFailure(id, { requestedByMemberId: ADMIN_ID });
  const requeueAudits = (id: string) =>
    prisma.auditLog.findMany({ where: { action: REQUEUE_ACTION, targetId: id } });

  /**
   * Wait until `n` lock waits on `EmailLog` are queued. Scoped by the waiting
   * statement's text, as in `caller-retried-alert-release.realdb.test.ts`;
   * realdb files take turns on the database, so no other suite's writer counts.
   */
  async function waitForLockWaiters(n: number) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%"EmailLog"%'`;
      if (waiting >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`never saw ${n} queued lock waits`);
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(RACE_DB_URL, "exhausted email requeue proof");
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    review = await import("@/lib/email-failure-review");
    ({ retryFailedEmails } = await import("@/lib/cron-email-retry"));
    ({ recordSesEmailFeedback } = await import("@/lib/email-suppression"));
    await deleteFixtures();
  }, 60_000);

  beforeEach(async () => {
    await deleteFixtures();
    sendMail.mockReset();
    sendMail.mockResolvedValue({ messageId: `${P}-message` });
  });

  afterAll(async () => {
    if (typeof prisma === "undefined") return;
    try {
      await deleteFixtures();
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  });

  it("lets exactly one of two concurrent presses requeue the row, with one audit row", async () => {
    const row = await exhausted(`a@${P}.test`);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "EmailLog" WHERE id = ${row.id} FOR UPDATE`;
        locked();
        await held;
      },
      { maxWait: 30_000, timeout: 60_000 },
    );
    await lockTaken;

    const presses = Promise.allSettled([press(row.id), press(row.id)]);
    await waitForLockWaiters(2);
    release();
    await holder;

    const outcomes = await presses;
    const won = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const lost = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(review.EmailFailureReviewError);
    expect(lost[0]!.reason.status).toBe(409);

    expect(await read(row.id)).toEqual(
      expect.objectContaining({ status: "FAILED", attempts: 2, htmlBody: row.htmlBody }),
    );
    const audits = await requeueAudits(row.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual(
      expect.objectContaining({ actorMemberId: ADMIN_ID, category: "communication" }),
    );
  });

  it("is sent by the retry cron's next run, and is not requeued by a third press", async () => {
    const row = await exhausted(`a@${P}.test`);
    // Before the press the cron leaves an exhausted row alone.
    await retryFailedEmails();
    expect(await read(row.id)).toEqual(expect.objectContaining({ status: "FAILED", attempts: 3 }));

    await press(row.id);
    await retryFailedEmails();

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: row.to, subject: SUBJECT, html: row.htmlBody }),
    );
    expect(await read(row.id)).toEqual(
      expect.objectContaining({ status: "SENT", attempts: 3, messageId: `${P}-message`, errorMessage: null }),
    );
    await expect(press(row.id)).rejects.toMatchObject({ status: 409 });
    expect(await requeueAudits(row.id)).toHaveLength(1);
  });

  it("lands back in review after one more failed attempt", async () => {
    const row = await exhausted(`a@${P}.test`);
    sendMail.mockRejectedValue(new Error("SMTP still throttled"));

    await press(row.id);
    await retryFailedEmails();

    expect(await read(row.id)).toEqual(
      expect.objectContaining({ status: "FAILED", attempts: 3, errorMessage: "SMTP still throttled" }),
    );
    expect((await review.getExhaustedEmailFailureReviewQueue()).failures.map((failure) => failure.id)).toContain(row.id);
  });

  it("is marked BOUNCED, never sent, when the recipient was suppressed after the press", async () => {
    const row = await exhausted(`bounced@${P}.test`);
    await press(row.id);
    await recordSesEmailFeedback([
      { email: row.to, reason: "BOUNCE", eventType: "bounce", bounceType: "Permanent" },
    ]);

    await retryFailedEmails();

    expect(sendMail).not.toHaveBeenCalledWith(expect.objectContaining({ to: row.to }));
    expect(await read(row.id)).toEqual(
      expect.objectContaining({ status: "BOUNCED", htmlBody: null, bookingRetryHtmlBody: null }),
    );
  });

  /** A member, a lodge and one cancelled booking of theirs. */
  async function booking(noEmails: boolean) {
    await prisma.member.create({
      data: { id: MEMBER_ID, email: `member@${P}.test`, passwordHash: "not-a-real-password", firstName: "Race", lastName: "Requeue", role: "USER", ageTier: "ADULT" },
    });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 4963 Lodge", slug: P } });
    await prisma.booking.create({
      data: {
        id: BOOKING_ID, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: new Date(Date.UTC(2026, 7, 1)),
        checkOut: new Date(Date.UTC(2026, 7, 3)), status: "CANCELLED", totalPriceCents: 0, finalPriceCents: 0, noEmails,
      },
    });
  }

  /** A `booking-cancelled` copy to the booking's member, body kept as booking mail keeps it. */
  const exhaustedBookingEmail = (extra: Record<string, unknown> = {}) =>
    exhausted(`member@${P}.test`, {
      templateName: "booking-cancelled",
      htmlBody: null,
      bookingRetryHtmlBody: "<p>your booking was cancelled</p>",
      bookingId: BOOKING_ID,
      bookingRecipientMemberId: MEMBER_ID,
      bookingBodyOverrideApplied: false,
      bookingDetailLinkIncluded: false,
      ...extra,
    });

  it("is sent to the booking's member once the cron re-proves their authority", async () => {
    await booking(false);
    const row = await exhaustedBookingEmail();

    await press(row.id);
    await retryFailedEmails();

    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: row.to }));
    expect(await read(row.id)).toEqual(expect.objectContaining({ status: "SENT", attempts: 3 }));
  });

  it("is retired, never sent, when the cron cannot re-prove the recipient's authority (#2362)", async () => {
    await booking(false);
    const row = await exhaustedBookingEmail({ bookingBodyOverrideApplied: null, bookingDetailLinkIncluded: null });

    await press(row.id);
    await retryFailedEmails();

    expect(sendMail).not.toHaveBeenCalledWith(expect.objectContaining({ to: row.to }));
    const retired = await read(row.id);
    expect(retired).toEqual(
      expect.objectContaining({ status: "FAILED", attempts: 3, htmlBody: null, bookingRetryHtmlBody: null }),
    );
    expect(retired.errorMessage).toMatch(/#2362/);
    // Back in review with no copy left, so Try again is not offered again.
    const queued = (await review.getExhaustedEmailFailureReviewQueue()).failures.find(
      (failure) => failure.id === row.id,
    );
    expect(queued?.recovery).toBe("retired");
    await expect(press(row.id)).rejects.toMatchObject({ status: 409 });
  });

  it("is withheld, never sent, when its booking's No emails switch is on", async () => {
    await booking(true);
    const row = await exhaustedBookingEmail();

    await press(row.id);
    await retryFailedEmails();

    expect(sendMail).not.toHaveBeenCalledWith(expect.objectContaining({ to: row.to }));
    expect(await read(row.id)).toEqual(
      expect.objectContaining({ status: "SKIPPED_NO_EMAILS", bookingRetryHtmlBody: null }),
    );
  });
});
