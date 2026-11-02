import { BookingEventType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logAudit: vi.fn(),
  recordBookingEvent: vi.fn().mockResolvedValue(undefined),
  sendMemberEmail: vi.fn(),
  sendAdminAlert: vi.fn(),
  findBooking: vi.fn(),
  findRefunds: vi.fn(),
  listRefunds: vi.fn(),
  /** #4690: the `AlertCooldown` table, by key. */
  cooldowns: new Map<string, Date>(),
  /**
   * One-shot `AlertCooldown` faults by `op:key`: "before" throws with nothing
   * written; "after" writes, then throws - a commit whose reply was lost.
   */
  cooldownFaults: new Map<string, "before" | "after">(),
  /** The member emails recorded, by key: the real `EmailLog` row is unique on it. */
  memberEmails: new Map<string, unknown>(),
}));

function cooldownWhereMatches(row: { key: string; lastAlertedAt: Date }, where: { key: unknown; lastAlertedAt?: unknown }): boolean {
  const keyOk = typeof where.key === "string" ? row.key === where.key : (where.key as { in: string[] }).in.includes(row.key);
  const at = where.lastAlertedAt;
  if (at === undefined) return keyOk;
  if (at instanceof Date) return keyOk && row.lastAlertedAt.getTime() === at.getTime();
  const range = at as { lt?: Date; gte?: Date };
  return keyOk &&
    (range.lt === undefined || row.lastAlertedAt < range.lt) &&
    (range.gte === undefined || row.lastAlertedAt >= range.gte);
}

function takeCooldownFault(op: string, key: string): "before" | "after" | undefined {
  const fault = mocks.cooldownFaults.get(`${op}:${key}`);
  mocks.cooldownFaults.delete(`${op}:${key}`);
  if (fault === "before") throw new Error(`${op} failed`);
  return fault;
}

vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/booking-events", () => ({
  recordBookingEvent: mocks.recordBookingEvent,
}));
vi.mock("@/lib/email/booking", () => ({
  sendSupersededPaymentRefundedEmail: mocks.sendMemberEmail,
}));
vi.mock("@/lib/email/admin-alerts-finance", () => ({
  sendAdminSupersededPaymentRefundAlert: mocks.sendAdminAlert,
}));
vi.mock("@/lib/stripe", () => ({ listRefundsForPaymentIntent: mocks.listRefunds }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.findBooking },
    paymentRefund: { findMany: mocks.findRefunds },
    alertCooldown: {
      updateMany: async ({ where, data }: { where: { key: string; lastAlertedAt?: unknown }; data: { lastAlertedAt: Date } }) => {
        takeCooldownFault("updateMany", where.key);
        const held = mocks.cooldowns.get(where.key);
        if (!held || !cooldownWhereMatches({ key: where.key, lastAlertedAt: held }, where)) return { count: 0 };
        mocks.cooldowns.set(where.key, data.lastAlertedAt);
        return { count: 1 };
      },
      create: async ({ data }: { data: { key: string; lastAlertedAt: Date } }) => {
        const fault = takeCooldownFault("create", data.key);
        if (mocks.cooldowns.has(data.key)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002", clientVersion: "test" });
        }
        mocks.cooldowns.set(data.key, data.lastAlertedAt);
        if (fault === "after") throw new Error("connection reset after commit");
        return data;
      },
      deleteMany: async ({ where }: { where: { key: string; lastAlertedAt: Date } }) => {
        takeCooldownFault("deleteMany", where.key);
        const held = mocks.cooldowns.get(where.key);
        if (!held || held.getTime() !== where.lastAlertedAt.getTime()) return { count: 0 };
        mocks.cooldowns.delete(where.key);
        return { count: 1 };
      },
      findMany: async ({ where }: { where: { key: { in: string[] }; lastAlertedAt: unknown } }) =>
        [...mocks.cooldowns]
          .map(([key, lastAlertedAt]) => ({ key, lastAlertedAt }))
          .filter((row) => cooldownWhereMatches(row, where)),
    },
  },
}));

