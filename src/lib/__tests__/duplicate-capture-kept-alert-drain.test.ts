import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4285 review (`INV-PAY-043`): the payments cron's drain for an owed
 * `new-capture` alert. The real-PostgreSQL proof (`completed-redelivery.realdb.test.ts`)
 * drives it end to end; this pins each branch: what it sends, what it clears
 * silently, what it leaves owed, and that it reads "another payment holding
 * money" through the guard's own telling reading (`readOtherSettledCaptureWhere`'s
 * `readTellingWhere`, run for real here over a fake ledger), never a copy of its own.
 */
type Row = { id: string; source: string; status: string; stripePaymentIntentId: string | null };
type Operation = {
  type: string;
  paymentId: string;
  paymentTransactionId: string | null;
  paymentIntentId: string;
  allocationPlan: unknown;
  status: string;
  attempts: number;
  nextRetryAt: Date | null;
};
type InFlightArm = { status: string; attempts?: { lt: number }; nextRetryAt?: { not: null } };
/** A booking's recovery row as the cancel's card refund reading selects it (`readCancelledCardRefund`). */
type RecoveryRow = {
  id: string;
  idempotencyKey: string;
  paymentId: string;
  amountCents: number;
  allocationPlan: unknown;
  status: string;
  attempts: number;
  nextRetryAt: Date | null;
  succeededAt: Date | null;
};

const mocks = vi.hoisted(() => ({
  listOwedAlertKeys: vi.fn(),
  noteOwedAlertAttempt: vi.fn(),
  settleOwedAlert: vi.fn(),
  bookingFindUnique: vi.fn(),
  transactionFindUnique: vi.fn(),
  transaction: vi.fn(),
  bookingEvents: [] as Array<{ type: string; snapshot: unknown }>,
  operations: [] as Operation[],
  /**
   * The booking's recovery rows by key: the member cancel's card refund
   * (`booking_cancel_refund_recovery_<booking>`), the rows owing a refund Stripe
   * failed later (`card_refund_failed_later_<refund>`), an organiser child's
   * debt (`organiser_child_refund_cancel_<settlement>_<child>`).
   */
  recoveryRows: [] as RecoveryRow[],
  recoveryReads: vi.fn(),
  /** A "Paid another way" close record on a closed row (`closeKeysOf`), or null. */
  closeRecord: null as { amountCents: number | null; raisedAmountCents: number | null } | null,
  /** #4285 review 9: close records by recovery row id, where only some rows were closed. */
  closeRecordFor: null as Record<string, { amountCents: number | null; raisedAmountCents: number | null }> | null,
  /** A card refund shortfall's hand-back tasks (`cancel-card-shortfall:`). */
  shortfallTasks: [] as Array<{ kind: string; occurrenceKey: string; status: string }>,
  /** The group's combined card settlement, for an organiser-settled child. */
  settlement: null as { id: string; stripePaymentIntentId: string; amountCents: number; status: string; refundPlan: null } | null,
  /** The card refunds recorded against the capture (`PaymentRefund`), summed. */
  cardRefundedCents: 0,
  cardRefundWhere: vi.fn(),
  alert: vi.fn(),
  clubFormatValues: vi.fn(),
  liveSuperseded: vi.fn(),
  owningCaptures: vi.fn(),
  duplicateRefundIntentIds: vi.fn(),
  /** The duplicate-capture refunds still holding their captures (the telling reading's half, #4285 review). */
  duplicateRefundsHolding: vi.fn(),
  executeRaw: vi.fn(),
  rows: [] as Row[],
}));

vi.mock("@/lib/alert-cooldown", () => ({
  listOwedAlertKeys: (...args: unknown[]) => mocks.listOwedAlertKeys(...args),
  noteOwedAlertAttempt: (...args: unknown[]) => mocks.noteOwedAlertAttempt(...args),
  settleOwedAlert: (...args: unknown[]) => mocks.settleOwedAlert(...args),
  releaseAlertCooldown: vi.fn(),
}));

