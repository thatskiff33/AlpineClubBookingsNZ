/**
 * Unit witnesses for the M4b receipt hook and census (#4516): the real plan builder, store, hook and census run
 * against an in-memory journal (`support/member-money-memory-db.ts`), and each case asserts the rows they write.
 * `member-money-receipts.realdb.test.ts` separately proves PostgreSQL's deferred checks, the Payment-row lock
 * and the real application-state projection.
 */
import { describe, expect, it } from "vitest";
import { memberMoneyEventKeys as keys, postMemberMoneyEvent, reverseMemberMoneyJournal, type MemberMoneyDebtor } from "@/lib/member-money";
import { postBookingReceipts, postMemberMergeTransfer } from "@/lib/member-money/doors";
import { countBookingJournalEvents, isJournalEraBooking, readBookingJournalCharges, readJournalSince } from "@/lib/member-money/internal/booking-journal-read";
import { memberMoneyApplicationTotals } from "@/lib/member-money/internal/application-state";
import { bookingReceiptEventKey, readMergedDebtorBalances, receiptFactContext, type BookingReceiptDecision } from "@/lib/member-money/internal/booking-receipts";
import { memberMoneyApplicationKeys } from "@/lib/member-money/internal/keys";
import { MemberMoneyPlanError } from "@/lib/member-money/internal/plan";
import type { BookingJournalContext } from "@/lib/member-money/internal/journal-activity";
import { readBookingReceiptCensus, receiptPopulationPaymentIds } from "@/lib/member-money/internal/receipt-census";
import { ORGANISER_SHARE_RECEIPT_REASON } from "@/lib/organiser-extra-state";
import { MemberMoneyMemoryDb } from "./support/member-money-memory-db";
import { memberMoneyTestContext } from "./support/member-money-fixtures";

const context = memberMoneyTestContext();
const LODGE = "lodge";
const A = "member-a";
const B = "member-b";
const C = "member-c";
const OFFICER = "officer";
const INACTIVE = { inactive: "unusable-currency", detail: "test club's currency cannot be charged" } as const;
type Kind = "CARD_CAPTURE" | "BANK_RECEIPT" | "CASH_RECORDED";