import {
  reportSupersededPaymentRefund,
  reportUnannouncedSupersededPaymentRefund,
  SupersededRefundReportNotSettledError,
  supersededRefundReportKeys,
  supersededRefundReportSettled,
} from "@/lib/superseded-additional-refund";
import { SUPERSEDED_PAYMENT_REFUND_METADATA_REASON } from "@/lib/payment-recovery-keys";
import { PAYMENT_RECOVERY_STALE_PROCESSING_MS } from "@/lib/payment-recovery-constants";
import {
  isSupersededAdditionalRefundEvent,
  SUPERSEDED_ADDITIONAL_REFUND_EVENT_KIND,
} from "@/lib/superseded-additional-refund-event";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/*
  #3340 acceptance criterion 5 — A LATE-CAPTURED SUPERSEDED INTENT THAT IS
  REFUNDED PRODUCES AN AUDIT ROW, A BOOKING EVENT, A MEMBER EMAIL AND AN ADMIN
  ALERT.

  Before this, the `REFUND_SUPERSEDED_PAYMENT` path recorded NOTHING. Stripe's own
  receipt was the only notice anybody got; the member in the live case wrote in
  asking what had happened, and that query is the only reason the money leak
  underneath was found at all.

  Frozen clock inherited; the fixtures carry fixed dates and no `Date.now()`.
*/

const CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");

/**
 * A booking whose ledger BALANCES, parameterised on the ask.
 *
 * `finalPriceCents` and the captured total move together with the ask, because
 * the figure under test is the booking's WHOLE outstanding (`INV-PAY-047`
 * rearranged) rather than the ask alone - and on a balanced ledger the two are
 * the same number, which is the property that keeps the ordinary case's member
 * email unchanged.
 */
function bookingRow(
  payment:
    | {
        additionalAmountCents: number;
        additionalPaymentStatus: string | null;
        finalPriceCents?: number;
        changeFeeCents?: number;
        amountCents?: number;
        refundedAmountCents?: number;
        creditAppliedCents?: number;
      }
    | null,
) {
  return {
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    lodgeId: "lodge_1",
    // Price = captured + the uncollected ask, so the residual is zero.
    finalPriceCents:
      payment?.finalPriceCents ?? 13000 + (payment?.additionalAmountCents ?? 0),
    member: {
      id: "member_1",
      email: "member@example.test",
      firstName: "Ada",
      lastName: "Lovelace",
    },
    payment: payment
      ? {
          changeFeeCents: 0,
          amountCents: 13000,
          refundedAmountCents: 0,
          creditAppliedCents: 0,
          ...payment,
        }
      : null,
  };
}

const SENT_TO_ONE_ADMIN = { deliveryAllowed: true, recipients: 1, sent: 1, queuedForRetry: 0, notDelivered: 0 };
const NOBODY_OPTED_IN = { deliveryAllowed: true, recipients: 0, sent: 0, queuedForRetry: 0, notDelivered: 0 };
const OPERATION_ID = "recovery_superseded_1";
const KEYS = supersededRefundReportKeys(OPERATION_ID);

beforeEach(() => {
  mocks.logAudit.mockClear();
  mocks.recordBookingEvent.mockClear();
  mocks.sendMemberEmail.mockReset();
  mocks.sendAdminAlert.mockReset();
  mocks.findBooking.mockReset();
  mocks.findRefunds.mockReset();
  mocks.listRefunds.mockReset();
  mocks.cooldowns.clear();
  mocks.cooldownFaults.clear();
  mocks.memberEmails.clear();
  // The member email is durable and keyed (#4690): a second record of the same key sends nothing.
  mocks.sendMemberEmail.mockImplementation(async (params: { idempotencyKey: string }) => {
    if (!mocks.memberEmails.has(params.idempotencyKey)) mocks.memberEmails.set(params.idempotencyKey, params);
  });
  mocks.sendAdminAlert.mockResolvedValue(SENT_TO_ONE_ADMIN);
});

