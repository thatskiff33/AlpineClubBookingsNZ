/**
 * A cancellation's lines (#3611, design §5.1): the stay, the live stand-ins and
 * — where the club kept less than them — the change fees reversed, and what the
 * club keeps posted as one CANCELLATION_FEE. For every fixture, `owed(b)` is
 * zero once the refund, credit or hand-back that follows has posted its own
 * settlement line (§5.2). The kept figure comes from `paidCancellationMoney`,
 * the paid cancel path's own call, on the policy's real functions; the matrix
 * covers each review-share direction against each route its money moved by.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: log }));

import { bookingLedgerBalance } from "@/lib/booking-ledger-balance";
import { planCancellationChargeLines } from "@/lib/booking-ledger-cancellation-posting";
import { postCancellationLedgerLines } from "@/lib/booking-ledger-cancellation-sync";
import { planConfirmationChargeLines } from "@/lib/booking-ledger-confirmation-posting";
import { planAgreedAdjustmentLine, planReviewClosureShareLines } from "@/lib/booking-ledger-modification-posting";
import { postModificationLedgerLines } from "@/lib/booking-ledger-modification-sync";
import { buildBookingLedgerRows, type BookingLedgerPosting } from "@/lib/booking-ledger-write";
import type { ModificationPricingSide } from "@/lib/booking-modification-lines";
import { paidCancellationMoney } from "@/lib/paid-cancellation-money";
import type { CancellationRule } from "@/lib/policies/cancellation";

const D1 = new Date("2026-08-01T00:00:00.000Z");
const D2 = new Date("2026-08-02T00:00:00.000Z");

type Row = ReturnType<typeof buildBookingLedgerRows>[number] & { id: string };

/**
 * The ledger table in memory, with the two unique constraints that matter here
 * enforced the way `ON CONFLICT DO NOTHING` does: a repeated key, or a second
 * reversal of one line, is skipped rather than written.
 */
function ledger() {
  const rows: Row[] = [];
  const insert = (data: ReturnType<typeof buildBookingLedgerRows>) => {
    let count = 0;
    for (const row of data) {
      if (rows.some((r) => r.postingKey === row.postingKey)) continue;
      if (row.reversesLineId && rows.some((r) => r.reversesLineId === row.reversesLineId)) continue;
      rows.push({ ...row, id: `line:${row.postingKey}` } as Row);
      count += 1;
    }
    return count;
  };
  const store = {
    bookingLedgerLine: {
      findFirst: vi.fn(async ({ where }: { where: { bookingId: string; anchorKind: string } }) =>
        rows.find((r) => r.bookingId === where.bookingId && r.anchorKind === where.anchorKind) ? { id: "x" } : null,
      ),
      findMany: vi.fn(async ({ where }: { where: { bookingId: string; kind: { in: string[] } } }) =>
        rows
          .filter((r) => r.bookingId === where.bookingId && where.kind.in.includes(r.kind))
          .map((r) => ({ ...r, reversesLineId: r.reversesLineId ?? null })),
      ),
      createMany: vi.fn(async ({ data }: { data: ReturnType<typeof buildBookingLedgerRows> }) => ({
        count: insert(data),
      })),
    },
  };
  return { rows, insert, store: store as never };
}

function settlement(posting: Omit<BookingLedgerPosting, "bookingId" | "lodgeId" | "side" | "quantity">) {
  return buildBookingLedgerRows([{ bookingId: "b1", lodgeId: "l1", side: "SETTLEMENT", quantity: 1, ...posting }]);
}
const capture = (cents: number) =>
  settlement({ kind: "CARD_CAPTURE", sign: 1, unitCents: cents, anchorKind: "PAYMENT_TRANSACTION", anchorId: "t1", settlementMethod: "CARD", narration: "Card", postingKey: "capture:t1" });
const cash = (cents: number) =>
  settlement({ kind: "CASH_RECORDED", sign: 1, unitCents: cents, anchorKind: "PAYMENT_TRANSACTION", anchorId: "t1", settlementMethod: "CASH", narration: "Cash", postingKey: "capture:t1" });
const creditApplied = (cents: number) =>
  settlement({ kind: "CREDIT_APPLIED", sign: 1, unitCents: cents, anchorKind: "MEMBER_CREDIT", anchorId: "c1", settlementMethod: "ACCOUNT_CREDIT", narration: "Credit", postingKey: "credit:c1" });
