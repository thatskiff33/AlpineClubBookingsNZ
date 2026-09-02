/**
 * #3232's linked move, at the service seam: two of a member's own bookings moved
 * together, atomically, on one combined figure they accept once.
 *
 * WHAT THIS FILE IS FOR, and what it deliberately leaves to its neighbours. The
 * pure half of the feature — where the dependent goes, what binds the member's
 * answer, what the member is told — is `adult-member-hosting-linked-move.test.ts`,
 * and the dependent READ that notices the booking a move leaves behind is
 * `adult-member-hosting-same-owner.test.ts`. What only this file can show is the
 * ORCHESTRATION, which is where the money and the atomicity live:
 *
 *  - both bookings are written on ONE transaction client, so the driver's rollback
 *    covers both — there is no path on which one moved and the other did not;
 *  - the provider work runs AFTER the commit and never inside it;
 *  - the combined figure is the sum of the two real results, in integer cents;
 *  - the club's change-fee setting reaches the PRICING ENGINE and not just the
 *    sentence (D2 — it was cosmetic until this suite went looking for it);
 *  - a failure on the SECOND booking — no beds, minimum stay, a Xero lock date, a
 *    member-night conflict, or the supervision rule refusing the FINAL state —
 *    takes the first one down with it and runs no provider work at all.
 *
 * ## Why the doubles are shaped the way they are
 *
 * `prisma.$transaction` is a real pass-through that records `commit` or
 * `rollback`, because "did this roll back" is asked here as "did the callback
 * throw out of `$transaction`, and did anything with an external footprint run
 * anyway". A `vi.fn()` cannot roll a real row back, and pretending otherwise would
 * be a test that proves PostgreSQL works. What it CAN prove, and what actually
 * decides whether the rollback is total, is that every write goes through the
 * caller's `tx` and that no provider call, no post-commit drain and no email fires
 * on a failed attempt. The genuine database property — that a booking written in
 * this transaction is really gone after the throw — is left to a real-PostgreSQL
 * proof, and the reason there is no such suite here is recorded in the pull
 * request rather than implied by its absence.
 *
 * `modifyBookingBatch` is a double that HONOURS `waiveChangeFee` (it returns a zero
 * fee when told to), because the arithmetic assertions are about what the service
 * does with the engine's answers. That the real engine honours the same lever is a
 * separate, cheap contract, asserted in `adult-member-hosting-call-sites.test.ts`
 * against the source of the branch itself.
 *
 * `hostingCoverageActorOptions` is a recorder rather than the real helper, so the
 * second-pass assertion can read the exact actor options the service built. What
 * the real helper does with those options is `adult-member-hosting-same-owner`'s
 * subject, not this file's.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StrandedCoverageBooking } from "@/lib/adult-member-hosting-same-owner";
import { stripComments } from "@/lib/__tests__/support/strip-comments";

vi.mock("server-only", () => ({}));

type BatchArgs = {
  bookingId: string;
  input: { checkIn?: string; checkOut?: string; settlementMethod?: string };
  tx: unknown;
  hostingReconcile?: string;
  waiveChangeFee?: boolean;
  hostingCoverageLinkedMove?: unknown;
  hostingCoverageOverride?: unknown;
  todayAtClub?: unknown;
};

const h = vi.hoisted(() => ({
  events: [] as string[],
  txClient: {} as Record<string, unknown>,
  transaction: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingDefaultsFindUnique: vi.fn(),
  modifyBookingBatch: vi.fn(),
  modifyBookingDates: vi.fn(),
  inspectStranding: vi.fn(),
  reconcileSiblings: vi.fn(),
  settleAfterCommit: vi.fn(),
  acquireLodgeCapacityLock: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  actorOptionCalls: [] as unknown[],
  logError: vi.fn(),
  prepareBatch: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: h.transaction,
    booking: { findUnique: h.bookingFindUnique },
    bookingDefaults: { findUnique: h.bookingDefaultsFindUnique },
  },
}));

vi.mock("@/lib/booking-batch-modification-service", () => ({
  modifyBookingBatch: h.modifyBookingBatch,
  prepareBookingBatchModification: h.prepareBatch,
}));

vi.mock("@/lib/booking-date-modification-service", () => ({
  modifyBookingDates: h.modifyBookingDates,
}));

vi.mock("@/lib/adult-member-hosting-review", () => ({
  hostingCoverageActorOptions: (actor: unknown) => {
    h.actorOptionCalls.push(actor);
    return { __actorOptions: actor };
  },
  inspectSameOwnerStrandingForOffer: h.inspectStranding,
  reconcileAdultMemberHostingReviewWithSiblings: h.reconcileSiblings,
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: h.settleAfterCommit,
}));

vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: h.acquireLodgeCapacityLock,
}));

vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: h.getDefaultLodgeId,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: h.logError, warn: vi.fn(), info: vi.fn() },
}));

import {
  SameOwnerCoverageLinkedMoveRequiredError,
  linkedMoveStateKey,
  linkedMoveTargetRange,
} from "@/lib/adult-member-hosting-linked-move";
import {
  SameOwnerCoverageWouldBreakError,
  strandedCoverageStateKey,
} from "@/lib/adult-member-hosting-same-owner";
import { BookingModificationSettlementMethodRequiredError } from "@/lib/booking-modify-settlement-required";
import {
  InsufficientCapacityError,
  OverCapacityConfirmationRequiredError,
  WholeLodgeHoldBlockedError,
} from "@/lib/over-capacity-confirmation";
import {
  applyLinkedDateMove,
  offerLinkedDateMove,
} from "@/lib/booking-linked-date-move-service";
// #3232: the club's change-fee answer and the pre-transaction reads live in
// `-preflight`, and the three arms over each surface's own writer in `-arms`, so
// the service file is the one procedure it describes. This suite drives all
// three, because what it tests is how they compose.
import { loadLinkedMoveChargesBothChangeFees } from "@/lib/booking-linked-date-move-preflight";
import {
  modifyBookingDatesWithLinkedMoveSupport,
  modifyBookingWithLinkedMoveSupport,
} from "@/lib/booking-linked-date-move-arms";

const LODGE = "lodge-alpine";
const PRIMARY = "bk-primary-0001";
const DEPENDENT = "bk-dependent-01";
const SECOND_DEPENDENT = "bk-dependent-02";

/** The window the primary really held before the move (10 -> 12 August). */
const HELD = {
  checkIn: new Date("2026-08-10T00:00:00.000Z"),
  checkOut: new Date("2026-08-12T00:00:00.000Z"),
};
/** Where the member asked to put it: ten days later, same length. */
const MOVED = {
  checkIn: new Date("2026-08-20T00:00:00.000Z"),
  checkOut: new Date("2026-08-22T00:00:00.000Z"),
};

function strandedRow(
  overrides: Partial<StrandedCoverageBooking> = {},
): StrandedCoverageBooking {
  return {
    bookingId: DEPENDENT,
    reference: "BK-DEPEN",
    lodgeName: "Alpine Lodge",
    nights: ["2026-08-10", "2026-08-11"],
    checkIn: "2026-08-10",
    checkOut: "2026-08-12",
    ...overrides,
  };
}

type Money = {
  priceDiffCents: number;
  changeFeeCents: number;
  additionalAmountCents: number;
  refundAmountCents: number;
  accountCreditAmountCents: number;
};

