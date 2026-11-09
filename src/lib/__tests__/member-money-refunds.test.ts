/**
 * Unit witnesses for M4c's card refund engine (#4516): R05, the reservation step, R12/R13 in the cash writer, a
 * "Paid another way" close, the lazy D4 refund successor, the recovery-row map, the census and the rollback rules.
 * The real plan builder, store and engine run against the in-memory journal (`support/member-money-memory-db.ts`);
 * `member-money-refunds.realdb.test.ts` proves the same flows against PostgreSQL's deferred checks and locks.
 */
import { describe, expect, it } from "vitest";
import { memberMoneyEventKeys as keys, postMemberMoneyEvent, isCardRefundReservationRefusal, MemberMoneyReservationRefused, type MemberMoneyDebtor } from "@/lib/member-money";
import {
  cardRefundObligationOfRecoveryKey,
  postBookingReceipts,
  postCardRefundCash,
  postPaidAnotherWayClose,
  postRefundObligation,
  reserveCardRefundSlice,
  resolveCardRefundObligation,
  withdrawRefundObligation,
  type CardRefundObligationRef,
} from "@/lib/member-money/doors";
import { memberMoneyApplicationTotals, memberMoneyConservationProblems } from "@/lib/member-money/internal/application-state";
import { readBookingRefundCensus, reconcileMadeRefundReservations, releaseReservationByOperator } from "@/lib/member-money/internal/refund-census";
import { refundDoorOfObligationKey } from "@/lib/member-money/internal/refund-obligation-map";
import { MemberMoneyPlanError } from "@/lib/member-money/internal/plan";
import { PartialRefundError } from "@/lib/payment-transactions";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { MemberMoneyMemoryDb } from "./support/member-money-memory-db";
import { memberMoneyTestContext } from "./support/member-money-fixtures";

const context = memberMoneyTestContext();
const INACTIVE = { inactive: "unusable-currency", detail: "test club's currency cannot be charged" } as const;
const LODGE = "lodge";
const A = "member-a";
const B = "member-b";
const OFFICER = "officer";
const R05 = (scope: CardRefundObligationRef["scope"], id: string) => keys.refundObligation(scope, id);

/** A paid card booking: R01 10000, one capture collected by its R06; `cancel` posts a synthetic R04 keeping `kept`. */
async function setup(input: { owner?: MemberMoneyDebtor; db?: MemberMoneyMemoryDb; id?: string } = {}) {
  const db = input.db ?? new MemberMoneyMemoryDb();
  const id = input.id ?? "booking";
  const owner = input.owner ?? { kind: "MEMBER", memberId: A };
  const at = { bookingId: id, lodgeId: LODGE };
  db.seed("booking", { id, lodgeId: LODGE, memberId: owner.kind === "MEMBER" ? owner.memberId : null, organisationId: owner.kind === "ORGANISATION" ? owner.organisationId : null });
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
  const r05 = (scope: CardRefundObligationRef["scope"], scopeId: string, amountCents: number, extra: { concession?: boolean; debtorRead?: "booking-row" | "plain" } = {}) =>
    postRefundObligation(db.tx, context, { bookingId: id, scope, id: scopeId, amountCents, origin: "APP", debtorRead: extra.debtorRead ?? "booking-row", concession: extra.concession });
  const reserve = (row: { id: string }, obligation: CardRefundObligationRef, attemptKey: string, amountCents: number, planAttemptKeys = [attemptKey]) =>
    reserveCardRefundSlice(db.tx, context, { paymentId: `${id}-payment`, obligation, attemptKey, paymentTransactionId: row.id, amountCents, planAttemptKeys });
  /** A card refund row as the legacy writer records it, then the one cash writer's journal step for the payment. */
  const refund = (row: { id: string; stripePaymentIntentId: string }, refundId: string, amountCents: number, status = "succeeded", attemptKey?: string) => {
    const existing = db.rows("paymentRefund", { stripeRefundId: refundId })[0];
    if (existing) existing.status = status;
    else db.seed("paymentRefund", { id: refundId, paymentId: `${id}-payment`, paymentTransactionId: row.id, stripeRefundId: refundId, stripePaymentIntentId: row.stripePaymentIntentId,
      amountCents, status, stripeCreatedAt: new Date(context.effectiveAt), createdAt: new Date(context.effectiveAt), updatedAt: new Date(context.effectiveAt) });
    return postCardRefundCash(db.tx, context, { paymentId: `${id}-payment`, attemptKeys: new Map(attemptKey ? [[refundId, attemptKey]] : []) });
  };
  const state = () => db.applicationState(id);
  const family = (root: string) => memberMoneyApplicationTotals(state()).families.get(root) ?? { funded: 0, paid: 0, reserved: 0 };
  const event = (eventKey: string) => db.rows("memberMoneyEvent", { eventKey })[0] ?? null;
  const journalOf = (eventKey: string) => { const e = event(eventKey); return e ? db.rows("memberMoneyJournal", { eventId: e.id })[0]! : null; };
  const reversed = (eventKey: string) => { const j = journalOf(eventKey); return j ? db.rows("memberMoneyJournal", { reversesJournalId: j.id }).length === 1 : false; };
  const reservation = (attemptKey: string) => db.rows("memberMoneyRefundReservation", { attemptKey })[0] ?? null;
  const release = (attemptKey: string) => { const r = reservation(attemptKey); return r ? db.rows("memberMoneyRefundReservationRelease", { reservationId: r.id })[0] ?? null : null; };
  return { db, id, owner, capture, cancel, r05, reserve, refund, state, family, event, journalOf, reversed, reservation, release,
    caps: () => memberMoneyConservationProblems(state()), census: () => readBookingRefundCensus(db.tx, `${id}-payment`) };
}