/** One booking on a fresh in-memory journal, its R01 posted as the realdb suite's synthetic one. */
async function setup(input: { charge?: number; zero?: boolean; owner?: MemberMoneyDebtor; bookingId?: string; db?: MemberMoneyMemoryDb } = {}) {
  const db = input.db ?? new MemberMoneyMemoryDb();
  const id = input.bookingId ?? "booking";
  const owner = input.owner ?? { kind: "MEMBER", memberId: A };
  const charge = input.charge ?? 10_000;
  const at = { bookingId: id, lodgeId: LODGE };
  db.seed("booking", { id, lodgeId: LODGE, memberId: owner.kind === "MEMBER" ? owner.memberId : null, organisationId: owner.kind === "ORGANISATION" ? owner.organisationId : null });
  db.seed("payment", { id: `${id}-payment`, bookingId: id });
  const root = keys.bookingCharge(id);
  await postMemberMoneyEvent(db.tx, context, input.zero
    ? { kind: "ZERO", eventKey: root, origin: "APP", source: { kind: "BOOKING", id, version: "1" }, reason: "Synthetic zero R01" }
    : { kind: "CHARGE", eventKey: root, origin: "APP", source: { kind: "BOOKING", id, version: "1" }, reason: "Synthetic R01",
      obligations: [{ key: root, kind: "CHARGE", debtor: owner, faceCents: charge, evidence: {} }],
      legs: [
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: charge, booking: at, debtor: owner, obligationKey: root, evidence: {} },
        { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: charge, booking: at, chargeIdentity: `booking:${id}:nights`, evidence: {} },
      ] });
  let sequence = 0;
  const lines = (model: string, where: Record<string, unknown> = {}) => db.rows(model, where);
  return {
    db, id, root,
    /** A captured transaction and the settlement line the legacy sync writes for it. */
    cash(cents: number, kind: Kind = "CARD_CAPTURE", extra: { reason?: string } = {}) {
      const n = ++sequence;
      const row = db.seed("paymentTransaction", { id: `${id}-tx-${n}`, paymentId: `${id}-payment`, source: kind === "CARD_CAPTURE" ? "STRIPE" : "INTERNET_BANKING",
        kind: "PRIMARY", status: "SUCCEEDED", amountCents: cents, stripePaymentIntentId: kind === "CARD_CAPTURE" ? `${id}-pi-${n}` : null, reason: extra.reason ?? null })[0]!;
      const line = db.seed("bookingLedgerLine", { id: `${id}-line-${n}`, bookingId: id, side: "SETTLEMENT", kind, anchorId: row.id, reversesLineId: null,
        amountCents: cents, postedAt: new Date(Date.UTC(2026, 5, 20, 0, n)), postingKey: `posting-${n}` })[0]!;
      return { row: row as { id: string; stripePaymentIntentId: string | null }, line: line as { id: string; kind: string } };
    },
    /** The settlement sync's reversal of a capture line (an officer correction). */
    reverse(line: { id: string }) {
      const n = ++sequence;
      return db.seed("bookingLedgerLine", { id: `${id}-line-${n}`, bookingId: id, side: "SETTLEMENT", kind: "CASH_RECORDED", anchorId: null, reversesLineId: line.id,
        amountCents: -1, postedAt: new Date(Date.UTC(2026, 5, 21, 0, n)), postingKey: `reversal-${n}` })[0]!;
    },
    post: (decision?: BookingReceiptDecision, journal: BookingJournalContext = context) => postBookingReceipts(db.tx, journal, { paymentId: `${id}-payment`, decision }),
    totals: () => memberMoneyApplicationTotals(db.applicationState(id)),
    census: () => readBookingReceiptCensus(db.tx, `${id}-payment`),
    /** The journal lines of one event, as [account, side, cents, member]. */
    legs(eventKey: string) {
      const event = lines("memberMoneyEvent", { eventKey })[0];
      if (!event) return null;
      const journal = lines("memberMoneyJournal", { eventId: event.id })[0]!;
      return lines("memberMoneyLine", { journalId: journal.id }).map((l) => [l.account, l.side, l.amountCents, l.memberId]).sort((x, y) => String(x).localeCompare(String(y)));
    },
    /** Each application of one event's journal, as [source line's event, obligation key, cents, reverses]. */
    applications(eventKey: string) {
      const event = lines("memberMoneyEvent", { eventKey })[0];
      if (!event) return null;
      const journal = lines("memberMoneyJournal", { eventId: event.id })[0]!;
      return lines("memberMoneyApplication", { journalId: journal.id }).map((a) => {
        const source = lines("memberMoneyLine", { id: a.sourceLineId })[0]!;
        const sourceEvent = lines("memberMoneyEvent", { id: lines("memberMoneyJournal", { id: source.journalId })[0]!.eventId })[0]!;
        return [sourceEvent.eventKey, lines("memberMoneyObligation", { id: a.obligationId })[0]!.obligationKey, a.amountCents, a.reversesApplicationId !== null];
      });
    },
    obligation: (key: string) => lines("memberMoneyObligation", { obligationKey: key })[0] ?? null,
    posted: (eventKey: string) => lines("memberMoneyEvent", { eventKey }).length === 1,
    async merge(from: string, to: string) {
      db.tables.booking!.find((b) => b.id === id)!.memberId = to;
      await postMemberMergeTransfer(db.tx, context, { fromMemberId: from, toMemberId: to, actorMemberId: OFFICER });
    },
    /** A synthetic edit's revenue and receivable legs, on a component of its own (no `lock(1)` needed). */
    increase: (cents: number, debtor: MemberMoneyDebtor, version = "increase") => postMemberMoneyEvent(db.tx, context, { kind: "ADJUSTMENT", eventKey: keys.modification(`${id}-${version}`),
      origin: "APP", source: { kind: "BOOKING", id, version }, reason: "Synthetic price increase", legs: [
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: cents, debtor, booking: at, evidence: {} },
        { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: cents, booking: at, chargeIdentity: `booking:${id}:${version}`, evidence: {} },
      ] }),
  };
}
const member = (memberId: string): MemberMoneyDebtor => ({ kind: "MEMBER", memberId });
const successor = (root: string, ...owners: string[]) => owners.reduce((key, owner) => memberMoneyApplicationKeys.successor(key, "MEMBER", owner), root);
const receiptKey = (cash: { row: { id: string; stripePaymentIntentId: string | null }; line: { id: string; kind: string } }) => bookingReceiptEventKey(cash.row, cash.line);