const cardRefund = (cents: number) =>
  settlement({ kind: "CARD_REFUND", sign: -1, unitCents: cents, anchorKind: "PAYMENT_REFUND", anchorId: "r1", settlementMethod: "CARD", narration: "Refund", postingKey: "refund:r1" });
const creditIssued = (cents: number, key: string) =>
  settlement({ kind: "CREDIT_ISSUED", sign: -1, unitCents: cents, anchorKind: "CANCELLATION", anchorId: "b1", settlementMethod: "ACCOUNT_CREDIT", narration: "Credit", postingKey: key });
const handBack = (cents: number) =>
  settlement({ kind: "BANK_REFUND", sign: -1, unitCents: cents, anchorKind: "REVIEW_TASK", anchorId: "task", settlementMethod: "INTERNET_BANKING", narration: "Hand-back", postingKey: "handback:task" });

/** Two adults, two nights each at $50, and the promotion given; confirmed on the ledger. */
function confirm(book: ReturnType<typeof ledger>, promoAdjustmentCents = 0): void {
  const plan = planConfirmationChargeLines({
    id: "b1",
    lodgeId: "l1",
    totalPriceCents: 20_000,
    promoAdjustmentCents,
    guests: ["g1", "g2"].map((id) => ({
      id,
      firstName: "Guest",
      lastName: id,
      ageTier: "ADULT" as const,
      rateMembershipTypeId: "rate-m",
      nights: [
        { stayDate: D1, priceCents: 5_000 },
        { stayDate: D2, priceCents: 5_000 },
      ],
    })),
  });
  book.insert(buildBookingLedgerRows(plan.postings));
}

const owed = (rows: readonly Row[]) => bookingLedgerBalance(rows).owedCents;

const FIFTY: CancellationRule[] = [
  { daysBeforeStay: 30, refundPercentage: 100 },
  { daysBeforeStay: 7, refundPercentage: 50, fixedFeeCents: 2_000 },
  { daysBeforeStay: 0, refundPercentage: 0 },
];

/** The paid cancel path's own call (`booking-cancel.ts`), on one payment. */
function paidCancel(payment: {
  amountCents: number;
  refundedAmountCents?: number;
  creditAppliedCents: number;
  changeFeeCents: number;
  finalPriceCents: number;
  days: number;
  refundMethod: "card" | "credit";
  policy?: CancellationRule[];
}) {
  const money = paidCancellationMoney({
    payment: {
      amountCents: payment.amountCents,
      refundedAmountCents: payment.refundedAmountCents ?? 0,
      changeFeeCents: payment.changeFeeCents,
      creditAppliedCents: payment.creditAppliedCents,
    },
    finalPriceCents: payment.finalPriceCents,
    appliedCreditCents: payment.creditAppliedCents,
    restoresToMemberLedger: true,
    days: payment.days,
    policy: payment.policy ?? FIFTY,
    refundMethod: payment.refundMethod,
    // #3809: no edit ran through the give-back, so main's uncapped credit (`INV-PAY-115`).
    capAppliedCredit: false,
  });
  return {
    refundAmountCents: money.refundAmountCents,
    creditRestoredCents: money.creditRestoredCents,
    keptCents: money.ledgerKeptCents,
  };
}

async function cancel(book: ReturnType<typeof ledger>, keptCents: number): Promise<void> {
  await postCancellationLedgerLines({ store: book.store, bookingId: "b1", lodgeId: "l1", keptCents, site: "test" });
}

function chargeLinesOf(book: ReturnType<typeof ledger>) {
  return book.rows
    .filter((r) => ["GUEST_NIGHT", "PROMOTION", "CHANGE_FEE"].includes(r.kind))
    .map((r) => ({ ...r, reversesLineId: r.reversesLineId ?? null })) as never;
}

const changeFeeLine = (cents: number, modId: string) =>
  buildBookingLedgerRows([
    { bookingId: "b1", lodgeId: "l1", side: "CHARGE", kind: "CHANGE_FEE", sign: 1, quantity: 1, unitCents: cents, anchorKind: "MODIFICATION", anchorId: modId, narration: "Change fee", postingKey: `modification:${modId}:change-fee` },
  ]);