/** A card booking cancelled keeping 2000, its 8000 card refund owed (R05). */
async function cancelled(input: Parameters<typeof setup>[0] = {}) {
  const t = await setup(input);
  const row = await t.capture(10_000);
  await t.cancel(2_000);
  await t.r05("cancellation", t.id, 8_000);
  return { ...t, row, key: `booking_cancel_refund_${t.id}_${row.id}_8000`, root: R05("cancellation", t.id) };
}

describe("R05 at a card refund door", () => {
  it("moves the door's exact debt to its own obligation once: Dr AR, Cr RP, keyed by its scope", async () => {
    const t = await cancelled();
    expect(t.db.rows("memberMoneyObligation", { obligationKey: t.root })[0]).toMatchObject({ kind: "REFUND", faceCents: 8_000, memberId: A });
    const lines = t.db.rows("memberMoneyLine", { journalId: t.journalOf(t.root)!.id }).map((l) => `${l.side} ${l.account} ${l.amountCents}`).sort();
    expect(lines).toEqual(["CREDIT REFUND_PAYABLE 8000", "DEBIT MEMBER_RECEIVABLE 8000"]);
    expect(await t.r05("cancellation", t.id, 8_000)).toBe(t.root);
    expect(t.db.rows("memberMoneyEvent").filter((e) => String(e.eventKey).startsWith("refund-obligation|"))).toHaveLength(1);
  });

  it("an approved appeal posts its concession against approved goodwill first, in the same batch", async () => {
    const t = await cancelled();
    await t.r05("refund-request", "appeal-1", 1_500, { concession: true });
    const lines = t.db.rows("memberMoneyLine", { journalId: t.journalOf(R05("refund-request", "appeal-1"))!.id }).map((l) => `${l.side} ${l.account} ${l.amountCents}`).sort();
    expect(lines).toEqual(["CREDIT MEMBER_RECEIVABLE 1500", "CREDIT REFUND_PAYABLE 1500", "DEBIT GOODWILL 1500", "DEBIT MEMBER_RECEIVABLE 1500"]);
  });

  it("posts nothing for an inactive journal, a booking outside the population, or no money", async () => {
    const t = await setup();
    expect(await postRefundObligation(t.db.tx, INACTIVE, { bookingId: t.id, scope: "cancellation", id: t.id, amountCents: 1, origin: "APP", debtorRead: "plain" })).toBeNull();
    expect(await t.r05("cancellation", t.id, 0)).toBeNull();
    t.db.seed("booking", { id: "outside", lodgeId: LODGE, memberId: A });
    expect(await postRefundObligation(t.db.tx, context, { bookingId: "outside", scope: "cancellation", id: "outside", amountCents: 1, origin: "APP", debtorRead: "plain" })).toBeNull();
  });

  it("a withdrawn door releases its open reservations with their funding and reverses its R05; one already paid cannot be withdrawn", async () => {
    const t = await cancelled();
    await t.r05("refund-request", "appeal", 1_000, { concession: true });
    await t.reserve(t.row, { scope: "refund-request", id: "appeal" }, "appeal_key", 1_000);
    expect(await withdrawRefundObligation(t.db.tx, context, { bookingId: t.id, scope: "refund-request", id: "appeal", reason: "release_claim" })).toBe(true);
    expect(t.release("appeal_key")).toMatchObject({ reason: "SUPERSEDED_KEY" });
    expect(t.reversed(R05("refund-request", "appeal"))).toBe(true);
    expect(await withdrawRefundObligation(t.db.tx, context, { bookingId: t.id, scope: "refund-request", id: "appeal", reason: "again" })).toBe(false);
    expect(await withdrawRefundObligation(t.db.tx, INACTIVE, { bookingId: t.id, scope: "refund-request", id: "appeal", reason: "inactive" })).toBe(false);
    // A re-approval posts under the chain's next key.
    expect(await t.r05("refund-request", "appeal", 1_000, { concession: true })).toMatch(/\|after\|/);

    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    await t.refund(t.row, "re_paid", 8_000, "succeeded", t.key);
    await expect(withdrawRefundObligation(t.db.tx, context, { bookingId: t.id, scope: "cancellation", id: t.id, reason: "too late" })).rejects.toBeInstanceOf(MemberMoneyPlanError);
  });
});

