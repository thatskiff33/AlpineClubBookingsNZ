import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Prisma } from "@prisma/client";

import { bookingLedgerBalance } from "@/lib/booking-ledger-balance";
import { planCancellationChargeLines } from "@/lib/booking-ledger-cancellation-posting";
import { planConfirmationChargeLines } from "@/lib/booking-ledger-confirmation-posting";
import { planCreditLines, type BookingCreditRow } from "@/lib/booking-ledger-credit-posting";
import {
  liveLines,
  planModificationChargeLines,
  type PostedChargeLine,
} from "@/lib/booking-ledger-modification-posting";
import { planSettlementLines } from "@/lib/booking-ledger-settlement-posting";
import {
  buildBookingLedgerRows,
  ledgerLineAmountCents,
  type BookingLedgerPosting,
} from "@/lib/booking-ledger-write";
import type { ReversibleChargeLine } from "@/lib/booking-ledger-charge-line";
import type { ModificationPricingSide } from "@/lib/booking-modification-lines";

/**
 * A MODEL-BASED TEST OF THE BOOKING LEDGER (#4459, programme #4450).
 *
 * The ledger's planners are pure: each takes a booking's source rows and the
 * lines already posted, and returns what to post. This test drives all five of
 * them (confirmation, edit, cancellation, settlement, credit) through random
 * sequences of the events the issue names, against an in-memory store that
 * behaves like the write door (`INV-MONEY-032`/`033`: append-only, a repeated
 * posting key is skipped, one reversal per line). After EVERY step it asserts
 * the ledger's identities against a model that knows only the events, never the
 * planners' rules:
 *
 *   charged  = what the stay costs now (nights + promotion + change fees),
 *              or what the club kept once cancelled
 *   settled  = captures - recorded refunds + credit consumed - credit issued,
 *              per method
 *   owed     = charged + adjusted - settled
 *
 * plus the structural rules those identities lean on: lines are never edited,
 * a reversal mirrors exactly the line it names, a line is reversed once, and
 * running every sync again posts nothing.
 *
 * The existing property tests (`xero-settlement.property.test.ts`, the pricing
 * and cancellation properties, `src/test/providers/round-trip.test.ts`) check a
 * pure function or a provider fake in one step; none exercises the ledger as a
 * running balance, which is where a wrong reversal or a re-post under a stale
 * key shows up only several events later.
 *
 * Deterministic: the seed is fixed (as the provider round-trip properties pin
 * 4460 and 4461), nothing reads the clock, and nights are fixed UTC dates.
 */

const SEED = 4459;
const GUESTS = ["g0", "g1", "g2"] as const;
const DAYS = 4;
const BOOKING = "booking-1";
const LODGE = "lodge-1";
const OFFICER = "officer-1";

type Method = "CARD" | "INTERNET_BANKING" | "ACCOUNT_CREDIT" | "CASH";
const METHODS: readonly Method[] = ["CARD", "INTERNET_BANKING", "ACCOUNT_CREDIT", "CASH"];
type TxStatus = "SUCCEEDED" | "PARTIALLY_REFUNDED" | "REFUNDED" | "FAILED" | "PENDING";
const CAPTURED: readonly TxStatus[] = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"];
type RefundStatus = "succeeded" | "pending" | "failed" | "canceled";
const RECORDED: readonly RefundStatus[] = ["succeeded", "pending"];
type CreditKind = "APPLY" | "GIVE_BACK" | "MODIFICATION_CREDIT" | "CANCELLATION_CREDIT" | "RESTORE";

/** One cell per guest and night; null is a night the guest does not hold. */
type NightGrid = ReadonlyArray<ReadonlyArray<number | null>>;

const night = (day: number): Date => new Date(Date.UTC(2026, 7, 1 + day));

function sideOf(grid: NightGrid, promoAdjustmentCents: number): ModificationPricingSide {
  return {
    guests: GUESTS.flatMap((key, index) => {
      const nights = grid[index]!.flatMap((price, day) =>
        price === null ? [] : [{ stayDate: night(day), priceCents: price, priceSource: "SOLD" as const }],
      );
      return nights.length === 0
        ? []
        : [
            {
              guestKey: key,
              ageTier: "ADULT" as const,
              isMember: true,
              rateMembershipTypeId: "rate-m",
              name: `Guest ${key}`,
              nights,
            },
          ];
    }),
    promoAdjustmentCents,
  };
}