/** The guard's `otherSettledCaptureWhere` shape, interpreted (STRIPE arm with its exclusions, non-STRIPE arm). */
function matchesOtherSettled(row: Row, where: {
  paymentId: string;
  status: { in: string[] };
  OR: Array<{ source?: string | { not: string }; stripePaymentIntentId?: { not: string; notIn: string[] } }>;
}) {
  if (!where.status.in.includes(row.status)) return false;
  return where.OR.some((arm) => {
    if (typeof arm.source === "string" && row.source !== arm.source) return false;
    if (arm.source && typeof arm.source === "object" && row.source === arm.source.not) return false;
    if (arm.stripePaymentIntentId) {
      if (row.stripePaymentIntentId === null) return false;
      if (row.stripePaymentIntentId === arm.stripePaymentIntentId.not) return false;
      if (arm.stripePaymentIntentId.notIn.includes(row.stripePaymentIntentId)) return false;
    }
    return true;
  });
}

/** `PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE`'s arms, interpreted - or every row when the read asks for none. */
function matchesInFlight(operation: Operation, where: { OR?: InFlightArm[] }) {
  if (!where.OR) return true;
  return where.OR.some(
    (arm) =>
      operation.status === arm.status &&
      (arm.attempts === undefined || operation.attempts < arm.attempts.lt) &&
      (arm.nextRetryAt === undefined || operation.nextRetryAt !== null),
  );
}

/** A `LIKE` prefix as `exactPrefix` escapes it, read back. */
const unescapeLike = (pattern: string) => pattern.replace(/\\(.)/g, "$1");

/** The booking-keyed recovery reads, interpreted: an exact key, a key prefix, or either (`bookingCancelCardRefundRecoveryWhere`). */
function matchesRecoveryKey(key: string, where: { idempotencyKey?: string | { startsWith: string }; OR?: Array<{ idempotencyKey: string | { startsWith: string } }> }): boolean {
  const one = (arm: string | { startsWith: string }) => (typeof arm === "string" ? key === arm : key.startsWith(unescapeLike(arm.startsWith)));
  if (where.OR) return where.OR.some((arm) => one(arm.idempotencyKey));
  return where.idempotencyKey !== undefined && one(where.idempotencyKey);
}

vi.mock("@/lib/prisma", () => {
  // Every read the drain makes runs on the snapshot's transaction: the app's client offers it nothing else.
  const client = {
    $executeRaw: (...args: unknown[]) => mocks.executeRaw(...args),
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
    bookingEvent: { findMany: async () => mocks.bookingEvents },
    paymentRefund: {
      aggregate: async ({ where }: { where: unknown }) => {
        mocks.cardRefundWhere(where);
        return { _sum: { amountCents: mocks.cardRefundedCents || null } };
      },
    },
    paymentTransaction: {
      findUnique: (...args: unknown[]) => mocks.transactionFindUnique(...args),
      findMany: async () => [],
      findFirst: async ({ where }: { where: Parameters<typeof matchesOtherSettled>[1] }) =>
        mocks.rows.find((row) => matchesOtherSettled(row, where)) ?? null,
    },
    // F7: the read's own `type`, `paymentId` and in-flight filters are interpreted, so a dead row is read as the drain asks.
    paymentRecoveryOperation: {
      findMany: async ({ where }: { where: { paymentId?: string; bookingId?: string; type?: { in: string[] }; OR?: unknown[]; idempotencyKey?: { startsWith: string } } }) => {
        if (where.bookingId !== undefined) {
          mocks.recoveryReads(where);
          return mocks.recoveryRows.filter((row) => matchesRecoveryKey(row.idempotencyKey, where as Parameters<typeof matchesRecoveryKey>[1]));
        }
        return mocks.operations.filter(
          (operation) =>
            operation.paymentId === where.paymentId && (where.type?.in ?? []).includes(operation.type) && matchesInFlight(operation, where as { OR?: InFlightArm[] }),
        );
      },
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) => {
        mocks.recoveryReads(where);
        return mocks.recoveryRows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null;
      },
    },
    manualRefundTask: {
      // A close record per row where a case keys them (`closeKeysOf` carries the row's id), else the one for every closed row.
      findFirst: async ({ where }: { where: { occurrenceKey: { in: string[] } } }) => {
        if (!mocks.closeRecordFor) return mocks.closeRecord;
        const entry = Object.entries(mocks.closeRecordFor).find(([id]) => where.occurrenceKey.in.some((key) => key.includes(id)));
        return entry?.[1] ?? null;
      },
      findMany: async ({ where }: { where: { occurrenceKey: { startsWith: string } } }) =>
        mocks.shortfallTasks.filter((task) => task.occurrenceKey.startsWith(where.occurrenceKey.startsWith)),
    },
    payment: { findMany: async () => [] },
    groupBookingSettlement: { findFirst: async () => mocks.settlement },
  };
  return {
    prisma: {
      // F3: one read-only snapshot, run against the fake ledger.
      $transaction: async (fn: (tx: typeof client) => unknown, options: unknown) => {
        mocks.transaction(options);
        return fn(client);
      },
    },
  };
});
vi.mock("@/lib/superseded-intent-ownership", () => ({
  listLiveSupersededIntentIds: (...args: unknown[]) => mocks.liveSuperseded(...args),
  // #4300: the guard reads the Xero reading through `superseded-capture-ownership.ts`, over this seam.
  readSupersededCaptureHolds: async (...args: unknown[]) => ({
    holdsForMember: new Set<string>(await mocks.owningCaptures(...args)),
    owedBackAtAll: new Set<string>(),
    refundInFlight: new Set<string>(),
    refundStopped: new Set<string>(),
  }),
  listDuplicateRefundIntentIdsOwningCaptures: (...args: unknown[]) => mocks.duplicateRefundsHolding(...args),
  findLiveSupersededIntentOperation: vi.fn(),
}));
vi.mock("@/lib/duplicate-capture-ownership", () => ({
  listDuplicateCaptureRefundIntentIds: (...args: unknown[]) => mocks.duplicateRefundIntentIds(...args),
}));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: () => mocks.clubFormatValues() }));
vi.mock("@/lib/duplicate-capture-guard", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/duplicate-capture-guard")),
  alertCaptureKeptWithoutRecordedSettler: (...args: unknown[]) => mocks.alert(...args),
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { drainOwedNewCaptureAlerts, NEW_CAPTURE_ALERT_DRAIN_AFTER_MS } from "@/lib/duplicate-capture-kept-alert-drain";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { formatCents } from "@/lib/utils";

const KEY = "duplicate-capture-new-capture-owed:booking-1:pi_new";
const NOW = new Date("2026-07-01T00:00:00.000Z");
const FORMAT = CLUB_FORMAT_TEST;

/** A card refund row, in flight unless the case says otherwise. */
function refundOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    type: "REFUND_BOOKING_MODIFICATION",
    paymentId: "payment-1",
    paymentTransactionId: null,
    paymentIntentId: "pi_primary",
    allocationPlan: null,
    status: "PENDING",
    attempts: 0,
    nextRetryAt: NOW,
    ...overrides,
  };
}