function report(refundedAmountCents = 6500) {
  return reportSupersededPaymentRefund({
    format: CLUB_FORMAT_TEST,
    operationId: OPERATION_ID,
    bookingId: "booking_1",
    paymentId: "payment_1",
    paymentIntentId: "pi_superseded",
    refundedAmountCents,
  });
}

/** What reached people and the record: each counted once per real send or write. */
function sent() {
  const actions = mocks.logAudit.mock.calls.map((call) => call[0].action);
  return {
    memberEmails: mocks.memberEmails.size,
    adminAlerts: mocks.sendAdminAlert.mock.calls.length,
    auditRows: actions.filter((action) => action === "booking.payment.superseded_payment_refunded").length,
    events: mocks.recordBookingEvent.mock.calls.length,
  };
}
const ONCE_EACH = { memberEmails: 1, adminAlerts: 1, auditRows: 1, events: 1 };

describe("reportSupersededPaymentRefund", () => {
  it("writes all four records, quoting one amount owing to everybody", async () => {
    mocks.findBooking.mockResolvedValue(
      bookingRow({ additionalAmountCents: 36500, additionalPaymentStatus: "PENDING" }),
    );

    await reportSupersededPaymentRefund({
      format: CLUB_FORMAT_TEST,
      operationId: OPERATION_ID,
      bookingId: "booking_1",
      paymentId: "payment_1",
      paymentIntentId: "pi_superseded",
      refundedAmountCents: 6500,
    });

    const audit = mocks.logAudit.mock.calls[0][0];
    expect(audit.action).toBe("booking.payment.superseded_payment_refunded");
    expect(audit.category).toBe("payment");
    expect(JSON.parse(audit.details)).toMatchObject({
      paymentIntentId: "pi_superseded",
      refundedAmountCents: 6500,
      amountOwingAfterRefundCents: 36500,
      refundSent: true,
    });

    const event = mocks.recordBookingEvent.mock.calls[0][0];
    expect(event.type).toBe(BookingEventType.REFUNDED);
    expect(event.amountCents).toBe(6500);
    expect(event.actorMemberId).toBeNull();
    expect(event.snapshot).toMatchObject({
      kind: SUPERSEDED_ADDITIONAL_REFUND_EVENT_KIND,
      supersededPaymentIntentId: "pi_superseded",
      refundedAmountCents: 6500,
      amountOwingAfterRefundCents: 36500,
    });

    expect(mocks.sendMemberEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "booking_1",
        recipientMemberId: "member_1",
        email: "member@example.test",
        firstName: "Ada",
        refundedAmountCents: 6500,
        amountOwingCents: 36500,
      }),
      CLUB_FORMAT_TEST,
    );

    expect(mocks.sendAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Ada Lovelace",
        refundedAmountCents: 6500,
        amountOwingCents: 36500,
        paymentIntentId: "pi_superseded",
        bookingId: "booking_1",
      }),
      CLUB_FORMAT_TEST,
    );
  });

  it("reports nothing owing as a real answer, not as a missing one", async () => {
    mocks.findBooking.mockResolvedValue(
      bookingRow({ additionalAmountCents: 0, additionalPaymentStatus: null }),
    );

    await reportSupersededPaymentRefund({
      format: CLUB_FORMAT_TEST,
      operationId: OPERATION_ID,
      bookingId: "booking_1",
      paymentId: "payment_1",
      paymentIntentId: "pi_superseded",
      refundedAmountCents: 6500,
    });

    expect(mocks.sendMemberEmail).toHaveBeenCalledWith(
      expect.objectContaining({ amountOwingCents: 0 }),
      CLUB_FORMAT_TEST,
    );
  });

  /*
    #3340 fix round (money lens F4) - THE WHOLE OUTSTANDING, NOT JUST THE ASK.

    `REFUND_SUPERSEDED_PAYMENT` is not additional-only: the same processor
    handles the rows `queueSupersededPrimaryIntentCancellations` writes for the
    stale-tab protection (#1041 / #1161). A PAYMENT_PENDING booking edited from
    $130 to $195, whose stale tab confirms the $130 PRIMARY and has it refunded,
    carries no ask at all - and was told "Nothing further is owing on this
    booking" while the entire $195 was owed.
  */
  it("quotes the whole price when the refund was the booking's only payment", async () => {
    mocks.findBooking.mockResolvedValue(
      bookingRow({
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        finalPriceCents: 19500,
        // The primary was captured and has just been refunded in full.
        amountCents: 13000,
        refundedAmountCents: 13000,
      }),
    );

    await reportSupersededPaymentRefund({
      format: CLUB_FORMAT_TEST,
      operationId: OPERATION_ID,
      bookingId: "booking_1",
      paymentId: "payment_1",
      paymentIntentId: "pi_superseded",
      refundedAmountCents: 13000,
    });

    expect(mocks.sendMemberEmail).toHaveBeenCalledWith(
      expect.objectContaining({ amountOwingCents: 19500 }),
      CLUB_FORMAT_TEST,
    );
    expect(mocks.sendAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({ amountOwingCents: 19500 }),
      CLUB_FORMAT_TEST,
    );
  });

  /*
    A policy-tiered reduction leaves the club holding more than the price
    (`INV-MOD-011`), which makes the identity's residual NEGATIVE. "The club owes
    you" is not a sentence this figure is allowed to imply - the refund it
    accompanies has its own amount - so it floors at zero.
  */
  it("never reports a negative amount owing when the club retains a slice", async () => {
    mocks.findBooking.mockResolvedValue(
      bookingRow({
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
        finalPriceCents: 10000,
        amountCents: 13000,
        refundedAmountCents: 0,
      }),
    );

    await reportSupersededPaymentRefund({
      format: CLUB_FORMAT_TEST,
      operationId: OPERATION_ID,
      bookingId: "booking_1",
      paymentId: "payment_1",
      paymentIntentId: "pi_superseded",
      refundedAmountCents: 6500,
    });

    expect(mocks.sendMemberEmail).toHaveBeenCalledWith(
      expect.objectContaining({ amountOwingCents: 0 }),
      CLUB_FORMAT_TEST,
    );
  });

  it("a booking with no owner to address: the refund is recorded and escalated, nothing is sent, and it is settled", async () => {
    mocks.findBooking.mockResolvedValue(null);

    await report();

    const actions = mocks.logAudit.mock.calls.map((call) => call[0].action);
    // The money movement is on the permanent record either way ...
    expect(actions).toContain("booking.payment.superseded_payment_refunded");
    // ... and the lost notice is its own critical row rather than a log line.
    const escalation = mocks.logAudit.mock.calls.find(
      (call) => call[0].action === "booking.payment.superseded_refund_notice_failed",
    )![0];
    expect(escalation.severity).toBe("critical");
    expect(mocks.sendMemberEmail).not.toHaveBeenCalled();
    expect(mocks.sendAdminAlert).not.toHaveBeenCalled();
    expect(await supersededRefundReportSettled(OPERATION_ID)).toBe(true);
  });
});

