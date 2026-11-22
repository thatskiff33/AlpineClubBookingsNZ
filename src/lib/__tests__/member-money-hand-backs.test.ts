/**
 * Unit witnesses for M4d's hand-back engine (#4516): R05 for a hand-back task, R14 when it is marked paid (applied to
 * its R05, unapplied without one, the excess on the receivable), the late-capture keep and its reversal. The real plan
 * builder, store and engine run against the in-memory journal (`support/member-money-memory-db.ts`);
 * `member-money-hand-backs.realdb.test.ts` proves the completion door, and its refused dismissal, against PostgreSQL.
 */
import { describe, expect, it, vi } from "vitest";
import logger from "@/lib/logger";
import { memberMoneyEventKeys as keys, postMemberMoneyEvent, type MemberMoneyDebtor } from "@/lib/member-money";
import { postBookingReceipts, postHandBackObligation, postHandBackPayment, postKeptCapture, reverseKeptCapture, withdrawRefundObligation } from "@/lib/member-money/doors";
import { memberMoneyApplicationTotals, memberMoneyConservationProblems } from "@/lib/member-money/internal/application-state";
import { MemberMoneyMemoryDb } from "./support/member-money-memory-db";
import { memberMoneyTestContext, MEMBER_MONEY_TEST_TAX_ANCHOR } from "./support/member-money-fixtures";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "./helpers/clock";
import { CLUB_TAX_SETTINGS_DEFAULTS } from "@/lib/club-tax-settings";
import { requireCalendarDate } from "@/lib/club-time";

const context = memberMoneyTestContext();
const INACTIVE = { inactive: "unusable-currency", detail: "test club's currency cannot be charged" } as const;
const LODGE = "lodge";
const A = "member-a";
const OFFICER = "officer";
const TASK = "task-1";

/** A paid booking: R01 10000 and one capture collected by its R06; `cancel` posts a synthetic R04 keeping `kept`. */
async function setup() {
  const db = new MemberMoneyMemoryDb();
  const id = "booking";
  const owner: MemberMoneyDebtor = { kind: "MEMBER", memberId: A };
  const at = { bookingId: id, lodgeId: LODGE };
  db.seed("booking", { id, lodgeId: LODGE, createdAt: new Date(FROZEN_TEST_CLOCK_BASE_ISO), memberId: A, organisationId: null });
  db.seed("payment", { id: `${id}-payment`, bookingId: id });
  await postMemberMoneyEvent(db.tx, context, { kind: "CHARGE", eventKey: keys.bookingCharge(id), origin: "APP", source: { kind: "BOOKING", id, version: "1" }, reason: "Synthetic R01",
    obligations: [{ key: keys.bookingCharge(id), kind: "CHARGE", debtor: owner, faceCents: 10_000, evidence: {} }],
    legs: [
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: 10_000, booking: at, debtor: owner, obligationKey: keys.bookingCharge(id), evidence: {} },
      { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: 10_000, booking: at, chargeIdentity: `booking:${id}:nights`, taxAnchorDate: MEMBER_MONEY_TEST_TAX_ANCHOR, evidence: {} },
    ] });
  let sequence = 0;
  const capture = async (cents: number, collect = true) => {
    const n = ++sequence;
    const row = db.seed("paymentTransaction", { id: `${id}-tx-${n}`, paymentId: `${id}-payment`, source: "STRIPE", kind: "PRIMARY", status: "SUCCEEDED",
      amountCents: cents, stripePaymentIntentId: `${id}-pi-${n}` })[0] as { id: string; stripePaymentIntentId: string };
    db.seed("bookingLedgerLine", { id: `${id}-line-${n}`, bookingId: id, side: "SETTLEMENT", kind: "CARD_CAPTURE", anchorId: row.id, reversesLineId: null,
      amountCents: cents, postedAt: new Date(Date.UTC(2026, 5, 20, 0, n)), postingKey: `posting-${n}` });
    await postBookingReceipts(db.tx, context, { paymentId: `${id}-payment`, decision: { paymentIntentId: row.stripePaymentIntentId, collect } });
    return row;
  };
  const cancel = async (kept: number) => {
    db.globalLockHeld = true;
    await postMemberMoneyEvent(db.tx, context, { kind: "ADJUSTMENT", eventKey: keys.cancellation(id, 0), origin: "APP", source: { kind: "BOOKING", id, version: "cancel" }, reason: "Synthetic R04",
      legs: [
        { type: "revenue", account: "BOOKING_REVENUE", side: "DEBIT", grossCents: 10_000, booking: at, chargeIdentity: `booking:${id}:nights`, evidence: {} },
        { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: kept, booking: at, chargeIdentity: `booking:${id}:nights`, taxAnchorDate: MEMBER_MONEY_TEST_TAX_ANCHOR, evidence: {} },
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 10_000 - kept, booking: at, debtor: owner, evidence: {} },
      ] });
  };
  const raise = (amountCents: number) => postHandBackObligation(db.tx, context, { bookingId: id, taskId: TASK, amountCents, origin: "APP", debtorRead: "booking-row" });
  const pay = (cents: number, funding: readonly string[], account: "BANK" | "CASH" = "BANK", ctx: Parameters<typeof postHandBackPayment>[1] = context) =>
    postHandBackPayment(db.tx, ctx, { bookingId: id, taskId: TASK, cents, account, fundingTransactionIds: funding, actorMemberId: OFFICER, debtorRead: "booking-row" });
  const state = () => db.applicationState(id);
  const event = (eventKey: string) => db.rows("memberMoneyEvent", { eventKey })[0] ?? null;
  const journalOf = (eventKey: string) => { const e = event(eventKey); return e ? db.rows("memberMoneyJournal", { eventId: e.id })[0]! : null; };
  const linesOf = (eventKey: string) => db.rows("memberMoneyLine", { journalId: journalOf(eventKey)!.id }).map((l) => `${l.side} ${l.account} ${l.amountCents}`).sort();
  const applied = (eventKey: string) => db.rows("memberMoneyApplication", { journalId: journalOf(eventKey)!.id }).reduce((sum, a) => sum + Number(a.amountCents), 0);
  return { db, id, capture, cancel, raise, pay, state, event, journalOf, linesOf, applied,
    family: (root: string) => memberMoneyApplicationTotals(state()).families.get(root) ?? { funded: 0, paid: 0, reserved: 0 },
    caps: () => memberMoneyConservationProblems(state()) };
}

