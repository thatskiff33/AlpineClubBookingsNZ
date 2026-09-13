import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus, CreditType } from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";

/**
 * #2265 (epic #2245, E1) — the stored credit election.
 *
 * A member who ticks "use my credit" and then saves the booking as a draft used
 * to have that election silently discarded. It is now remembered on the booking
 * and applied when the booking reaches PAYMENT_PENDING.
 *
 * These are the money tests for the consumption rules. They drive the REAL
 * credit ledger helpers (getMemberCreditBalance, deriveBookingAppliedCreditCents,
 * applyCreditToBooking) against an in-memory MemberCredit table, so the ledger
 * arithmetic under test is the same arithmetic booking-create uses — not a
 * mock's idea of it.
 */

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
}));

// #2576 §9. Mocked at the module boundary, like the other collaborators this suite
// already stubs. The real seam reads the booking and the lodge policy through the
// CONFIRMING transaction's client, and this suite drives that transaction with a fake
// that carries only the delegates the money path itself needs — so without this the
// enqueue throws and the settlement fails. Failing closed is the correct production
// behaviour (§8 wants the obligation to commit WITH the transition), so the fixture is
// what changes. Whether an uncovered booking becomes an incident belongs to the hosting
// suites; that this path reaches a seam at all is pinned tree-wide by
// `adult-member-hosting-call-sites.test.ts`.
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueOwnHostingCoverageReevaluation: vi.fn(async () => null),
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: vi.fn(async () => undefined),
}));


import {
  clearStaleCreditElection,
  consumeStoredCreditElection,
  settleFullyCreditCoveredBooking,
  CreditCoveredSettlementConflictError,
} from "@/lib/booking-credit-election";
import { queueSupersededPrimaryIntentCancellations } from "@/lib/booking-payment-cleanup";

type LedgerRow = {
  memberId: string;
  amountCents: number;
  type: CreditType;
  appliedToBookingId?: string | null;
};

const MEMBER_ID = "member-2265";
const BOOKING_ID = "booking-2265";

/**
 * A transaction double backed by an in-memory MemberCredit table plus one
 * booking row. `aggregate` discriminates on the same `where` shapes the real
 * helpers issue, so balance and applied-credit reads behave like Postgres.
 */
function makeTx({
  ledger = [],
  booking,
  raceBeforeClaim,
}: {
  ledger?: LedgerRow[];
  booking: {
    memberId?: string;
    status?: BookingStatus;
    finalPriceCents: number;
    creditElectionCents: number | null;
  };
  /**
   * Runs once, between this consumer's post-lock read and its guarded claim, so
   * a test can commit a competing transaction into exactly the window the claim
   * exists to close.
   */
  raceBeforeClaim?: (row: Record<string, unknown>) => void;
}) {
  const rows: LedgerRow[] = [...ledger];
  const bookingRow = {
    id: BOOKING_ID,
    memberId: MEMBER_ID,
    status: BookingStatus.PAYMENT_PENDING,
    ...booking,
    // Real-shaped Stage 2 stored-money projection. Credit election verifies
    // the booking-wide headline/component relation, not individual-night
    // provenance, so an empty adjustment build-up means total === final.
    totalPriceCents: booking.finalPriceCents,
    checkIn: parseDateOnly("2026-08-01"),
    checkOut: parseDateOnly("2026-08-02"),
    guests: [
      {
        id: "guest-2265",
        priceCents: booking.finalPriceCents,
        stayStart: null,
        stayEnd: null,
        nights: [
          {
            id: "night-2265",
            stayDate: parseDateOnly("2026-08-01"),
            priceCents: booking.finalPriceCents,
            priceSource: "SOLD" as const,
          },
        ],
      },
    ],
    promoRedemption: null,
    nightAdjustments: [],
  };
  const bookingUpdates: Array<Record<string, unknown>> = [];
  const paymentUpserts: Array<Record<string, unknown>> = [];
  let raced = false;

  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    booking: {
      findUnique: vi.fn(async () => ({ ...bookingRow })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        bookingUpdates.push(data);
        Object.assign(bookingRow, data);
        return { ...bookingRow };
      }),
      // Behaves like a guarded UPDATE ... WHERE: every key in `where` must
      // match the row as it stands NOW, which is what makes the claim a real
      // test of the race rather than a rename of the old unconditional update.
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (!raced && raceBeforeClaim) {
            raced = true;
            raceBeforeClaim(bookingRow);
          }
          const matches = Object.entries(where).every(([key, value]) => {
            if (key === "id") return value === BOOKING_ID;
            return value === (bookingRow as Record<string, unknown>)[key];
          });
          if (!matches) return { count: 0 };
          bookingUpdates.push(data);
          Object.assign(bookingRow, data);
          return { count: 1 };
        },
      ),
    },
    payment: {
      upsert: vi.fn(async (args: Record<string, unknown>) => {
        paymentUpserts.push(args);
        return { id: "payment-2265" };
      }),
    },
    memberCredit: {
      aggregate: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          const matched = rows.filter((row) => {
            if (where.memberId != null && row.memberId !== where.memberId) {
              return false;
            }
            if (
              where.appliedToBookingId != null &&
              row.appliedToBookingId !== where.appliedToBookingId
            ) {
              return false;
            }
            if (where.type != null && row.type !== where.type) return false;
            return true;
          });
          return {
            _sum: {
              amountCents: matched.reduce((sum, row) => sum + row.amountCents, 0),
            },
          };
        },
      ),
      create: vi.fn(async ({ data }: { data: LedgerRow }) => {
        rows.push(data);
        return data;
      }),
    },
  };

  return { tx, rows, bookingRow, bookingUpdates, paymentUpserts };
}