describe("the reservation step", () => {
  it("MUTATION (probe 15): funds the slice from its own receipt, taking back exactly the shortfall of that receipt's collection, then reserves", async () => {
    const t = await cancelled();
    expect(await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000)).toMatchObject({ outcome: "reserved", replayed: false });
    expect(t.family(t.root)).toMatchObject({ funded: 8_000, reserved: 8_000, paid: 0 });
    expect(memberMoneyApplicationTotals(t.state()).collected).toBe(2_000);
    expect(t.event(keys.refundUncollect(keys.refundFunding(t.key)))).not.toBeNull();
    expect(t.caps()).toEqual([]);
    // A retry under the same key replays the reservation; nothing is funded twice.
    expect(await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000)).toMatchObject({ outcome: "reserved", replayed: true });
    expect(t.family(t.root)).toMatchObject({ funded: 8_000, reserved: 8_000 });
  });

  it("MUTATION (probe 14): a re-plan to a new key releases the superseded reservation, reverses its funding, and funds again", async () => {
    const t = await cancelled();
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, `${t.key}_refused1`, 8_000, [`${t.key}_refused1`]);
    expect(t.release(t.key)).toMatchObject({ reason: "SUPERSEDED_KEY" });
    expect(t.reversed(keys.refundFunding(t.key))).toBe(true);
    expect(t.family(t.root)).toMatchObject({ funded: 8_000, reserved: 8_000 });
    expect(t.caps()).toEqual([]);
  });

  it("keeps a reservation the whole plan still carries (a made slice is answered, never superseded)", async () => {
    const t = await cancelled();
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    const other = await t.capture(500, false);
    await t.r05("modification", "edit", 500);
    await t.reserve(other, { scope: "modification", id: "edit" }, "edit_key", 500, ["edit_key", t.key]);
    expect(t.release(t.key)).toBeNull();
  });

  it("MUTATION (probes 2, 4): refuses before Stripe when the receipt cannot fund a second debt, writing nothing", async () => {
    const t = await cancelled();
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    await t.r05("refund-request", "appeal", 5_000, { concession: true });
    const writes = t.db.writes.length;
    const refusal = await t.reserve(t.row, { scope: "refund-request", id: "appeal" }, "appeal_key", 5_000).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(MemberMoneyReservationRefused);
    expect(isCardRefundReservationRefusal(refusal)).toBe(true);
    expect(t.db.writes.length).toBe(writes);
  });

  it("MUTATION (probe 3): C3 counts the whole family: a reservation beyond the root face is refused", async () => {
    const t = await cancelled();
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    const second = await t.capture(1_000, false);
    await expect(t.reserve(second, { scope: "cancellation", id: t.id }, "over_key", 1_000)).rejects.toBeInstanceOf(MemberMoneyReservationRefused);
  });

  it("skips, never refuses: an inactive journal, a booking outside the population, a capture with no receipt, a debt not in the journal, a decided key", async () => {
    const t = await cancelled();
    expect(await reserveCardRefundSlice(t.db.tx, INACTIVE, { paymentId: `${t.id}-payment`, obligation: { scope: "cancellation", id: t.id }, attemptKey: "k", paymentTransactionId: t.row.id, amountCents: 1, planAttemptKeys: ["k"] }))
      .toEqual({ outcome: "skipped", reason: "inactive" });
    t.db.seed("booking", { id: "outside", lodgeId: LODGE, memberId: A });
    t.db.seed("payment", { id: "outside-payment", bookingId: "outside" });
    expect(await reserveCardRefundSlice(t.db.tx, context, { paymentId: "outside-payment", obligation: { scope: "cancellation", id: "outside" }, attemptKey: "k", paymentTransactionId: t.row.id, amountCents: 1, planAttemptKeys: ["k"] }))
      .toEqual({ outcome: "skipped", reason: "outside-population" });
    const bare = t.db.seed("paymentTransaction", { id: "bare", paymentId: `${t.id}-payment`, source: "STRIPE", kind: "ADDITIONAL", status: "SUCCEEDED", amountCents: 100, stripePaymentIntentId: "pi-bare" })[0] as { id: string };
    expect(await t.reserve(bare, { scope: "cancellation", id: t.id }, "k_bare", 100)).toEqual({ outcome: "skipped", reason: "no-receipt" });
    expect(await t.reserve(t.row, { scope: "modification", id: "missing" }, "k_missing", 100)).toEqual({ outcome: "skipped", reason: "no-obligation" });
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    await t.refund(t.row, "re_1", 8_000, "failed", t.key); // REFUSED: the key is decided
    expect(await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000)).toEqual({ outcome: "skipped", reason: "key-already-decided" });
  });

  it("posts a deferred R05 (a superseded capture's return) sized as its door gave it", async () => {
    const t = await setup();
    await t.capture(10_000);
    const late = await t.capture(3_000, false);
    expect(await t.reserve(late, { scope: "capture-return", id: late.stripePaymentIntentId, ensureFaceCents: 3_000 }, "superseded_key", 3_000)).toMatchObject({ outcome: "reserved" });
    expect(t.db.rows("memberMoneyObligation", { obligationKey: R05("capture-return", late.stripePaymentIntentId) })[0]).toMatchObject({ faceCents: 3_000 });
  });

  it("skips a receipt on a member a merge moved away from: applications never cross debtors", async () => {
    const t = await cancelled();
    t.db.rows("booking", { id: t.id })[0]!.memberId = B;
    expect(await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000)).toEqual({ outcome: "skipped", reason: "merged-debtor" });
    // The tip moved to B lazily, under the Payment row, carrying what was still owed.
    expect(t.db.rows("memberMoneyObligation", { obligationKey: `${t.root}|for|MEMBER|${B}` })[0]).toMatchObject({ memberId: B, faceCents: 8_000 });
  });
});