/** A paid booking cancelled keeping 2000, with its 8000 hand-back debt raised. */
async function owedBack() {
  const t = await setup();
  const row = await t.capture(10_000);
  await t.cancel(2_000);
  const root = await t.raise(8_000);
  return { ...t, row, root: root! };
}

describe("R05 for a hand-back task", () => {
  it("moves the task's exact amount to its own refund debt once, keyed by the task", async () => {
    const t = await owedBack();
    expect(t.root).toBe(keys.refundObligation("hand-back", TASK));
    expect(t.linesOf(t.root)).toEqual(["CREDIT REFUND_PAYABLE 8000", "DEBIT MEMBER_RECEIVABLE 8000"]);
    expect(await t.raise(8_000)).toBe(t.root); // a replay posts nothing new
    expect(t.db.rows("memberMoneyEvent").filter((e) => String(e.eventKey).startsWith("refund-obligation|"))).toHaveLength(1);
  });

  it("posts nothing for an inactive journal", async () => {
    const t = await setup();
    expect(await postHandBackObligation(t.db.tx, INACTIVE, { bookingId: t.id, taskId: TASK, amountCents: 1, origin: "APP", debtorRead: "plain" })).toBeNull();
  });
});

describe("R14 when a hand-back is marked paid", () => {
  it("pays its R05 by bank, funded from the receipt the allocation consumed, once", async () => {
    const t = await owedBack();
    expect(await t.pay(8_000, [t.row.id])).toBeGreaterThan(0);
    const r14 = keys.handBackPaid(TASK);
    expect(t.linesOf(r14)).toEqual(["CREDIT BANK 8000", "DEBIT REFUND_PAYABLE 8000"]);
    expect(t.applied(r14)).toBe(8_000);
    expect(t.family(t.root)).toMatchObject({ funded: 8_000, paid: 8_000 });
    expect(await t.pay(8_000, [t.row.id])).toBe(0); // a replay posts nothing
    expect(t.caps()).toEqual([]);
  });

  it("credits CASH when the money went back in cash", async () => {
    const t = await owedBack();
    await t.pay(8_000, [t.row.id], "CASH");
    expect(t.linesOf(keys.handBackPaid(TASK))).toEqual(["CREDIT CASH 8000", "DEBIT REFUND_PAYABLE 8000"]);
  });

  it("is never refused for the cap: what the debt no longer has open debits the owner's receivable", async () => {
    const t = await owedBack();
    await t.pay(9_000, [t.row.id]);
    expect(t.linesOf(keys.handBackPaid(TASK))).toEqual(["CREDIT BANK 9000", "DEBIT MEMBER_RECEIVABLE 1000", "DEBIT REFUND_PAYABLE 8000"]);
    expect(t.applied(keys.handBackPaid(TASK))).toBe(8_000);
    expect(t.caps()).toEqual([]);
  });

  it("MUTATION: with no R05 in the journal (a task raised before M4d) it posts unapplied, onto no debt", async () => {
    const t = await setup();
    const row = await t.capture(10_000);
    await t.cancel(2_000);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    expect(await t.pay(8_000, [row.id])).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(t.linesOf(keys.handBackPaid(TASK))).toEqual(["CREDIT BANK 8000", "DEBIT MEMBER_RECEIVABLE 8000"]);
    expect(t.applied(keys.handBackPaid(TASK))).toBe(0);
  });

  it("MUTATION: a receipt the allocation did not consume never funds it", async () => {
    const t = await owedBack();
    await t.pay(8_000, []);
    expect(t.family(t.root)).toMatchObject({ funded: 0 });
  });

  it("posts nothing for an inactive journal, a booking outside the population, or no money", async () => {
    const t = await owedBack();
    expect(await t.pay(8_000, [t.row.id], "BANK", INACTIVE)).toBe(0);
    expect(await t.pay(0, [t.row.id])).toBe(0);
    t.db.seed("booking", { id: "outside", lodgeId: LODGE, memberId: A });
    expect(await postHandBackPayment(t.db.tx, context, { bookingId: "outside", taskId: "t-out", cents: 1, account: "BANK", fundingTransactionIds: [], actorMemberId: OFFICER, debtorRead: "plain" })).toBe(0);
    expect(t.event(keys.handBackPaid(TASK))).toBeNull();
  });
});