describe("M4b receipt hook: posting", () => {
  it("posts every capture kind's full cash to its own account, bridged to its settlement line", async () => {
    const b = await setup();
    const card = b.cash(7_000); const bank = b.cash(2_000, "BANK_RECEIPT"); const officer = b.cash(1_000, "CASH_RECORDED");
    expect(await b.post()).toBe(3);
    expect(b.legs(keys.capture(card.row.stripePaymentIntentId!))).toEqual([["MEMBER_RECEIVABLE", "CREDIT", 7_000, A], ["STRIPE_CLEARING", "DEBIT", 7_000, null]]);
    expect(b.legs(keys.receipt(bank.row.id, bank.line.id))).toEqual([["BANK", "DEBIT", 2_000, null], ["MEMBER_RECEIVABLE", "CREDIT", 2_000, A]]);
    expect(b.legs(keys.receipt(officer.row.id, officer.line.id))).toEqual([["CASH", "DEBIT", 1_000, null], ["MEMBER_RECEIVABLE", "CREDIT", 1_000, A]]);
    const origins = b.db.rows("memberMoneyEvent", { kind: "RECEIPT" }).map((e) => e.origin).sort();
    expect(origins).toEqual(["OFFICER", "STRIPE", "XERO"]);
    expect(b.db.rows("memberMoneySourceLink", { bookingLedgerLineId: { in: [card.line.id, bank.line.id, officer.line.id] } })).toHaveLength(3);
    expect(b.totals().collected).toBe(0);
    // Nothing selected and everything bridged: a replay posts nothing.
    expect(await b.post()).toBe(0);
  });

  it("collects only the selected instrument, clamped to the live charge, keeping the full cash", async () => {
    const b = await setup();
    const first = b.cash(7_000); const second = b.cash(8_000);
    expect(await b.post({ paymentIntentId: first.row.stripePaymentIntentId!, collect: true })).toBe(3);
    expect(b.applications(keys.collect(receiptKey(first)))).toEqual([[receiptKey(first), b.root, 7_000, false]]);
    // The second receipt was posted by that call as a catch-up, so its own writer's later selection cannot collect it.
    expect(await b.post({ paymentIntentId: second.row.stripePaymentIntentId!, collect: true })).toBe(0);
    expect(b.totals().collected).toBe(7_000);
    const third = b.cash(8_000);
    expect(await b.post({ transactionIds: [third.row.id], collect: true })).toBe(2);
    expect(b.applications(keys.collect(receiptKey(third)))).toEqual([[receiptKey(third), b.root, 3_000, false]]);
    expect(b.totals().collected).toBe(10_000);
    const clearing = b.db.rows("memberMoneyLine", { account: "STRIPE_CLEARING", side: "DEBIT" }).reduce((n, l) => n + (l.amountCents as number), 0);
    expect(clearing).toBe(23_000);
    expect(await b.post({ transactionIds: [third.row.id], collect: true })).toBe(0);
  });

  it("records how each receipt was posted, and collects later only one its writer deferred", async () => {
    const b = await setup();
    const caught = b.cash(2_000, "BANK_RECEIPT");
    expect(await b.post()).toBe(1);
    const held = b.cash(3_000);
    await b.post({ paymentIntentId: held.row.stripePaymentIntentId!, collect: false });
    const deferred = b.cash(4_000);
    await b.post({ paymentIntentId: deferred.row.stripePaymentIntentId!, collect: false, deferred: true });
    const postedAs = (cash: Parameters<typeof receiptKey>[0]) => (b.db.rows("memberMoneyLine", { account: "MEMBER_RECEIVABLE", side: "CREDIT",
      journal: { event: { eventKey: receiptKey(cash) } } })[0]!.evidence as { postedAs: string }).postedAs;
    expect([postedAs(caught), postedAs(held), postedAs(deferred)]).toEqual(["catch-up", "uncollected", "deferred"]);
    expect(await b.post({ transactionIds: [caught.row.id], collect: true })).toBe(0);
    expect(await b.post({ paymentIntentId: held.row.stripePaymentIntentId!, collect: true })).toBe(0);
    expect(b.totals().collected).toBe(0);
    expect(await b.post({ paymentIntentId: deferred.row.stripePaymentIntentId!, collect: true })).toBe(1);
    expect(b.applications(keys.collect(receiptKey(deferred)))).toEqual([[receiptKey(deferred), b.root, 4_000, false]]);
  });

  it("dates a selected receipt by its source instant or provider day, and an unselected one by its line", async () => {
    const b = await setup();
    const instant = b.cash(1_000);
    await b.post({ paymentIntentId: instant.row.stripePaymentIntentId!, collect: false, effectiveAt: new Date("2026-06-29T11:59:00Z") });
    const day = b.cash(1_000); const other = b.cash(1_000);
    await b.post({ paymentIntentId: day.row.stripePaymentIntentId!, collect: false, effectiveDate: "2026-06-25" as never });
    const event = (cash: Parameters<typeof receiptKey>[0]) => b.db.rows("memberMoneyEvent", { eventKey: receiptKey(cash) })[0]!;
    expect((event(instant).effectiveAt as Date).toISOString()).toBe("2026-06-29T11:59:00.000Z");
    expect((event(instant).effectiveDate as Date).toISOString()).toBe("2026-06-29T00:00:00.000Z");
    expect((event(day).effectiveDate as Date).toISOString()).toBe("2026-06-25T00:00:00.000Z");
    // Posted as a catch-up by the second call, dated by its settlement line.
    expect((event(other).effectiveAt as Date).toISOString()).toBe("2026-06-20T00:03:00.000Z");
    expect(receiptFactContext(context, new Date("2026-06-30T13:00:00Z")).effectiveDate).toBe("2026-07-01");
  });

  it("posts nothing while inactive, before R01, for organiser-share mirrors or non-positive lines", async () => {
    const b = await setup();
    const real = b.cash(2_000);
    expect(await b.post({ transactionIds: [real.row.id], collect: true }, INACTIVE)).toBe(0);
    b.db.tables.paymentTransaction!.find((t) => t.id === real.row.id)!.reason = ORGANISER_SHARE_RECEIPT_REASON;
    b.cash(0);
    expect(await b.post()).toBe(0);
    const outside = new MemberMoneyMemoryDb();
    outside.seed("booking", { id: "outside", lodgeId: LODGE, memberId: A });
    outside.seed("payment", { id: "outside-payment", bookingId: "outside" });
    expect(await postBookingReceipts(outside.tx, context, { paymentId: "outside-payment" })).toBe(0);
    expect(await postBookingReceipts(outside.tx, context, { paymentId: "missing" })).toBe(0);
    expect(b.db.rows("memberMoneyEvent", { kind: "RECEIPT" })).toEqual([]);
  });

  it("refuses a card line whose transaction carries no capture identity", async () => {
    expect(() => bookingReceiptEventKey({ id: "t", stripePaymentIntentId: null }, { id: "l", kind: "CARD_CAPTURE" })).toThrow(MemberMoneyPlanError);
    expect(bookingReceiptEventKey({ id: "t", stripePaymentIntentId: null }, { id: "l", kind: "BANK_RECEIPT" })).toBe(keys.receipt("t", "l"));
  });

  it("opens a charge obligation lazily after a ZERO R01, at the live charge, without charging again", async () => {
    const b = await setup({ zero: true });
    const empty = b.cash(1_000);
    await b.post({ transactionIds: [empty.row.id], collect: true });
    expect(b.posted(keys.chargeOpen(b.id))).toBe(false);
    await b.increase(10_000, member(A));
    const row = b.cash(5_000);
    await b.post({ transactionIds: [row.row.id], collect: true });
    expect(b.legs(keys.chargeOpen(b.id))).toEqual([["MEMBER_RECEIVABLE", "CREDIT", 10_000, A], ["MEMBER_RECEIVABLE", "DEBIT", 10_000, A]]);
    expect(b.obligation(b.root)?.faceCents).toBe(10_000);
    expect(b.totals().collected).toBe(5_000);
  });
});