describe("R12 and R13 in the one cash writer", () => {
  it("MUTATION (probe 8, 11): R12 is applied only through the reservation its key names, keyed by the refund's id; with no key it posts unapplied", async () => {
    const t = await cancelled();
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    expect(await t.refund(t.row, "re_dash", 1_000)).toBe(1);
    expect(t.db.rows("memberMoneyLine", { journalId: t.journalOf(keys.refund("re_dash"))!.id }).map((l) => `${l.side} ${l.account}`).sort()).toEqual(["CREDIT STRIPE_CLEARING", "DEBIT MEMBER_RECEIVABLE"]);
    expect(await t.refund(t.row, "re_keyed", 8_000, "succeeded", t.key)).toBe(1);
    expect(t.release(t.key)).toMatchObject({ reason: "ANSWERED", stripeRefundId: "re_keyed" });
    expect(t.family(t.root)).toMatchObject({ paid: 8_000, reserved: 0 });
    expect(await t.refund(t.row, "re_keyed", 8_000, "succeeded", t.key)).toBe(0);
    expect((await t.census()).map((f) => f.kind)).toEqual(["UNAPPLIED_CARD_REFUND"]);
    expect(t.caps()).toEqual([]);
  });

  it("a key whose reservation names another capture or other cents posts unapplied", async () => {
    const t = await cancelled();
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    await t.refund(t.row, "re_other_cents", 7_000, "succeeded", t.key);
    expect(t.release(t.key)).toBeNull();
    expect(t.db.rows("memberMoneyApplication", { journalId: t.journalOf(keys.refund("re_other_cents"))!.id })).toEqual([]);
  });

  it("MUTATION (probe 7): a key arriving after an unapplied R12 answers it once, only while the refund counts", async () => {
    const t = await cancelled();
    await t.refund(t.row, "re_late", 8_000);
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    expect(await t.refund(t.row, "re_late", 8_000, "succeeded", t.key)).toBe(1);
    expect(t.event(keys.refundAnswer("re_late"))).not.toBeNull();
    expect(t.family(t.root)).toMatchObject({ paid: 8_000, reserved: 0 });
    expect(await t.refund(t.row, "re_late", 8_000, "succeeded", t.key)).toBe(0);
    expect(await t.census()).toEqual([]);

    const u = await cancelled({ id: "second" });
    await u.refund(u.row, "re_failed", 8_000);
    await u.refund(u.row, "re_failed", 8_000, "failed");
    await u.reserve(u.row, { scope: "cancellation", id: u.id }, u.key, 8_000);
    await u.refund(u.row, "re_failed", 8_000, "failed", u.key);
    expect(u.event(keys.refundAnswer("re_failed"))).toBeNull();
    expect(u.release(u.key)).toBeNull();
  });

  it("R13 reverses the answer, the cash and the answered reservation's funding once, so the re-send funds again", async () => {
    const t = await cancelled();
    await t.refund(t.row, "re_r13", 8_000, "pending");
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    await t.refund(t.row, "re_r13", 8_000, "pending", t.key); // answered
    expect(await t.refund(t.row, "re_r13", 8_000, "failed")).toBe(3);
    expect(t.reversed(keys.refundAnswer("re_r13")) && t.reversed(keys.refund("re_r13")) && t.reversed(keys.refundFunding(t.key))).toBe(true);
    expect(t.family(t.root)).toMatchObject({ funded: 0, paid: 0, reserved: 0 });
    expect(await t.refund(t.row, "re_r13", 8_000, "failed")).toBe(0);
    expect(await t.reserve(t.row, { scope: "cancellation", id: t.id }, `${t.key}_refused1`, 8_000, [`${t.key}_refused1`])).toMatchObject({ outcome: "reserved" });
    expect(t.caps()).toEqual([]);
  });

  it("a refund refused before it counted releases its reservation, REFUSED, with its funding", async () => {
    const t = await cancelled();
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    expect(await t.refund(t.row, "re_refused", 8_000, "canceled", t.key)).toBe(1);
    expect(t.release(t.key)).toMatchObject({ reason: "REFUSED" });
    expect(t.family(t.root)).toMatchObject({ funded: 0, reserved: 0 });
  });

  it("posts nothing for an inactive journal or a booking outside the population", async () => {
    const t = await cancelled();
    expect(await postCardRefundCash(t.db.tx, INACTIVE, { paymentId: `${t.id}-payment`, attemptKeys: new Map() })).toBe(0);
    t.db.seed("booking", { id: "outside", lodgeId: LODGE, memberId: A });
    t.db.seed("payment", { id: "outside-payment", bookingId: "outside" });
    expect(await postCardRefundCash(t.db.tx, context, { paymentId: "outside-payment", attemptKeys: new Map() })).toBe(0);
  });

  it("D4: a refund after a merge pays the survivor's successor, and the family's caps hold", async () => {
    const t = await cancelled();
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    t.db.rows("booking", { id: t.id })[0]!.memberId = B;
    await t.refund(t.row, "re_merged", 8_000, "succeeded", t.key);
    const successor = t.db.rows("memberMoneyObligation", { obligationKey: `${t.root}|for|MEMBER|${B}` })[0]!;
    expect(memberMoneyApplicationTotals(t.state()).obligations.get(successor.id as string)).toBe(8_000);
    expect(t.family(t.root)).toMatchObject({ paid: 8_000, reserved: 0 });
    expect(t.caps()).toEqual([]);
  });
});