const sideTotal = (side: ModificationPricingSide): number =>
  side.promoAdjustmentCents +
  side.guests.reduce((sum, guest) => sum + guest.nights.reduce((n, entry) => n + (entry.priceCents ?? 0), 0), 0);

const gridTotal = (grid: NightGrid): number =>
  grid.reduce((sum, row) => sum + row.reduce<number>((rowSum, price) => rowSum + (price ?? 0), 0), 0);

// --- the in-memory ledger: the write door's behaviour, nothing else --------

type StoredLine = {
  id: string;
  side: BookingLedgerPosting["side"];
  kind: BookingLedgerPosting["kind"];
  sign: 1 | -1;
  quantity: number;
  unitCents: number;
  amountCents: number;
  anchorKind: BookingLedgerPosting["anchorKind"];
  anchorId: string;
  narration: string;
  postingKey: string;
  bookingGuestId: string | null;
  nightStart: Date | null;
  nightEndExclusive: Date | null;
  rateMembershipTypeId: string | null;
  ageTier: NonNullable<BookingLedgerPosting["ageTier"]> | null;
  guestNames: string[];
  settlementMethod: Method | null;
  reversesLineId: string | null;
};

function toStored(row: Prisma.BookingLedgerLineCreateManyInput, id: string): StoredLine {
  return {
    id,
    side: row.side,
    kind: row.kind,
    sign: row.sign as 1 | -1,
    quantity: row.quantity,
    unitCents: row.unitCents,
    amountCents: row.amountCents,
    anchorKind: row.anchorKind,
    anchorId: row.anchorId,
    narration: row.narration,
    postingKey: row.postingKey as string,
    bookingGuestId: row.bookingGuestId ?? null,
    nightStart: (row.nightStart as Date | null | undefined) ?? null,
    nightEndExclusive: (row.nightEndExclusive as Date | null | undefined) ?? null,
    rateMembershipTypeId: row.rateMembershipTypeId ?? null,
    ageTier: row.ageTier ?? null,
    guestNames: [...((row.guestNames as string[] | undefined) ?? [])],
    settlementMethod: (row.settlementMethod as Method | null | undefined) ?? null,
    reversesLineId: row.reversesLineId ?? null,
  };
}

class InMemoryLedger {
  lines: StoredLine[] = [];
  /** Each distinct posting ever handed to `post`, for the replay step. */
  readonly everPosted: BookingLedgerPosting[] = [];

  /** `postBookingLedgerLines`: validate in pure code, skip a repeated key, fence one reversal per line. */
  post(postings: readonly BookingLedgerPosting[]): number {
    const rows = buildBookingLedgerRows(postings);
    let inserted = 0;
    for (const row of rows) {
      if (this.lines.some((line) => line.postingKey === row.postingKey)) continue;
      const target = row.reversesLineId ?? null;
      if (target !== null) {
        if (!this.lines.some((line) => line.id === target)) {
          throw new Error(`reversal names line ${target}, which is not on the ledger`);
        }
        if (this.lines.some((line) => line.reversesLineId === target)) {
          throw new Error(`line ${target} is reversed twice (the database's unique reversesLineId)`);
        }
      }
      this.lines.push(toStored(row, `L${this.lines.length + 1}`));
      inserted += 1;
    }
    for (const posting of postings) {
      if (!this.everPosted.some((seen) => seen.postingKey === posting.postingKey)) this.everPosted.push(posting);
    }
    return inserted;
  }

  where(predicate: (line: StoredLine) => boolean): StoredLine[] {
    return this.lines.filter(predicate);
  }
}

// --- the model: what the events mean, in plain sums -------------------------

type Tx = { id: string; source: "STRIPE" | "INTERNET_BANKING"; status: TxStatus; amountCents: number };
type Refund = { id: string; status: RefundStatus; amountCents: number };
type Credit = BookingCreditRow;

class Model {
  confirmed = false;
  cancelled = false;
  keptCents = 0;
  grid: NightGrid = GUESTS.map(() => Array<number | null>(DAYS).fill(null));
  promo = 0;
  changeFees = 0;
  readonly txs: Tx[] = [];
  readonly refunds: Refund[] = [];
  readonly credits: Credit[] = [];
  /** `Payment.manuallyMarkedPaidAt` is set: Internet Banking rows are an officer's cash. */
  constructor(readonly manuallySettled: boolean) {}

  get charged(): number {
    if (this.cancelled) return this.keptCents;
    return this.confirmed ? gridTotal(this.grid) + this.promo + this.changeFees : 0;
  }