describe("an approved appeal's bank part (#4516 review A)", () => {
  /** Signed balance (debit positive) of one account across the booking's lines. */
  const balance = (t: Awaited<ReturnType<typeof setup>>, account: string) => t.db.rows("memberMoneyLine", { bookingId: t.id, account })
    .reduce((sum, l) => sum + (l.side === "DEBIT" ? 1 : -1) * Number(l.amountCents), 0);
  const appeal = (t: Awaited<ReturnType<typeof setup>>, taskId: string, concession: boolean) =>
    postHandBackObligation(t.db.tx, context, { bookingId: t.id, taskId, amountCents: 10_000, origin: "OFFICER", actorMemberId: OFFICER, debtorRead: "booking-row", concession });

  it("MUTATION: posts the concession against goodwill, so once paid the member owes nothing and refund payable is clear", async () => {
    const t = await setup();
    const row = await t.capture(10_000); // paid in full; the cancellation (not modelled) refunded nothing
    expect(balance(t, "MEMBER_RECEIVABLE")).toBe(0);
    const root = await appeal(t, "appeal-task", true);
    expect(t.linesOf(root!)).toEqual(["CREDIT MEMBER_RECEIVABLE 10000", "CREDIT REFUND_PAYABLE 10000", "DEBIT GOODWILL 10000", "DEBIT MEMBER_RECEIVABLE 10000"]);
    await postHandBackPayment(t.db.tx, context, { bookingId: t.id, taskId: "appeal-task", cents: 10_000, account: "BANK", fundingTransactionIds: [row.id], actorMemberId: OFFICER, debtorRead: "booking-row" });
    expect(balance(t, "MEMBER_RECEIVABLE")).toBe(0);
    expect(balance(t, "GOODWILL")).toBe(10_000);
    expect(balance(t, "REFUND_PAYABLE")).toBe(0);
    expect(t.linesOf(keys.handBackPaid("appeal-task"))).toEqual(["CREDIT BANK 10000", "DEBIT REFUND_PAYABLE 10000"]);
    expect(t.caps()).toEqual([]);
  });

  it("CONTROL: without the concession the member would be left owing the whole appeal", async () => {
    const t = await setup();
    const row = await t.capture(10_000);
    await appeal(t, "appeal-task", false);
    await postHandBackPayment(t.db.tx, context, { bookingId: t.id, taskId: "appeal-task", cents: 10_000, account: "BANK", fundingTransactionIds: [row.id], actorMemberId: OFFICER, debtorRead: "booking-row" });
    expect(balance(t, "MEMBER_RECEIVABLE")).toBe(10_000);
  });

  it("a released approval reverses the concession with its debt, and a re-approval's new task posts it again once", async () => {
    const t = await setup();
    await t.capture(10_000);
    await appeal(t, "appeal-task", true);
    t.db.globalLockHeld = true; // release_claim holds lock(1)
    expect(await withdrawRefundObligation(t.db.tx, context, { bookingId: t.id, scope: "hand-back", id: "appeal-task", reason: "release_claim", senderKeyPrefix: "refund_request_refund_x" })).toBe(true);
    expect(balance(t, "GOODWILL")).toBe(0);
    expect(balance(t, "REFUND_PAYABLE")).toBe(0);
    expect(balance(t, "MEMBER_RECEIVABLE")).toBe(0);
    await appeal(t, "appeal-task-2", true); // the re-approval raises a new task
    expect(balance(t, "GOODWILL")).toBe(10_000);
    expect(balance(t, "REFUND_PAYABLE")).toBe(-10_000);
    expect(t.caps()).toEqual([]);
  });
});