/** Dead: FAILED with no retry left - the runner never sends it again. */
const DEAD = { status: "FAILED", attempts: 5, nextRetryAt: null } as const;

function prime({
  status = "COMPLETED",
  captureStatus = "SUCCEEDED",
  refundedAmountCents = 0,
  cardRefundedCents = refundedAmountCents,
  organiserChild = false,
}: { status?: string; captureStatus?: string; refundedAmountCents?: number; cardRefundedCents?: number; organiserChild?: boolean } = {}) {
  mocks.cardRefundedCents = cardRefundedCents;
  mocks.listOwedAlertKeys.mockResolvedValue([KEY]);
  mocks.bookingFindUnique.mockResolvedValue({
    id: "booking-1",
    status,
    checkIn: new Date("2026-06-20"),
    checkOut: new Date("2026-06-22"),
    memberId: "member-1",
    member: { firstName: "Alice", lastName: "Example", email: "alice@example.com" },
    organisation: null,
    // A joiner's booking the group organiser paid for by card (`paidByOrganiserCard`), or the member's own.
    organiserSettled: organiserChild,
    parentBookingId: organiserChild ? "booking-organiser" : null,
    payment: { source: "STRIPE" },
  });
  mocks.transactionFindUnique.mockResolvedValue({ id: "txn-new", paymentId: "payment-1", status: captureStatus, amountCents: 20000, refundedAmountCents });
  mocks.rows = [{ id: "txn-new", source: "STRIPE", status: captureStatus, stripePaymentIntentId: "pi_new" }];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
  mocks.operations = [];
  mocks.bookingEvents = [];
  mocks.clubFormatValues.mockResolvedValue(FORMAT);
  mocks.alert.mockResolvedValue("sent");
  mocks.liveSuperseded.mockResolvedValue([]);
  mocks.owningCaptures.mockResolvedValue([]);
  mocks.duplicateRefundIntentIds.mockResolvedValue([]);
  // By default every duplicate-capture refund still holds its capture, as one at any status does until it failed later.
  mocks.duplicateRefundsHolding.mockImplementation(() => mocks.duplicateRefundIntentIds());
  mocks.recoveryRows = [];
  mocks.closeRecord = null;
  mocks.closeRecordFor = null;
  mocks.shortfallTasks = [];
  mocks.settlement = null;
});

