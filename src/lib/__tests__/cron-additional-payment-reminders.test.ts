import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Chasing an uncollected additional payment (#2350).
 *
 * The whole point of this cron is that it is SAFE to run every three hours: it
 * must send at most two emails per outstanding amount, never touch a booking,
 * never chase a stay that is over, and never speak to a member whose booking has
 * been silenced. These tests are the due/not-due matrix that pins each of those.
 */

const {
  mockPrisma,
  mockSendAdditionalPaymentReminderEmail,
  mockReadBookingNoEmails,
  mockGetActiveEmailSuppression,
  mockLogger,
} = vi.hoisted(() => ({
  mockPrisma: {
    booking: { findMany: vi.fn(), findUnique: vi.fn() },
    payment: { updateMany: vi.fn() },
    cronJobRun: { findFirst: vi.fn() },
    /*
      #3035: this cron asks the delivery policy BEFORE it claims anything, and
      that resolver reads the environment-safety override. A missing delegate is
      an UNREADABLE override, not "no override", so it resolves UNKNOWN and the
      whole run returns early — every assertion below would then be about a job
      that did nothing. `null` is the ordinary state of an installation that has
      never touched the safer switch. Written inline because `vi.hoisted` runs
      above the file's imports.
    */
    environmentSafetySettings: { findUnique: vi.fn().mockResolvedValue(null) },
  },
  mockSendAdditionalPaymentReminderEmail: vi.fn(),
  mockReadBookingNoEmails: vi.fn(),
  mockGetActiveEmailSuppression: vi.fn(),
  mockLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/email", () => ({
  sendAdditionalPaymentReminderEmail: mockSendAdditionalPaymentReminderEmail,
}));
vi.mock("@/lib/booking-email-suppression", () => ({
  readBookingNoEmails: mockReadBookingNoEmails,
}));
vi.mock("@/lib/email-suppression", () => ({
  getActiveEmailSuppression: mockGetActiveEmailSuppression,
}));
vi.mock("@/lib/logger", () => ({ default: mockLogger }));

import { sendAdditionalPaymentReminders } from "@/lib/cron-additional-payment-reminders";
import {
  declareEnvironmentRole,
  expectEnvironmentRolePremise,
} from "@/lib/__tests__/helpers/environment-role";

// NZ today for the frozen clock below is 2026-10-11 (NZST is UTC+12).
const NOW = new Date("2026-10-10T22:00:00.000Z");
const TODAY = new Date("2026-10-11T00:00:00.000Z");

/** An owing booking whose extra was raised well over the reminder threshold. */
function booking(overrides: Record<string, unknown> = {}) {
  const payment = {
    id: "payment-1",
    additionalAmountCents: 21_000,
    additionalPaymentStatus: "PENDING",
    additionalReminderSentAt: null,
    additionalFinalReminderSentAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    // Raised 10 days ago, so the day-3 nudge is overdue.
    transactions: [{ createdAt: new Date("2026-10-01T00:00:00.000Z") }],
    ...((overrides.payment as Record<string, unknown>) ?? {}),
  };
  return {
    id: "booking-1",
    lodgeId: "lodge-1",
    status: "PAID",
    // Well outside the pre-check-in window, so only the day-3 nudge applies.
    checkIn: new Date("2026-11-01T00:00:00.000Z"),
    checkOut: new Date("2026-11-03T00:00:00.000Z"),
    member: { email: "member@example.org", firstName: "Alice" },
    ...overrides,
    payment,
  };
}

const EPISODE_STARTED_AT = new Date("2026-10-01T00:00:00.000Z");

/**
 * The first-deploy cutover is DERIVED from the job's own first recorded run
 * rather than read from a hand-edited constant, so the tests state the deploy
 * date the way production will: as a `CronJobRun` row.
 */
const FIRST_RUN_AT = new Date("2026-08-01T00:00:00.000Z");

describe("sendAdditionalPaymentReminders", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mockPrisma.booking.findMany.mockResolvedValue([]);
    mockPrisma.booking.findUnique.mockResolvedValue(null);
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.cronJobRun.findFirst.mockResolvedValue({
      startedAt: FIRST_RUN_AT,
    });
    mockReadBookingNoEmails.mockResolvedValue(false);
    mockGetActiveEmailSuppression.mockResolvedValue(null);
    // The mailer RETURNS its outcome; "sent" is the only one that means the
    // member actually received something.
    mockSendAdditionalPaymentReminderEmail.mockResolvedValue({
      status: "sent",
      emailLogId: "log-1",
      messageId: "msg-1",
    });
    // #3035: which installation this suite is pretending to be. Without it the
    // role resolves UNKNOWN and the run returns before it claims anything.
    declareEnvironmentRole("production");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("only considers owing bookings whose stay has not finished", async () => {
    await sendAdditionalPaymentReminders();

    const args = mockPrisma.booking.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      deletedAt: null,
      checkOut: { gt: TODAY },
      status: { in: ["CONFIRMED", "PAID", "COMPLETED"] },
      payment: {
        is: {
          additionalAmountCents: { gt: 0 },
          OR: [
            { additionalPaymentStatus: null },
            { additionalPaymentStatus: { not: "SUCCEEDED" } },
          ],
        },
      },
    });
  });

  it("sends the day-three nudge once the extra has been owing long enough", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).toHaveBeenCalledWith({
      bookingId: "booking-1",
      email: "member@example.org",
      firstName: "Alice",
      additionalAmountCents: 21_000,
      checkIn: new Date("2026-11-01T00:00:00.000Z"),
      checkOut: new Date("2026-11-03T00:00:00.000Z"),
      requestedOn: EPISODE_STARTED_AT,
      lodgeId: "lodge-1",
    });
    expect(result.initialSentBookingIds).toEqual(["booking-1"]);
    expect(result.finalSentBookingIds).toEqual([]);
    // Only the day-three stamp is written; the pre-arrival one stays free.
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { additionalReminderSentAt: NOW } }),
    );
  });

  it("stays quiet while the extra is younger than the reminder threshold", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        payment: {
          transactions: [{ createdAt: new Date("2026-10-09T00:00:00.000Z") }],
        },
      }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(result.skippedBookingIds).toEqual(["booking-1"]);
  });

  it("sends the last-chance nudge close to check-in and closes both stamps", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        checkIn: new Date("2026-10-12T00:00:00.000Z"),
        checkOut: new Date("2026-10-14T00:00:00.000Z"),
        payment: {
          // Raised yesterday: the day-three nudge is NOT due, but check-in is.
          transactions: [{ createdAt: new Date("2026-10-10T00:00:00.000Z") }],
        },
      }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(result.finalSentBookingIds).toEqual(["booking-1"]);
    expect(result.initialSentBookingIds).toEqual([]);
    // Both stamps close: inside the pre-arrival window the gentler nudge has
    // nothing left to add, and leaving it unset would send a second email.
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          additionalFinalReminderSentAt: NOW,
          additionalReminderSentAt: NOW,
        },
      }),
    );
  });

  it("never chases a stay that has already ended", async () => {
    // The database filter excludes these, but the decision is also made in
    // memory so a widened query can never start emailing about finished stays.
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        checkIn: new Date("2026-10-05T00:00:00.000Z"),
        checkOut: new Date("2026-10-07T00:00:00.000Z"),
      }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(result.skippedBookingIds).toEqual(["booking-1"]);
  });

  it("chases a FAILED charge exactly as it chases a pending one", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({ payment: { additionalPaymentStatus: "FAILED" } }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(result.initialSentBookingIds).toEqual(["booking-1"]);
  });

  it("does not re-send once this obligation has been stamped", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        payment: {
          additionalReminderSentAt: new Date("2026-10-05T00:00:00.000Z"),
        },
      }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(result.skippedBookingIds).toEqual(["booking-1"]);
  });

  /*
    The stamps are read RELATIVE to the current obligation, which is what lets a
    later modification raise a fresh delta and be chased from scratch without any
    writer having to reset the columns.
  */
  it("chases a NEW obligation even though the previous one was stamped", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        payment: {
          additionalReminderSentAt: new Date("2026-09-20T00:00:00.000Z"),
          additionalFinalReminderSentAt: new Date("2026-09-20T00:00:00.000Z"),
          // Raised AFTER those stamps, so they belong to a settled episode.
          transactions: [{ createdAt: new Date("2026-10-01T00:00:00.000Z") }],
        },
      }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(result.initialSentBookingIds).toEqual(["booking-1"]);
  });

  it("says nothing about a booking whose emails are switched off", async () => {
    mockReadBookingNoEmails.mockResolvedValue(true);
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    // No stamp is burned, so the reminder is still due once the switch is off.
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(result.suppressedBookingIds).toEqual(["booking-1"]);
  });

  it("fails closed when the no-emails switch cannot be read", async () => {
    mockReadBookingNoEmails.mockRejectedValue(new Error("database unavailable"));
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(result.suppressedBookingIds).toEqual(["booking-1"]);
  });

  it("sends nothing when another runner claimed the reminder first", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(result.skippedBookingIds).toEqual(["booking-1"]);
  });

  it("re-states the owed test in the claim so a settled extra cannot be chased", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);

    await sendAdditionalPaymentReminders();

    const where = mockPrisma.payment.updateMany.mock.calls[0][0].where;
    expect(where.id).toBe("payment-1");
    // The whole owed test, booking lifecycle status included, so a cancellation
    // landing between the read and the claim cannot be emailed about.
    expect(where.AND).toContainEqual({
      additionalAmountCents: { gt: 0 },
      OR: [
        { additionalPaymentStatus: null },
        { additionalPaymentStatus: { not: "SUCCEEDED" } },
      ],
      booking: { is: { status: { in: ["CONFIRMED", "PAID", "COMPLETED"] } } },
    });
    expect(where.AND).toContainEqual({
      OR: [
        { additionalReminderSentAt: null },
        { additionalReminderSentAt: { lt: EPISODE_STARTED_AT } },
      ],
    });
  });

  /*
    #2350 F1: a cancelled booking keeps its delta columns exactly as they were —
    the cancel path marks the intent FAILED without zeroing the amount — so the
    in-memory test must exclude it too, not just the SQL. Chasing here would
    email a member "Payment Still Needed" about a booking they cancelled.
  */
  it("never chases a booking whose lifecycle no longer owes anything", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        status: "CANCELLED",
        payment: { additionalPaymentStatus: "FAILED" },
      }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(result.skippedBookingIds).toEqual(["booking-1"]);
  });

  /*
    #2350 F2. The claim fences the obligation the read decided on, so a change
    landing in the read→claim window loses the claim instead of producing an
    email about the wrong amount. The episode fence is the load-bearing half: a
    member retrying a failed charge mints a new Stripe intent and therefore a
    new ADDITIONAL transaction row at the SAME amount.
  */
  it("fences the amount and the episode it read into the claim", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);

    await sendAdditionalPaymentReminders();

    const where = mockPrisma.payment.updateMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({ additionalAmountCents: 21_000 });
    expect(where.AND).toContainEqual({
      transactions: {
        none: { kind: "ADDITIONAL", createdAt: { gt: EPISODE_STARTED_AT } },
      },
    });
  });

  /*
    The case an amount pin alone would sail straight through. A member retrying
    a failed additional charge mints a NEW Stripe intent, and the transaction
    upsert is keyed on the intent id, so a new row appears carrying the SAME
    amount. Only the episode fence notices; without it the cron would email the
    old obligation while stamping the new episode as already chased, and that
    episode's first reminder would never be sent.

    The claim is evaluated here rather than stubbed, so this tests the WHERE the
    database will actually be given, not an assertion about its shape.
  */
  it("loses the claim when a retry starts a new episode at the same amount", async () => {
    const rowTransactions = [{ createdAt: new Date("2026-10-04T00:00:00.000Z") }];
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({ payment: { transactions: rowTransactions } }),
    );
    mockPrisma.payment.updateMany.mockImplementation(
      ({ where }: { where: { AND?: Array<Record<string, unknown>> } }) => {
        const fence = (where.AND ?? []).find((clause) => "transactions" in clause) as
          | {
              transactions: {
                none: { kind: string; createdAt: { gt: Date } };
              };
            }
          | undefined;
        const cutoff = fence?.transactions.none.createdAt.gt;
        const violated =
          cutoff != null &&
          rowTransactions.some((tx) => tx.createdAt.getTime() > cutoff.getTime());
        return Promise.resolve({ count: violated ? 0 : 1 });
      },
    );

    const result = await sendAdditionalPaymentReminders();

    // First claim (episode 1 Oct) is fenced out by the 4 Oct retry row; the
    // re-read sees the new episode and chases THAT, quoting its own start.
    expect(result.initialSentBookingIds).toEqual(["booking-1"]);
    expect(mockSendAdditionalPaymentReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalAmountCents: 21_000,
        requestedOn: new Date("2026-10-04T00:00:00.000Z"),
      }),
    );
  });

  it("re-reads and chases the NEW obligation when the delta moved under it", async () => {
    // The sweep saw $210 raised on 1 Oct; by the time we claim, a second upward
    // change has raised $340 and started a fresh episode.
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockPrisma.booking.findUnique.mockResolvedValue(
      booking({
        payment: {
          additionalAmountCents: 34_000,
          transactions: [{ createdAt: new Date("2026-10-05T00:00:00.000Z") }],
        },
      }),
    );
    mockPrisma.payment.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 1 });

    const result = await sendAdditionalPaymentReminders();

    expect(result.initialSentBookingIds).toEqual(["booking-1"]);
    // The email quotes the CURRENT amount and the CURRENT episode, never the
    // stale pair the sweep read.
    expect(mockSendAdditionalPaymentReminderEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalAmountCents: 34_000,
        requestedOn: new Date("2026-10-05T00:00:00.000Z"),
      }),
    );
    expect(
      mockPrisma.payment.updateMany.mock.calls[1][0].where.AND,
    ).toContainEqual({ additionalAmountCents: 34_000 });
  });

  it("stops after one re-read rather than spinning on a contended row", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockPrisma.booking.findUnique.mockResolvedValue(booking());
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 0 });

    const result = await sendAdditionalPaymentReminders();

    expect(mockPrisma.payment.updateMany).toHaveBeenCalledTimes(2);
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(result.skippedBookingIds).toEqual(["booking-1"]);
  });

  /*
    #2350: the mailer RETURNS rather than throws when it withholds a message, so
    a withheld send must not read as a send — that would leave the stamp burned
    and this obligation never chased again.
  */
  it("hands the stamp back when the no-emails switch beat it to the mailer", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockSendAdditionalPaymentReminderEmail.mockResolvedValue({
      status: "withheld_for_booking",
      emailLogId: "log-1",
      bookingId: "booking-1",
      reason: "booking_no_emails",
    });

    const result = await sendAdditionalPaymentReminders();

    expect(result.initialSentBookingIds).toEqual([]);
    expect(result.suppressedBookingIds).toEqual(["booking-1"]);
    expect(mockPrisma.payment.updateMany).toHaveBeenLastCalledWith({
      where: { id: "payment-1", additionalReminderSentAt: NOW },
      data: { additionalReminderSentAt: null },
    });
  });

  /*
    ONE stamp rule, shared with the manual re-send: a stamp is only ever spent
    on a message that went out, or on one something else will replay. A
    suppression can be cleared by a person, so it must not permanently disarm
    the chase — and reaching the mailer at all means the address was suppressed
    between the pre-check below and the send.
  */
  it("hands the stamp back for a suppressed address, exactly as the manual re-send does", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockSendAdditionalPaymentReminderEmail.mockResolvedValue({
      status: "suppressed",
      emailLogId: "log-1",
      emailSuppressionId: "sup-1",
      reason: "BOUNCE",
    });

    const result = await sendAdditionalPaymentReminders();

    expect(result.initialSentBookingIds).toEqual([]);
    expect(result.suppressedBookingIds).toEqual(["booking-1"]);
    expect(mockPrisma.payment.updateMany).toHaveBeenLastCalledWith({
      where: { id: "payment-1", additionalReminderSentAt: NOW },
      data: { additionalReminderSentAt: null },
    });
  });

  it("keeps the stamp only where the message will be replayed for us", async () => {
    // An unreadable switch leaves a FAILED EmailLog that the retry cron picks
    // up (re-checking the switch first), so handing the stamp back here is the
    // one case that could produce a second copy.
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockSendAdditionalPaymentReminderEmail.mockResolvedValue({
      status: "withheld_for_booking",
      emailLogId: "log-1",
      bookingId: "booking-1",
      reason: "booking_flag_unreadable",
    });

    const result = await sendAdditionalPaymentReminders();

    expect(result.suppressedBookingIds).toEqual(["booking-1"]);
    // One write only: the claim. Nothing was given back.
    expect(mockPrisma.payment.updateMany).toHaveBeenCalledTimes(1);
  });

  /*
    The pre-check is what makes the shared stamp rule affordable in a job that
    runs eight times a day: an unreachable member never reaches the claim, so
    there is no stamp to burn and no bounce row manufactured every three hours,
    and the reminder stays due for whenever the address is fixed.
  */
  it("skips an unreachable member before claiming anything", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockGetActiveEmailSuppression.mockResolvedValue({
      id: "sup-1",
      reason: "BOUNCE",
    });

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(result.suppressedBookingIds).toEqual(["booking-1"]);
  });

  it("skips a walk-in placeholder address before claiming anything", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        member: { email: "walk-in-abc@no-email.invalid", firstName: "Walk-in" },
      }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(result.suppressedBookingIds).toEqual(["booking-1"]);
  });

  it("fails closed when the suppression state cannot be read", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockGetActiveEmailSuppression.mockRejectedValue(new Error("db down"));

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(result.suppressedBookingIds).toEqual(["booking-1"]);
  });

  /*
    First-deploy guard: on the day this ships every pre-existing delta is
    already long past the day-3 threshold, so without this the first pass would
    email the club's entire backlog at once.
  */
  it("never chases an obligation raised before the chase existed", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        payment: {
          createdAt: new Date("2026-07-01T00:00:00.000Z"),
          transactions: [{ createdAt: new Date("2026-07-02T00:00:00.000Z") }],
        },
      }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(result.skippedBookingIds).toEqual(["booking-1"]);
  });

  /*
    The cutover is derived from the job's own first recorded run rather than a
    hand-edited constant, which is what stops a slipped deploy mailing the gap
    as backlog. It is read from CronJobRun, not from the calendar.
  */
  it("takes the cutover from the job's first recorded run", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    // The chase started AFTER this obligation was raised, so it is backlog.
    mockPrisma.cronJobRun.findFirst.mockResolvedValue({
      startedAt: new Date("2026-10-05T00:00:00.000Z"),
    });

    const result = await sendAdditionalPaymentReminders();

    expect(mockPrisma.cronJobRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobName: "additional-payment-reminders" },
        orderBy: { startedAt: "asc" },
      }),
    );
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(result.chaseStartsAt).toEqual(new Date("2026-10-05T00:00:00.000Z"));
  });

  it("sends nothing on the very first run, which establishes the cutover", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockPrisma.cronJobRun.findFirst.mockResolvedValue(null);

    const result = await sendAdditionalPaymentReminders();

    // Not even the sweep runs: there is nothing this pass may act on.
    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(result.chaseStartsAt).toBeNull();
  });

  it("sends nothing when the cutover cannot be read", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockPrisma.cronJobRun.findFirst.mockRejectedValue(new Error("db down"));

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(result.chaseStartsAt).toBeNull();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  /*
    The collision the cooldown is supposed to prevent, end to end. An admin
    re-sent by hand ten minutes ago, which wrote the day-N stamp only because
    the pre-arrival window had not opened yet. It has now, and the final stamp
    is still unset - reading the stamps alone, this tick would send the
    near-identical last-chance email inside the hour.
  */
  it("will not chase on top of a manual send from the last hour", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({
        checkIn: new Date("2026-10-12T00:00:00.000Z"),
        checkOut: new Date("2026-10-14T00:00:00.000Z"),
        payment: {
          transactions: [{ createdAt: new Date("2026-10-05T00:00:00.000Z") }],
          additionalReminderSentAt: new Date(NOW.getTime() - 10 * 60_000),
        },
      }),
    ]);

    const result = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(result.skippedBookingIds).toEqual(["booking-1"]);
  });

  it("fences the cooldown into the claim as well as the decision", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);

    await sendAdditionalPaymentReminders();

    const where = mockPrisma.payment.updateMany.mock.calls[0][0].where;
    const cutoff = new Date(NOW.getTime() - 60 * 60_000);
    for (const field of [
      "additionalReminderSentAt",
      "additionalFinalReminderSentAt",
    ]) {
      expect(where.AND).toContainEqual({
        OR: [{ [field]: null }, { [field]: { lte: cutoff } }],
      });
    }
  });

  it("records a transport failure without pretending the email went out", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockSendAdditionalPaymentReminderEmail.mockRejectedValue(
      new Error("SES unavailable"),
    );

    const result = await sendAdditionalPaymentReminders();

    expect(result.failedBookingIds).toEqual(["booking-1"]);
    expect(result.initialSentBookingIds).toEqual([]);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  /*
    The property the whole design exists for: running the job twice back to back
    must not email the member twice. The second pass sees the stamp the first
    wrote — modelled here by feeding it back in, which is what the real re-read
    would return.
  */
  it("sends nothing on an immediate rerun", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    await sendAdditionalPaymentReminders();
    expect(mockSendAdditionalPaymentReminderEmail).toHaveBeenCalledTimes(1);

    mockSendAdditionalPaymentReminderEmail.mockClear();
    mockPrisma.booking.findMany.mockResolvedValue([
      booking({ payment: { additionalReminderSentAt: NOW } }),
    ]);

    const rerun = await sendAdditionalPaymentReminders();

    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(rerun.initialSentBookingIds).toEqual([]);
  });
});

