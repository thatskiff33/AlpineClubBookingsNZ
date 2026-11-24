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
  /** #4516: a close record by its id - the row it closed - for a still-owed rest keyed by it. */
  recordsById: {} as Record<string, string>,
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
  /** #5240: the saved-card captures flagged "not yet settled", by key, with when each was written. */
  flags: new Map<string, Date>(),
  /** #5240: owed new-capture markers the flag step wrote, by key. */
  owed: new Map<string, Date>(),
  /** #5240 review: how many pages of flags the listing read. */
  flagPages: 0,
  /** #5240 review: the flag listing fails as a whole (its read throws). */
  flagListError: null as Error | null,
  /** #5240 review: the flag's delete throws once (a crash at the consume). */
  flagDeleteError: null as Error | null,
  /** #5240 review: the guard's verdict on the flagged capture, as its arrival would read it. */
  judge: vi.fn(),
}));

vi.mock("@/lib/alert-cooldown", async (importOriginal) => ({
  // #5240 review: the flags are listed by the real pager, over the fake flag store's `findMany` below.
  listAllOwedAlertKeys: ((await importOriginal()) as typeof import("@/lib/alert-cooldown")).listAllOwedAlertKeys,
  // Each owed prefix lists only its own markers, as the real listing's `startsWith` does.
  listOwedAlertKeys: async (options: { prefix: string }) =>
    (((await mocks.listOwedAlertKeys(options)) ?? []) as string[]).filter((key) => key.startsWith(options.prefix)),
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
      findUnique: async ({ where }: { where: { idempotencyKey?: string; id?: string } }) => {
        mocks.recoveryReads(where);
        return mocks.recoveryRows.find((row) => row.idempotencyKey === where.idempotencyKey || row.id === where.id) ?? null;
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
      // #4516: a still-owed rest's close record, naming the row it closed.
      findUnique: async ({ where }: { where: { id: string } }) => {
        const closed = mocks.recordsById[where.id];
        return closed ? { kind: "CANCELLED_BOOKING_HAND_BACK", occurrenceKey: `card-refund-paid-another-way:${closed}` } : null;
      },
    },
    payment: { findMany: async () => [] },
    groupBookingSettlement: { findFirst: async () => mocks.settlement },
  };
  // #5240: the flag store, as the flag step and its promotion read and write it.
  const alertCooldown = {
    // The listing's shape, interpreted: an escaped prefix, a "due by" stamp, an optional key cursor, its order and page size.
    findMany: async ({ where, orderBy, take }: {
      where: { key: { startsWith: string }; lastAlertedAt: { lte: Date }; AND?: Array<{ key: { gt: string } }> };
      orderBy: { key?: "asc"; lastAlertedAt?: "asc" };
      take: number;
    }) => {
      mocks.flagPages += 1;
      if (mocks.flagListError) throw mocks.flagListError;
      const after = where.AND?.[0]?.key.gt;
      return [...mocks.flags.entries()]
        .filter(([key, at]) => key.startsWith(unescapeLike(where.key.startsWith)) && at <= where.lastAlertedAt.lte && (after === undefined || key > after))
        .sort(([a, aAt], [b, bAt]) => (orderBy.key ? a.localeCompare(b) : aAt.getTime() - bAt.getTime()))
        .slice(0, take)
        .map(([key]) => ({ key }));
    },
    findUnique: async ({ where }: { where: { key: string } }) => {
      const at = mocks.flags.get(where.key);
      return at ? { lastAlertedAt: at } : null;
    },
    deleteMany: async ({ where }: { where: { key: string } }) => {
      const error = mocks.flagDeleteError;
      mocks.flagDeleteError = null;
      if (error) throw error;
      return { count: mocks.flags.delete(where.key) ? 1 : 0 };
    },
    upsert: async ({ where, create }: { where: { key: string }; create: { lastAlertedAt: Date } }) =>
      void (mocks.owed.has(where.key) || mocks.owed.set(where.key, create.lastAlertedAt)),
  };
  Object.assign(client, { alertCooldown });
  return {
    prisma: {
      alertCooldown,
      // #5240 review (23 Nov, item 4): no ledger read outside a transaction. The flag step reads
      // the capture and its payment's recorded settler in the transaction that claims the flag,
      // so a read moved back onto the app's client throws here and fails its case.
      get paymentTransaction(): never {
        throw new Error("paymentTransaction read outside the transaction");
      },
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
  // #5240 review: the guard itself is proven over real PostgreSQL (`third-duplicate-capture.realdb.test.ts`).
  judgeCaptureOnPaidBooking: (...args: unknown[]) => mocks.judge(...args),
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { drainOwedNewCaptureAlerts, NEW_CAPTURE_ALERT_DRAIN_AFTER_MS } from "@/lib/duplicate-capture-kept-alert-drain";
import logger from "@/lib/logger";
import { UNSETTLED_CAPTURE_HAND_OVER_MS } from "@/lib/unsettled-capture-marker";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { formatCents } from "@/lib/utils";

const KEY = "duplicate-capture-new-capture-owed:booking-1:pi_new";
const NOW = new Date("2026-07-01T00:00:00.000Z");
const FORMAT = CLUB_FORMAT_TEST;
/** #5240: a run whose saved-card flag step found nothing to do. */
const NO_FLAGS = { promoted: 0, handedOver: 0, promotionFailed: false } as const;

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
  mocks.flags.clear();
  mocks.flagPages = 0;
  mocks.flagListError = null;
  mocks.flagDeleteError = null;
  mocks.judge.mockResolvedValue({ verdict: "keep_unrecorded_settler", reason: "new-capture", otherPaymentIntentId: null, otherHoldsMoney: false, heldCents: 20000 });
  mocks.owed.clear();
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
  mocks.recordsById = {};
  mocks.shortfallTasks = [];
  mocks.settlement = null;
});

describe("the owed new-capture alert's drain (#4285 review)", () => {
  it("reads only due markers under its own prefix, an hour after they were owed, and reads nothing else when none is due", async () => {
    mocks.listOwedAlertKeys.mockResolvedValue([]);

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 0, sent: 0, ...NO_FLAGS });
    expect(mocks.listOwedAlertKeys).toHaveBeenCalledWith({ prefix: "duplicate-capture-new-capture-owed:", now: NOW, retryAfterMs: NEW_CAPTURE_ALERT_DRAIN_AFTER_MS });
    expect(NEW_CAPTURE_ALERT_DRAIN_AFTER_MS).toBe(60 * 60 * 1000);
    expect(mocks.clubFormatValues).not.toHaveBeenCalled();
  });

  it("sends the kept-capture alert for a capture still holding money on a paid booking, as the settle would", async () => {
    prime();

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1, ...NO_FLAGS });
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

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1, ...NO_FLAGS });
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture-closed", amountCents: held }));
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
  });

  it.each([
    ["refunded to the card since", { captureStatus: "REFUNDED", refundedAmountCents: 20000 }],
    ["never captured", { captureStatus: "PENDING" }],
  ])("clears a marker with nothing to tell (%s) without an email", async (_label, state) => {
    prime(state);

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0, ...NO_FLAGS });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).toHaveBeenCalledWith({ key: KEY });
  });

  it("clears a marker whose booking is gone without an email", async () => {
    prime();
    mocks.bookingFindUnique.mockResolvedValue(null);

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0, ...NO_FLAGS });
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

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0, ...NO_FLAGS });
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

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1, ...NO_FLAGS });
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ reason: "new-capture" }));
    expect(mocks.noteOwedAlertAttempt).not.toHaveBeenCalled();
  });

  it("F2/F3: a booking cancelled since is told as closed, with what the capture still holds after the cancel's refund", async () => {
    prime({ status: "CANCELLED", captureStatus: "PARTIALLY_REFUNDED", refundedAmountCents: 15000 });

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1, ...NO_FLAGS });
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

  // #4516 (round-3 review 1): a close that paid back part and left the rest still owed on a row of its own - the
  // alert says the card refund is not sent while that rest is owed, and paid another way once a later close pays it.
  it.each([
    ["while the rest is still owed", { status: "PENDING", attempts: 5, nextRetryAt: null, succeededAt: null }, "not-sent"],
    ["once a later close paid the rest", {}, "paid-another-way"],
  ] as const)("#4516: a cancel's card refund paid back in part, the rest still owed, is said as the rest stands (%s)", async (_when, restState, standing) => {
    prime({ status: "CANCELLED" });
    mocks.recoveryRows = [recoveryRow(), recoveryRow({ id: "op-rest", idempotencyKey: "card_refund_still_owed_close-1", amountCents: 6000, ...restState })];
    mocks.closeRecordFor = { "op-cancel": { amountCents: 4000, raisedAmountCents: 4000 }, "op-rest": { amountCents: 6000, raisedAmountCents: 6000 } };
    mocks.recordsById = { "close-1": "op-cancel" };
    mocks.bookingEvents = [CARD_DECISION];

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ cancellationRefund: cardNote({ amount: money(10000), standing }) }));
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

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1, ...NO_FLAGS });
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

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0, ...NO_FLAGS });
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
    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 0, ...NO_FLAGS });
    expect(mocks.noteOwedAlertAttempt).not.toHaveBeenCalled();
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
  });
});