describe("planCancellationChargeLines", () => {
  it("reverses every live night and promotion line and posts one fee, all anchored on the cancellation", () => {
    const book = ledger();
    confirm(book, -2_000);
    const plan = planCancellationChargeLines({ bookingId: "b1", lodgeId: "l1", keptCents: 9_000, chargeLines: chargeLinesOf(book), adjustmentLines: [] });
    expect(plan.kind).toBe("lines");
    if (plan.kind !== "lines") return;
    expect(plan.postings.filter((p) => p.reversesLineId)).toHaveLength(5);
    expect(new Set(plan.postings.map((p) => p.anchorKind))).toEqual(new Set(["CANCELLATION"]));
    expect(plan.postings.find((p) => p.kind === "CANCELLATION_FEE")).toMatchObject({
      side: "CHARGE",
      sign: 1,
      unitCents: 9_000,
      anchorId: "b1",
      narration: "Cancellation fee retained",
      postingKey: "cancellation:b1:fee",
    });
    expect(plan.postings.filter((p) => p.reversesLineId).every((p) => p.postingKey === `reversal:${p.reversesLineId}`)).toBe(true);
  });

  it("keeps a change fee the kept figure covers, and takes back one it does not", () => {
    const book = ledger();
    book.insert(changeFeeLine(1_500, "mod-1"));
    const plan = (keptCents: number) =>
      planCancellationChargeLines({ bookingId: "b1", lodgeId: "l1", keptCents, chargeLines: chargeLinesOf(book), adjustmentLines: [] });
    expect(plan(1_500)).toMatchObject({ cancellationFeeCents: 0, changeFeesReversed: false, postings: [] });
    expect(plan(1_499)).toMatchObject({ cancellationFeeCents: 1_499, changeFeesReversed: true });
  });

  it("D1: names the kept line by what it holds — the decision's narration only where it is the policy's own figure", () => {
    const fee = (keptCents: number, policyKeptCents?: number) => {
      const plan = planCancellationChargeLines({ bookingId: "b1", lodgeId: "l1", keptCents, ...(policyKeptCents === undefined ? {} : { policyKeptCents }), chargeLines: [], adjustmentLines: [] });
      return plan.kind === "lines" ? plan.postings.find((p) => p.kind === "CANCELLATION_FEE") : undefined;
    };
    expect(fee(5_000)?.narration).toBe("Cancellation fee retained");
    expect(fee(5_000, 5_000)?.narration).toBe("Cancellation fee retained");
    expect(fee(8_000, 5_000)).toMatchObject({ unitCents: 8_000, narration: "Cancellation: amount retained (policy fee plus earlier charges)" });
    expect(fee(4_000, 5_000)).toMatchObject({ unitCents: 4_000, narration: "Cancellation: amount retained (less than the policy fee)" });
  });

  it("posts no fee when the club keeps nothing, and nothing at all for a negative kept figure", () => {
    expect(planCancellationChargeLines({ bookingId: "b1", lodgeId: "l1", keptCents: 0, chargeLines: [], adjustmentLines: [] })).toEqual({
      kind: "lines",
      postings: [],
      cancellationFeeCents: 0,
      changeFeesReversed: false,
    });
    expect(planCancellationChargeLines({ bookingId: "b1", lodgeId: "l1", keptCents: -1, chargeLines: [], adjustmentLines: [] })).toEqual({
      kind: "none",
      reason: "INVALID_KEPT_AMOUNT",
    });
  });
});