const PRIMARY_MONEY: Money = {
  priceDiffCents: 2_500,
  changeFeeCents: 1_000,
  additionalAmountCents: 3_500,
  refundAmountCents: 0,
  accountCreditAmountCents: 0,
};

const DEPENDENT_MONEY: Money = {
  priceDiffCents: -1_200,
  changeFeeCents: 1_000,
  additionalAmountCents: 0,
  refundAmountCents: 200,
  accountCreditAmountCents: 0,
};

/**
 * A `modifyBookingBatch` result, from a double that behaves like the real engine
 * on the one lever this service pulls: told to waive the change fee, it charges
 * none, and the reduction it hands back grows by exactly the fee it did not take.
 */
function batchResult(
  bookingId: string,
  money: Money,
  range: { checkIn: Date; checkOut: Date },
  waiveChangeFee: boolean,
) {
  const changeFeeCents = waiveChangeFee ? 0 : money.changeFeeCents;
  const waived = money.changeFeeCents - changeFeeCents;
  return {
    booking: { id: bookingId, checkIn: range.checkIn, checkOut: range.checkOut },
    priceDiffCents: money.priceDiffCents,
    changeFeeCents,
    additionalAmountCents: Math.max(0, money.additionalAmountCents - waived),
    refundAmountCents: money.refundAmountCents + waived,
    accountCreditAmountCents: money.accountCreditAmountCents,
    settlementMethod: null,
    additionalPaymentClientSecret: null,
    stripeRefundId: null,
    promoRemoved: false,
    promoChanged: false,
    promoCoverage: null,
    promoChangeNotApplied: null,
    choreWarnings: [],
    creditElectionCents: null,
    policyRetainedAmountCents: 0,
    capacityOverridden: false,
    deferredPostCommit: async () => {
      h.events.push(`deferred:${bookingId}`);
    },
    pendingHostingReconcile: async () => {
      h.events.push(`reconcile:${bookingId}`);
    },
  };
}

/** What the two callers hand in. Dates only — this is a date move. */
function args(
  overrides: {
    linkedMove?: {
      choice: "MOVE_BOTH" | "LEAVE_UNCOVERED";
      acknowledged: true;
      stateKey: string;
    };
  } = {},
) {
  return {
    bookingId: PRIMARY,
    actor: { id: "member-owner", role: "USER" as const },
    input: { checkIn: "2026-08-20", checkOut: "2026-08-22" },
    ipAddress: "203.0.113.7",
    todayAtClub: "2026-07-01" as never,
    ...overrides,
  };
}

/**
 * The transaction double.
 *
 * A REAL pass-through that records the outcome, so "rolled back" is asked as
 * "threw out of `$transaction`, and nothing with an external footprint ran".
 */
function installTransaction() {
  const tx = {
    $executeRaw: vi.fn(async (strings: { raw?: readonly string[] }) => {
      const statement = Array.isArray(strings.raw)
        ? strings.raw.join("?")
        : String(strings);
      h.events.push(`raw:${statement.trim()}`);
      return 1;
    }),
    // The deferred envelope-constraint flush. Recorded as an event, because WHEN
    // it happens is the whole point: each `modifyBookingBatch` must skip its own
    // (`SET CONSTRAINTS ... IMMEDIATE` applies for the rest of the transaction, so
    // the first booking's flush breaks the second booking's legitimate write
    // order) and this service must perform it once after both are written.
    $executeRawUnsafe: vi.fn(async (statement: string) => {
      h.events.push(
        statement.startsWith("SET CONSTRAINTS")
          ? "flush:envelope"
          : `raw-unsafe:${statement}`,
      );
      return 1;
    }),
    booking: { findUnique: h.bookingFindUnique },
  };
  h.txClient = tx as unknown as Record<string, unknown>;
  h.transaction.mockImplementation(
    async (callback: (client: unknown) => Promise<unknown>) => {
      h.events.push("tx:begin");
      try {
        const result = await callback(tx);
        h.events.push("tx:commit");
        return result;
      } catch (error) {
        h.events.push("tx:rollback");
        throw error;
      }
    },
  );
}

/** Both dependents move; the second is a different length, on purpose. */
function twoDependents(): StrandedCoverageBooking[] {
  return [
    strandedRow(),
    strandedRow({
      bookingId: SECOND_DEPENDENT,
      reference: "BK-DEPTW",
      nights: ["2026-08-11", "2026-08-12", "2026-08-13"],
      checkIn: "2026-08-11",
      checkOut: "2026-08-14",
    }),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.events = [];
  h.actorOptionCalls = [];
  installTransaction();
  h.bookingFindUnique.mockResolvedValue({
    lodgeId: LODGE,
    checkIn: HELD.checkIn,
    checkOut: HELD.checkOut,
  });
  h.bookingDefaultsFindUnique.mockResolvedValue({
    linkedMoveChargesBothChangeFees: true,
  });
  h.acquireLodgeCapacityLock.mockImplementation(
    async (_tx: unknown, lodgeId: string) => {
      h.events.push(`lock:lodge:${lodgeId}`);
    },
  );
  h.getDefaultLodgeId.mockResolvedValue("lodge-default");
  h.prepareBatch.mockImplementation(async () => {
    // Recorded, because WHEN it runs is the assertion: the club settings, the
    // subscription-lockout mode and the Xero lock dates must be resolved before
    // the transaction opens, never from inside it (`INV-LOCK-004`).
    h.events.push("prepare:pre-transaction");
    return { prepared: true };
  });
  h.inspectStranding.mockResolvedValue([strandedRow()]);
  h.reconcileSiblings.mockImplementation(async (bookingId: string) => {
    h.events.push(`reconcile-siblings:${bookingId}`);
  });
  h.settleAfterCommit.mockImplementation(
    async ({ bookingId }: { bookingId: string }) => {
      h.events.push(`settle:${bookingId}`);
    },
  );
  h.modifyBookingBatch.mockImplementation(async (call: BatchArgs) => {
    h.events.push(`edit:${call.bookingId}`);
    const isPrimary = call.bookingId === PRIMARY;
    const range = isPrimary
      ? MOVED
      : {
          checkIn: new Date(`${call.input.checkIn}T00:00:00.000Z`),
          checkOut: new Date(`${call.input.checkOut}T00:00:00.000Z`),
        };
    return batchResult(
      call.bookingId,
      isPrimary ? PRIMARY_MONEY : DEPENDENT_MONEY,
      range,
      call.waiveChangeFee === true,
    );
  });
  h.modifyBookingDates.mockImplementation(async (call: { bookingId: string }) => {
    h.events.push(`date-edit:${call.bookingId}`);
    return { booking: { id: call.bookingId } };
  });
});

/** Raise the offer and hand back the error, which is how a member gets the keys. */
async function raiseOffer(): Promise<SameOwnerCoverageLinkedMoveRequiredError> {
  const error = await offerLinkedDateMove(args()).then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(SameOwnerCoverageLinkedMoveRequiredError);
  return error as SameOwnerCoverageLinkedMoveRequiredError;
}

/**
 * Accept the offer with the key it really issued, then apply it.
 *
 * The probe's own calls are cleared, not merely its event log: the offer above
 * really ran both moves in order to price them, so a call-count assertion made
 * without this would be counting two runs and would pass for the wrong reason.
 */