describe("the owed new-capture alert's drain (#4285 review)", () => {
  it("reads only due markers under its own prefix, an hour after they were owed, and reads nothing else when none is due", async () => {
    mocks.listOwedAlertKeys.mockResolvedValue([]);

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 0, sent: 0 });
    expect(mocks.listOwedAlertKeys).toHaveBeenCalledWith({ prefix: "duplicate-capture-new-capture-owed:", now: NOW, retryAfterMs: NEW_CAPTURE_ALERT_DRAIN_AFTER_MS });
    expect(NEW_CAPTURE_ALERT_DRAIN_AFTER_MS).toBe(60 * 60 * 1000);
    expect(mocks.clubFormatValues).not.toHaveBeenCalled();
  });

  it("sends the kept-capture alert for a capture still holding money on a paid booking, as the settle would", async () => {
    prime();

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1 });
    expect(mocks.alert).toHaveBeenCalledWith({
      booking: expect.objectContaining({ id: "booking-1" }),
      memberName: "Alice Example",
      paymentIntentId: "pi_new",
      amountCents: 20000,
      otherPaymentIntentId: null,
      otherHoldsMoney: false,
      reason: "new-capture",
      format: FORMAT,
    });
    // The alert clears the marker itself once delivered.
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
    // F3: judged in one read-only REPEATABLE READ snapshot, the transaction made read-only before any read.
    expect(mocks.transaction).toHaveBeenCalledWith({ isolationLevel: "RepeatableRead" });
    expect(String((mocks.executeRaw.mock.calls[0] as unknown[])[0])).toContain("SET TRANSACTION READ ONLY");
    expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.bookingFindUnique.mock.invocationCallOrder[0]!);
  });

  it("F7: shows what the card still holds after card refunds recorded against it, whatever the reason", async () => {
    prime({ captureStatus: "PARTIALLY_REFUNDED", refundedAmountCents: 4000 });

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture", amountCents: 16000 }));
    // The capture's own card refunds, by row or intent, that Stripe has not refused.
    expect(mocks.cardRefundWhere).toHaveBeenCalledWith({
      OR: [{ paymentTransactionId: "txn-new" }, { stripePaymentIntentId: "pi_new" }],
      status: { notIn: ["failed", "canceled"] },
    });
  });

  it.each([
    ["in full", { captureStatus: "REFUNDED", refundedAmountCents: 20000, cardRefundedCents: 0 }, 20000],
    ["in part", { captureStatus: "PARTIALLY_REFUNDED", refundedAmountCents: 10000, cardRefundedCents: 0 }, 20000],
  ])("F2: a refund as account credit marks the capture refunded (%s) but leaves the money on the card: still told, with what the card holds", async (_label, state, held) => {
    prime({ status: "CANCELLED", ...state });

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1 });
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture-closed", amountCents: held }));
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
  });

  it.each([
    ["refunded to the card since", { captureStatus: "REFUNDED", refundedAmountCents: 20000 }],
    ["never captured", { captureStatus: "PENDING" }],
  ])("clears a marker with nothing to tell (%s) without an email", async (_label, state) => {
    prime(state);

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).toHaveBeenCalledWith({ key: KEY });
  });

  it("clears a marker whose booking is gone without an email", async () => {
    prime();
    mocks.bookingFindUnique.mockResolvedValue(null);

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).toHaveBeenCalledWith({ key: KEY });
  });

  it.each([
    ["not yet planned (a cancel's refund plans newest first when it runs)", refundOperation()],
    ["planned with a slice of this capture", refundOperation({ allocationPlan: [{ paymentTransactionId: "txn-new", amountCents: 5000 }] })],
    ["on this capture's own row", refundOperation({ paymentTransactionId: "txn-new", allocationPlan: [{ paymentTransactionId: "txn-other", amountCents: 5000 }] })],
    ["on this capture's intent", refundOperation({ paymentIntentId: "pi_new", allocationPlan: [{ paymentTransactionId: "txn-other", amountCents: 5000 }] })],
    ["a superseded refund not yet planned", refundOperation({ type: "REFUND_SUPERSEDED_PAYMENT" })],
  ])("F2/F4: waits, neither sending nor clearing, while a card refund that may take from this capture is in flight (%s)", async (_label, operation) => {
    prime({ status: "CANCELLED" });
    mocks.operations.push(operation);

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
    expect(mocks.noteOwedAlertAttempt).toHaveBeenCalledWith({ key: KEY, now: NOW });
  });

  it.each([
    ["an additional-payment charge (#4272's review charge)", refundOperation({ type: "CREATE_ADDITIONAL_PAYMENT_INTENT" })],
    ["a cancel of an intent", refundOperation({ type: "CANCEL_PAYMENT_INTENT" })],
    ["a card refund planned on another capture only", refundOperation({ allocationPlan: [{ paymentTransactionId: "txn-other", amountCents: 5000 }] })],
    ["a card refund on another payment", refundOperation({ paymentId: "payment-2" })],
  ])("F4: an operation that cannot take from this capture never holds the alert back (%s)", async (_label, operation) => {
    prime();
    mocks.operations.push(operation);

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1 });
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture" }));
    expect(mocks.noteOwedAlertAttempt).not.toHaveBeenCalled();
  });

  it("F2/F3: a booking cancelled since is told as closed, with what the capture still holds after the cancel's refund", async () => {
    prime({ status: "CANCELLED", captureStatus: "PARTIALLY_REFUNDED", refundedAmountCents: 15000 });

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1 });
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture-closed", paymentIntentId: "pi_new", amountCents: 5000, cancellationRefund: null }));
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
  });

  const money = (cents: number) => formatCents(cents, CLUB_FORMAT_TEST);

  it.each([
    ["credit", { refundMethod: "credit", settledAmountCents: 10000 }, { method: "credit", amount: money(10000) }],
    ["by hand", { refundMethod: "manual", settledAmountCents: 10000 }, { method: "manual", amount: money(10000) }],
    ["no refund due", { refundMethod: "card", settledAmountCents: 0 }, { method: "none" }],
  ])("F2: a closed alert names the cancellation's recorded refund (%s): a credit or by-hand refund never touched the capture", async (_label, recorded, expected) => {
    // A $200 credit-paid booking cancelled at a 50% tier: the stray capture still holds all $200.
    prime({ status: "CANCELLED" });
    mocks.bookingEvents = [
      { type: "CANCELLED", snapshot: { autoCancelledPastCheckIn: true } },
      { type: "CANCELLED", snapshot: { ...recorded, refundPercentage: 50 } },
    ];

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture-closed", amountCents: 20000, cancellationRefund: expected }));
  });

  const CANCEL_KEY = "booking_cancel_refund_recovery_booking-1";
  /** A booking recovery row: the member cancel's card refund unless the case says otherwise. */
  const recoveryRow = (overrides: Partial<RecoveryRow> = {}): RecoveryRow => ({
    id: "op-cancel",
    idempotencyKey: CANCEL_KEY,
    paymentId: "payment-1",
    amountCents: 10000,
    allocationPlan: [{ paymentTransactionId: "txn-new", amountCents: 10000 }],
    status: "SUCCEEDED",
    attempts: 1,
    nextRetryAt: null,
    succeededAt: new Date("2026-06-25T00:00:00.000Z"),
    ...overrides,
  });
  /** A card refund the cancel's row made that Stripe failed later, owed again on a row of its own (#4104, #4166). */
  const failedLaterRow = (overrides: Partial<RecoveryRow> = {}): RecoveryRow =>
    recoveryRow({
      id: "op-failed-later",
      idempotencyKey: "card_refund_failed_later_re_1",
      allocationPlan: [{ paymentTransactionId: "txn-new", amountCents: 10000, madeByOperationId: "op-cancel" }],
      status: "PENDING",
      attempts: 0,
      nextRetryAt: NOW,
      succeededAt: null,
      ...overrides,
    });
  const CARD_DECISION = { type: "CANCELLED", snapshot: { refundMethod: "card", refundPercentage: 50, settledAmountCents: 10000 } };
  const cardNote = (card: unknown) => ({ method: "card", card, byBank: null, toCheck: null });

  it.each([
    ["its row SUCCEEDED: sent", [recoveryRow()], null, "sent"],
    ["its row dead: planned, never sent", [recoveryRow({ ...DEAD, succeededAt: null })], null, "not-sent"],
    ["its row still on its way", [recoveryRow({ status: "FAILED", attempts: 2, nextRetryAt: NOW, succeededAt: null })], null, "not-sent"],
    ["closed as paid another way", [recoveryRow()], { amountCents: 10000, raisedAmountCents: 10000 }, "paid-another-way"],
    ["no row (a cancel from before it existed)", [], null, "unrecorded"],
    // #4285 review 8 F1: the row SUCCEEDED, but Stripe failed the refund later and it is owed again.
    ["its refund failed later, asked for again", [recoveryRow(), failedLaterRow()], null, "not-sent"],
    ["its refund failed later, dead for the treasurer", [recoveryRow(), failedLaterRow(DEAD)], null, "not-sent"],
    ["its refund failed later and was sent again", [recoveryRow(), failedLaterRow({ status: "SUCCEEDED", attempts: 1, nextRetryAt: null, succeededAt: NOW })], null, "sent"],
    ["another booking's failed-later row", [recoveryRow(), failedLaterRow({ allocationPlan: [{ paymentTransactionId: "txn-x", amountCents: 10000, madeByOperationId: "op-elsewhere" }] })], null, "sent"],
  ])("#4285 review 7 F1, review 8 F1: a card cancel's refund is said as its rows stand (%s), never as planned", async (_label, rows, close, standing) => {
    prime({ status: "CANCELLED" });
    mocks.recoveryRows = rows;
    mocks.closeRecord = close;
    mocks.bookingEvents = [CARD_DECISION];

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new-capture-closed", cancellationRefund: cardNote({ amount: money(10000), standing }) }),
    );
    // The booking page's reading (`readCancelledCardRefund`): the member's cancel row and a capacity race's, by this booking.
    expect(mocks.recoveryReads).toHaveBeenCalledWith(expect.objectContaining({ bookingId: "booking-1", OR: expect.arrayContaining([{ idempotencyKey: CANCEL_KEY }]) }));
  });

  it("#4285 review 9 F1: a part close as paid another way names what it left unpaid", async () => {
    prime({ status: "CANCELLED" });
    mocks.recoveryRows = [recoveryRow()];
    // The officer paid back $60 of the $100 the row still owed when it closed.
    mocks.closeRecord = { amountCents: 6000, raisedAmountCents: 10000 };
    mocks.bookingEvents = [CARD_DECISION];

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({ cancellationRefund: cardNote({ amount: money(10000), standing: "paid-another-way", unpaid: money(4000) }) }),
    );
  });

  it("#4285 review 9 F2: a refund made, of which a part failed later and was closed as paid another way, names that part (and what it left unpaid), not the whole", async () => {
    prime({ status: "CANCELLED" });
    const madeAgainClosed = { status: "SUCCEEDED", attempts: 1, nextRetryAt: null, succeededAt: NOW } as const;
    mocks.recoveryRows = [
      recoveryRow(),
      failedLaterRow({ ...madeAgainClosed, amountCents: 3000, allocationPlan: [{ paymentTransactionId: "txn-new", amountCents: 3000, madeByOperationId: "op-cancel" }] }),
    ];
    // Only the failed-later row was closed: $20 of its $30 paid back.
    mocks.closeRecordFor = { "op-failed-later": { amountCents: 2000, raisedAmountCents: 3000 } };
    mocks.bookingEvents = [CARD_DECISION];

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        cancellationRefund: cardNote({ amount: money(10000), standing: "sent", closedAnotherWay: money(3000), unpaid: money(1000) }),
      }),
    );
  });

  it("#4285 review 7 F1/F7: a dead card refund planned on this very capture neither holds the alert back nor is said to have refunded it", async () => {
    prime({ status: "CANCELLED" });
    const dead = refundOperation({ ...DEAD, paymentIntentId: "pi_new", allocationPlan: [{ paymentTransactionId: "txn-new", amountCents: 10000 }] });
    mocks.operations.push(dead);
    mocks.recoveryRows = [recoveryRow({ ...DEAD, succeededAt: null })];
    mocks.bookingEvents = [CARD_DECISION];

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1 });
    expect(mocks.noteOwedAlertAttempt).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new-capture-closed", amountCents: 20000, cancellationRefund: cardNote({ amount: money(10000), standing: "not-sent" }) }),
    );
  });

  const ORGANISER_KEY = "organiser_child_refund_cancel_settlement-1_booking-1";

  it.each([
    ["its debt SUCCEEDED", [recoveryRow({ id: "op-debt", idempotencyKey: ORGANISER_KEY, amountCents: 8000 })], "sent", 8000],
    ["its debt reopened after Stripe failed the refund later", [recoveryRow({ id: "op-debt", idempotencyKey: ORGANISER_KEY, amountCents: 8000, status: "PENDING", attempts: 0, nextRetryAt: NOW, succeededAt: null })], "not-sent", 8000],
    ["its debt dead", [recoveryRow({ id: "op-debt", idempotencyKey: ORGANISER_KEY, amountCents: 8000, ...DEAD, succeededAt: null })], "not-sent", 8000],
    ["no debt recorded", [], "unrecorded", 10000],
    // A member-cancel row under the child's own key is not the organiser's refund.
    ["only a member-cancel row", [recoveryRow()], "unrecorded", 10000],
  ])("#4285 review 8 F2: an organiser-card child's cancel is said as a refund to the group organiser's card, as its debt stands (%s)", async (_label, rows, standing, cents) => {
    prime({ status: "CANCELLED", organiserChild: true });
    mocks.settlement = { id: "settlement-1", stripePaymentIntentId: "pi_group", amountCents: 40000, status: "PAID", refundPlan: null };
    mocks.recoveryRows = rows;
    mocks.bookingEvents = [CARD_DECISION];

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new-capture-closed", cancellationRefund: cardNote({ amount: money(cents), standing, organiserCard: true }) }),
    );
    expect(mocks.recoveryReads).toHaveBeenCalledWith({ idempotencyKey: ORGANISER_KEY });
    // Never the member's own card refund reading.
    expect(mocks.recoveryReads).not.toHaveBeenCalledWith(expect.objectContaining({ OR: expect.anything() }));
  });

  it("#4285 review 8 F2: a joiner cancelling behind the group's cancellation (its own refund $0) names the group's debt to the organiser's card", async () => {
    prime({ status: "CANCELLED", organiserChild: true });
    mocks.settlement = { id: "settlement-1", stripePaymentIntentId: "pi_group", amountCents: 40000, status: "PAID", refundPlan: null };
    mocks.recoveryRows = [recoveryRow({ id: "op-debt", idempotencyKey: ORGANISER_KEY, amountCents: 8000 })];
    mocks.bookingEvents = [{ type: "CANCELLED", snapshot: { refundMethod: "card", refundPercentage: 0, settledAmountCents: 0 } }];

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({ cancellationRefund: cardNote({ amount: money(8000), standing: "sent", organiserCard: true }) }),
    );
  });

  it.each([
    ["the card carried part", { cardCents: 6000, bankCents: 3000, checkCents: 1000 }, { amount: money(6000), standing: "sent" }],
    ["the card carried nothing", { cardCents: 0, bankCents: 7000, checkCents: 3000 }, null],
  ])("#4285 review 7 F1: a card refund shortfall says the parts owed by bank transfer and for the club to check beside the card's (%s)", async (_label, cardShortfall, card) => {
    prime({ status: "CANCELLED" });
    mocks.recoveryRows = [recoveryRow()];
    mocks.bookingEvents = [{ type: "CANCELLED", snapshot: { refundMethod: "card", refundPercentage: 50, settledAmountCents: 10000, cardShortfall } }];

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        cancellationRefund: {
          method: "card",
          card,
          byBank: { amount: money(cardShortfall.bankCents), standing: "owed" },
          toCheck: { amount: money(cardShortfall.checkCents), standing: "owed" },
        },
      }),
    );
    // No card part, no card refund row to read.
    expect(mocks.recoveryReads.mock.calls.some(([where]) => "OR" in (where as object))).toBe(card !== null);
  });

  it.each([
    ["paid back", "COMPLETED", "COMPLETED", { bank: "paid", check: "paid" }],
    ["dismissed", "DISMISSED", "DISMISSED", { bank: "closed", check: "closed" }],
    ["one paid, one still open", "COMPLETED", "OPEN", { bank: "paid", check: "owed" }],
  ])("#4285 review 8 F3: a shortfall part is said as its hand-back task stands, never owed once %s", async (_label, bankStatus, checkStatus, said) => {
    prime({ status: "CANCELLED" });
    mocks.recoveryRows = [recoveryRow()];
    mocks.shortfallTasks = [
      { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "cancel-card-shortfall:booking-1", status: bankStatus },
      { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: "cancel-card-shortfall:booking-1:check", status: checkStatus },
    ];
    mocks.bookingEvents = [{ type: "CANCELLED", snapshot: { refundMethod: "card", refundPercentage: 50, settledAmountCents: 10000, cardShortfall: { cardCents: 6000, bankCents: 3000, checkCents: 1000 } } }];

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({
        cancellationRefund: {
          method: "card",
          card: { amount: money(6000), standing: "sent" },
          byBank: { amount: money(3000), standing: said.bank },
          toCheck: { amount: money(1000), standing: said.check },
        },
      }),
    );
  });

  it("a paid booking's alert never reads or names a cancellation refund", async () => {
    prime();
    mocks.bookingEvents = [{ type: "CANCELLED", snapshot: { refundMethod: "credit", refundPercentage: 50, settledAmountCents: 10000 } }];

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert.mock.calls[0]![0]).not.toHaveProperty("cancellationRefund");
  });

  it.each([
    ["the superseded-payment machinery", () => mocks.owningCaptures.mockResolvedValue(["pi_new"])],
    ["a duplicate-capture refund", () => mocks.duplicateRefundIntentIds.mockResolvedValue(["pi_new"])],
  ])("clears silently a capture %s owns: that machinery refunds it and tells the admins itself", async (_label, arrange) => {
    prime();
    arrange();

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).toHaveBeenCalledWith({ key: KEY });
  });

  it("F1/F3: another payment the guard counts as holding money is told as a later payment, naming it", async () => {
    prime();
    mocks.rows.push({ id: "txn-other", source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: "pi_other" });

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new-capture-later-payment", otherPaymentIntentId: "pi_other", otherHoldsMoney: true }),
    );
  });

  it("a bank payment holding money counts as the other payment too (any source, as the guard reads it)", async () => {
    prime();
    mocks.rows.push({ id: "txn-bank", source: "INTERNET_BANKING", status: "SUCCEEDED", stripePaymentIntentId: null });

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture-later-payment", otherPaymentIntentId: null, otherHoldsMoney: true }));
  });

  it("F1: a capture behind a dead cancel (handed to nobody) still holds money: told as a later payment, naming it", async () => {
    prime();
    mocks.rows.push({ id: "txn-dead-cancel", source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: "pi_dead_cancel" });
    // The guard's refund-safety reading counts the exhausted cancel as live; the Xero (telling) reading does not.
    mocks.liveSuperseded.mockResolvedValue(["pi_dead_cancel"]);

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new-capture-later-payment", otherPaymentIntentId: "pi_dead_cancel", otherHoldsMoney: true }),
    );
    expect(mocks.alert).not.toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture" }));
  });

  it.each([
    ["owed back (#4227)", () => mocks.owningCaptures.mockResolvedValue(["pi_superseded"])],
    ["owned by a duplicate-capture refund", () => mocks.duplicateRefundIntentIds.mockResolvedValue(["pi_superseded"])],
  ])("F1: the only other capture is one its machinery is sending back (%s): told as new-capture, never 'refund the other one'", async (_label, arrange) => {
    prime();
    mocks.rows.push({ id: "txn-superseded", source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: "pi_superseded" });
    arrange();

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture", otherPaymentIntentId: null, otherHoldsMoney: false }));
  });

  it("#4285 review 7 F6: a capture whose duplicate-capture refund failed later, with nothing owing it again, still holds money: named, never 'no other payment'", async () => {
    prime();
    mocks.rows.push({ id: "txn-dup", source: "STRIPE", status: "SUCCEEDED", stripePaymentIntentId: "pi_dup" });
    // Its refund operation owns it at any status for the refund-safety reading; the telling reading no longer counts it.
    mocks.duplicateRefundIntentIds.mockResolvedValue(["pi_dup"]);
    mocks.duplicateRefundsHolding.mockResolvedValue([]);

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new-capture-later-payment", otherPaymentIntentId: "pi_dup", otherHoldsMoney: true }),
    );
  });

  it("a send the day's cooldown blocked is tried again later; one that threw stays due for the next run", async () => {
    prime();
    mocks.alert.mockResolvedValueOnce("cooldown");
    await drainOwedNewCaptureAlerts(NOW);
    expect(mocks.noteOwedAlertAttempt).toHaveBeenCalledWith({ key: KEY, now: NOW });

    vi.clearAllMocks();
    prime();
    mocks.clubFormatValues.mockResolvedValue(FORMAT);
    mocks.liveSuperseded.mockResolvedValue([]);
    mocks.owningCaptures.mockResolvedValue([]);
    mocks.duplicateRefundIntentIds.mockResolvedValue([]);
    mocks.duplicateRefundsHolding.mockResolvedValue([]);
    mocks.alert.mockResolvedValueOnce("send-threw");
    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0 });
    expect(mocks.noteOwedAlertAttempt).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
  });
});