describe("M4b receipt hook: member merges", () => {
  it("posts the survivor's successor at its first collection, sized from the live charge less what was collected", async () => {
    const b = await setup();
    const first = b.cash(4_000);
    await b.post({ transactionIds: [first.row.id], collect: true });
    await b.merge(A, B);
    expect(b.obligation(successor(b.root, B))).toBeNull();
    const next = b.cash(6_000);
    await b.post({ transactionIds: [next.row.id], collect: true });
    expect(b.obligation(successor(b.root, B))?.faceCents).toBe(6_000);
    expect(b.legs(keys.successor(b.root, A, B))).toEqual([["MEMBER_RECEIVABLE", "CREDIT", 6_000, B], ["MEMBER_RECEIVABLE", "DEBIT", 6_000, B]]);
    expect(b.applications(keys.collect(receiptKey(next)))).toEqual([[receiptKey(next), successor(b.root, B), 6_000, false]]);
    expect(b.totals().collected).toBe(10_000);
    expect((await b.census()).filter((f) => f.kind === "MERGED_DEBTOR_BALANCE")).toEqual([]);
  });

  it("after a merge, collects a payment toward a price increase on a successor for what is left (#4516 round 4, 2)", async () => {
    const b = await setup();
    const paid = b.cash(10_000);
    await b.post({ transactionIds: [paid.row.id], collect: true });
    await b.merge(A, B);
    await b.increase(3_000, member(B));
    const next = b.cash(3_000);
    // The receipt and its collection; the successor is a transfer the count does not include.
    expect(await b.post({ transactionIds: [next.row.id], collect: true })).toBe(2);
    expect(b.obligation(successor(b.root, B))?.faceCents).toBe(3_000);
    expect(b.applications(keys.collect(receiptKey(next)))).toEqual([[receiptKey(next), successor(b.root, B), 3_000, false]]);
    expect(b.totals().collected).toBe(13_000);
    expect((await b.census()).filter((f) => ["UNAPPLIED_RECEIPT_ON_OPEN_CHARGE", "OVER_COLLECTED", "MERGED_DEBTOR_BALANCE"].includes(f.kind))).toEqual([]);
  });

  it("mints no successor when the chain has nothing left to collect", async () => {
    const b = await setup();
    const paid = b.cash(10_000);
    await b.post({ transactionIds: [paid.row.id], collect: true });
    await b.merge(A, B);
    const extra = b.cash(2_000);
    expect(await b.post({ transactionIds: [extra.row.id], collect: true })).toBe(1);
    expect(b.obligation(successor(b.root, B))).toBeNull();
    expect(b.totals().collected).toBe(10_000);
  });

  it("collects a receipt a merge's snapshot netted through a zero-net stand-in on the owner", async () => {
    const b = await setup();
    const held = b.cash(4_000);
    await b.post({ paymentIntentId: held.row.stripePaymentIntentId!, collect: false, deferred: true });
    await b.merge(A, B);
    const follow = keys.mergeFollow(receiptKey(held), B);
    expect(await b.post({ paymentIntentId: held.row.stripePaymentIntentId!, collect: true })).toBe(1);
    expect(b.legs(follow)).toEqual([["MEMBER_RECEIVABLE", "CREDIT", 4_000, B], ["MEMBER_RECEIVABLE", "DEBIT", 4_000, B]]);
    expect(b.applications(keys.collect(receiptKey(held)))).toEqual([[follow, successor(b.root, B), 4_000, false]]);
    expect(b.obligation(successor(b.root, B))?.faceCents).toBe(10_000);
    expect((await b.census()).filter((f) => ["UNAPPLIED_RECEIPT_ON_OPEN_CHARGE", "MERGED_DEBTOR_BALANCE"].includes(f.kind))).toEqual([]);
  });

  it("posts no stand-in when nothing is left to collect (#4516 round 4, 6)", async () => {
    const b = await setup();
    const held = b.cash(3_000);
    await b.post({ paymentIntentId: held.row.stripePaymentIntentId!, collect: false, deferred: true });
    await b.merge(A, B);
    const own = b.cash(10_000);
    await b.post({ transactionIds: [own.row.id], collect: true });
    expect(b.totals().collected).toBe(10_000);
    expect(await b.post({ paymentIntentId: held.row.stripePaymentIntentId!, collect: true })).toBe(0);
    expect(b.posted(keys.mergeFollow(receiptKey(held), B))).toBe(false);
    expect(b.posted(keys.collect(receiptKey(held)))).toBe(false);
  });

  it("carries a receipt that landed after the merge's snapshot as an exact residue and collects through that line", async () => {
    const b = await setup();
    // The merge's snapshot is taken first; the receipt then names the member it read, before the owner move.
    await postMemberMergeTransfer(b.db.tx, context, { fromMemberId: A, toMemberId: B, actorMemberId: OFFICER });
    const late = b.cash(4_000);
    await b.post({ paymentIntentId: late.row.stripePaymentIntentId!, collect: false, deferred: true });
    b.db.tables.booking![0]!.memberId = B;
    expect((await b.census()).filter((f) => f.kind === "MERGED_DEBTOR_BALANCE")).toEqual([{ kind: "MERGED_DEBTOR_BALANCE", identity: A, bookingId: b.id, cents: -4_000 }]);
    expect(await b.post({ paymentIntentId: late.row.stripePaymentIntentId!, collect: true })).toBe(1);
    const residue = keys.mergeResidue(A, B, receiptKey(late));
    expect(b.legs(residue)).toEqual([["MEMBER_RECEIVABLE", "CREDIT", 4_000, B], ["MEMBER_RECEIVABLE", "DEBIT", 4_000, A]]);
    expect(b.applications(keys.collect(receiptKey(late)))).toEqual([[residue, successor(b.root, B), 4_000, false]]);
    expect(b.posted(keys.mergeFollow(receiptKey(late), B))).toBe(false);
    expect((await b.census()).filter((f) => ["UNAPPLIED_RECEIPT_ON_OPEN_CHARGE", "MERGED_DEBTOR_BALANCE"].includes(f.kind))).toEqual([]);
    expect([...(await readMergedDebtorBalances(b.db.tx, b.id, B)).values()]).toEqual([0]);
  });

  it("two hops: a receipt deferred before A merged into B and B into C is collected on C's live tip", async () => {
    const b = await setup();
    const held = b.cash(2_000);
    await b.post({ paymentIntentId: held.row.stripePaymentIntentId!, collect: false, deferred: true });
    await b.merge(A, B);
    await b.merge(B, C);
    const own = b.cash(2_500);
    await b.post({ transactionIds: [own.row.id], collect: true });
    expect(b.obligation(successor(b.root, C))?.faceCents).toBe(10_000);
    expect(await b.post({ paymentIntentId: held.row.stripePaymentIntentId!, collect: true })).toBe(1);
    expect(b.applications(keys.collect(receiptKey(held)))).toEqual([[keys.mergeFollow(receiptKey(held), C), successor(b.root, C), 2_000, false]]);
    expect(b.totals().collected).toBe(4_500);
  });

  it("leaves unapplied a deferred receipt whose debtor no merge carried to the owner", async () => {
    const b = await setup();
    const held = b.cash(4_000);
    await b.post({ paymentIntentId: held.row.stripePaymentIntentId!, collect: false, deferred: true });
    b.db.tables.booking![0]!.memberId = B;
    await b.post({ paymentIntentId: held.row.stripePaymentIntentId!, collect: true });
    expect(b.totals().collected).toBe(0);
    expect((await b.census()).filter((f) => f.kind === "UNAPPLIED_RECEIPT_ON_OPEN_CHARGE")).toEqual([expect.objectContaining({ cents: 4_000 })]);
  });
});