function creditLot(amountCents: number): LedgerRow {
  return {
    memberId: MEMBER_ID,
    amountCents,
    type: CreditType.CANCELLATION_REFUND,
    appliedToBookingId: null,
  };
}

function run(fixture: ReturnType<typeof makeTx>) {
  return consumeStoredCreditElection(
    fixture.tx as never,
    { bookingId: BOOKING_ID },
  );
}

/** Net credit consumed by the booking, straight off the fake ledger. */
function appliedTotal(rows: LedgerRow[]) {
  return -rows
    .filter(
      (row) =>
        row.type === CreditType.BOOKING_APPLIED &&
        row.appliedToBookingId === BOOKING_ID,
    )
    .reduce((sum, row) => sum + row.amountCents, 0) || 0;
}

/** What the member has left to spend. */
function balance(rows: LedgerRow[]) {
  return rows.reduce((sum, row) => sum + row.amountCents, 0);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#2265 consumeStoredCreditElection", () => {
  it("does nothing at all when the booking carries no election", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: null },
    });

    await expect(run(fixture)).resolves.toBeNull();
    expect(fixture.tx.booking.updateMany).not.toHaveBeenCalled();
    expect(fixture.tx.memberCredit.create).not.toHaveBeenCalled();
    expect(balance(fixture.rows)).toBe(20_000);
    // No election, no lock: a booking that never made one costs one SELECT.
    expect(fixture.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("refuses to consume credit while the booking is still a DRAFT", async () => {
    // The whole point of the stored election: a draft may be abandoned or
    // expire, so the member's balance must stay free until the booking is real.
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: {
        status: BookingStatus.DRAFT,
        finalPriceCents: 10_000,
        creditElectionCents: 5_000,
      },
    });

    await expect(run(fixture)).resolves.toBeNull();
    expect(fixture.tx.memberCredit.create).not.toHaveBeenCalled();
    expect(balance(fixture.rows)).toBe(20_000);
    // And the election is NOT cleared — it is still owed to the member.
    expect(fixture.bookingRow.creditElectionCents).toBe(5_000);
  });

  it("refuses to consume credit while the booking is AWAITING_REVIEW", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: {
        status: BookingStatus.AWAITING_REVIEW,
        finalPriceCents: 10_000,
        creditElectionCents: 5_000,
      },
    });

    await expect(run(fixture)).resolves.toBeNull();
    expect(balance(fixture.rows)).toBe(20_000);
    expect(fixture.bookingRow.creditElectionCents).toBe(5_000);
  });

  it("applies the elected amount in full when the balance and price still allow it", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: 8_650 },
    });

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      requestedCents: 8_650,
      appliedCents: 8_650,
      shortfallCents: 0,
      shortfallReason: "none",
      fullyCovered: false,
      moneyBuildUp: {
        moneyBuildUpOperation: "CREDIT_ELECTION",
        moneyBuildUpSource: "STORED",
        moneyBuildUpStoredCents: 10_000,
        moneyBuildUpDerivedCents: 10_000,
      },
    });
    expect(fixture.tx.memberCredit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        description: expect.stringContaining("price source STORED"),
      }),
    });
    expect(appliedTotal(fixture.rows)).toBe(8_650);
    expect(balance(fixture.rows)).toBe(11_350);
  });

  it("clears the election in the same transaction, so a re-drive cannot apply it twice", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: 5_000 },
    });

    await run(fixture);
    expect(fixture.bookingUpdates[0]).toEqual({ creditElectionCents: null });
    expect(fixture.bookingRow.creditElectionCents).toBeNull();

    // Second attempt on the same booking: nothing left to consume.
    const second = await run(fixture);
    expect(second).toBeNull();
    expect(appliedTotal(fixture.rows)).toBe(5_000);
  });

  it("clamps to the balance when the member spent their credit elsewhere, and says so", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000), { ...creditLot(-17_000), type: CreditType.BOOKING_APPLIED, appliedToBookingId: "other-booking" }],
      booking: { finalPriceCents: 10_000, creditElectionCents: 8_650 },
    });

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      requestedCents: 8_650,
      appliedCents: 3_000,
      shortfallCents: 5_650,
      shortfallReason: "balance",
      availableBalanceCents: 3_000,
      fullyCovered: false,
    });
    expect(appliedTotal(fixture.rows)).toBe(3_000);
    // Never overdrawn.
    expect(balance(fixture.rows)).toBe(0);
  });

  it("clamps to the price when the draft was edited down below the election", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 4_000, creditElectionCents: 8_650 },
    });

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      requestedCents: 8_650,
      appliedCents: 4_000,
      shortfallCents: 4_650,
      shortfallReason: "price",
      fullyCovered: true,
    });
    expect(appliedTotal(fixture.rows)).toBe(4_000);
    expect(balance(fixture.rows)).toBe(16_000);
  });

  it("names the price when the price is the tighter of two moved bounds", async () => {
    // Both the balance (3,000) and the price (2,500) sit under the 8,650
    // request, but only the price decided the answer. Telling the member their
    // balance was short would be untrue — they still have 500 left over.
    const fixture = makeTx({
      ledger: [creditLot(3_000)],
      booking: { finalPriceCents: 2_500, creditElectionCents: 8_650 },
    });

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      appliedCents: 2_500,
      shortfallCents: 6_150,
      shortfallReason: "price",
      fullyCovered: true,
    });
    expect(balance(fixture.rows)).toBe(500);
  });

  it("reports both limits only when the balance and the price bind equally", async () => {
    // 2,500 of credit against a 2,500 price: naming either one alone would be
    // arbitrary, so this is the one case that honestly reads "both".
    const fixture = makeTx({
      ledger: [creditLot(2_500)],
      booking: { finalPriceCents: 2_500, creditElectionCents: 8_650 },
    });

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      appliedCents: 2_500,
      shortfallCents: 6_150,
      shortfallReason: "balance_and_price",
      fullyCovered: true,
    });
    expect(balance(fixture.rows)).toBe(0);
  });

  it("applies nothing, without throwing, when the balance is gone entirely", async () => {
    // calculateBookingCreditApplication throws on an over-request; the
    // confirmation path must never leave a member unable to pay their own
    // booking, so the election is clamped to zero and reported instead.
    const fixture = makeTx({
      ledger: [],
      booking: { finalPriceCents: 10_000, creditElectionCents: 8_650 },
    });

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      requestedCents: 8_650,
      appliedCents: 0,
      shortfallCents: 8_650,
      shortfallReason: "balance",
      fullyCovered: false,
    });
    expect(fixture.tx.memberCredit.create).not.toHaveBeenCalled();
  });

  it("honours an explicit election of zero without touching the ledger", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: 0 },
    });

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      requestedCents: 0,
      appliedCents: 0,
      shortfallCents: 0,
      shortfallReason: "none",
    });
    expect(fixture.tx.memberCredit.create).not.toHaveBeenCalled();
    expect(fixture.bookingRow.creditElectionCents).toBeNull();
  });

  it("never re-covers a slice of the price another path already paid with credit", async () => {
    const fixture = makeTx({
      ledger: [
        creditLot(20_000),
        {
          memberId: MEMBER_ID,
          amountCents: -6_000,
          type: CreditType.BOOKING_APPLIED,
          appliedToBookingId: BOOKING_ID,
        },
      ],
      booking: { finalPriceCents: 10_000, creditElectionCents: 8_650 },
    });

    const outcome = await run(fixture);

    // Only the outstanding 4,000 is claimable.
    expect(outcome).toMatchObject({
      appliedCents: 4_000,
      shortfallReason: "price",
      fullyCovered: true,
    });
    expect(appliedTotal(fixture.rows)).toBe(10_000);
  });

  it("takes the ledger lock before it writes the booking row", async () => {
    // Lock order matters: every other credit writer in the house takes the
    // per-member ledger lock before touching the booking, so this one must too
    // or it inverts the order and can deadlock against them.
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: 5_000 },
    });

    await run(fixture);

    expect(fixture.tx.$executeRaw).toHaveBeenCalled();
    const lockOrder = fixture.tx.$executeRaw.mock.invocationCallOrder[0];
    const claimOrder = fixture.tx.booking.updateMany.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(claimOrder);
  });

  it("lets exactly one of two racing consumers debit the credit", async () => {
    // The window the guarded claim exists to close: this consumer read the
    // election, and a competing pay attempt committed its own consumption
    // before this one could claim it. The loser must do NOTHING — no ledger
    // row, and no outcome object, because its caller would act on one (a second
    // confirmation email, a second Xero invoice, a second MEMBER_PAID event).
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: 5_000 },
      raceBeforeClaim: (row) => {
        row.creditElectionCents = null;
      },
    });

    await expect(run(fixture)).resolves.toBeNull();
    expect(fixture.tx.memberCredit.create).not.toHaveBeenCalled();
    expect(balance(fixture.rows)).toBe(20_000);
    expect(appliedTotal(fixture.rows)).toBe(0);
  });

  it("claims nothing when a cancel lands between the read and the claim", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: 5_000 },
      raceBeforeClaim: (row) => {
        row.status = BookingStatus.CANCELLED;
      },
    });

    await expect(run(fixture)).resolves.toBeNull();
    expect(fixture.tx.memberCredit.create).not.toHaveBeenCalled();
    expect(balance(fixture.rows)).toBe(20_000);
    // The election survives the lost race; the booking still owes it.
    expect(fixture.bookingRow.creditElectionCents).toBe(5_000);
  });

  it("flags a booking the election covers in full", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: 10_000 },
    });

    const outcome = await run(fixture);

    expect(outcome).toMatchObject({
      appliedCents: 10_000,
      shortfallCents: 0,
      fullyCovered: true,
    });
  });
});