// --- #3035 review: an idle copy must not manufacture the "live club" signal ---
//
// The stamp-restoring path this suite already covers is correct, and it is also
// why this early return exists. Without it a copy re-claims every eligible
// booking on every run, has each message suppressed, restores each stamp, and
// starts again three hours later — writing N NEW counted
// `SKIPPED_NON_PRODUCTION` rows per pass with `mostRecentAt` always minutes old.
// That is precisely the signature owner decision 1 asks the withheld-email count
// to MEAN ("a live club is being held back, steadily and right now"), so an
// ordinary staging box would produce it forever and the detector would be
// useless.
//
// The pre-existing justification for restoring a stamp is that the checks above
// the claim already skip an unreachable recipient, so reaching the restore means
// the state changed under this very pass. An environment withhold is not a race —
// it is a standing fact about the installation — so it is answered before any
// work.
describe("sendAdditionalPaymentReminders on an installation that cannot send (#3035)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mockPrisma.booking.findMany.mockResolvedValue([booking()]);
    mockPrisma.booking.findUnique.mockResolvedValue(null);
    mockPrisma.payment.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.cronJobRun.findFirst.mockResolvedValue({
      startedAt: FIRST_RUN_AT,
    });
    mockReadBookingNoEmails.mockResolvedValue(false);
    mockGetActiveEmailSuppression.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("claims nothing and sends nothing on a confirmed copy", async () => {
    declareEnvironmentRole("non-production");
    await expectEnvironmentRolePremise("NON_PRODUCTION");

    const result = await sendAdditionalPaymentReminders();

    // The load-bearing assertion: no CLAIM. A claim is what produces the
    // suppression row, and a suppression row per booking per run is the false
    // signal.
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(result.initialSentBookingIds).toEqual([]);
    expect(result.suppressedBookingIds).toEqual([]);
    // And it is not reported as a failure: a copy declining to chase the club's
    // money is the job working.
    expect(result.failedBookingIds).toEqual([]);
  });

  it("claims nothing when nobody has declared what this installation is", async () => {
    declareEnvironmentRole("");
    await expectEnvironmentRolePremise("UNKNOWN");

    const result = await sendAdditionalPaymentReminders();

    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    expect(mockSendAdditionalPaymentReminderEmail).not.toHaveBeenCalled();
    expect(result.suppressedBookingIds).toEqual([]);
  });

  it("still claims and sends on the club's live site", async () => {
    // The discriminating half: the early return must not swallow a real run.
    declareEnvironmentRole("production");
    await expectEnvironmentRolePremise("PRODUCTION");
    mockSendAdditionalPaymentReminderEmail.mockResolvedValue({
      status: "sent",
      emailLogId: "log-1",
      messageId: "msg-1",
    });

    const result = await sendAdditionalPaymentReminders();

    expect(mockPrisma.payment.updateMany).toHaveBeenCalled();
    expect(mockSendAdditionalPaymentReminderEmail).toHaveBeenCalledTimes(1);
    expect(result.initialSentBookingIds).toEqual(["booking-1"]);
  });
});