describe("postCancellationLedgerLines: owed(b) is zero once the settlement lines post", () => {
  it("WORKED EXAMPLE — 50% tier, card: $200 paid, $80 refunded ($100 less the $20 fee), $120 kept", async () => {
    const book = ledger();
    confirm(book);
    book.insert(capture(20_000));
    const { refundAmountCents, keptCents } = paidCancel({ amountCents: 20_000, creditAppliedCents: 0, changeFeeCents: 0, finalPriceCents: 20_000, days: 10, refundMethod: "card" });
    expect([refundAmountCents, keptCents]).toEqual([8_000, 12_000]);
    await cancel(book, keptCents);
    book.insert(cardRefund(refundAmountCents));
    expect(bookingLedgerBalance(book.rows)).toEqual({ chargedCents: 12_000, settledCents: 12_000, adjustedCents: 0, owedCents: 0 });
  });

  it("50% tier refunded as account credit: CREDIT_ISSUED settles it", async () => {
    const book = ledger();
    confirm(book);
    book.insert(capture(20_000));
    const { refundAmountCents, keptCents } = paidCancel({ amountCents: 20_000, creditAppliedCents: 0, changeFeeCents: 0, finalPriceCents: 20_000, days: 10, refundMethod: "credit" });
    await cancel(book, keptCents);
    book.insert(creditIssued(refundAmountCents, "credit:cancellation-refund"));
    expect(owed(book.rows)).toBe(0);
  });

  it("cash settled, handed back by an officer: BANK_REFUND settles it", async () => {
    const book = ledger();
    confirm(book);
    book.insert(cash(20_000));
    const { refundAmountCents, keptCents } = paidCancel({ amountCents: 20_000, creditAppliedCents: 0, changeFeeCents: 0, finalPriceCents: 20_000, days: 10, refundMethod: "credit" });
    await cancel(book, keptCents);
    book.insert(handBack(refundAmountCents));
    expect(owed(book.rows)).toBe(0);
  });

  it("card and applied credit: the fee is taken once, card-first, and the tiered restore settles the credit slice", async () => {
    const book = ledger();
    confirm(book);
    book.insert(capture(15_000));
    book.insert(creditApplied(5_000));
    const r = paidCancel({ amountCents: 15_000, creditAppliedCents: 5_000, changeFeeCents: 0, finalPriceCents: 20_000, days: 10, refundMethod: "card" });
    expect(r).toEqual({ refundAmountCents: 5_500, creditRestoredCents: 2_500, keptCents: 12_000 });
    await cancel(book, r.keptCents);
    book.insert(cardRefund(r.refundAmountCents));
    book.insert(creditIssued(r.creditRestoredCents, "credit:restore"));
    expect(owed(book.rows)).toBe(0);
  });

  it("a 0% tier keeps everything and a 100% tier keeps nothing (no fee line)", async () => {
    for (const [days, refund, kept] of [[1, 0, 20_000], [40, 20_000, 0]] as const) {
      const book = ledger();
      confirm(book);
      book.insert(capture(20_000));
      const r = paidCancel({ amountCents: 20_000, creditAppliedCents: 0, changeFeeCents: 0, finalPriceCents: 20_000, days, refundMethod: "card" });
      expect([r.refundAmountCents, r.keptCents]).toEqual([refund, kept]);
      await cancel(book, r.keptCents);
      if (refund > 0) book.insert(cardRefund(refund));
      expect(owed(book.rows)).toBe(0);
      expect(book.rows.some((row) => row.kind === "CANCELLATION_FEE")).toBe(kept > 0);
    }
  });

  it("the promotion is taken back with the stay", async () => {
    const book = ledger();
    confirm(book, -2_000);
    book.insert(capture(18_000));
    const r = paidCancel({ amountCents: 18_000, creditAppliedCents: 0, changeFeeCents: 0, finalPriceCents: 18_000, days: 10, refundMethod: "card" });
    await cancel(book, r.keptCents);
    book.insert(cardRefund(r.refundAmountCents));
    expect(owed(book.rows)).toBe(0);
  });

  it("AFTER AN EDIT: the edit's re-post is reversed, never the line it already reversed; its change fee stays, and the fee is what was kept beyond it", async () => {
    const book = ledger();
    confirm(book);
    // Edit: g1's second night repriced $50 -> $60, with a $15 change fee; the member pays both.
    const guest = (id: string, second: number): ModificationPricingSide["guests"][number] => ({
      guestKey: id,
      ageTier: "ADULT",
      isMember: true,
      rateMembershipTypeId: "rate-m",
      name: `Guest ${id}`,
      nights: [
        { stayDate: D1, priceCents: 5_000, priceSource: "SOLD" },
        { stayDate: D2, priceCents: second, priceSource: "SOLD" },
      ],
    });
    await postModificationLedgerLines({
      store: book.store,
      bookingId: "b1",
      lodgeId: "l1",
      bookingModification: { id: "mod-1", priceDiffCents: 1_000, changeFeeCents: 1_500 },
      sides: {
        before: { guests: [guest("g1", 5_000), guest("g2", 5_000)], promoAdjustmentCents: 0 },
        after: { guests: [guest("g1", 6_000), guest("g2", 5_000)], promoAdjustmentCents: 0 },
      },
      site: "test",
    });
    expect(book.rows.filter((row) => row.reversesLineId)).toHaveLength(1);
    book.insert(capture(22_500));
    const r = paidCancel({ amountCents: 22_500, creditAppliedCents: 0, changeFeeCents: 1_500, finalPriceCents: 21_000, days: 10, refundMethod: "card" });
    await cancel(book, r.keptCents);
    book.insert(cardRefund(r.refundAmountCents));

    const targets = book.rows.flatMap((row) => (row.reversesLineId ? [row.reversesLineId] : []));
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets).toContain("line:modification:mod-1:night:g1:2026-08-02");
    expect(book.rows.filter((row) => row.kind === "GUEST_NIGHT")).toHaveLength(4 + 2 + 4);
    expect(book.rows.filter((row) => row.kind === "CHANGE_FEE")).toHaveLength(1);
    expect(book.rows.find((row) => row.kind === "CANCELLATION_FEE")?.amountCents).toBe(r.keptCents - 1_500);
    expect(owed(book.rows)).toBe(0);
  });

  it("F3 — KEPT BELOW THE CHANGE FEE: $200 stay, $150 credit + $50 card, a $100 change fee never paid, 100% tier: the change fee is reversed and the fee is the $50 kept", async () => {
    const book = ledger();
    confirm(book);
    book.insert(capture(5_000));
    book.insert(creditApplied(15_000));
    book.insert(changeFeeLine(10_000, "mod-f3"));
    const r = paidCancel({ amountCents: 5_000, creditAppliedCents: 15_000, changeFeeCents: 10_000, finalPriceCents: 20_000, days: 10, refundMethod: "card", policy: [{ daysBeforeStay: 0, refundPercentage: 100 }] });
    expect(r).toEqual({ refundAmountCents: 0, creditRestoredCents: 15_000, keptCents: 5_000 });
    await cancel(book, r.keptCents);
    book.insert(creditIssued(r.creditRestoredCents, "credit:restore"));
    expect(book.rows.some((row) => row.kind === "CHANGE_FEE" && row.reversesLineId === "line:modification:mod-f3:change-fee")).toBe(true);
    expect(book.rows.find((row) => row.kind === "CANCELLATION_FEE")?.amountCents).toBe(5_000);
    expect(owed(book.rows)).toBe(0);
  });

  it("D1: the sync carries the policy figure through, so a kept line holding more than the fee is named for what it is", async () => {
    const book = ledger();
    confirm(book);
    await postCancellationLedgerLines({ store: book.store, bookingId: "b1", lodgeId: "l1", keptCents: 8_000, policyKeptCents: 5_000, site: "test" });
    expect(book.rows.find((row) => row.kind === "CANCELLATION_FEE")).toMatchObject({
      amountCents: 8_000,
      narration: "Cancellation: amount retained (policy fee plus earlier charges)",
    });
  });

  it("a replayed cancellation posts nothing new", async () => {
    const book = ledger();
    confirm(book);
    await cancel(book, 12_000);
    const count = book.rows.length;
    await cancel(book, 12_000);
    expect(book.rows).toHaveLength(count);
  });
});