describe("#2265 settleFullyCreditCoveredBooking", () => {
  it("marks the booking PAID with a $0 payment that mirrors the applied credit", async () => {
    const fixture = makeTx({
      booking: { finalPriceCents: 10_000, creditElectionCents: null },
    });

    await settleFullyCreditCoveredBooking(fixture.tx as never, {
      bookingId: BOOKING_ID,
      appliedCreditCents: 10_000,
    });

    // amountCents + creditAppliedCents = finalPriceCents.
    const upsert = fixture.paymentUpserts[0] as {
      create: { amountCents: number; creditAppliedCents: number; status: string };
      update: { amountCents: number; creditAppliedCents: number };
    };
    expect(upsert.create.amountCents).toBe(0);
    expect(upsert.create.creditAppliedCents).toBe(10_000);
    expect(upsert.create.status).toBe("SUCCEEDED");
    expect(upsert.update.amountCents).toBe(0);
    expect(upsert.update.creditAppliedCents).toBe(10_000);

    expect(fixture.bookingRow.status).toBe(BookingStatus.PAID);
  });

  it("sweeps every stale positive card intent, because nothing is owed", async () => {
    const fixture = makeTx({
      booking: { finalPriceCents: 10_000, creditElectionCents: null },
    });

    await settleFullyCreditCoveredBooking(fixture.tx as never, {
      bookingId: BOOKING_ID,
      appliedCreditCents: 10_000,
    });

    expect(queueSupersededPrimaryIntentCancellations).toHaveBeenCalledWith(
      fixture.tx,
      expect.objectContaining({
        bookingId: BOOKING_ID,
        paymentId: "payment-2265",
        newFinalPriceCents: 0,
      }),
    );
  });

  it("clears the card pointers but keeps the saved card the guest charge needs", async () => {
    const fixture = makeTx({
      booking: { finalPriceCents: 10_000, creditElectionCents: null },
    });

    await settleFullyCreditCoveredBooking(fixture.tx as never, {
      bookingId: BOOKING_ID,
      appliedCreditCents: 10_000,
    });

    const upsert = fixture.paymentUpserts[0] as {
      update: Record<string, unknown>;
    };
    expect(upsert.update.stripePaymentIntentId).toBeNull();
    expect(upsert.update.additionalPaymentIntentId).toBeNull();
    // A split parent's saved card is the fallback the deferred non-member guest
    // charge uses, so this settlement must not strip it.
    expect(upsert.update).not.toHaveProperty("stripePaymentMethodId");
  });

  it("refuses to resurrect a booking a cancel took out of PAYMENT_PENDING", async () => {
    const fixture = makeTx({
      booking: {
        status: BookingStatus.CANCELLED,
        finalPriceCents: 10_000,
        creditElectionCents: null,
      },
    });

    await expect(
      settleFullyCreditCoveredBooking(fixture.tx as never, {
        bookingId: BOOKING_ID,
        appliedCreditCents: 10_000,
      }),
    ).rejects.toBeInstanceOf(CreditCoveredSettlementConflictError);

    // Loud, and empty-handed: the caller's transaction rolls back, so no
    // Payment row and no cancellation queue entry are left behind.
    expect(fixture.bookingRow.status).toBe(BookingStatus.CANCELLED);
    expect(fixture.tx.payment.upsert).not.toHaveBeenCalled();
    expect(queueSupersededPrimaryIntentCancellations).not.toHaveBeenCalled();
  });
});