describe("M4b receipt hook: officer reversals", () => {
  it("reverses the receipt's own collection first, then the receipt, once", async () => {
    const b = await setup();
    const officer = b.cash(10_000, "CASH_RECORDED");
    await b.post({ transactionIds: [officer.row.id], collect: true });
    expect(b.totals().collected).toBe(10_000);
    b.reverse(officer.line);
    expect(await b.post()).toBe(2);
    const collect = b.db.rows("memberMoneyJournal", { event: { eventKey: keys.collect(receiptKey(officer)) } })[0]!;
    const receipt = b.db.rows("memberMoneyJournal", { event: { eventKey: receiptKey(officer) } })[0]!;
    expect(b.applications(keys.reversal(collect.id as string))).toEqual([[receiptKey(officer), b.root, 10_000, true]]);
    expect(b.legs(keys.reversal(receipt.id as string))).toEqual([["CASH", "CREDIT", 10_000, null], ["MEMBER_RECEIVABLE", "DEBIT", 10_000, A]]);
    expect(b.applications(keys.reversal(receipt.id as string))).toEqual([]);
    expect(b.totals().collected).toBe(0);
    expect(await b.post()).toBe(0);
  });

  it("reverses a collection made through a merge stand-in, unmasking another unapplied receipt (#4516 round 4, 1)", async () => {
    const b = await setup();
    const officer = b.cash(4_000, "CASH_RECORDED");
    await b.post({ transactionIds: [officer.row.id], collect: false, deferred: true });
    await b.merge(A, B);
    const held = b.cash(3_000);
    await b.post({ paymentIntentId: held.row.stripePaymentIntentId!, collect: false });
    await b.post({ transactionIds: [officer.row.id], collect: true });
    expect(b.applications(keys.collect(receiptKey(officer)))).toEqual([[keys.mergeFollow(receiptKey(officer), B), successor(b.root, B), 4_000, false]]);
    // Before the reversal the stand-in's collection counts against the officer receipt alone: the held one is unapplied.
    expect((await b.census()).filter((f) => f.kind === "UNAPPLIED_RECEIPT_ON_OPEN_CHARGE")).toEqual([expect.objectContaining({ cents: 3_000 })]);
    b.reverse(officer.line);
    expect(await b.post()).toBe(2);
    const collect = b.db.rows("memberMoneyJournal", { event: { eventKey: keys.collect(receiptKey(officer)) } })[0]!;
    expect(b.applications(keys.reversal(collect.id as string))).toEqual([[keys.mergeFollow(receiptKey(officer), B), successor(b.root, B), 4_000, true]]);
    expect(b.totals().collected).toBe(0);
    const census = await b.census();
    expect(census.filter((f) => f.kind === "UNAPPLIED_RECEIPT_ON_OPEN_CHARGE")).toEqual([expect.objectContaining({ cents: 3_000 })]);
    // The reversal's debit on A is carried to B, so no merged-away balance is left behind.
    expect(census.filter((f) => f.kind === "MERGED_DEBTOR_BALANCE")).toEqual([]);
  });
});