describe("a late capture the treasurer keeps", () => {
  const keep = (t: Awaited<ReturnType<typeof setup>>, pi: string, billedCents: number, ctx: Parameters<typeof postKeptCapture>[1] = context) =>
    postKeptCapture(t.db.tx, ctx, { bookingId: t.id, paymentIntentId: pi, amountCents: 3_000, actorMemberId: OFFICER, debtorRead: "booking-row", billedCents });

  it("records the part no invoice bills as a retained component, and reverses it exactly before a reopened approval", async () => {
    const t = await setup();
    await t.capture(10_000);
    const late = await t.capture(3_000, false);
    expect(await keep(t, late.stripePaymentIntentId, 0)).toBe(true);
    const kept = keys.keptCapture(late.stripePaymentIntentId);
    expect(t.linesOf(kept)).toEqual(expect.arrayContaining(["DEBIT MEMBER_RECEIVABLE 3000"]));
    expect(await keep(t, late.stripePaymentIntentId, 0)).toBe(false); // a replay posts nothing
    t.db.globalLockHeld = true; // the approval holds lock(1): a revenue reversal is refused without it
    expect(await reverseKeptCapture(t.db.tx, context, { bookingId: t.id, paymentIntentId: late.stripePaymentIntentId, actorMemberId: OFFICER })).toBe(true);
    expect(t.db.rows("memberMoneyJournal", { reversesJournalId: t.journalOf(kept)!.id })).toHaveLength(1);
    expect(t.caps()).toEqual([]);
  });

  it("splits the retained component under the treatment in force when the booking was made, not on the day it is kept (#4632)", async () => {
    // Registered at 15% until 2026-08-01, then not registered. The booking was
    // made on the frozen clock's day (2026-07-01) and its late capture is kept
    // on 2026-08-15: decision A keeps the booking's own treatment for its whole life.
    const changed = memberMoneyTestContext({
      effectiveAt: "2026-08-15T00:00:00.000Z",
      taxSchedule: [CLUB_TAX_SETTINGS_DEFAULTS,
        { gstRegistered: false, taxRateBasisPoints: 0, xeroTaxType: null, effectiveFrom: requireCalendarDate("2026-08-01") }],
    });
    const t = await setup();
    await t.capture(10_000);
    const late = await t.capture(3_000, false);
    expect(await keep(t, late.stripePaymentIntentId, 0, changed)).toBe(true);
    // round(3000 x 0.15 / 1.15) = 391 GST; 2609 net revenue.
    expect(t.linesOf(keys.keptCapture(late.stripePaymentIntentId)))
      .toEqual(expect.arrayContaining(["CREDIT BOOKING_REVENUE 2609", "CREDIT GST_PAYABLE 391"]));
  });

  it("collects against the booking, posting no revenue, where an invoice already bills it", async () => {
    const t = await setup();
    await t.capture(7_000);
    const late = await t.capture(3_000, false);
    expect(await keep(t, late.stripePaymentIntentId, 3_000)).toBe(true);
    const kept = keys.keptCapture(late.stripePaymentIntentId);
    expect(t.db.rows("memberMoneyLine", { journalId: t.journalOf(kept)!.id })).toEqual([]);
    expect(t.applied(kept)).toBe(3_000);
  });

  it("posts and reverses nothing for an inactive journal, or with no keep to reverse", async () => {
    const t = await setup();
    const late = await t.capture(3_000, false);
    expect(await keep(t, late.stripePaymentIntentId, 0, INACTIVE)).toBe(false);
    expect(await reverseKeptCapture(t.db.tx, INACTIVE, { bookingId: t.id, paymentIntentId: late.stripePaymentIntentId, actorMemberId: OFFICER })).toBe(false);
    expect(await reverseKeptCapture(t.db.tx, context, { bookingId: t.id, paymentIntentId: late.stripePaymentIntentId, actorMemberId: OFFICER })).toBe(false);
  });
});