  get settled(): Record<Method, number> {
    const totals: Record<Method, number> = { CARD: 0, INTERNET_BANKING: 0, ACCOUNT_CREDIT: 0, CASH: 0 };
    for (const tx of this.txs) {
      if (!CAPTURED.includes(tx.status)) continue;
      const method: Method =
        tx.source === "STRIPE" ? "CARD" : this.manuallySettled ? "CASH" : "INTERNET_BANKING";
      totals[method] += tx.amountCents;
    }
    for (const refund of this.refunds) {
      if (RECORDED.includes(refund.status)) totals.CARD -= refund.amountCents;
    }
    // A credit row is the member's account: consuming it (negative) settles the booking.
    for (const credit of this.credits) totals.ACCOUNT_CREDIT -= credit.amountCents;
    return totals;
  }
}

// --- the system under test: source rows, planners, the store ----------------

class Real {
  readonly ledger = new InMemoryLedger();
  side: ModificationPricingSide = { guests: [], promoAdjustmentCents: 0 };
  modifications = 0;
  nextRow = 0;

  constructor(readonly model: Model) {}

  /** The charge lines a reader selects by kind, as the sync reads them (`booking-ledger-read.ts`). */
  private charge(kinds: ReadonlyArray<ReversibleChargeLine["kind"]>): Array<StoredLine & ReversibleChargeLine> {
    return this.ledger.lines.filter(
      (line): line is StoredLine & ReversibleChargeLine => (kinds as readonly string[]).includes(line.kind),
    );
  }

  confirm(grid: NightGrid, promo: number): void {
    const side = sideOf(grid, promo);
    const plan = planConfirmationChargeLines({
      id: BOOKING,
      lodgeId: LODGE,
      totalPriceCents: gridTotal(grid),
      promoAdjustmentCents: promo,
      guests: side.guests.map((guest) => ({
        id: guest.guestKey,
        firstName: "Guest",
        lastName: guest.guestKey,
        ageTier: guest.ageTier,
        rateMembershipTypeId: guest.rateMembershipTypeId,
        nights: guest.nights.map((n) => ({ stayDate: n.stayDate, priceCents: n.priceCents })),
      })),
    });
    expect(plan.unpricedStrandIds).toEqual([]);
    expect(plan.reconciles).toBe(true);
    this.ledger.post(plan.postings);
    this.side = side;
  }

  edit(grid: NightGrid, promo: number, changeFeeCents: number): void {
    const before = this.side;
    const after = sideOf(grid, promo);
    this.modifications += 1;
    const priceDiff = sideTotal(after) - sideTotal(before);
    const plan = planModificationChargeLines({
      bookingId: BOOKING,
      lodgeId: LODGE,
      bookingModificationId: `mod-${this.modifications}`,
      before,
      after,
      changeFeeCents,
      expectedCents: priceDiff + changeFeeCents,
      postedLines: this.charge(["GUEST_NIGHT", "PROMOTION"]) as PostedChargeLine[],
    });
    // An edit a booking can legitimately make must plan; "none" is a ledger gap.
    expect(plan.kind).toBe("lines");
    if (plan.kind !== "lines") return;
    this.ledger.post(plan.postings);
    this.side = after;
  }

  cancel(keptCents: number): void {
    const plan = planCancellationChargeLines({
      bookingId: BOOKING,
      lodgeId: LODGE,
      keptCents,
      chargeLines: this.charge(["GUEST_NIGHT", "PROMOTION", "CHANGE_FEE"]),
      adjustmentLines: [],
    });
    expect(plan.kind).toBe("lines");
    if (plan.kind !== "lines") return;
    this.ledger.post(plan.postings);
  }

  /** `syncBookingLedgerSettlement`: converge the lines to the payment rows. */
  syncSettlement(): void {
    const input = () => ({
      bookingId: BOOKING,
      lodgeId: LODGE,
      manuallySettled: this.model.manuallySettled,
      manualActorMemberId: OFFICER,
      transactions: this.model.txs.map((tx) => ({ ...tx, source: tx.source, status: tx.status })),
      refunds: this.model.refunds,
      postedLines: this.ledger.where((line) => line.side === "SETTLEMENT"),
    });
    const plan = input();
    const first = planSettlementLines(plan);
    expect(first.amountDrift).toEqual([]);
    this.ledger.post(first.postings);
    // Converged: planning again over the new state posts nothing.
    expect(planSettlementLines(input()).postings).toEqual([]);
  }