describe("M4b receipt census", () => {
  it("classifies unbridged, missing, drifted, over-collected and unapplied receipts", async () => {
    const b = await setup();
    const unposted = b.cash(1_000);
    const lineless = b.db.seed("paymentTransaction", { id: "lineless", paymentId: `${b.id}-payment`, source: "STRIPE", kind: "ADDITIONAL", status: "SUCCEEDED",
      amountCents: 500, stripePaymentIntentId: "pi-lineless", reason: null })[0]!;
    const findings = await b.census();
    expect(findings).toEqual(expect.arrayContaining([
      { kind: "RECEIPT_WITHOUT_EVENT", identity: unposted.row.id, bookingId: b.id, cents: 1_000 },
      { kind: "UNBRIDGED_SETTLEMENT_LINE", identity: unposted.line.id, bookingId: b.id, cents: 1_000 },
      { kind: "UNBRIDGED_SETTLEMENT_LINE", identity: lineless.id, bookingId: b.id, cents: 500 },
      { kind: "RECEIPT_WITHOUT_EVENT", identity: lineless.id, bookingId: b.id, cents: 500 },
    ]));
    await b.post();
    expect((await b.census()).filter((f) => f.identity === unposted.row.id || f.identity === unposted.line.id)).toEqual([]);
    expect((await b.census()).filter((f) => f.kind === "UNAPPLIED_RECEIPT_ON_OPEN_CHARGE")).toEqual([{ kind: "UNAPPLIED_RECEIPT_ON_OPEN_CHARGE", identity: b.id, bookingId: b.id, cents: 1_000 }]);
    b.db.tables.paymentTransaction!.find((t) => t.id === unposted.row.id)!.amountCents = 1_300;
    expect((await b.census()).filter((f) => f.kind === "RECEIPT_AMOUNT_DRIFT")).toEqual([{ kind: "RECEIPT_AMOUNT_DRIFT", identity: unposted.row.id, bookingId: b.id, cents: 300 }]);

    const over = await setup({ bookingId: "over" });
    const paid = over.cash(10_000);
    await over.post({ transactionIds: [paid.row.id], collect: true });
    over.db.globalLockHeld = true;
    await postMemberMoneyEvent(over.db.tx, context, { kind: "ADJUSTMENT", eventKey: keys.modification("over-decrease"), origin: "APP",
      source: { kind: "BOOKING", id: "over", version: "decrease" }, reason: "Synthetic decrease after collection", legs: [
        { type: "revenue", account: "BOOKING_REVENUE", side: "DEBIT", grossCents: 10_000, chargeIdentity: "booking:over:nights", booking: { bookingId: "over", lodgeId: LODGE }, evidence: {} },
        { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: 6_000, chargeIdentity: "booking:over:nights", booking: { bookingId: "over", lodgeId: LODGE }, evidence: {} },
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 4_000, debtor: member(A), booking: { bookingId: "over", lodgeId: LODGE }, evidence: {} },
      ] });
    expect((await over.census()).filter((f) => f.kind === "OVER_COLLECTED")).toEqual([{ kind: "OVER_COLLECTED", identity: "over", bookingId: "over", cents: 4_000 }]);
  });

  it("treats a receipt and its stand-in as one source cap, and counts nothing for a reversed one whose collection survived", async () => {
    const b = await setup();
    const officer = b.cash(4_000, "CASH_RECORDED");
    await b.post({ transactionIds: [officer.row.id], collect: false, deferred: true });
    await b.merge(A, B);
    const held = b.cash(3_000);
    await b.post({ paymentIntentId: held.row.stripePaymentIntentId!, collect: false });
    await b.post({ transactionIds: [officer.row.id], collect: true });
    // A receipt reversed directly, as no writer may: its stand-in's collection outlives it.
    const receipt = b.db.rows("memberMoneyJournal", { event: { eventKey: receiptKey(officer) } })[0]!;
    await reverseMemberMoneyJournal(b.db.tx, context, { reversesJournalId: receipt.id as string, origin: "OFFICER",
      source: { kind: "PAYMENT", id: officer.row.id, version: "direct" }, reason: "Synthetic bare reversal" });
    expect(b.totals().collected).toBe(4_000);
    // The surviving 4000 is not set against the held receipt's 3000: that stays reported.
    expect((await b.census()).filter((f) => f.kind === "UNAPPLIED_RECEIPT_ON_OPEN_CHARGE")).toEqual([expect.objectContaining({ cents: 3_000 })]);
  });

  it("lists exactly the payments of bookings with R01, across pages", async () => {
    const db = new MemberMoneyMemoryDb();
    await setup({ db, bookingId: "one" });
    await setup({ db, bookingId: "two", owner: { kind: "ORGANISATION", organisationId: "org" } });
    db.seed("booking", { id: "none", lodgeId: LODGE, memberId: A });
    db.seed("payment", { id: "none-payment", bookingId: "none" });
    expect((await receiptPopulationPaymentIds(db.tx)).sort()).toEqual(["one-payment", "two-payment"]);
  });

  it("names an organisation owner's receipts against the organisation and reports no merged-debtor balance", async () => {
    const b = await setup({ owner: { kind: "ORGANISATION", organisationId: "org" } });
    const row = b.cash(4_000);
    await b.post({ transactionIds: [row.row.id], collect: true });
    expect(b.db.rows("memberMoneyLine", { account: "MEMBER_RECEIVABLE", side: "CREDIT" }).map((l) => [l.debtorKind, l.organisationId, l.amountCents]))
      .toEqual([["ORGANISATION", "org", 4_000]]);
    expect(b.totals().collected).toBe(4_000);
    expect((await b.census()).filter((f) => f.kind === "MERGED_DEBTOR_BALANCE")).toEqual([]);
  });
});