describe("part of a hand-back's debt withdrawn (#4516, owner decision 15 Nov 2026, comment 6893252570)", () => {
  const withdraw = (t: Awaited<ReturnType<typeof owedBack>>, part: { eventKey: ReturnType<typeof keys.handBackRestWithdrawn>; amountCents: number | "open" }) =>
    withdrawRefundObligation(t.db.tx, context, { bookingId: t.id, scope: "hand-back", id: TASK, reason: "test", senderKeyPrefix: `hand-back-reduce:${TASK}`,
      part: { ...part, debtorRead: "booking-row" } });
  const open = (t: Awaited<ReturnType<typeof owedBack>>) => 8_000 - t.family(t.root).paid;

  it("withdraws exactly the cents asked, the mirror of the R05 for them, paying it; a second part under its name is refused", async () => {
    const t = await owedBack();
    const first = keys.handBackReduced(TASK, ["dp_b", "dp_a"]);
    expect(first).toBe(keys.handBackReduced(TASK, ["dp_a", "dp_b"])); // sorted: one spelling per set of lost disputes
    expect(await withdraw(t, { eventKey: first, amountCents: 3_000 })).toBe(true);
    expect(t.linesOf(first)).toEqual(["CREDIT MEMBER_RECEIVABLE 3000", "DEBIT REFUND_PAYABLE 3000"]);
    expect(t.applied(first)).toBe(3_000);
    expect(open(t)).toBe(5_000);
    // A second part under a name already used is a different reduction (a dispute's amount changed): refused, never posted.
    await expect(withdraw(t, { eventKey: first, amountCents: 3_000 })).rejects.toThrow(/already posted/);
    expect(open(t)).toBe(5_000);
    expect(t.caps()).toEqual([]);
  });

  it("a second part under its own key, then the open rest: nothing is left open and nothing is withdrawn twice", async () => {
    const t = await owedBack();
    await withdraw(t, { eventKey: keys.handBackReduced(TASK, ["dp_a"]), amountCents: 3_000 });
    await withdraw(t, { eventKey: keys.handBackReduced(TASK, ["dp_a", "dp_b"]), amountCents: 2_000 });
    expect(open(t)).toBe(3_000);
    expect(await withdraw(t, { eventKey: keys.handBackRestWithdrawn(TASK), amountCents: "open" })).toBe(true);
    expect(t.linesOf(keys.handBackRestWithdrawn(TASK))).toEqual(["CREDIT MEMBER_RECEIVABLE 3000", "DEBIT REFUND_PAYABLE 3000"]);
    expect(open(t)).toBe(0);
    expect(await withdraw(t, { eventKey: keys.handBackRestWithdrawn(TASK), amountCents: "open" })).toBe(false);
    expect(t.caps()).toEqual([]);
  });

  it("never withdraws more than is open: a part larger than the rest is capped", async () => {
    const t = await owedBack();
    await withdraw(t, { eventKey: keys.handBackReduced(TASK, ["dp_a"]), amountCents: 6_000 });
    expect(await withdraw(t, { eventKey: keys.handBackReduced(TASK, ["dp_a", "dp_b"]), amountCents: 5_000 })).toBe(true);
    expect(t.linesOf(keys.handBackReduced(TASK, ["dp_a", "dp_b"]))).toEqual(["CREDIT MEMBER_RECEIVABLE 2000", "DEBIT REFUND_PAYABLE 2000"]);
    expect(open(t)).toBe(0);
  });

  it("CONTROL: the open rest of a debt nothing has paid is still the exact reversal", async () => {
    const t = await owedBack();
    expect(await withdraw(t, { eventKey: keys.handBackRestWithdrawn(TASK), amountCents: "open" })).toBe(true);
    expect(t.event(keys.handBackRestWithdrawn(TASK))).toBeNull();
    expect(t.journalOf(t.root)!.reversedById ?? t.db.rows("memberMoneyJournal", { reversesJournalId: t.journalOf(t.root)!.id }).length).toBeTruthy();
  });

  it("R14 after a part withdrawal pays only what is still open", async () => {
    const t = await owedBack();
    await withdraw(t, { eventKey: keys.handBackReduced(TASK, ["dp_a"]), amountCents: 3_000 });
    expect(await t.pay(5_000, [t.row.id])).toBeGreaterThan(0);
    expect(t.applied(keys.handBackPaid(TASK))).toBe(5_000);
    expect(open(t)).toBe(0);
    expect(t.caps()).toEqual([]);
  });
});