  /** `syncBookingLedgerCredits`: one line per booking-linked credit row. */
  syncCredits(): void {
    const input = () => ({
      bookingId: BOOKING,
      lodgeId: LODGE,
      credits: this.model.credits,
      postedLines: this.ledger.where((line) => line.kind === "CREDIT_APPLIED" || line.kind === "CREDIT_ISSUED"),
    });
    const first = planCreditLines(input());
    expect(first.amountDrift).toEqual([]);
    this.ledger.post(first.postings);
    expect(planCreditLines(input()).postings).toEqual([]);
  }
}

// --- the identities, checked after every step -------------------------------

function assertLedger(model: Model, real: Real, previous: readonly StoredLine[]): void {
  const lines = real.ledger.lines;

  // Append-only: nothing already on the ledger changed.
  expect(lines.slice(0, previous.length)).toEqual(previous);

  // Every line's figure is its parts; every key is used once; a line is reversed once.
  const ids = new Set<string>();
  const keys = new Set<string>();
  const reversed = new Map<string, StoredLine>();
  for (const line of lines) {
    expect(line.amountCents).toBe(ledgerLineAmountCents(line));
    expect(keys.has(line.postingKey)).toBe(false);
    keys.add(line.postingKey);
    if (line.reversesLineId !== null) {
      // The reversed line is already on the ledger and is mirrored exactly.
      const original = lines.find((candidate) => candidate.id === line.reversesLineId);
      expect(original, `reversal ${line.id} names an earlier line`).toBeDefined();
      expect(ids.has(line.reversesLineId)).toBe(true);
      expect(reversed.has(line.reversesLineId)).toBe(false);
      reversed.set(line.reversesLineId, line);
      expect(line.amountCents).toBe(-original!.amountCents);
      expect(line.kind).toBe(original!.kind);
      expect(line.side).toBe(original!.side);
      expect(line.settlementMethod).toBe(original!.settlementMethod);
    }
    ids.add(line.id);
  }

  const balance = bookingLedgerBalance(lines);

  // charged: the stay as it stands, or what the club kept once cancelled.
  expect(balance.chargedCents).toBe(model.charged);
  // ...and it is also exactly what the lines that still stand add up to.
  const standing = liveLines(lines.filter((line) => line.side === "CHARGE"));
  expect(standing.reduce((sum, line) => sum + line.amountCents, 0)).toBe(model.charged);

  // settled: per method, from the events alone.
  const expected = model.settled;
  for (const method of METHODS) {
    const posted = lines
      .filter((line) => line.side === "SETTLEMENT" && line.settlementMethod === method)
      .reduce((sum, line) => sum + line.amountCents, 0);
    expect(posted, `settled via ${method}`).toBe(expected[method]);
  }
  const settledTotal = METHODS.reduce((sum, method) => sum + expected[method], 0);
  expect(balance.settledCents).toBe(settledTotal);

  // No event here moves an agreed adjustment; the identity of the balance holds.
  expect(balance.adjustedCents).toBe(0);
  expect(balance.owedCents).toBe(model.charged - settledTotal);
}

// --- the commands ------------------------------------------------------------

type Cmd = fc.Command<Model, Real>;

/** Every command ends the same way, so no step can skip the identities. */
function step(model: Model, real: Real, act: () => void): void {
  const previous = real.ledger.lines.map((line) => ({ ...line }));
  act();
  assertLedger(model, real, previous);
}

class ConfirmCmd implements Cmd {
  constructor(
    readonly grid: NightGrid,
    readonly promo: number,
  ) {}
  check = (model: Readonly<Model>) => !model.confirmed;
  run(model: Model, real: Real) {
    step(model, real, () => {
      real.confirm(this.grid, this.promo);
      model.confirmed = true;
      model.grid = this.grid;
      model.promo = this.promo;
    });
  }
  toString = () => `confirm(${gridTotal(this.grid)} cents, promo ${this.promo})`;
}

class EditCmd implements Cmd {
  constructor(
    readonly grid: NightGrid,
    readonly promo: number,
    readonly changeFeeCents: number,
  ) {}
  check = (model: Readonly<Model>) => model.confirmed && !model.cancelled;
  run(model: Model, real: Real) {
    step(model, real, () => {
      real.edit(this.grid, this.promo, this.changeFeeCents);
      model.grid = this.grid;
      model.promo = this.promo;
      model.changeFees += this.changeFeeCents;
    });
  }
  toString = () => `edit(${gridTotal(this.grid)} cents, promo ${this.promo}, fee ${this.changeFeeCents})`;
}