async function acceptOffer(
  offer: SameOwnerCoverageLinkedMoveRequiredError,
) {
  h.events = [];
  h.actorOptionCalls = [];
  h.modifyBookingBatch.mockClear();
  h.reconcileSiblings.mockClear();
  h.settleAfterCommit.mockClear();
  h.bookingDefaultsFindUnique.mockClear();
  return applyLinkedDateMove({
    ...args(),
    linkedMove: {
      choice: "MOVE_BOTH",
      acknowledged: true,
      stateKey: offer.acceptStateKey,
    },
  });
}

describe("the linked move is one transaction (#3232, INV-HOST-051)", () => {
  it("takes the registered locks, writes both bookings, and only then commits", async () => {
    const result = await acceptOffer(await raiseOffer());

    expect(result.booking.id).toBe(PRIMARY);
    expect(h.events).toEqual([
      // FIRST, AND OUTSIDE THE TRANSACTION. The club settings, the
      // subscription-lockout mode and the Xero organisation's lock dates are
      // resolved here and passed to both bookings as a value. Left to
      // `modifyBookingBatch` they would have run INSIDE this transaction, twice,
      // under the global money key and the lodge capacity key — with a live HTTPS
      // request to Xero among them (`INV-LOCK-004`).
      "prepare:pre-transaction",
      "tx:begin",
      "raw:SELECT pg_advisory_xact_lock(1)",
      `lock:lodge:${LODGE}`,
      `edit:${PRIMARY}`,
      `edit:${DEPENDENT}`,
      // The envelope, ONCE, and only after BOTH bookings are written. Neither
      // `modifyBookingBatch` may flush its own: the first one's flush turns the
      // deferrable triggers immediate for the rest of the transaction, and the
      // second booking legitimately writes its guest stay ranges before its own
      // booking row — which is the ordering the triggers are deferrable to permit.
      // That was a real 500 on a real database, caught end to end.
      "flush:envelope",
      // The supervision rule ONCE, over the state that will really commit.
      `reconcile:${PRIMARY}`,
      `reconcile:${DEPENDENT}`,
      `reconcile-siblings:${PRIMARY}`,
      "tx:commit",
      // And the provider work strictly after it.
      `deferred:${PRIMARY}`,
      `deferred:${DEPENDENT}`,
      `settle:${PRIMARY}`,
      `settle:${DEPENDENT}`,
    ]);
  });

  it("writes both bookings on the SAME transaction client, with the check deferred", async () => {
    await acceptOffer(await raiseOffer());

    const calls = h.modifyBookingBatch.mock.calls.map(
      ([call]) => call as BatchArgs,
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      // This is what makes the driver's rollback total: a write on the module
      // client would commit on its own and survive the throw.
      expect(call.tx, call.bookingId).toBe(h.txClient);
      expect(call.hostingReconcile, call.bookingId).toBe("CALLER");
    }
  });

  it("shifts each dependent by the primary's arrival delta, keeping its own length", async () => {
    h.inspectStranding.mockResolvedValue(twoDependents());

    const offer = await raiseOffer();

    // Ten days later for both, and the three-night booking is still three nights
    // — a member extending their own stay has not asked to extend anybody else's.
    expect(
      offer.quote.linked.map((booking) => [
        booking.bookingId,
        booking.proposedCheckIn,
        booking.proposedCheckOut,
      ]),
    ).toEqual([
      [DEPENDENT, "2026-08-20", "2026-08-22"],
      [SECOND_DEPENDENT, "2026-08-21", "2026-08-24"],
    ]);
    // And the window the engine was really asked for matches what the member was
    // shown, rather than being re-derived for the write.
    const dependentCalls = h.modifyBookingBatch.mock.calls
      .map(([call]) => call as BatchArgs)
      .filter((call) => call.bookingId !== PRIMARY)
      .map((call) => [call.bookingId, call.input.checkIn, call.input.checkOut]);
    expect(dependentCalls).toEqual([
      [DEPENDENT, "2026-08-20", "2026-08-22"],
      [SECOND_DEPENDENT, "2026-08-21", "2026-08-24"],
    ]);
  });

  it("measures the shift from the window the booking really HELD, not the proposal", async () => {
    // The member asked for 20 August; the row under the lock says the booking was
    // on 10 August. A clamped or normalised edit would make the two disagree, and
    // the dependent must follow the real move.
    expect(
      linkedMoveTargetRange(
        { previousCheckIn: HELD.checkIn, currentCheckIn: MOVED.checkIn },
        { checkIn: "2026-08-10", checkOut: "2026-08-12" },
      ),
    ).toEqual({ checkIn: "2026-08-20", checkOut: "2026-08-22" });
  });

  it("carries the member's single settlement choice onto the dependent", async () => {
    const offer = await offerLinkedDateMove({
      ...args(),
      input: { ...args().input, settlementMethod: "credit" },
    }).then(
      () => null,
      (thrown: unknown) => thrown as SameOwnerCoverageLinkedMoveRequiredError,
    );

    const dependentCall = h.modifyBookingBatch.mock.calls
      .map(([call]) => call as BatchArgs)
      .find((call) => call.bookingId === DEPENDENT);
    expect(dependentCall?.input.settlementMethod).toBe("credit");
    expect(offer?.quote.linked).toHaveLength(1);
  });

  it("re-asserts the rule over the primary using the window it vacated", async () => {
    await acceptOffer(await raiseOffer());

    expect(h.reconcileSiblings).toHaveBeenCalledTimes(1);
    const [bookingId, client] = h.reconcileSiblings.mock.calls[0] as [
      string,
      unknown,
    ];
    expect(bookingId).toBe(PRIMARY);
    expect(client).toBe(h.txClient);
    const actorOptions = h.actorOptionCalls.at(-1) as {
      vacatedRange: { checkIn: Date; checkOut: Date };
      actorMemberId: string;
    };
    expect(actorOptions.vacatedRange).toEqual(HELD);
    expect(actorOptions.actorMemberId).toBe("member-owner");
  });

  it("does not run the second pass when nothing moved alongside", async () => {
    // No dependent means no world-changing second write, so re-reading the rule a
    // second time would be a query that can only agree with itself.
    h.inspectStranding.mockResolvedValue([]);
    const offer = await raiseOffer();
    h.events = [];

    await applyLinkedDateMove({
      ...args(),
      linkedMove: {
        choice: "MOVE_BOTH",
        acknowledged: true,
        stateKey: offer.acceptStateKey,
      },
    });

    expect(h.reconcileSiblings).not.toHaveBeenCalled();
    expect(h.events).toContain("tx:commit");
  });

  it("refuses to commit a booking whose supervision check went missing", async () => {
    // A caller that asked for the deferral and did not receive the thunk has no
    // supervision check at all, which must be a loud failure inside the
    // transaction rather than a quietly unchecked booking.
    h.modifyBookingBatch.mockImplementation(async (call: BatchArgs) => {
      h.events.push(`edit:${call.bookingId}`);
      const result = batchResult(call.bookingId, PRIMARY_MONEY, MOVED, false);
      return { ...result, pendingHostingReconcile: undefined };
    });

    await expect(
      applyLinkedDateMove({
        ...args(),
        linkedMove: {
          choice: "MOVE_BOTH",
          acknowledged: true,
          stateKey: `v1:${"0".repeat(64)}`,
        },
      }),
    ).rejects.toThrow(/without receiving its deferred hosting/);
    expect(h.events).toContain("tx:rollback");
    expect(h.events).not.toContain(`deferred:${PRIMARY}`);
  });

  it("refuses when it is the DEPENDENT's supervision check that went missing", async () => {
    // THE HALF THE GUARD USED TO MISS. It inspected the primary only, and the
    // dependents called their thunk optionally (`?.()`), so a wiring fault on the
    // second booking — the one this whole service exists to write — committed a
    // booking whose supervision state nobody had judged. Deferral moves the check;
    // it must never be able to remove it.
    h.modifyBookingBatch.mockImplementation(async (call: BatchArgs) => {
      h.events.push(`edit:${call.bookingId}`);
      const isPrimary = call.bookingId === PRIMARY;
      const result = batchResult(
        call.bookingId,
        isPrimary ? PRIMARY_MONEY : DEPENDENT_MONEY,
        isPrimary
          ? MOVED
          : {
              checkIn: new Date(`${call.input.checkIn}T00:00:00.000Z`),
              checkOut: new Date(`${call.input.checkOut}T00:00:00.000Z`),
            },
        false,
      );
      return isPrimary ? result : { ...result, pendingHostingReconcile: undefined };
    });

    await expect(
      applyLinkedDateMove({
        ...args(),
        linkedMove: {
          choice: "MOVE_BOTH",
          acknowledged: true,
          stateKey: `v1:${"0".repeat(64)}`,
        },
      }),
    ).rejects.toThrow(/INV-HOST-051: the linked move wrote a booking without/);
    expect(h.events).toContain("tx:rollback");
    expect(h.events).not.toContain(`deferred:${PRIMARY}`);
    expect(h.events).not.toContain(`deferred:${DEPENDENT}`);
  });

  it("falls back to the default lodge key when the booking row has gone", async () => {
    h.bookingFindUnique.mockResolvedValueOnce(null);
    await raiseOffer().catch(() => undefined);
    expect(h.events).toContain("lock:lodge:lodge-default");
  });

  it("refuses outright when the booking cannot be re-read under the lock", async () => {
    h.bookingFindUnique.mockResolvedValue(null);
    await expect(offerLinkedDateMove(args())).rejects.toThrow(
      "Booking not found",
    );
    expect(h.events).toContain("tx:rollback");
  });
});