describe("a Paid another way close", () => {
  const close = (t: Awaited<ReturnType<typeof cancelled>>, recordId: string, amountCents: number, restCents: number, rest: "club-keeps" | "still-owed" | null) =>
    postPaidAnotherWayClose(t.db.tx, context, { bookingId: t.id, obligation: { scope: "cancellation", id: t.id }, recordId, amountCents, restCents, rest,
      attemptKeys: [t.key], transactionIds: [t.row.id], closedAt: new Date(context.effectiveAt), actorMemberId: OFFICER });

  it("club keeps the rest: closes the reservation without a refund, pays the bank cash, retains and collects the rest", async () => {
    const t = await cancelled();
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    expect(await close(t, "record", 5_000, 3_000, "club-keeps")).toBeGreaterThanOrEqual(3);
    expect(t.release(t.key)).toMatchObject({ reason: "CLOSED_WITHOUT_REFUND" });
    expect(t.family(t.root)).toMatchObject({ funded: 5_000, paid: 8_000, reserved: 0 });
    expect(memberMoneyApplicationTotals(t.state()).collected).toBe(5_000);
    expect(t.db.rows("memberMoneyLine", { chargeIdentity: `booking:${t.id}:refund-close-out:record` }).length).toBeGreaterThan(0);
    expect(t.caps()).toEqual([]);
    expect(await close(t, "record", 5_000, 3_000, "club-keeps")).toBe(0);
  });

  it("still owed: the debt stays open for the rest, and a later close pays only that", async () => {
    const t = await cancelled();
    await close(t, "part", 5_000, 3_000, "still-owed");
    expect(t.event(keys.refundCloseOut(t.root))).toBeNull();
    expect(t.family(t.root)).toMatchObject({ paid: 5_000 });
    await close(t, "rest", 3_000, 0, null);
    expect(t.family(t.root)).toMatchObject({ funded: 8_000, paid: 8_000 });
    expect(t.caps()).toEqual([]);
  });

  it("posts nothing for a debt not in the journal, a row that maps to none, or an inactive journal", async () => {
    const t = await cancelled();
    expect(await postPaidAnotherWayClose(t.db.tx, context, { bookingId: t.id, obligation: { scope: "modification", id: "missing" }, recordId: "r", amountCents: 1, restCents: 0, rest: null,
      attemptKeys: [], transactionIds: [], closedAt: new Date(context.effectiveAt), actorMemberId: OFFICER })).toBe(0);
    expect(await postPaidAnotherWayClose(t.db.tx, context, { bookingId: t.id, obligation: null, recordId: "r", amountCents: 1, restCents: 0, rest: null,
      attemptKeys: [], transactionIds: [], closedAt: new Date(context.effectiveAt), actorMemberId: OFFICER })).toBe(0);
    expect(await postPaidAnotherWayClose(t.db.tx, INACTIVE, { bookingId: t.id, obligation: { scope: "cancellation", id: t.id }, recordId: "r", amountCents: 1, restCents: 0, rest: null,
      attemptKeys: [], transactionIds: [], closedAt: new Date(context.effectiveAt), actorMemberId: OFFICER })).toBe(0);
  });
});