describe("M4b merge transfer and journal reads", () => {
  it("records a merge with no open receivable as a ZERO event carrying its snapshot, once, and refuses while inactive", async () => {
    const db = new MemberMoneyMemoryDb();
    const posted = await postMemberMergeTransfer(db.tx, context, { fromMemberId: A, toMemberId: B, actorMemberId: OFFICER });
    const event = db.rows("memberMoneyEvent", { eventKey: keys.merge(A, B) })[0]!;
    expect([posted?.replayed, event.kind, event.sourceKind, event.sourceIdentity, event.sourceVersion]).toEqual([false, "ZERO", "OFFICER_FACT", A, `merge:${B}`]);
    expect(db.rows("memberMoneySourceLink", { journalId: posted!.journalId }).map((l) => [l.sourceId, l.sourceVersion]))
      .toEqual(expect.arrayContaining([[keys.merge(A, B), "member-money-merge-snapshot-1"]]));
    expect(await postMemberMergeTransfer(db.tx, context, { fromMemberId: A, toMemberId: B, actorMemberId: OFFICER })).toBeNull();
    await expect(postMemberMergeTransfer(db.tx, INACTIVE, { fromMemberId: B, toMemberId: C, actorMemberId: OFFICER }))
      .rejects.toThrow(/inactive/);
  });

  it("moves each booking's open receivable, naming every event its snapshot netted", async () => {
    const b = await setup();
    const paid = b.cash(4_000);
    await b.post({ transactionIds: [paid.row.id], collect: true });
    await b.merge(A, B);
    expect(b.legs(keys.merge(A, B))).toEqual([["MEMBER_RECEIVABLE", "CREDIT", 6_000, A], ["MEMBER_RECEIVABLE", "DEBIT", 6_000, B]]);
    const merge = b.db.rows("memberMoneyJournal", { event: { eventKey: keys.merge(A, B) } })[0]!;
    const netted = b.db.rows("memberMoneySourceLink", { journalId: merge.id, sourceVersion: keys.merge(A, B) }).map((l) => l.sourceId);
    const included = [b.root, receiptKey(paid)].map((key) => b.db.rows("memberMoneyEvent", { eventKey: key })[0]!.id);
    expect(netted.sort()).toEqual(included.sort());
  });

  it("reads each booking's charge components, bridged lines, era and event count from the journal", async () => {
    const db = new MemberMoneyMemoryDb();
    expect(await readJournalSince(db.tx)).toBeNull();
    expect(await readBookingJournalCharges(db.tx, [])).toEqual(new Map());
    const b = await setup({ db, bookingId: "read" });
    const row = b.cash(2_500, "BANK_RECEIPT");
    await b.post();
    await b.increase(1_000, member(A));
    const charges = (await readBookingJournalCharges(db.tx, ["read", "absent"]));
    expect(charges.get("read")).toMatchObject({ charged: true, pending: false, bridgedLineIds: new Set([row.line.id]),
      components: expect.arrayContaining([{ account: "BOOKING_REVENUE", chargeIdentity: "booking:read:nights", liveGrossCents: 10_000 },
        { account: "BOOKING_REVENUE", chargeIdentity: "booking:read:increase", liveGrossCents: 1_000 }]) });
    expect(charges.get("absent")).toMatchObject({ charged: false, pending: false, components: [], bridgedLineIds: new Set() });
    const since = await readJournalSince(db.tx);
    expect(since).toBeInstanceOf(Date);
    expect([isJournalEraBooking(new Date(since!.getTime() + 1), since), isJournalEraBooking(since, since), isJournalEraBooking(null, since),
      isJournalEraBooking(new Date("2027-01-01T00:00:00Z"), null)]).toEqual([true, false, false, false]);
    expect(await countBookingJournalEvents(db.tx, "read")).toBe(2);
  });
});