/*
  #4690 - ONCE PER ROW, WHICHEVER ATTEMPT CALLS IT.

  The recovery worker calls the report BEFORE the row's close, from the attempt
  that made the refund and from a later claim that finds it made, so the report
  itself must say whether it already went out. Each record has its own key
  named for the row; a report that cannot say it went out throws, so the worker
  keeps the row open and the retry sends what is missing - once.
*/
describe("reportSupersededPaymentRefund sends once per recovery row (#4690)", () => {
  beforeEach(() => {
    mocks.findBooking.mockResolvedValue(
      bookingRow({ additionalAmountCents: 0, additionalPaymentStatus: null }),
    );
  });

  it("records the member's email durably under the row's id, for the retry worker to send", async () => {
    await report();

    expect(mocks.sendMemberEmail).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: OPERATION_ID }),
      CLUB_FORMAT_TEST,
    );
    expect(sent()).toEqual(ONCE_EACH);
    expect(await supersededRefundReportSettled(OPERATION_ID)).toBe(true);
  });

  it("MUTATION: report already sent - a second call sends and writes nothing more", async () => {
    await report();
    await report();

    expect(sent()).toEqual(ONCE_EACH);
    expect(mocks.sendMemberEmail).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: records already written by a call that died before its alert are not written again", async () => {
    // A call claimed the records and wrote them, then died before the alert.
    mocks.cooldowns.set(KEYS.records, new Date());

    await report();

    expect(sent()).toEqual({ memberEmails: 1, adminAlerts: 1, auditRows: 0, events: 0 });
  });

  it("the member's email not recorded: nothing else is written, it throws, and the retry sends each once", async () => {
    mocks.sendMemberEmail.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(report()).rejects.toBeInstanceOf(SupersededRefundReportNotSettledError);
    expect(sent()).toEqual({ memberEmails: 0, adminAlerts: 0, auditRows: 0, events: 0 });

    await report();
    expect(sent()).toEqual(ONCE_EACH);
  });

  it("the booking unreadable: it throws and sends nothing, so the row stays open", async () => {
    mocks.findBooking.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(report()).rejects.toBeInstanceOf(SupersededRefundReportNotSettledError);
    expect(sent()).toEqual({ memberEmails: 0, adminAlerts: 0, auditRows: 0, events: 0 });
    expect(await supersededRefundReportSettled(OPERATION_ID)).toBe(false);
  });

  it("MUTATION: the admin alert's send threw - its claim is given back, it throws, and the retry sends the alert once and nothing else twice", async () => {
    mocks.sendAdminAlert.mockRejectedValueOnce(new Error("admin list unreadable"));

    await expect(report()).rejects.toBeInstanceOf(SupersededRefundReportNotSettledError);
    expect(mocks.cooldowns.has(KEYS.alert)).toBe(false);
    expect(await supersededRefundReportSettled(OPERATION_ID)).toBe(false);

    await report();
    expect(sent()).toEqual({ ...ONCE_EACH, adminAlerts: 2 });
    expect(mocks.sendAdminAlert.mock.settledResults.filter((result) => result.type === "fulfilled")).toHaveLength(1);
    expect(await supersededRefundReportSettled(OPERATION_ID)).toBe(true);
  });

  it("MUTATION: the alert's claim write threw (#4679) - nothing sent, its own stamp given back, it throws; the retry sends", async () => {
    // The write lands and only its reply is lost: the claim is held under this call's stamp.
    mocks.cooldownFaults.set(`create:${KEYS.alert}`, "after");
    // And the helper's own give-back is not tried for an uncertain claim; the first of ours fails.
    mocks.cooldownFaults.set(`deleteMany:${KEYS.alert}`, "before");

    await expect(report()).rejects.toBeInstanceOf(SupersededRefundReportNotSettledError);
    expect(mocks.sendAdminAlert).not.toHaveBeenCalled();
    // Given back on the second try: a retry can claim it.
    expect(mocks.cooldowns.has(KEYS.alert)).toBe(false);

    await report();
    expect(sent()).toEqual(ONCE_EACH);
  });

  it("MUTATION: the records' claim write threw - none written, its stamp given back, it throws; the retry writes them once", async () => {
    mocks.cooldownFaults.set(`create:${KEYS.records}`, "after");

    await expect(report()).rejects.toBeInstanceOf(SupersededRefundReportNotSettledError);
    expect(sent()).toEqual({ memberEmails: 1, adminAlerts: 0, auditRows: 0, events: 0 });
    expect(mocks.cooldowns.has(KEYS.records)).toBe(false);

    await report();
    expect(sent()).toEqual(ONCE_EACH);
  });

  it("nobody can receive the alert: the report is settled, and a second call sends nothing", async () => {
    mocks.sendAdminAlert.mockResolvedValue(NOBODY_OPTED_IN);

    await report();
    await report();

    expect(sent()).toEqual(ONCE_EACH);
    expect(await supersededRefundReportSettled(OPERATION_ID)).toBe(true);
  });

  it("MUTATION: a crash between the alert's claim and its send - a later run takes the dead claim over and sends it once", async () => {
    // A call claimed the alert longer ago than any live attempt runs, then died: no `reported`.
    mocks.cooldowns.set(KEYS.alert, new Date(Date.now() - PAYMENT_RECOVERY_STALE_PROCESSING_MS - 1));

    await report();

    expect(sent()).toEqual(ONCE_EACH);
    expect(await supersededRefundReportSettled(OPERATION_ID)).toBe(true);
  });

  it("MUTATION: an alert claim a sibling took inside the stale threshold is left to it - nothing sent, it throws so the row waits", async () => {
    mocks.cooldowns.set(KEYS.alert, new Date(Date.now() - PAYMENT_RECOVERY_STALE_PROCESSING_MS + 60_000));

    await expect(report()).rejects.toBeInstanceOf(SupersededRefundReportNotSettledError);
    expect(mocks.sendAdminAlert).not.toHaveBeenCalled();
    expect(mocks.cooldowns.has(KEYS.alert)).toBe(true);
  });

  it("MUTATION: an alert claim held with the report marked sent is not taken over, however old", async () => {
    mocks.cooldowns.set(KEYS.alert, new Date(Date.now() - PAYMENT_RECOVERY_STALE_PROCESSING_MS - 1));
    mocks.cooldowns.set(KEYS.reported, new Date());

    await report();

    expect(sent()).toEqual({ memberEmails: 0, adminAlerts: 0, auditRows: 0, events: 0 });
  });
});