class CancelCmd implements Cmd {
  constructor(readonly keptCents: number) {}
  check = (model: Readonly<Model>) => model.confirmed && !model.cancelled;
  run(model: Model, real: Real) {
    step(model, real, () => {
      real.cancel(this.keptCents);
      model.cancelled = true;
      model.keptCents = this.keptCents;
    });
  }
  toString = () => `cancel(keep ${this.keptCents})`;
}

class CaptureCmd implements Cmd {
  constructor(
    readonly source: Tx["source"],
    readonly amountCents: number,
  ) {}
  check = () => true;
  run(model: Model, real: Real) {
    step(model, real, () => {
      model.txs.push({
        id: `tx-${model.txs.length + 1}`,
        source: this.source,
        status: "SUCCEEDED",
        amountCents: this.amountCents,
      });
      real.syncSettlement();
    });
  }
  toString = () => `capture(${this.source}, ${this.amountCents})`;
}

/** A mark-paid reversed, a refund recorded on the row, a row paid again through Xero. */
class TxStatusCmd implements Cmd {
  constructor(
    readonly pick: number,
    readonly status: TxStatus,
  ) {}
  check = (model: Readonly<Model>) => model.txs.length > 0;
  run(model: Model, real: Real) {
    step(model, real, () => {
      model.txs[this.pick % model.txs.length]!.status = this.status;
      real.syncSettlement();
    });
  }
  toString = () => `txStatus(#${this.pick}, ${this.status})`;
}

class RefundCmd implements Cmd {
  constructor(
    readonly amountCents: number,
    readonly status: RefundStatus,
  ) {}
  check = () => true;
  run(model: Model, real: Real) {
    step(model, real, () => {
      model.refunds.push({ id: `rf-${model.refunds.length + 1}`, status: this.status, amountCents: this.amountCents });
      real.syncSettlement();
    });
  }
  toString = () => `refund(${this.amountCents}, ${this.status})`;
}

/** A refund Stripe later fails, or accepts after it was pending. */
class RefundStatusCmd implements Cmd {
  constructor(
    readonly pick: number,
    readonly status: RefundStatus,
  ) {}
  check = (model: Readonly<Model>) => model.refunds.length > 0;
  run(model: Model, real: Real) {
    step(model, real, () => {
      model.refunds[this.pick % model.refunds.length]!.status = this.status;
      real.syncSettlement();
    });
  }
  toString = () => `refundStatus(#${this.pick}, ${this.status})`;
}

class CreditCmd implements Cmd {
  constructor(
    readonly kind: CreditKind,
    readonly amountCents: number,
  ) {}
  check = () => true;
  run(model: Model, real: Real) {
    step(model, real, () => {
      real.nextRow += 1;
      const id = `credit-${real.nextRow}`;
      const row: Credit = (() => {
        switch (this.kind) {
          case "APPLY":
            return { id, type: "BOOKING_APPLIED", amountCents: -this.amountCents, description: null, restoredFromBookingId: null };
          case "GIVE_BACK":
            return { id, type: "BOOKING_APPLIED", amountCents: this.amountCents, description: null, restoredFromBookingId: null };
          case "MODIFICATION_CREDIT":
            return { id, type: "BOOKING_MODIFICATION_REFUND", amountCents: this.amountCents, description: null, restoredFromBookingId: null };
          case "CANCELLATION_CREDIT":
            return { id, type: "CANCELLATION_REFUND", amountCents: this.amountCents, description: null, restoredFromBookingId: null };
          case "RESTORE":
            return { id, type: "CANCELLATION_REFUND", amountCents: this.amountCents, description: null, restoredFromBookingId: BOOKING };
        }
      })();
      model.credits.push(row);
      real.syncCredits();
    });
  }
  toString = () => `credit(${this.kind}, ${this.amountCents})`;
}

/** Every sync run again, and every posting ever made posted again: nothing changes. */
class ReplayCmd implements Cmd {
  check = () => true;
  run(model: Model, real: Real) {
    step(model, real, () => {
      real.syncSettlement();
      real.syncCredits();
      expect(real.ledger.post([...real.ledger.everPosted])).toBe(0);
    });
  }
  toString = () => "replay()";
}