describe("what the member is charged, once, for both (#3232 D2)", () => {
  it("sums the two real results in integer cents", async () => {
    const { quote } = await raiseOffer();

    expect(quote.primary.priceDiffCents).toBe(2_500);
    expect(quote.linked[0]?.priceDiffCents).toBe(-1_200);
    expect(quote.combinedPriceDiffCents).toBe(1_300);
    expect(quote.combinedChangeFeeCents).toBe(2_000);
    expect(quote.combinedAmountDueCents).toBe(3_500);
    expect(quote.combinedRefundCents).toBe(200);
    // Money comes back, so the member has one card-or-credit choice to make and
    // it covers both bookings.
    expect(quote.settlementMethodRequired).toBe(true);
    for (const cents of [
      quote.combinedPriceDiffCents,
      quote.combinedChangeFeeCents,
      quote.combinedAmountDueCents,
      quote.combinedRefundCents,
      quote.primary.changeFeeCents,
      quote.linked[0]?.changeFeeCents ?? 0,
    ]) {
      expect(Number.isInteger(cents)).toBe(true);
    }
  });

  it("counts a reduction once whether it comes back as card money or as credit", async () => {
    h.modifyBookingBatch.mockImplementation(async (call: BatchArgs) => {
      h.events.push(`edit:${call.bookingId}`);
      const money =
        call.bookingId === PRIMARY
          ? {
              ...PRIMARY_MONEY,
              additionalAmountCents: 0,
              refundAmountCents: 900,
            }
          : {
              ...DEPENDENT_MONEY,
              refundAmountCents: 0,
              accountCreditAmountCents: 400,
            };
      return batchResult(
        call.bookingId,
        money,
        call.bookingId === PRIMARY ? MOVED : MOVED,
        call.waiveChangeFee === true,
      );
    });

    const { quote } = await raiseOffer();
    expect(quote.combinedRefundCents).toBe(1_300);
    expect(quote.settlementMethodRequired).toBe(true);
  });

  it("charges both change fees by default, including when the club has never chosen", async () => {
    h.bookingDefaultsFindUnique.mockResolvedValue(null);

    const { quote } = await raiseOffer();

    expect(quote.bothChangeFeesCharged).toBe(true);
    expect(quote.combinedChangeFeeCents).toBe(2_000);
    const dependentCall = h.modifyBookingBatch.mock.calls
      .map(([call]) => call as BatchArgs)
      .find((call) => call.bookingId === DEPENDENT);
    expect(dependentCall?.waiveChangeFee).toBeUndefined();
    expect(await loadLinkedMoveChargesBothChangeFees()).toBe(true);
  });

  it("waives the DRAGGED booking's fee when the club says so, in the money and not only in the words", async () => {
    // This is the assertion that caught the defect: the setting used to change the
    // sentence and nothing else, so a club that had waived the second fee told the
    // member it was waived and charged it anyway.
    h.bookingDefaultsFindUnique.mockResolvedValue({
      linkedMoveChargesBothChangeFees: false,
    });

    const { quote, message } = await raiseOffer();

    const calls = h.modifyBookingBatch.mock.calls.map(
      ([call]) => call as BatchArgs,
    );
    expect(
      calls.find((call) => call.bookingId === PRIMARY)?.waiveChangeFee,
    ).toBeUndefined();
    expect(
      calls.find((call) => call.bookingId === DEPENDENT)?.waiveChangeFee,
    ).toBe(true);

    expect(quote.bothChangeFeesCharged).toBe(false);
    expect(quote.primary.changeFeeCents).toBe(1_000);
    expect(quote.linked[0]?.changeFeeCents).toBe(0);
    // One fee only, and the sentence the member reads agrees with the figure.
    expect(quote.combinedChangeFeeCents).toBe(1_000);
    expect(message).toContain("waived by the club");
    expect(message).toContain("one change fee only");
  });

  it("reads the club's setting BEFORE the transaction opens", async () => {
    // `INV-LOCK-004`: a settings read inside the transaction would take a second
    // pooled connection while the global money key and the lodge capacity key are
    // both held.
    await raiseOffer();
    expect(h.bookingDefaultsFindUnique).toHaveBeenCalledTimes(1);
    const order = h.bookingDefaultsFindUnique.mock.invocationCallOrder[0] ?? 0;
    const transactionOrder = h.transaction.mock.invocationCallOrder[0] ?? 0;
    expect(order).toBeLessThan(transactionOrder);
  });

  it("prices the offer from the same engine that will charge it", async () => {
    // The quote is not a prediction of what apply will do — it IS apply, not kept.
    // So the accepted key is derived from the same figures the second run produces.
    const offer = await raiseOffer();
    expect(offer.acceptStateKey).toBe(
      linkedMoveStateKey({
        stranded: [strandedRow()],
        sourceBookingId: PRIMARY,
        proposals: [
          {
            bookingId: PRIMARY,
            checkIn: "2026-08-20",
            checkOut: "2026-08-22",
          },
          {
            bookingId: DEPENDENT,
            checkIn: "2026-08-20",
            checkOut: "2026-08-22",
          },
        ],
        combinedAmountDueCents: 3_500,
        combinedRefundCents: 200,
        combinedChangeFeeCents: 2_000,
        // 2_500 + -1_200. Bound because the other three cannot see it: on a
        // booking that has taken no money yet they are all 0 whatever its price
        // does.
        combinedPriceDiffCents: 1_300,
      }),
    );
    // Declining carries no price, so it is bound to the stranded set alone — the
    // same derivation the officer's override uses.
    expect(offer.declineStateKey).toBe(
      strandedCoverageStateKey([strandedRow()], PRIMARY),
    );
    expect(offer.acceptStateKey).not.toBe(offer.declineStateKey);
  });
});