/*
  #4690 - THE NEXT CLAIM'S HALF. A row whose refund is made reads nothing
  outstanding. It announces the refund only when it is provably the row's own -
  on Stripe with exactly the metadata this row's runner sends, and recorded in
  the ledger as made - and only when nobody announced it yet.
*/
describe("reportUnannouncedSupersededPaymentRefund", () => {
  const operation = {
    id: OPERATION_ID,
    type: "REFUND_SUPERSEDED_PAYMENT" as const,
    idempotencyKey: "payment_recovery_refund_superseded_txn_1_pi_superseded",
    stripeKeyPrefix: null,
    bookingId: "booking_1",
    paymentId: "payment_1",
    paymentIntentId: "pi_superseded",
  };
  const ownMetadata = { bookingId: "booking_1", reason: SUPERSEDED_PAYMENT_REFUND_METADATA_REASON };
  const stripeRefund = (id: string, metadata: Record<string, string>, status = "succeeded") =>
    ({ id, amount: 6500, status, payment_intent: "pi_superseded", metadata });
  const ledgerRow = (stripeRefundId: string, status = "succeeded") => ({ stripeRefundId, amountCents: 6500, status });

  beforeEach(() => {
    mocks.findBooking.mockResolvedValue(
      bookingRow({ additionalAmountCents: 0, additionalPaymentStatus: null }),
    );
  });

  it("MUTATION: own refund identified - announced once, for what the ledger recorded", async () => {
    mocks.listRefunds.mockResolvedValue([stripeRefund("re_own", ownMetadata)]);
    mocks.findRefunds.mockResolvedValue([ledgerRow("re_own")]);

    await reportUnannouncedSupersededPaymentRefund(operation, CLUB_FORMAT_TEST);
    await reportUnannouncedSupersededPaymentRefund(operation, CLUB_FORMAT_TEST);

    expect(mocks.listRefunds).toHaveBeenCalledWith("pi_superseded", { timeoutMs: 10_000, singlePage: true });
    expect(mocks.findRefunds).toHaveBeenCalledWith(expect.objectContaining({
      where: { paymentId: "payment_1", stripeRefundId: { in: ["re_own"] } },
    }));
    expect(sent()).toEqual(ONCE_EACH);
    expect(mocks.sendAdminAlert).toHaveBeenCalledWith(expect.objectContaining({ refundedAmountCents: 6500 }), CLUB_FORMAT_TEST);
    // The second call read the marker and asked Stripe nothing.
    expect(mocks.listRefunds).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another door's refund (a cancellation's metadata)", { bookingId: "booking_1", reason: "booking_cancellation" }],
    ["a Stripe dashboard refund (no metadata)", {}],
    ["the row's metadata plus a key no runner sends", { ...ownMetadata, source: "dashboard" }],
  ])("MUTATION: not identified - %s brings nothing outstanding but is never announced", async (_label, metadata) => {
    mocks.listRefunds.mockResolvedValue([stripeRefund("re_other", metadata)]);
    mocks.findRefunds.mockResolvedValue([ledgerRow("re_other")]);

    await reportUnannouncedSupersededPaymentRefund(operation, CLUB_FORMAT_TEST);

    expect(sent()).toEqual({ memberEmails: 0, adminAlerts: 0, auditRows: 0, events: 0 });
    expect(mocks.findRefunds).not.toHaveBeenCalled();
  });

  it("MUTATION: the row's own refund Stripe refused is not money back - nothing announced", async () => {
    mocks.listRefunds.mockResolvedValue([stripeRefund("re_own", ownMetadata, "failed")]);

    await reportUnannouncedSupersededPaymentRefund(operation, CLUB_FORMAT_TEST);

    expect(sent()).toEqual({ memberEmails: 0, adminAlerts: 0, auditRows: 0, events: 0 });
  });

  it.each([
    ["not in the ledger", []],
    ["in the ledger as failed since", [ledgerRow("re_own", "failed")]],
  ])("MUTATION: the row's own refund %s - not certain, so nothing is announced", async (_label, rows) => {
    mocks.listRefunds.mockResolvedValue([stripeRefund("re_own", ownMetadata)]);
    mocks.findRefunds.mockResolvedValue(rows);

    await reportUnannouncedSupersededPaymentRefund(operation, CLUB_FORMAT_TEST);

    expect(sent()).toEqual({ memberEmails: 0, adminAlerts: 0, auditRows: 0, events: 0 });
    expect(await supersededRefundReportSettled(OPERATION_ID)).toBe(false);
  });

  it("MUTATION: report already sent by the attempt that made the refund - nothing sent, and Stripe is not asked", async () => {
    await report();
    mocks.listRefunds.mockResolvedValue([stripeRefund("re_own", ownMetadata)]);
    mocks.findRefunds.mockResolvedValue([ledgerRow("re_own")]);

    await reportUnannouncedSupersededPaymentRefund(operation, CLUB_FORMAT_TEST);

    expect(sent()).toEqual(ONCE_EACH);
    expect(mocks.listRefunds).not.toHaveBeenCalled();
  });
});

describe("the event never masquerades as a cancellation settlement", () => {
  it("is recognised by its discriminator, and an ordinary refund is not", () => {
    expect(
      isSupersededAdditionalRefundEvent({
        type: BookingEventType.REFUNDED,
        snapshot: { kind: SUPERSEDED_ADDITIONAL_REFUND_EVENT_KIND },
      }),
    ).toBe(true);
    expect(
      isSupersededAdditionalRefundEvent({
        type: BookingEventType.REFUNDED,
        snapshot: { policySummary: "50% within 7 days" },
      }),
    ).toBe(false);
    expect(
      isSupersededAdditionalRefundEvent({
        type: BookingEventType.CANCELLED,
        snapshot: { kind: SUPERSEDED_ADDITIONAL_REFUND_EVENT_KIND },
      }),
    ).toBe(false);
  });
});