// --- arbitraries -------------------------------------------------------------

const price = fc.integer({ min: 0, max: 40_000 });
const gridArb: fc.Arbitrary<NightGrid> = fc.array(
  fc.array(fc.option(price, { nil: null, freq: 3 }), { minLength: DAYS, maxLength: DAYS }),
  { minLength: GUESTS.length, maxLength: GUESTS.length },
);
const promoArb = fc.integer({ min: -10_000, max: 3_000 });
// 1 is the smallest fee a posting can carry; 0 posts none.
const feeArb = fc.oneof(fc.constant(0), fc.constant(1), fc.integer({ min: 2, max: 8_000 }));
const centsArb = fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 60_000 }));
const pickArb = fc.nat(50);
const txStatusArb = fc.constantFrom<TxStatus>("SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED", "FAILED", "PENDING");
const refundStatusArb = fc.constantFrom<RefundStatus>("succeeded", "pending", "failed", "canceled");
const creditKindArb = fc.constantFrom<CreditKind>(
  "APPLY",
  "GIVE_BACK",
  "MODIFICATION_CREDIT",
  "CANCELLATION_CREDIT",
  "RESTORE",
);

const commandsArb = fc.commands<Model, Real>(
  [
    fc.tuple(gridArb, promoArb).map(([grid, promo]) => new ConfirmCmd(grid, promo)),
    fc.tuple(gridArb, promoArb, feeArb).map(([grid, promo, fee]) => new EditCmd(grid, promo, fee)),
    fc.tuple(gridArb, promoArb, feeArb).map(([grid, promo, fee]) => new EditCmd(grid, promo, fee)),
    centsArb.map((kept) => new CancelCmd(kept)),
    fc.tuple(fc.constantFrom<Tx["source"]>("STRIPE", "INTERNET_BANKING"), centsArb).map(([s, c]) => new CaptureCmd(s, c)),
    fc.tuple(pickArb, txStatusArb).map(([p, s]) => new TxStatusCmd(p, s)),
    fc.tuple(centsArb, refundStatusArb).map(([c, s]) => new RefundCmd(c, s)),
    fc.tuple(pickArb, refundStatusArb).map(([p, s]) => new RefundStatusCmd(p, s)),
    fc.tuple(creditKindArb, centsArb).map(([k, c]) => new CreditCmd(k, c)),
    fc.constant(new ReplayCmd()),
  ],
  { maxCommands: 40 },
);

describe("booking ledger model-based properties", () => {
  it("holds the ledger identities after every step of a random booking, edit, payment, refund and credit history", () => {
    fc.assert(
      fc.property(fc.boolean(), commandsArb, (manuallySettled, commands) => {
        const setup = () => {
          const model = new Model(manuallySettled);
          return { model, real: new Real(model) };
        };
        fc.modelRun(setup, commands);
      }),
      { seed: SEED, numRuns: 150 },
    );
  });

  it("settles a witness history to known figures: confirm, edit, pay, refund, fail the refund, cancel", () => {
    // The same machinery, one hand-written path, so a failure here names the step
    // without a shrunk counterexample, and the model's own sums are pinned.
    const model = new Model(false);
    const real = new Real(model);
    const grid: NightGrid = [[5_000, 5_000, null, null], [5_000, 5_000, null, null], [null, null, null, null]];
    const commands: Cmd[] = [
      new ConfirmCmd(grid, -2_000),
      new CaptureCmd("STRIPE", 18_000),
      new EditCmd([[5_000, 6_000, 6_000, null], [5_000, 5_000, null, null], [null, null, null, null]], -2_000, 1_500),
      new CaptureCmd("INTERNET_BANKING", 3_500),
      new RefundCmd(4_000, "succeeded"),
      new RefundStatusCmd(0, "failed"),
      new CreditCmd("APPLY", 2_000),
      new TxStatusCmd(1, "FAILED"),
      new TxStatusCmd(1, "SUCCEEDED"),
      new CancelCmd(7_000),
      new ReplayCmd(),
    ];
    for (const command of commands) {
      expect(command.check(model)).toBe(true);
      command.run(model, real);
    }
    // Cancelled: the club keeps 7,000; 18,000 card + 3,500 bank + 2,000 credit settled it.
    const balance = bookingLedgerBalance(real.ledger.lines);
    expect(balance).toEqual({ chargedCents: 7_000, settledCents: 23_500, adjustedCents: 0, owedCents: -16_500 });
  });
});
