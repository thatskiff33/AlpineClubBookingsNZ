/**
 * Unit witnesses for M4d's hand-back engine (#4516): R05 for a hand-back task, R14 when it is marked paid (applied to
 * its R05, unapplied without one, the excess on the receivable), the late-capture keep and its reversal. The real plan
 * builder, store and engine run against the in-memory journal (`support/member-money-memory-db.ts`);
 * `member-money-hand-backs.realdb.test.ts` proves the completion door, and its refused dismissal, against PostgreSQL.
 */
import { describe, expect, it, vi } from "vitest";
import logger from "@/lib/logger";
import { memberMoneyEventKeys as keys, postMemberMoneyEvent, type MemberMoneyDebtor } from "@/lib/member-money";
import { postBookingReceipts, postHandBackObligation, postHandBackPayment, postKeptCapture, reverseKeptCapture } from "@/lib/member-money/doors";
import { memberMoneyApplicationTotals, memberMoneyConservationProblems } from "@/lib/member-money/internal/application-state";
import { MemberMoneyMemoryDb } from "./support/member-money-memory-db";
import { memberMoneyTestContext } from "./support/member-money-fixtures";

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
  db.seed("booking", { id, lodgeId: LODGE, memberId: A, organisationId: null });
  db.seed("payment", { id: `${id}-payment`, bookingId: id });
  await postMemberMoneyEvent(db.tx, context, { kind: "CHARGE", eventKey: keys.bookingCharge(id), origin: "APP", source: { kind: "BOOKING", id, version: "1" }, reason: "Synthetic R01",
    obligations: [{ key: keys.bookingCharge(id), kind: "CHARGE", debtor: owner, faceCents: 10_000, evidence: {} }],
    legs: [
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: 10_000, booking: at, debtor: owner, obligationKey: keys.bookingCharge(id), evidence: {} },
      { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: 10_000, booking: at, chargeIdentity: `booking:${id}:nights`, evidence: {} },
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
        { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: kept, booking: at, chargeIdentity: `booking:${id}:nights`, evidence: {} },
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