/**
 * F1: a review share whose money the charge lines did not carry stands on the
 * ledger as a live AGREED_ADJUSTMENT (§5.3). Every refund route with a captured
 * payment raises the mirror's refunded total by the share exactly as it moves
 * the ledger (the account-credit route through its own allocation), and a
 * captured charge share lands in `amountCents`; so reversing the stand-in and
 * keeping what `paidCancellationMoney` says zeroes every combination.
 */
describe("a live review-share stand-in at cancellation (review F1): owed(b) is zero for every direction and route", () => {
  const SHARE = 3_000;
  const standIn = (direction: "REFUND_TO_MEMBER" | "CHARGE_TO_MEMBER") =>
    buildBookingLedgerRows([
      planAgreedAdjustmentLine({ bookingId: "b1", lodgeId: "l1", manualRefundTaskId: "task-share", direction, amountCents: SHARE, note: "share", officerMemberId: "officer" }),
    ]);
  const shareRefund = {
    card: () => settlement({ kind: "CARD_REFUND", sign: -1, unitCents: SHARE, anchorKind: "PAYMENT_REFUND", anchorId: "r-share", settlementMethod: "CARD", narration: "Share", postingKey: "refund:r-share" }),
    "hand-back": () => settlement({ kind: "BANK_REFUND", sign: -1, unitCents: SHARE, anchorKind: "REVIEW_TASK", anchorId: "task-share", settlementMethod: "INTERNET_BANKING", narration: "Share", postingKey: "handback:task-share" }),
    "account credit": () => settlement({ kind: "CREDIT_ISSUED", sign: -1, unitCents: SHARE, anchorKind: "MEMBER_CREDIT", anchorId: "c-share", settlementMethod: "ACCOUNT_CREDIT", narration: "Share", postingKey: "credit:c-share" }),
  };

  for (const [route, post] of Object.entries(shareRefund)) {
    for (const refundMethod of ["card", "credit"] as const) {
      it(`REFUND_TO_MEMBER, share returned by ${route}, cancellation refunded by ${refundMethod}`, async () => {
        const book = ledger();
        confirm(book);
        book.insert(route === "hand-back" ? cash(20_000) : capture(20_000));
        book.insert(standIn("REFUND_TO_MEMBER"));
        book.insert(post());
        const r = paidCancel({ amountCents: 20_000, refundedAmountCents: SHARE, creditAppliedCents: 0, changeFeeCents: 0, finalPriceCents: 20_000, days: 10, refundMethod });
        await cancel(book, r.keptCents);
        const cancelRefund =
          refundMethod === "credit"
            ? creditIssued(r.refundAmountCents, "credit:cancel")
            : route === "hand-back"
              ? handBack(r.refundAmountCents)
              : cardRefund(r.refundAmountCents);
        book.insert(cancelRefund);
        expect(book.rows.some((row) => row.kind === "AGREED_ADJUSTMENT" && row.reversesLineId === "line:agreed-adjustment:task-share")).toBe(true);
        expect(owed(book.rows)).toBe(0);
      });
    }
  }

  it("CHARGE_TO_MEMBER, ask unpaid at the cancel (the cancel fails it)", async () => {
    const book = ledger();
    confirm(book);
    book.insert(capture(20_000));
    book.insert(standIn("CHARGE_TO_MEMBER"));
    const r = paidCancel({ amountCents: 20_000, creditAppliedCents: 0, changeFeeCents: 0, finalPriceCents: 20_000, days: 10, refundMethod: "card" });
    await cancel(book, r.keptCents);
    book.insert(cardRefund(r.refundAmountCents));
    expect(owed(book.rows)).toBe(0);
  });

  const askPaid = {
    card: () => settlement({ kind: "CARD_CAPTURE", sign: 1, unitCents: SHARE, anchorKind: "PAYMENT_TRANSACTION", anchorId: "t-ask", settlementMethod: "CARD", narration: "Ask", postingKey: "capture:t-ask" }),
    "internet banking": () => settlement({ kind: "BANK_RECEIPT", sign: 1, unitCents: SHARE, anchorKind: "PAYMENT_TRANSACTION", anchorId: "t-ask", settlementMethod: "INTERNET_BANKING", narration: "Ask", postingKey: "capture:t-ask" }),
  };
  for (const [paidBy, line] of Object.entries(askPaid)) {
    it(`CHARGE_TO_MEMBER, ask paid by ${paidBy}: the refundable base leaves the share out, so the club keeps it`, async () => {
      const book = ledger();
      confirm(book);
      book.insert(capture(20_000));
      book.insert(standIn("CHARGE_TO_MEMBER"));
      book.insert(line());
      const r = paidCancel({ amountCents: 20_000 + SHARE, creditAppliedCents: 0, changeFeeCents: 0, finalPriceCents: 20_000, days: 10, refundMethod: "card" });
      await cancel(book, r.keptCents);
      book.insert(cardRefund(r.refundAmountCents));
      expect(owed(book.rows)).toBe(0);
    });
  }
});