describe("where there are not beds for both — the owner's cannot arm (#3232)", () => {
  for (const [label, makeError] of [
    [
      // THE ONE A MEMBER ACTUALLY GETS, and the reason this arm was dead code.
      // `calculateModifiedPricing` branches on `adminOverride` FIRST: the two
      // classed over-capacity errors below are admin-only, and the member path
      // throws this instead. A linked move is reachable only for the booking's own
      // member — an officer escalates through `REQUIRE_OVERRIDE` and never arrives
      // here — so the refusal a full lodge really produces was the one refusal the
      // service did not recognise: it propagated as a bare 400 about beds, on a
      // booking the member never asked to move, with no offer and therefore no
      // decline arm either. That is the deadlock this issue exists to remove,
      // reappearing by a third route.
      //
      // The other half of this pin is in `calculate-modified-pricing-capacity.
      // test.ts`, which drives the REAL pricing engine and asserts it throws this
      // exact class. This suite doubles `modifyBookingBatch`, so it can only show
      // what the service does with the class — neither half is meaningful alone.
      "the member-path refusal a full lodge really throws",
      () =>
        new InsufficientCapacityError(
          "Not enough beds available for these changes",
        ),
    ],
    [
      "over capacity",
      () => new OverCapacityConfirmationRequiredError([
        { date: "2026-08-20", availableBeds: 0 },
      ]),
    ],
    [
      "a whole-lodge hold",
      () => new WholeLodgeHoldBlockedError(["2026-08-20"]),
    ],
  ] as const) {
    it(`withdraws the offer and commits nothing when the dependent hits ${label}`, async () => {
      h.modifyBookingBatch.mockImplementation(async (call: BatchArgs) => {
        h.events.push(`edit:${call.bookingId}`);
        if (call.bookingId !== PRIMARY) throw makeError();
        return batchResult(call.bookingId, PRIMARY_MONEY, MOVED, false);
      });

      const offer = await raiseOffer();

      expect(offer.quote.feasibility).toBe("NO_CAPACITY");
      // It still NAMES the booking that will be left uncovered, priced at
      // nothing because nothing is moving. An empty list here is what the
      // browser's fail-closed reader discards, which used to drop the whole
      // offer and refuse the member with no door.
      expect(offer.quote.linked).toHaveLength(1);
      expect(offer.quote.linked[0]?.bookingId).toBe(DEPENDENT);
      expect(offer.quote.linked[0]?.uncoveredNights).toEqual([
        "2026-08-10",
        "2026-08-11",
      ]);
      expect(offer.quote.linked[0]?.priceDiffCents).toBe(0);
      expect(offer.quote.linked[0]?.changeFeeCents).toBe(0);
      // And the combined figures are the primary's own, because the only move
      // still on offer is the primary's.
      expect(offer.quote.combinedChangeFeeCents).toBe(1_000);
      expect(offer.quote.combinedAmountDueCents).toBe(3_500);
      expect(offer.message).toContain("not enough beds free on the new nights");
      expect(offer.message).toContain("a Booking Officer will be told");
      // Nothing survives the probe, and no provider work ran on the way out.
      expect(h.events).toContain("tx:rollback");
      expect(h.events).not.toContain("tx:commit");
      expect(h.events).not.toContain(`deferred:${PRIMARY}`);
      // Nothing to assert an envelope over on an arm that cannot commit.
      expect(h.events).not.toContain("flush:envelope");
      expect(h.settleAfterCommit).not.toHaveBeenCalled();
    });
  }

  it("does not run the supervision check on an arm that cannot commit", async () => {
    // THE DEFECT THIS PINS. On this arm the primary has moved in a transaction
    // that is certain to be discarded and the dependent has not — which IS the
    // stranding the rule refuses. Running the deferred check there threw the bare
    // refusal, and it propagated in place of the offer, so a full lodge refused
    // the member with no door on the very arm the owner added to stop that.
    h.modifyBookingBatch.mockImplementation(async (call: BatchArgs) => {
      h.events.push(`edit:${call.bookingId}`);
      if (call.bookingId !== PRIMARY) {
        throw new OverCapacityConfirmationRequiredError([
          { date: "2026-08-20", availableBeds: 0 },
        ]);
      }
      const result = batchResult(call.bookingId, PRIMARY_MONEY, MOVED, false);
      return {
        ...result,
        pendingHostingReconcile: async () => {
          h.events.push(`reconcile:${call.bookingId}`);
          throw new SameOwnerCoverageWouldBreakError([strandedRow()], {
            linkedMoveWouldAnswer: true,
          });
        },
      };
    });

    const offer = await raiseOffer();

    expect(offer.quote.feasibility).toBe("NO_CAPACITY");
    expect(h.events).not.toContain(`reconcile:${PRIMARY}`);
    expect(h.reconcileSiblings).not.toHaveBeenCalled();
  });

  it("cannot be accepted: a MOVE_BOTH answer against a full lodge rolls back and re-prompts", async () => {
    h.modifyBookingBatch.mockImplementation(async (call: BatchArgs) => {
      h.events.push(`edit:${call.bookingId}`);
      if (call.bookingId !== PRIMARY) {
        throw new OverCapacityConfirmationRequiredError([
          { date: "2026-08-20", availableBeds: 0 },
        ]);
      }
      return batchResult(call.bookingId, PRIMARY_MONEY, MOVED, false);
    });
    const offer = await raiseOffer();
    h.events = [];

    const thrown = await applyLinkedDateMove({
      ...args(),
      linkedMove: {
        choice: "MOVE_BOTH",
        acknowledged: true,
        stateKey: offer.acceptStateKey,
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(SameOwnerCoverageLinkedMoveRequiredError);
    expect(
      (thrown as SameOwnerCoverageLinkedMoveRequiredError).quote.feasibility,
    ).toBe("NO_CAPACITY");
    expect(h.events).toContain("tx:rollback");
    expect(h.events).not.toContain("tx:commit");
    expect(h.settleAfterCommit).not.toHaveBeenCalled();
  });
});

describe("either both bookings move or neither does (#3232)", () => {
  /**
   * The refusals that are NOT "cannot fit". Each is a reason this particular
   * linked move is wrong, so each must reach the member as itself rather than
   * dressed up as a capacity message — and each must take the first booking's
   * write down with it.
   */
  const REAL_REFUSALS = [
    ["a minimum-stay rule", () => Object.assign(new Error("Two nights are required on a Friday."), { name: "MinimumStayPolicyViolationError" })],
    ["a Xero lock date", () => Object.assign(new Error("That period is locked in Xero."), { name: "XeroPeriodLockedError" })],
    ["a member-night conflict", () => Object.assign(new Error("Somebody is already booked on those nights."), { name: "BookingMemberNightConflictError" })],
  ] as const;

  for (const [label, makeError] of REAL_REFUSALS) {
    it(`rolls the first booking back when the second hits ${label}`, async () => {
      const error = makeError();
      h.modifyBookingBatch.mockImplementation(async (call: BatchArgs) => {
        h.events.push(`edit:${call.bookingId}`);
        if (call.bookingId !== PRIMARY) throw error;
        return batchResult(call.bookingId, PRIMARY_MONEY, MOVED, false);
      });

      // The real refusal reaches the member unchanged: it is not hidden behind an
      // offer they cannot take, and it is not relabelled as a full lodge.
      await expect(offerLinkedDateMove(args())).rejects.toBe(error);

      expect(h.events).toEqual([
        "prepare:pre-transaction",
        "tx:begin",
        "raw:SELECT pg_advisory_xact_lock(1)",
        `lock:lodge:${LODGE}`,
        `edit:${PRIMARY}`,
        `edit:${DEPENDENT}`,
        "tx:rollback",
      ]);
      // Not even the envelope assertion ran: the second write failed, so there is
      // no final state to assert one over.
      expect(h.events).not.toContain("flush:envelope");
      // The primary was written and is gone with the transaction: no supervision
      // check was recorded, no provider work fired, no post-commit drain ran.
      expect(h.events).not.toContain(`reconcile:${PRIMARY}`);
      expect(h.events).not.toContain(`deferred:${PRIMARY}`);
      expect(h.settleAfterCommit).not.toHaveBeenCalled();
    });
  }

  it("rolls both back when the supervision rule refuses the FINAL state", async () => {
    // The one refusal that can only appear after both writes: the rule is judged
    // once, over the state that would really commit. If it says no there, the
    // member's own accepted move is undone rather than committed uncovered.
    const refusal = new SameOwnerCoverageWouldBreakError([strandedRow()], {
      linkedMoveWouldAnswer: false,
    });
    h.reconcileSiblings.mockImplementation(async (bookingId: string) => {
      h.events.push(`reconcile-siblings:${bookingId}`);
      throw refusal;
    });
    const thrown = await offerLinkedDateMove(args()).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBe(refusal);

    expect(h.events).toContain("tx:rollback");
    expect(h.events).not.toContain("tx:commit");
    expect(h.settleAfterCommit).not.toHaveBeenCalled();
  });

  it("runs no provider work at all on a failed attempt", async () => {
    h.modifyBookingBatch.mockImplementation(async (call: BatchArgs) => {
      h.events.push(`edit:${call.bookingId}`);
      if (call.bookingId !== PRIMARY) throw new Error("second booking failed");
      return batchResult(call.bookingId, PRIMARY_MONEY, MOVED, false);
    });

    await expect(offerLinkedDateMove(args())).rejects.toThrow(
      "second booking failed",
    );

    // Not "no thunk was called" by absence — the thunks exist and record when run,
    // and the recorded event list is what proves they did not.
    expect(h.events.filter((event) => event.startsWith("deferred:"))).toEqual(
      [],
    );
    expect(h.events.filter((event) => event.startsWith("settle:"))).toEqual([]);
  });
});

describe("a dependent that needs a refund-or-credit choice (#3232)", () => {
  /**
   * THE SHAPE, and it needs no contrivance. The panel collects the card-or-credit
   * choice only when the PRIMARY's own quote asks for one, so whenever the primary
   * needs none — it is unpaid, or its price went UP — and the compelled move
   * reduces a settled dependent, the request carries no choice and the dependent's
   * write demands one. That threw a bare 400 telling the member to choose
   * something there was no control for, the offer was never built, and they could
   * move neither booking.
   */
  // THE REAL CLASS, not a name-alike: the service recognises it with `instanceof`,
  // which is exactly why the class was split into a module whose only import is
  // `ApiError` — importing it from the pricing side would drag the modification
  // planner into this suite's graph, and this suite doubles that planner on
  // purpose.
  const demandsChoice = () => new BookingModificationSettlementMethodRequiredError();

  it("prices the quote on the card option instead of refusing to quote", async () => {
    const offer = await raiseOffer();

    const dependentCall = h.modifyBookingBatch.mock.calls
      .map(([call]) => call as BatchArgs)
      .find((call) => call.bookingId === DEPENDENT);
    expect(
      dependentCall?.input.settlementMethod,
      "the quote is a discarded probe, so it may assume the card option to get a figure",
    ).toBe("card");
    // And the quote says a choice is owed, which is what asks the member for it.
    expect(offer.quote.settlementMethodRequired).toBe(true);
  });

  it("never substitutes a choice on the arm that really moves money", async () => {
    await acceptOffer(await raiseOffer());

    const dependentCall = h.modifyBookingBatch.mock.calls
      .map(([call]) => call as BatchArgs)
      .find((call) => call.bookingId === DEPENDENT);
    expect(
      dependentCall?.input.settlementMethod,
      "real money goes where the member said or nowhere",
    ).toBeUndefined();
  });

  it("re-raises the OFFER when the accepted move still has no choice", async () => {
    const offer = await raiseOffer();
    // The apply attempt: the dependent demands the choice the request does not
    // carry. The member must get the prompt that states the requirement, not a 400
    // about a control they cannot see.
    let attempts = 0;
    h.modifyBookingBatch.mockImplementation(async (call: BatchArgs) => {
      h.events.push(`edit:${call.bookingId}`);
      const isPrimary = call.bookingId === PRIMARY;
      if (!isPrimary && !call.input.settlementMethod) {
        attempts += 1;
        throw demandsChoice();
      }
      return batchResult(
        call.bookingId,
        isPrimary ? PRIMARY_MONEY : DEPENDENT_MONEY,
        isPrimary
          ? MOVED
          : {
              checkIn: new Date(`${call.input.checkIn}T00:00:00.000Z`),
              checkOut: new Date(`${call.input.checkOut}T00:00:00.000Z`),
            },
        call.waiveChangeFee === true,
      );
    });

    const thrown = await applyLinkedDateMove({
      ...args(),
      linkedMove: {
        choice: "MOVE_BOTH",
        acknowledged: true,
        stateKey: offer.acceptStateKey,
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(SameOwnerCoverageLinkedMoveRequiredError);
    expect(
      (thrown as SameOwnerCoverageLinkedMoveRequiredError).quote
        .settlementMethodRequired,
      "the offer the member gets back is the one that asks for the choice",
    ).toBe(true);
    // Once on the apply attempt; the re-quote assumes the card option and so gets
    // its figures rather than throwing again.
    expect(attempts).toBe(1);
  });
});

describe("the transaction is budgeted for lock(1) contention (#3232, INV-LOCK-002)", () => {
  it("opens with the same budget as the longest-lived holder of the global key", async () => {
    await raiseOffer();

    // Prisma's defaults are 2s maxWait / 5s timeout, and the blocking wait for
    // `pg_advisory_xact_lock(1)` counts against them — while this one transaction
    // runs TWO full batch modifications, the envelope flush and three reconciles
    // behind that wait. On the defaults an ordinary cancel or a bed assignment
    // legitimately holding the key would abort a member's save.
    expect(h.transaction.mock.calls[0]?.[1]).toEqual({
      maxWait: 10_000,
      timeout: 30_000,
    });
  });

  for (const code of ["P2028", "P2034"] as const) {
    it(`answers ${code} with "try again", not an opaque failure`, async () => {
      h.transaction.mockRejectedValue(Object.assign(new Error("tx"), { code }));

      const thrown = await offerLinkedDateMove(args()).then(
        () => null,
        (error: unknown) => error,
      );

      // Nothing was committed, and the alternative is worse than untidy: an
      // unmapped contention error reaches the member as a 500 INSTEAD OF THE
      // OFFER, which puts them back to being unable to move either booking.
      expect((thrown as { status?: number })?.status).toBe(503);
      expect((thrown as Error)?.message).toContain("try again in a moment");
    });
  }
});

describe("post-commit work is contained per booking (#3232)", () => {
  /**
   * THE TRANSACTION HAS COMMITTED BY THIS POINT, so a failure here can never mean
   * "the move did not happen". Both loops used to be bare `for … await`, so the
   * FIRST booking's follow-up failing meant the second booking got none of its
   * own: no Stripe charge for its increase and no recovery row either (that
   * enqueue lives inside the thunk's own catch, which was never entered), no Xero
   * leg, no audit row, no member email — with its dates permanently changed. The
   * route then answered 500, telling the member their change had failed, and a
   * resubmit was refused because the acceptance no longer matched.
   */
  async function applyWithFailingPrimaryThunk() {
    const offer = await raiseOffer();
    h.events = [];
    h.logError.mockClear();
    h.modifyBookingBatch.mockImplementation(async (call: BatchArgs) => {
      h.events.push(`edit:${call.bookingId}`);
      const isPrimary = call.bookingId === PRIMARY;
      const result = batchResult(
        call.bookingId,
        isPrimary ? PRIMARY_MONEY : DEPENDENT_MONEY,
        isPrimary
          ? MOVED
          : {
              checkIn: new Date(`${call.input.checkIn}T00:00:00.000Z`),
              checkOut: new Date(`${call.input.checkOut}T00:00:00.000Z`),
            },
        false,
      );
      if (!isPrimary) return result;
      return {
        ...result,
        deferredPostCommit: async () => {
          h.events.push(`deferred:${call.bookingId}`);
          // The realistic shape: an ordinary read failing under pool pressure
          // straight after a long doubled transaction.
          throw new Error("Timed out fetching a new connection from the pool");
        },
      };
    });
    return applyLinkedDateMove({
      ...args(),
      linkedMove: {
        choice: "MOVE_BOTH",
        acknowledged: true,
        stateKey: offer.acceptStateKey,
      },
    });
  }

  it("still runs the OTHER booking's provider work when one booking's fails", async () => {
    const result = await applyWithFailingPrimaryThunk();

    expect(result.booking.id).toBe(PRIMARY);
    // The primary's thunk threw, and the dependent's still ran.
    expect(h.events).toContain(`deferred:${PRIMARY}`);
    expect(h.events).toContain(`deferred:${DEPENDENT}`);
    // And so did the supervision drain for BOTH bookings, which is what opens the
    // incident and reaches the officer queue.
    expect(h.events).toContain(`settle:${PRIMARY}`);
    expect(h.events).toContain(`settle:${DEPENDENT}`);
  });

  it("does not report a committed move as a failure, and logs what did fail", async () => {
    await expect(applyWithFailingPrimaryThunk()).resolves.toBeTruthy();
    expect(h.logError).toHaveBeenCalledTimes(1);
    const [context, message] = h.logError.mock.calls[0] as [
      { errs: unknown[]; bookingIds: string[] },
      string,
    ];
    expect(message).toContain("post-commit follow-up work failed");
    expect(context.errs).toHaveLength(1);
    expect(context.bookingIds).toEqual([PRIMARY, DEPENDENT]);
  });
});

describe("an acceptance answers the offer it was shown (#3232)", () => {
  it("re-prompts with fresh figures rather than charging a price nobody agreed to", async () => {
    const offer = await raiseOffer();
    // The world moved: the dependent's price fell further between the offer and
    // the retry, so the combined figure the member accepted is no longer true.
    h.modifyBookingBatch.mockImplementation(async (call: BatchArgs) => {
      h.events.push(`edit:${call.bookingId}`);
      const money =
        call.bookingId === PRIMARY
          ? PRIMARY_MONEY
          : { ...DEPENDENT_MONEY, priceDiffCents: -9_900, refundAmountCents: 8_900 };
      return batchResult(
        call.bookingId,
        money,
        call.bookingId === PRIMARY
          ? MOVED
          : {
              checkIn: new Date(`${call.input.checkIn}T00:00:00.000Z`),
              checkOut: new Date(`${call.input.checkOut}T00:00:00.000Z`),
            },
        call.waiveChangeFee === true,
      );
    });
    h.events = [];

    const thrown = await applyLinkedDateMove({
      ...args(),
      linkedMove: {
        choice: "MOVE_BOTH",
        acknowledged: true,
        stateKey: offer.acceptStateKey,
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(SameOwnerCoverageLinkedMoveRequiredError);
    const fresh = thrown as SameOwnerCoverageLinkedMoveRequiredError;
    expect(fresh.quote.combinedRefundCents).toBe(8_900);
    expect(fresh.acceptStateKey).not.toBe(offer.acceptStateKey);
    expect(h.events).toContain("tx:rollback");
    expect(h.settleAfterCommit).not.toHaveBeenCalled();
  });

  it("refuses the DECLINE key on the accept arm, so one arm cannot answer the other", async () => {
    const offer = await raiseOffer();
    h.events = [];

    await expect(
      applyLinkedDateMove({
        ...args(),
        linkedMove: {
          choice: "MOVE_BOTH",
          acknowledged: true,
          stateKey: offer.declineStateKey,
        },
      }),
    ).rejects.toBeInstanceOf(SameOwnerCoverageLinkedMoveRequiredError);
    expect(h.events).toContain("tx:rollback");
  });

  it("re-prompts when a different booking is stranded than the member was shown", async () => {
    const offer = await raiseOffer();
    h.inspectStranding.mockResolvedValue([
      strandedRow({ bookingId: SECOND_DEPENDENT, reference: "BK-DEPTW" }),
    ]);
    h.events = [];

    await expect(
      applyLinkedDateMove({
        ...args(),
        linkedMove: {
          choice: "MOVE_BOTH",
          acknowledged: true,
          stateKey: offer.acceptStateKey,
        },
      }),
    ).rejects.toBeInstanceOf(SameOwnerCoverageLinkedMoveRequiredError);
    expect(h.events).toContain("tx:rollback");
    expect(h.settleAfterCommit).not.toHaveBeenCalled();
  });
});

describe("the three arms, shared across both date doors (#3232 D1, INV-SSOT-001)", () => {
  const MARKED = () =>
    new SameOwnerCoverageWouldBreakError([strandedRow()], {
      linkedMoveWouldAnswer: true,
    });
  const UNMARKED = () =>
    new SameOwnerCoverageWouldBreakError([strandedRow()], {
      linkedMoveWouldAnswer: false,
    });

  describe("PUT /api/bookings/[id]/modify", () => {
    it("performs the ordinary edit when nothing is stranded", async () => {
      const result = await modifyBookingWithLinkedMoveSupport(args());
      expect(result.booking.id).toBe(PRIMARY);
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it("turns a marked refusal into the offer", async () => {
      h.modifyBookingBatch.mockImplementationOnce(async () => {
        throw MARKED();
      });
      await expect(
        modifyBookingWithLinkedMoveSupport(args()),
      ).rejects.toBeInstanceOf(SameOwnerCoverageLinkedMoveRequiredError);
    });

    it("leaves an UNMARKED refusal exactly as it is", async () => {
      // A stranding the member can fix on the affected booking keeps today's
      // refusal: they can put cover back, cancel it, or ask an officer, and none
      // of those is forbidden.
      const refusal = UNMARKED();
      h.modifyBookingBatch.mockImplementationOnce(async () => {
        throw refusal;
      });
      await expect(modifyBookingWithLinkedMoveSupport(args())).rejects.toBe(
        refusal,
      );
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it("passes a LEAVE_UNCOVERED answer to the ordinary edit rather than moving two bookings", async () => {
      await modifyBookingWithLinkedMoveSupport({
        ...args(),
        linkedMove: {
          choice: "LEAVE_UNCOVERED",
          acknowledged: true,
          stateKey: `v1:${"a".repeat(64)}`,
        },
      });
      const call = h.modifyBookingBatch.mock.calls[0]?.[0] as BatchArgs;
      expect(call.hostingCoverageLinkedMove).toEqual({
        choice: "LEAVE_UNCOVERED",
        acknowledged: true,
        stateKey: `v1:${"a".repeat(64)}`,
      });
      expect(h.transaction).not.toHaveBeenCalled();
    });
  });

  describe("PUT /api/bookings/[id]/modify-dates", () => {
    it("performs the ordinary DATE edit, not the batch one", async () => {
      const result = await modifyBookingDatesWithLinkedMoveSupport(args());
      expect(h.events).toEqual([`date-edit:${PRIMARY}`]);
      expect(h.modifyBookingBatch).not.toHaveBeenCalled();
      expect(result.booking.id).toBe(PRIMARY);
    });

    it("turns a marked refusal into the same offer, from the same code", async () => {
      h.modifyBookingDates.mockImplementationOnce(async () => {
        throw MARKED();
      });
      const thrown = await modifyBookingDatesWithLinkedMoveSupport(args()).then(
        () => null,
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(SameOwnerCoverageLinkedMoveRequiredError);
      // The offer was priced by really applying both moves, which is why it
      // carries a figure at all.
      expect(
        (thrown as SameOwnerCoverageLinkedMoveRequiredError).quote
          .combinedAmountDueCents,
      ).toBe(3_500);
    });

    it("leaves an UNMARKED refusal exactly as it is", async () => {
      const refusal = UNMARKED();
      h.modifyBookingDates.mockImplementationOnce(async () => {
        throw refusal;
      });
      await expect(
        modifyBookingDatesWithLinkedMoveSupport(args()),
      ).rejects.toBe(refusal);
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it("hands a LEAVE_UNCOVERED answer to the date writer, which is what escalates it", async () => {
      await modifyBookingDatesWithLinkedMoveSupport({
        ...args(),
        linkedMove: {
          choice: "LEAVE_UNCOVERED",
          acknowledged: true,
          stateKey: `v1:${"b".repeat(64)}`,
        },
      });
      const call = h.modifyBookingDates.mock.calls[0]?.[0] as {
        hostingCoverageLinkedMove?: { choice: string };
      };
      expect(call.hostingCoverageLinkedMove?.choice).toBe("LEAVE_UNCOVERED");
    });

    it("accepts MOVE_BOTH through the atomic two-booking move", async () => {
      h.modifyBookingDates.mockImplementationOnce(async () => {
        throw MARKED();
      });
      const offer = (await modifyBookingDatesWithLinkedMoveSupport(args()).then(
        () => null,
        (error: unknown) => error,
      )) as SameOwnerCoverageLinkedMoveRequiredError;
      h.events = [];

      const result = await modifyBookingDatesWithLinkedMoveSupport({
        ...args(),
        linkedMove: {
          choice: "MOVE_BOTH",
          acknowledged: true,
          stateKey: offer.acceptStateKey,
        },
      });

      expect(h.events).toContain("tx:commit");
      expect(h.events).toContain(`edit:${DEPENDENT}`);
      // And it answers on this route's own contract, so no arm has to invent
      // money the date response has always disclosed.
      expect(result.policyRetainedAmountCents).toBe(0);
      expect(result.capacityOverridden).toBe(false);
    });

    it("carries only the dates and the settlement choice into the linked move", async () => {
      // The admin-only flags this route also accepts must not reach the offer: an
      // over-capacity CONFIRMATION is the opposite of what the cannot arm is for,
      // and an officer's change escalates instead of ever raising the offer.
      h.modifyBookingDates.mockImplementationOnce(async () => {
        throw MARKED();
      });
      await modifyBookingDatesWithLinkedMoveSupport({
        ...args(),
        input: {
          checkIn: "2026-08-20",
          checkOut: "2026-08-22",
          settlementMethod: "card",
          adminOverride: true,
          confirmOverCapacity: true,
          notifyMember: false,
        },
      }).catch(() => undefined);

      const primaryCall = h.modifyBookingBatch.mock.calls
        .map(([call]) => call as BatchArgs)
        .find((call) => call.bookingId === PRIMARY);
      expect(primaryCall?.input).toEqual({
        checkIn: "2026-08-20",
        checkOut: "2026-08-22",
        settlementMethod: "card",
      });
    });
  });
});

describe("nothing in this module can write outside the transaction (#3232)", () => {
  /**
   * THE ONE WAY THE ROLLBACK COULD BECOME PARTIAL, asserted against the source
   * rather than against a double.
   *
   * The tests above prove both `modifyBookingBatch` calls receive the caller's
   * `tx`, which is what makes the driver's rollback total. What they cannot see is
   * a THIRD write added later on the module-level Prisma client: it would commit
   * on its own, survive the throw, and leave exactly the half-moved state this
   * feature promises cannot exist. A source contract catches that the day it is
   * written, which no double can — a double is only handed the calls the code
   * already routes through it.
   *
   * Two spellings are allowed, and both are reads or the opener itself:
   * `prisma.$transaction(`, and the club's change-fee setting, which is read
   * deliberately OUTSIDE the transaction (`INV-LOCK-004`).
   */
  it("touches the module client only to open the transaction and read the club setting", () => {
    const moduleClientUses = (file: string) => {
      const source = stripComments(
        readFileSync(
          path.join(path.resolve(__dirname, "../.."), `lib/${file}`),
          "utf8",
        ),
      );
      return [...source.matchAll(/prisma[.][A-Za-z$]+/g)].map(
        (match) => match[0],
      );
    };

    // The transaction itself, and nothing else. Every read inside it goes through
    // the transaction client; a read on the module client would take a second
    // pooled connection while the global money key and the lodge capacity key are
    // both held (`INV-LOCK-004`).
    const service = moduleClientUses("booking-linked-date-move-service.ts");
    // Vacuity: a regex that stopped matching would report a clean file just as
    // loudly as a clean file does.
    expect(service.length).toBeGreaterThanOrEqual(1);
    expect([...new Set(service)]).toEqual(["prisma.$transaction"]);

    // And the club's own answer is read on the module client BEFORE that
    // transaction opens, which is why it lives in the pre-transaction module.
    const preflight = moduleClientUses("booking-linked-date-move-preflight.ts");
    expect([...new Set(preflight)]).toEqual(["prisma.bookingDefaults"]);
  });
});