describe("which debt a recovery row pays", () => {
  const row = (idempotencyKey: string, type = "REFUND_BOOKING_MODIFICATION") => ({ type, idempotencyKey, bookingId: "b", paymentIntentId: "pi", amountCents: 700 });

  it("MUTATION: maps every door's key exactly, and nothing it cannot", () => {
    expect(cardRefundObligationOfRecoveryKey(row("booking_cancel_refund_recovery_b"))).toEqual({ kind: "door", ref: { scope: "cancellation", id: "b" } });
    expect(cardRefundObligationOfRecoveryKey(row("capacity_claim_failed_refund_recovery_b_pi_race"))).toEqual({ kind: "door", ref: { scope: "capture-return", id: "pi_race" } });
    expect(cardRefundObligationOfRecoveryKey(row("duplicate_capture_b_pi_dup"))).toEqual({ kind: "door", ref: { scope: "capture-return", id: "pi_dup" } });
    expect(cardRefundObligationOfRecoveryKey(row("late_capture_approval_refund_recovery_pi_late"))).toEqual({ kind: "door", ref: { scope: "capture-return", id: "pi_late" } });
    expect(cardRefundObligationOfRecoveryKey(row("refund_request_refund_req"))).toEqual({ kind: "door", ref: { scope: "refund-request", id: "req" } });
    expect(cardRefundObligationOfRecoveryKey(row("payment_recovery_modification_refund_mod"))).toEqual({ kind: "door", ref: { scope: "modification", id: "mod" } });
    expect(cardRefundObligationOfRecoveryKey(row("edit_financial_review_refund_recovery_task"))).toEqual({ kind: "door", ref: { scope: "review", id: "task" } });
    expect(cardRefundObligationOfRecoveryKey(row("payment_recovery_refund_tx_pi", "REFUND_SUPERSEDED_PAYMENT"))).toEqual({ kind: "door", ref: { scope: "capture-return", id: "pi", ensureFaceCents: 700 } });
    expect(cardRefundObligationOfRecoveryKey(row("card_refund_failed_later_re_1"))).toEqual({ kind: "failed-later", stripeRefundId: "re_1" });
    expect(cardRefundObligationOfRecoveryKey(row("card_refund_still_owed_record"))).toEqual({ kind: "still-owed", closeRecordId: "record" });
    for (const key of ["organiser_child_refund_mod_x", "group_settlement_refund_recovery_s", "payment_recovery_cancel_tx_pi", "something_else"]) {
      expect(cardRefundObligationOfRecoveryKey(row(key))).toBeNull();
    }
    expect(cardRefundObligationOfRecoveryKey(row("booking_cancel_refund_recovery_b", "CANCEL_PAYMENT_INTENT"))).toBeNull();
    expect(refundDoorOfObligationKey(`${R05("review", "t")}|after|j1|for|MEMBER|m`)).toEqual({ scope: "review", id: "t" });
    expect(refundDoorOfObligationKey("booking-charge:b")).toBeNull();
  });

  it("resolves a failed refund's row to the debt its R12 paid, and a still-owed row through its close's own row", async () => {
    const t = await cancelled();
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    await t.refund(t.row, "re_paid", 8_000, "succeeded", t.key);
    await t.refund(t.row, "re_unapplied", 100);
    expect(await resolveCardRefundObligation(t.db.tx, row("card_refund_failed_later_re_paid"))).toEqual({ scope: "cancellation", id: t.id });
    expect(await resolveCardRefundObligation(t.db.tx, row("card_refund_failed_later_re_unapplied"))).toBeNull();
    t.db.seed("paymentRecoveryOperation", { id: "op-cancel", type: "REFUND_BOOKING_MODIFICATION", idempotencyKey: `booking_cancel_refund_recovery_${t.id}`, bookingId: t.id, paymentIntentId: "pi", amountCents: 8_000 });
    t.db.seed("manualRefundTask", { id: "record-1", occurrenceKey: "card-refund-paid-another-way:op-cancel:no-xero-note" });
    expect(await resolveCardRefundObligation(t.db.tx, row("card_refund_still_owed_record-1"))).toEqual({ scope: "cancellation", id: t.id });
    expect(await resolveCardRefundObligation(t.db.tx, row("card_refund_still_owed_missing"))).toBeNull();
  });
});