describe("postCancellationLedgerLines: what keeps nothing", () => {
  it("a booking cancelled before it was confirmed on the ledger posts nothing", async () => {
    // A kept figure offered, so only the confirmation fence can stop a fee.
    const book = ledger();
    await cancel(book, 5_000);
    expect(book.rows).toEqual([]);
  });

  it("UNPAID but confirmed (a mark-paid since reversed): the stay is reversed, no fee, owed is zero", async () => {
    const book = ledger();
    confirm(book);
    book.insert(cash(20_000));
    book.insert(
      settlement({ kind: "CASH_RECORDED", sign: -1, unitCents: 20_000, anchorKind: "PAYMENT_TRANSACTION", anchorId: "t1", settlementMethod: "CASH", narration: "Reversed", postingKey: "reversal:line:capture:t1", reversesLineId: "line:capture:t1" }),
    );
    await cancel(book, 0);
    expect(book.rows.some((row) => row.kind === "CANCELLATION_FEE")).toBe(false);
    expect(owed(book.rows)).toBe(0);
  });

  it("F2 — UNPAID with a live change fee: nothing kept, so the change fee is reversed with the stay", async () => {
    const book = ledger();
    confirm(book);
    book.insert(changeFeeLine(1_500, "mod-f2"));
    await cancel(book, 0);
    expect(book.rows.some((row) => row.reversesLineId === "line:modification:mod-f2:change-fee")).toBe(true);
    expect(owed(book.rows)).toBe(0);
  });

  it("a negative kept figure posts nothing at all and says so", async () => {
    const book = ledger();
    confirm(book);
    const before = book.rows.length;
    await cancel(book, -500);
    expect(book.rows).toHaveLength(before);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "INVALID_KEPT_AMOUNT", site: "test" }),
      expect.stringContaining("#3611"),
    );
  });
});