describe("#5240 a saved-card capture still flagged \"not yet settled\" an hour on", () => {
  const FLAG = "saved-card-capture-unsettled:pi_new";
  const PROMOTED = (reason: string) => `duplicate-capture-promoted-owed:${reason}:booking-1:pi_new`;
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** The capture as the flag step reads it: its row, its payment's recorded settler and its booking's status. */
  function primeFlag({ bookingStatus = "PAID", captureStatus = "SUCCEEDED", settledBy = null as string | null, ageMs = 2 * NEW_CAPTURE_ALERT_DRAIN_AFTER_MS } = {}) {
    prime({ status: bookingStatus, captureStatus });
    mocks.flags.set(FLAG, new Date(NOW.getTime() - ageMs));
    // The owed drain lists what the flag step left owed and due, in the same run.
    mocks.listOwedAlertKeys.mockImplementation(async ({ now, retryAfterMs }: { now: Date; retryAfterMs: number }) =>
      [...mocks.owed.entries()].filter(([, at]) => at.getTime() <= now.getTime() - retryAfterMs).map(([key]) => key));
    mocks.transactionFindUnique.mockResolvedValueOnce({
      id: "txn-new",
      status: captureStatus,
      amountCents: 20000,
      payment: { id: "payment-1", settledByTransactionId: settledBy, bookingId: "booking-1", booking: { status: bookingStatus } },
    });
  }

  it.each(["PAID", "COMPLETED"])("on a %s booking it becomes an owed new-capture alert, due at once, which this same run sends", async (bookingStatus) => {
    primeFlag({ bookingStatus });

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1, ...NO_FLAGS, promoted: 1 });

    expect(mocks.flags.has(FLAG), "the flag is consumed").toBe(false);
    expect(mocks.owed.get(KEY)).toEqual(new Date(NOW.getTime() - NEW_CAPTURE_ALERT_DRAIN_AFTER_MS));
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: "pi_new", reason: "new-capture" }));
  });

  it("a settle that consumed the flag first wins: the promotion writes nothing owed", async () => {
    primeFlag();
    // The capture's arrival takes the flag between the read and the promotion.
    mocks.transactionFindUnique.mockReset().mockImplementationOnce(async () => {
      mocks.flags.delete(FLAG);
      return { id: "txn-new", status: "SUCCEEDED", amountCents: 20000, payment: { id: "payment-1", settledByTransactionId: null, bookingId: "booking-1", booking: { status: "PAID" } } };
    });

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 0, sent: 0, ...NO_FLAGS });
    expect(mocks.owed.size).toBe(0);
  });

  it.each([
    ["the booking's recorded settler", { settledBy: "txn-new" }],
    ["refunded in full", { captureStatus: "REFUNDED" }],
    ["never captured", { captureStatus: "FAILED" }],
  ])("a capture that is %s is cleared without an alert", async (_label, overrides) => {
    primeFlag(overrides);

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.flags.has(FLAG), "cleared").toBe(false);
    expect(mocks.owed.size).toBe(0);
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("a capture whose row is gone is cleared", async () => {
    primeFlag();
    mocks.transactionFindUnique.mockReset().mockResolvedValue(null);

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.flags.has(FLAG), "cleared").toBe(false);
  });

  it("on an unpaid booking it waits for the webhook, unstamped, up to seven days less a millisecond", async () => {
    primeFlag({ bookingStatus: "CONFIRMED", ageMs: UNSETTLED_CAPTURE_HAND_OVER_MS - 1 });

    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.flags.get(FLAG)).toEqual(new Date(NOW.getTime() - UNSETTLED_CAPTURE_HAND_OVER_MS + 1));
    expect(mocks.settleOwedAlert).not.toHaveBeenCalled();
    expect(mocks.noteOwedAlertAttempt).not.toHaveBeenCalled();
    expect(mocks.owed.size).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("at seven days it is cleared and handed to the error log once", async () => {
    expect(UNSETTLED_CAPTURE_HAND_OVER_MS).toBe(7 * DAY_MS);
    primeFlag({ bookingStatus: "CONFIRMED", ageMs: UNSETTLED_CAPTURE_HAND_OVER_MS });

    await drainOwedNewCaptureAlerts(NOW);
    await drainOwedNewCaptureAlerts(NOW);

    expect(mocks.flags.has(FLAG)).toBe(false);
    expect(mocks.owed.size).toBe(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(mocks.judge, "an unpaid booking is never judged").not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      { bookingId: "booking-1", paymentIntentId: "pi_new", ageMs: UNSETTLED_CAPTURE_HAND_OVER_MS, bookingStatus: "CONFIRMED" },
      expect.stringContaining("never settled"),
    );
  });

  it("#5240 review item 1: the seven-day hand-over is logged before the flag is consumed, so a crash at the consume still leaves the log", async () => {
    primeFlag({ bookingStatus: "CONFIRMED", ageMs: UNSETTLED_CAPTURE_HAND_OVER_MS });
    const crash = new Error("connection lost at the consume");
    mocks.flagDeleteError = crash;

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 0, sent: 0, ...NO_FLAGS });

    const handOver = { bookingId: "booking-1", paymentIntentId: "pi_new", ageMs: UNSETTLED_CAPTURE_HAND_OVER_MS, bookingStatus: "CONFIRMED" };
    const calls = vi.mocked(logger.error).mock.calls;
    expect(calls[0], "the hand-over log came first").toEqual([handOver, expect.stringContaining("never settled")]);
    expect(calls[1], "then the consume's crash, caught for this flag alone").toEqual([{ err: crash, key: FLAG }, expect.any(String)]);
    expect(mocks.flags.has(FLAG), "the flag stands for the next run").toBe(true);
  });

  it("#5240 review item 3: on a paid booking where the arrival would refund it (another card is the settlement), the flag waits for the arrival; at seven days, with Stripe's retries over, it becomes the owed alert and the officers are emailed", async () => {
    mocks.judge.mockResolvedValue({ verdict: "refund", refundPlan: [{ paymentTransactionId: "txn-new", amountCents: 20000 }], refundCents: 20000, settledPaymentIntentId: "pi_settler" });
    primeFlag({ ageMs: UNSETTLED_CAPTURE_HAND_OVER_MS - 1 });

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 0, sent: 0, ...NO_FLAGS });
    expect(mocks.judge).toHaveBeenCalledWith(expect.anything(), {
      bookingId: "booking-1",
      paymentId: "payment-1",
      recordedSettlerId: null,
      paymentIntentId: "pi_new",
      amountCents: 20000,
      arrivingAlreadyCaptured: false,
    });
    expect(mocks.flags.has(FLAG), "left for the arrival, which refunds it").toBe(true);
    expect(mocks.owed.size).toBe(0);
    expect(mocks.alert).not.toHaveBeenCalled();

    primeFlag({ ageMs: UNSETTLED_CAPTURE_HAND_OVER_MS });
    // #5240 review (23 Nov, item 8): owed, but due an hour on, so an arrival that lost the flag
    // to this run has committed its refund before the drain judges the alert.
    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 0, sent: 0, ...NO_FLAGS, promoted: 1 });
    expect(mocks.flags.has(FLAG)).toBe(false);
    expect(mocks.owed.get(PROMOTED("unsettled-saved-card"))).toEqual(NOW);
    expect(mocks.alert).not.toHaveBeenCalled();

    const anHourOn = new Date(NOW.getTime() + NEW_CAPTURE_ALERT_DRAIN_AFTER_MS);
    expect(await drainOwedNewCaptureAlerts(anHourOn)).toEqual({ checked: 1, sent: 1, ...NO_FLAGS });
    // #5240 review (23 Nov, item 5): told as what it is, not as a payment made with account credit.
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: "pi_new", reason: "unsettled-saved-card" }));
    expect(logger.error, "an email, not only a log line").not.toHaveBeenCalled();
  });

  it("#5240 review (23 Nov, item 8): a seven-day alert whose capture an arrival refunded within the hour is never sent as kept", async () => {
    mocks.judge.mockResolvedValue({ verdict: "refund", refundPlan: [{ paymentTransactionId: "txn-new", amountCents: 20000 }], refundCents: 20000, settledPaymentIntentId: "pi_settler" });
    primeFlag({ ageMs: UNSETTLED_CAPTURE_HAND_OVER_MS });
    await drainOwedNewCaptureAlerts(NOW);
    // The arrival, blocked on the flag, replays after the promotion's commit and plans the duplicate's refund.
    mocks.operations = [refundOperation({ paymentTransactionId: "txn-new", paymentIntentId: "pi_new" })];

    await drainOwedNewCaptureAlerts(new Date(NOW.getTime() + NEW_CAPTURE_ALERT_DRAIN_AFTER_MS));

    expect(mocks.alert, "no kept alert beside the refund").not.toHaveBeenCalled();
    expect(mocks.noteOwedAlertAttempt, "it waits on the refund").toHaveBeenCalledWith(expect.objectContaining({ key: PROMOTED("unsettled-saved-card") }));
  });

  it.each(["not-recorded", "settler-released"])("#5240 review 23 Nov item 1(a): on a paid booking the arrival would keep and tell the admins for any reason (%s): the flag becomes the owed alert at once", async (reason) => {
    mocks.judge.mockResolvedValue({ verdict: "keep_unrecorded_settler", reason, otherPaymentIntentId: "pi_other", otherHoldsMoney: true, heldCents: 20000 });
    primeFlag();

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1, ...NO_FLAGS, promoted: 1 });
    expect(mocks.flags.has(FLAG)).toBe(false);
    expect(mocks.owed.get(PROMOTED(reason)), "the reason travels in the marker's key").toEqual(new Date(NOW.getTime() - NEW_CAPTURE_ALERT_DRAIN_AFTER_MS));
    expect(mocks.owed.has(KEY)).toBe(false);
    // #5240 review (23 Nov, item 5): the guard's reason, never "new-capture" (account credit or a zero total).
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: "pi_new", reason, otherPaymentIntentId: null }));
  });

  it("#5240 review (23 Nov, item 6): a silent keep (a cancel in flight holds it) waits and is judged again each run; if the cancel dies, the next run alerts; only at seven days is a keep cleared", async () => {
    mocks.judge.mockResolvedValue({ verdict: "keep" });
    primeFlag();
    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 0, sent: 0, ...NO_FLAGS });
    expect(mocks.flags.has(FLAG), "kept, not cleared: the keep may pass").toBe(true);
    expect(mocks.owed.size).toBe(0);
    expect(mocks.alert).not.toHaveBeenCalled();

    // The cancel died: the next run's judgement keeps and tells.
    mocks.judge.mockResolvedValue({ verdict: "keep_unrecorded_settler", reason: "new-capture", otherPaymentIntentId: null, otherHoldsMoney: false, heldCents: 20000 });
    primeFlag();
    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1, ...NO_FLAGS, promoted: 1 });
    expect(mocks.judge).toHaveBeenCalledTimes(2);
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: "pi_new", reason: "new-capture" }));
  });

  it("#5240 review (23 Nov, item 6): a keep still standing at seven days is cleared, with nothing owed or logged", async () => {
    mocks.judge.mockResolvedValue({ verdict: "keep" });
    primeFlag({ ageMs: UNSETTLED_CAPTURE_HAND_OVER_MS - 1 });
    await drainOwedNewCaptureAlerts(NOW);
    expect(mocks.flags.has(FLAG)).toBe(true);

    primeFlag({ ageMs: UNSETTLED_CAPTURE_HAND_OVER_MS });
    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 0, sent: 0, ...NO_FLAGS });
    expect(mocks.flags.has(FLAG)).toBe(false);
    expect(mocks.owed.size).toBe(0);
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("#5240 review 23 Nov item 1(b): a capture the arrival would not judge (partly refunded) on a paid booking waits, then at seven days becomes the owed alert", async () => {
    primeFlag({ captureStatus: "PARTIALLY_REFUNDED", ageMs: UNSETTLED_CAPTURE_HAND_OVER_MS - 1 });
    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 0, sent: 0, ...NO_FLAGS });
    expect(mocks.flags.has(FLAG)).toBe(true);

    primeFlag({ captureStatus: "PARTIALLY_REFUNDED", ageMs: UNSETTLED_CAPTURE_HAND_OVER_MS });
    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 0, sent: 0, ...NO_FLAGS, promoted: 1 });
    expect(mocks.judge, "only a SUCCEEDED row reaches the guard").not.toHaveBeenCalled();
    expect(mocks.flags.has(FLAG)).toBe(false);
    expect(await drainOwedNewCaptureAlerts(new Date(NOW.getTime() + NEW_CAPTURE_ALERT_DRAIN_AFTER_MS))).toEqual({ checked: 1, sent: 1, ...NO_FLAGS });
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: "pi_new", reason: "unsettled-saved-card" }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("#5240 review item 2: a flag step that throws as a whole never blocks the owed alerts: they are still drained and sent, and the run records the failure", async () => {
    prime();
    mocks.flagListError = new Error("flag listing failed");

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1, ...NO_FLAGS, promotionFailed: true });

    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: "pi_new" }));
    expect(logger.error).toHaveBeenCalledWith({ err: mocks.flagListError }, expect.stringContaining("still drained"));
  });

  it("#5240 review: more than a page of older flags waiting on unpaid bookings never hides a newer one on a paid booking", async () => {
    primeFlag();
    // 60 flags written six days ago, each waiting on an unpaid booking, all ahead of the paid one in key and age order.
    const waiting = Array.from({ length: 60 }, (_, i) => `saved-card-capture-unsettled:pi_a${String(i).padStart(2, "0")}`);
    for (const key of waiting) mocks.flags.set(key, new Date(NOW.getTime() - 6 * DAY_MS));
    const judgeCapture = { id: "txn-new", paymentId: "payment-1", status: "SUCCEEDED", amountCents: 20000, refundedAmountCents: 0 };
    mocks.transactionFindUnique.mockReset().mockImplementation(async ({ where, select }: { where: { stripePaymentIntentId: string }; select: { payment?: unknown } }) => {
      if (!select.payment) return judgeCapture;
      const paid = where.stripePaymentIntentId === "pi_new";
      return { id: `txn-${where.stripePaymentIntentId}`, status: "SUCCEEDED", amountCents: 20000, payment: { id: "payment-1", settledByTransactionId: null, bookingId: paid ? "booking-1" : "booking-unpaid", booking: { status: paid ? "PAID" : "CONFIRMED" } } };
    });

    expect(await drainOwedNewCaptureAlerts(NOW)).toEqual({ checked: 1, sent: 1, ...NO_FLAGS, promoted: 1 });

    expect(mocks.flagPages, "the listing read past its first page").toBeGreaterThan(1);
    expect(mocks.flags.has(FLAG), "the paid booking's flag is consumed").toBe(false);
    expect(mocks.alert).toHaveBeenCalledWith(expect.objectContaining({ paymentIntentId: "pi_new", reason: "new-capture" }));
    expect(waiting.every((key) => mocks.flags.has(key)), "the waiting flags still wait").toBe(true);
  });
});