describe("the refund census and the rollback rules", () => {
  it("lists a stranded reservation, answers one a recovery row marks made, and releases another only by the OPERATOR", async () => {
    const t = await cancelled();
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    await t.refund(t.row, "re_stranded", 8_000); // recorded without the journal's key
    expect((await t.census()).map((f) => f.kind).sort()).toEqual(["STRANDED_RESERVATION", "UNAPPLIED_CARD_REFUND"]);
    t.db.seed("paymentRecoveryOperation", { id: "op", type: "REFUND_BOOKING_MODIFICATION", idempotencyKey: `booking_cancel_refund_recovery_${t.id}`, bookingId: t.id,
      paymentId: `${t.id}-payment`, paymentIntentId: t.row.stripePaymentIntentId, amountCents: 8_000, stripeKeyPrefix: null,
      allocationPlan: [{ paymentTransactionId: t.row.id, amountCents: 8_000, madeRefundId: "re_stranded" }] });
    expect((await t.census()).map((f) => f.kind).sort()).toEqual(["ANSWERABLE_RESERVATION", "UNAPPLIED_CARD_REFUND"]);
    expect(await reconcileMadeRefundReservations(t.db.tx, context, `${t.id}-payment`)).toBe(1);
    expect(await t.census()).toEqual([]);
    expect(await reconcileMadeRefundReservations(t.db.tx, INACTIVE, `${t.id}-payment`)).toBe(0);

    const u = await cancelled({ id: "other" });
    await u.reserve(u.row, { scope: "cancellation", id: u.id }, u.key, 8_000);
    expect(await releaseReservationByOperator(u.db.tx, context, { reservationId: u.reservation(u.key)!.id as string })).toMatchObject({ bookingId: u.id, attemptKey: u.key, amountCents: 8_000 });
    expect(u.release(u.key)).toMatchObject({ reason: "OPERATOR" });
    expect(u.family(u.root)).toMatchObject({ funded: 0, reserved: 0 });
    await expect(releaseReservationByOperator(u.db.tx, context, { reservationId: "missing" })).rejects.toBeInstanceOf(MemberMoneyPlanError);
    await expect(releaseReservationByOperator(u.db.tx, INACTIVE, { reservationId: "missing" })).rejects.toBeInstanceOf(MemberMoneyPlanError);
  });

  it("a counted refund with no R12 is listed until the next cash-writer run posts it", async () => {
    const t = await cancelled();
    t.db.seed("paymentRefund", { id: "r", paymentId: `${t.id}-payment`, paymentTransactionId: t.row.id, stripeRefundId: "re_missing", stripePaymentIntentId: t.row.stripePaymentIntentId,
      amountCents: 500, status: "succeeded", stripeCreatedAt: null, createdAt: new Date(context.effectiveAt), updatedAt: new Date(context.effectiveAt) });
    expect((await t.census()).map((f) => f.kind)).toEqual(["CARD_REFUND_WITHOUT_EVENT"]);
  });
});

describe("the one test for a refused reservation", () => {
  it("knows the refusal bare or as a sender's PartialRefundError cause, and nothing else", () => {
    const refusal = new MemberMoneyReservationRefused(["C4_capture_cap: x"]);
    expect(isCardRefundReservationRefusal(refusal)).toBe(true);
    expect(isCardRefundReservationRefusal(new PartialRefundError({ completedRefundCents: 0, refunds: [], cause: refusal, format: CLUB_FORMAT_TEST }))).toBe(true);
    expect(isCardRefundReservationRefusal(new PartialRefundError({ completedRefundCents: 0, refunds: [], cause: new Error("network"), format: CLUB_FORMAT_TEST }))).toBe(false);
    expect(isCardRefundReservationRefusal(new MemberMoneyPlanError(["C1"]))).toBe(false);
  });
});