/**
 * ONE STAND-IN REVERSAL BUILDER (INV-SSOT): a review closure and a cancellation
 * take a live AGREED_ADJUSTMENT back through `agreedAdjustmentReversal`. Each
 * caller's exact output is pinned here, field for field, as #3582's closure
 * wrote it before the builder existed, so a divergence in the builder or in
 * either call fails.
 */
describe("the stand-in reversal both a review closure and a cancellation post", () => {
  const standIn = { id: "line-1", sign: -1 as const, quantity: 1, unitCents: 3_000, narration: "Adjustment agreed with member: share", reversesLineId: null, postingKey: "agreed-adjustment:t1" };

  it("a closure's: anchored on its task, naming the officer", () => {
    expect(
      planReviewClosureShareLines({
        bookingId: "b1",
        lodgeId: "l1",
        manualRefundTaskId: "task-2",
        officerMemberId: "officer",
        note: null,
        settlement: null,
        rebasedFinalPriceCents: 0,
        chargeLinesAfter: [],
        repriceRecordsMovement: false,
        postedAdjustmentLines: [standIn],
      }),
    ).toStrictEqual([
      {
        bookingId: "b1",
        lodgeId: "l1",
        side: "ADJUSTMENT",
        kind: "AGREED_ADJUSTMENT",
        sign: 1,
        quantity: 1,
        unitCents: 3_000,
        anchorKind: "REVIEW_TASK",
        anchorId: "task-2",
        narration: "Reversed: Adjustment agreed with member: share",
        postedByMemberId: "officer",
        reversesLineId: "line-1",
        postingKey: "reversal:line-1",
      },
    ]);
  });

  it("a cancellation's: anchored on the cancellation, naming nobody", () => {
    const plan = planCancellationChargeLines({ bookingId: "b1", lodgeId: "l1", keptCents: 0, chargeLines: [], adjustmentLines: [standIn] });
    expect(plan.kind === "lines" && plan.postings).toStrictEqual([
      {
        bookingId: "b1",
        lodgeId: "l1",
        side: "ADJUSTMENT",
        kind: "AGREED_ADJUSTMENT",
        sign: 1,
        quantity: 1,
        unitCents: 3_000,
        anchorKind: "CANCELLATION",
        anchorId: "b1",
        narration: "Reversed: Adjustment agreed with member: share",
        reversesLineId: "line-1",
        postingKey: "reversal:line-1",
      },
    ]);
  });
});