/**
 * #2319 — the CLEAR half of the column's lifecycle.
 *
 * `consumeStoredCreditElection` above is the honest answer while a booking is
 * still unpaid: apply the credit and charge the remainder. Once the money has
 * been taken at the full price there is nothing left to apply, and the only
 * honest answer is to clear the request — a settled booking must never carry an
 * election, because nothing will ever read it again and the row would advertise
 * an outstanding choice forever. These pin that the clear moves the column and
 * NOTHING else: no ledger row, no balance movement, no status write.
 */
describe("#2319 clearStaleCreditElection", () => {
  it("clears the election and touches no money", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: 8_000 },
    });

    await expect(
      clearStaleCreditElection(fixture.tx as never, {
        id: BOOKING_ID,
        creditElectionCents: 8_000,
      }),
    ).resolves.toBe(8_000);

    expect(fixture.bookingRow.creditElectionCents).toBeNull();
    // The whole point: the member paid full price in cash, so their balance is
    // still theirs down to the cent, and no BOOKING_APPLIED row exists.
    expect(balance(fixture.rows)).toBe(20_000);
    expect(appliedTotal(fixture.rows)).toBe(0);
    expect(fixture.tx.memberCredit.create).not.toHaveBeenCalled();
    // Only the column moved — the status is not this helper's business.
    expect(fixture.bookingUpdates).toEqual([{ creditElectionCents: null }]);
  });

  it("conserves money across consume -> re-arm -> settle-door clear (#2266 LOW-8)", async () => {
    // A member's election is consumed by a pay attempt (credit applied, intent
    // minted, booking still PAYMENT_PENDING), the member then edits and
    // RE-ARMS a fresh election, and the earlier intent finally captures: the
    // settle door clears the re-armed election and fires the operator alert.
    // The alert is accepted noise (see CREDIT_ELECTION_WRITABLE_STATUSES);
    // what this test pins is that MONEY IS CONSERVED — the balance moved
    // exactly once, at the consumption, and the clear debits nothing.
    const fixture = makeTx({
      ledger: [creditLot(5_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: 3_000 },
    });

    // 1. Pay attempt consumes the election: $30.00 applied, $20.00 left.
    const outcome = await run(fixture);
    expect(outcome).toMatchObject({ requestedCents: 3_000, appliedCents: 3_000 });
    expect(appliedTotal(fixture.rows)).toBe(3_000);
    expect(balance(fixture.rows)).toBe(2_000);
    expect(fixture.bookingRow.creditElectionCents).toBeNull();

    // 2. An edit re-arms a fresh election while the booking is still
    //    PAYMENT_PENDING (a writable status).
    fixture.bookingRow.creditElectionCents = 2_000;

    // 3. The earlier intent captures; the settle door clears the re-armed
    //    election (and its caller alerts). Nothing further moves.
    await expect(
      clearStaleCreditElection(fixture.tx as never, {
        id: BOOKING_ID,
        creditElectionCents: 2_000,
      }),
    ).resolves.toBe(2_000);

    expect(fixture.bookingRow.creditElectionCents).toBeNull();
    expect(appliedTotal(fixture.rows)).toBe(3_000); // still exactly once
    expect(balance(fixture.rows)).toBe(2_000); // the clear took nothing
  });

  it("does nothing, and writes nothing, when there is no election", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: null },
    });

    await expect(
      clearStaleCreditElection(fixture.tx as never, {
        id: BOOKING_ID,
        creditElectionCents: null,
      }),
    ).resolves.toBeNull();

    // The overwhelming majority of settlements land here, so this arm must cost
    // nothing at all: not even an UPDATE that matches zero rows.
    expect(fixture.tx.booking.updateMany).not.toHaveBeenCalled();
    expect(fixture.bookingUpdates).toEqual([]);
  });

  it("clears an explicit zero election, which is still a request on the row", async () => {
    const fixture = makeTx({
      booking: { finalPriceCents: 10_000, creditElectionCents: 0 },
    });

    // 0 means "the member explicitly chose to apply none", which is a live
    // request, not the absence of one — NULL is the absence. It must be cleared
    // like any other so the settled row reads NULL.
    await expect(
      clearStaleCreditElection(fixture.tx as never, {
        id: BOOKING_ID,
        creditElectionCents: 0,
      }),
    ).resolves.toBe(0);
    expect(fixture.bookingRow.creditElectionCents).toBeNull();
  });

  it("reports nothing when a consumer won the election first", async () => {
    const fixture = makeTx({
      ledger: [creditLot(20_000)],
      booking: { finalPriceCents: 10_000, creditElectionCents: 8_000 },
      // A pay step consumes the election in the window between this settlement
      // reading it and claiming it. The guarded claim must lose, and losing must
      // be reported as "nothing was stale" — otherwise the caller would audit,
      // alert and tell the member their credit went unapplied when it was in
      // fact applied a moment earlier.
      raceBeforeClaim: (row) => {
        row.creditElectionCents = null;
      },
    });

    await expect(
      clearStaleCreditElection(fixture.tx as never, {
        id: BOOKING_ID,
        creditElectionCents: 8_000,
      }),
    ).resolves.toBeNull();
    expect(fixture.bookingUpdates).toEqual([]);
  });

  it("does not clear an election a concurrent edit changed underneath it", async () => {
    const fixture = makeTx({
      booking: { finalPriceCents: 10_000, creditElectionCents: 8_000 },
      // The claim matches on the EXACT amount read, so a re-elected different
      // amount is left alone rather than silently discarded.
      raceBeforeClaim: (row) => {
        row.creditElectionCents = 3_000;
      },
    });

    await expect(
      clearStaleCreditElection(fixture.tx as never, {
        id: BOOKING_ID,
        creditElectionCents: 8_000,
      }),
    ).resolves.toBeNull();
    expect(fixture.bookingRow.creditElectionCents).toBe(3_000);
  });
});
