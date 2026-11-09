/**
 * Unit witnesses for M4c's card refund engine (#4516): R05, the reservation step, R12/R13 in the cash writer, a
 * "Paid another way" close, the lazy D4 refund successor, the recovery-row map, the census and the rollback rules.
 * The real plan builder, store and engine run against the in-memory journal (`support/member-money-memory-db.ts`);
 * `member-money-refunds.realdb.test.ts` proves the same flows against PostgreSQL's deferred checks and locks.
 */
import { describe, expect, it, vi } from "vitest";
import logger from "@/lib/logger";
import { memberMoneyEventKeys as keys, postMemberMoneyEvent, isCardRefundReservationRefusal, MemberMoneyReservationRefused, type MemberMoneyDebtor } from "@/lib/member-money";
import {
  cardRefundObligationOfRecoveryKey,
  closeKeptCaptureReturn,
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
import { isRefundReservationOpen, readBookingRefundCensus, reconcileMadeRefundReservations, releaseReservationByOperator } from "@/lib/member-money/internal/refund-census";
import { isMemberMoneyCapProblem, MEMBER_MONEY_CAP_PROBLEMS } from "@/lib/member-money/internal/cap-problems";
import { reservationGenerationKey, stripeKeyOfReservation } from "@/lib/member-money/internal/refund-family";
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
  /** A key's sender: the cancel's own prefix, or (a test key) what comes before its first underscore. */
  const senderOf = (attemptKey: string) => attemptKey.startsWith(`booking_cancel_refund_${id}`) ? `booking_cancel_refund_${id}` : attemptKey.split("_")[0]!;
  const reserve = (row: { id: string }, obligation: CardRefundObligationRef, attemptKey: string, amountCents: number, planAttemptKeys = [attemptKey], senderKeyPrefix = senderOf(attemptKey)) =>
    reserveCardRefundSlice(db.tx, context, { paymentId: `${id}-payment`, obligation, attemptKey, senderKeyPrefix, paymentTransactionId: row.id, amountCents, planAttemptKeys });
  /** A card refund row as the legacy writer records it, then the one cash writer's journal step for the payment. */
  const refund = (row: { id: string; stripePaymentIntentId: string }, refundId: string, amountCents: number, status = "succeeded", attemptKey?: string) => {
    const existing = db.rows("paymentRefund", { stripeRefundId: refundId })[0];
    if (existing) existing.status = status;
    else db.seed("paymentRefund", { id: refundId, paymentId: `${id}-payment`, paymentTransactionId: row.id, stripeRefundId: refundId, stripePaymentIntentId: row.stripePaymentIntentId,
      amountCents, status, stripeCreatedAt: new Date(context.effectiveAt), createdAt: new Date(context.effectiveAt), updatedAt: new Date(context.effectiveAt) });
    return postCardRefundCash(db.tx, context, { paymentId: `${id}-payment`, attemptKeys: new Map(attemptKey ? [[refundId, attemptKey]] : []),
      firstRecorded: new Set(existing ? [] : [refundId]) });
  };
  const state = () => db.applicationState(id);
  const family = (root: string) => memberMoneyApplicationTotals(state()).families.get(root) ?? { funded: 0, paid: 0, reserved: 0 };
  const event = (eventKey: string) => db.rows("memberMoneyEvent", { eventKey })[0] ?? null;
  const journalOf = (eventKey: string) => { const e = event(eventKey); return e ? db.rows("memberMoneyJournal", { eventId: e.id })[0]! : null; };
  const reversed = (eventKey: string) => { const j = journalOf(eventKey); return j ? db.rows("memberMoneyJournal", { reversesJournalId: j.id }).length === 1 : false; };
  const reservation = (attemptKey: string) => db.rows("memberMoneyRefundReservation", { attemptKey })[0] ?? null;
  const release = (attemptKey: string) => { const r = reservation(attemptKey); return r ? db.rows("memberMoneyRefundReservationRelease", { reservationId: r.id })[0] ?? null : null; };
  const withdraw = (scope: CardRefundObligationRef["scope"], scopeId: string, senderKeyPrefix: string, reason = "release_claim", ctx: Parameters<typeof withdrawRefundObligation>[1] = context) =>
    withdrawRefundObligation(db.tx, ctx, { bookingId: id, scope, id: scopeId, reason, senderKeyPrefix });
  return { db, id, owner, capture, cancel, r05, reserve, refund, withdraw, state, family, event, journalOf, reversed, reservation, release,
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
    expect(await t.withdraw("refund-request", "appeal", "appeal")).toBe(true);
    expect(t.release("appeal_key")).toMatchObject({ reason: "SUPERSEDED_KEY" });
    expect(t.reversed(R05("refund-request", "appeal"))).toBe(true);
    expect(await t.withdraw("refund-request", "appeal", "appeal", "again")).toBe(false);
    expect(await t.withdraw("refund-request", "appeal", "appeal", "inactive", INACTIVE)).toBe(false);
    // A re-approval posts under the chain's next key.
    expect(await t.r05("refund-request", "appeal", 1_000, { concession: true })).toMatch(/\|after\|/);

    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    await t.refund(t.row, "re_paid", 8_000, "succeeded", t.key);
    await expect(t.withdraw("cancellation", t.id, `booking_cancel_refund_${t.id}`, "too late")).rejects.toBeInstanceOf(MemberMoneyPlanError);
  });

  it("MUTATION (review F3): a door withdraws only its own keys' reservations; another sender's open one refuses the withdrawal", async () => {
    const t = await cancelled();
    await t.r05("refund-request", "appeal", 1_000, { concession: true });
    await t.reserve(t.row, { scope: "refund-request", id: "appeal" }, "other_key", 1_000);
    await expect(t.withdraw("refund-request", "appeal", "appeal")).rejects.toBeInstanceOf(MemberMoneyPlanError);
    expect(t.release("other_key")).toBeNull();
    expect(t.reversed(R05("refund-request", "appeal"))).toBe(false);
  });

  it("review M5: a door naming its debt again for another amount keeps the first face, and says so", async () => {
    const t = await cancelled();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    expect(await t.r05("cancellation", t.id, 7_000)).toBe(t.root);
    expect(t.db.rows("memberMoneyObligation", { obligationKey: t.root })[0]).toMatchObject({ faceCents: 8_000 });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ faceCents: 8_000, doorCents: 7_000 }), expect.stringContaining("#4516"));
    warn.mockClear();
    await t.r05("cancellation", t.id, 8_000);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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

  it("MUTATION (probe 15): takes back collection only from the receipt of the slice's own capture, never another", async () => {
    const t = await setup();
    const first = await t.capture(6_000);
    const second = await t.capture(4_000);
    await t.cancel(2_000);
    await t.r05("cancellation", t.id, 8_000);
    const applied = (row: { stripePaymentIntentId: string }) => {
      const line = t.db.rows("memberMoneyLine", { journalId: t.journalOf(keys.capture(row.stripePaymentIntentId))!.id, account: "MEMBER_RECEIVABLE", side: "CREDIT" })[0]!;
      return memberMoneyApplicationTotals(t.state()).sources.get(line.id as string) ?? 0;
    };
    await t.reserve(first, { scope: "cancellation", id: t.id }, "k_first", 3_000);
    expect([applied(first), applied(second)]).toEqual([6_000, 4_000]); // 3000 collected + 3000 funded; untouched
    await t.reserve(second, { scope: "cancellation", id: t.id }, "k_second", 4_000, ["k_first", "k_second"]);
    expect(t.db.rows("memberMoneyApplication").filter((a) => a.reversesApplicationId !== null).length).toBe(2);
    expect(memberMoneyApplicationTotals(t.state()).collected).toBe(3_000);
    expect([applied(first), applied(second)]).toEqual([6_000, 4_000]);
    expect(t.family(R05("cancellation", t.id))).toMatchObject({ funded: 7_000, reserved: 7_000 });
    expect(t.caps()).toEqual([]);
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

  it("skips, never refuses: an inactive journal, a booking outside the population, a capture with no receipt, a debt not in the journal, an answered key", async () => {
    const t = await cancelled();
    expect(await reserveCardRefundSlice(t.db.tx, INACTIVE, { paymentId: `${t.id}-payment`, obligation: { scope: "cancellation", id: t.id }, attemptKey: "k", senderKeyPrefix: "k", paymentTransactionId: t.row.id, amountCents: 1, planAttemptKeys: ["k"] }))
      .toEqual({ outcome: "skipped", reason: "inactive" });
    t.db.seed("booking", { id: "outside", lodgeId: LODGE, memberId: A });
    t.db.seed("payment", { id: "outside-payment", bookingId: "outside" });
    expect(await reserveCardRefundSlice(t.db.tx, context, { paymentId: "outside-payment", obligation: { scope: "cancellation", id: "outside" }, attemptKey: "k", senderKeyPrefix: "k", paymentTransactionId: t.row.id, amountCents: 1, planAttemptKeys: ["k"] }))
      .toEqual({ outcome: "skipped", reason: "outside-population" });
    const bare = t.db.seed("paymentTransaction", { id: "bare", paymentId: `${t.id}-payment`, source: "STRIPE", kind: "ADDITIONAL", status: "SUCCEEDED", amountCents: 100, stripePaymentIntentId: "pi-bare" })[0] as { id: string };
    expect(await t.reserve(bare, { scope: "cancellation", id: t.id }, "k_bare", 100)).toEqual({ outcome: "skipped", reason: "no-receipt" });
    expect(await t.reserve(t.row, { scope: "modification", id: "missing" }, "k_missing", 100)).toEqual({ outcome: "skipped", reason: "no-obligation" });
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    await t.refund(t.row, "re_1", 8_000, "succeeded", t.key); // ANSWERED: Stripe made it, and replays it to this key
    expect(await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000)).toEqual({ outcome: "skipped", reason: "key-already-decided" });
  });

  it("MUTATION (review F4): a key released without a refund reserves its next generation, which its refund then answers", async () => {
    const t = await cancelled();
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    await t.refund(t.row, "re_refused", 8_000, "failed", t.key); // REFUSED in this delivery
    expect(t.release(t.key)).toMatchObject({ reason: "REFUSED" });
    // The same Stripe key asked again: never sent unreserved.
    expect(await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000)).toMatchObject({ outcome: "reserved", attemptKey: `${t.key}#2`, replayed: false });
    expect(await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000)).toMatchObject({ outcome: "reserved", attemptKey: `${t.key}#2`, replayed: true });
    // Stripe's evidence names the bare key; it answers the open generation.
    expect(await t.refund(t.row, "re_made", 8_000, "succeeded", t.key)).toBe(1);
    expect(t.release(`${t.key}#2`)).toMatchObject({ reason: "ANSWERED", stripeRefundId: "re_made" });
    expect(t.family(t.root)).toMatchObject({ paid: 8_000, reserved: 0 });
    expect(t.caps()).toEqual([]);
  });

  it("review F4: an appeal re-approved after its release_claim reserves its unchanged keys again, against the new R05, and is paid", async () => {
    const t = await cancelled();
    const second = await t.capture(2_000, false);
    await t.r05("refund-request", "appeal", 2_000, { concession: true });
    await t.reserve(second, { scope: "refund-request", id: "appeal" }, "appeal_key", 2_000);
    expect(await t.withdraw("refund-request", "appeal", "appeal")).toBe(true);
    const next = await t.r05("refund-request", "appeal", 2_000, { concession: true });
    expect(next).toMatch(/\|after\|/);
    expect(await t.reserve(second, { scope: "refund-request", id: "appeal" }, "appeal_key", 2_000)).toMatchObject({ outcome: "reserved", attemptKey: "appeal_key#2" });
    await t.refund(second, "re_appeal", 2_000, "succeeded", "appeal_key");
    expect(t.family(next!)).toMatchObject({ paid: 2_000, reserved: 0 });
    expect(await t.census()).toEqual([]);
  });

  it("MUTATION (review L1): a retry replays its claim only for the same slice; a key reserved for other cents is refused before Stripe", async () => {
    const t = await setup();
    await t.capture(10_000);
    const late = await t.capture(3_000, false);
    const debt = { scope: "capture-return" as const, id: late.stripePaymentIntentId, ensureFaceCents: 3_000 };
    await t.reserve(late, debt, "superseded", 3_000);
    await expect(t.reserve(late, debt, "superseded", 2_000)).rejects.toBeInstanceOf(MemberMoneyReservationRefused);
    expect(await t.reserve(late, debt, "superseded", 3_000)).toMatchObject({ outcome: "reserved", replayed: true });
  });

  it("MUTATION (review F3): a sender supersedes only its own keys; another sender's open reservation on the same debt stands, and caps refuse the second", async () => {
    const t = await setup();
    await t.capture(10_000);
    const late = await t.capture(3_000, false);
    const debt = { scope: "capture-return" as const, id: late.stripePaymentIntentId, ensureFaceCents: 3_000 };
    await t.reserve(late, debt, "webhook_key", 3_000, ["webhook_key"], "webhook");
    const refusal = await t.reserve(late, debt, "repair_key", 3_000, ["repair_key"], "repair").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(MemberMoneyReservationRefused);
    expect(t.release("webhook_key")).toBeNull();
    // The same sender's re-plan does supersede its own.
    expect(await t.reserve(late, debt, "webhook_key_refused1", 3_000, ["webhook_key_refused1"], "webhook")).toMatchObject({ outcome: "reserved" });
    expect(t.release("webhook_key")).toMatchObject({ reason: "SUPERSEDED_KEY" });
  });

  it("a reservation's attempt key: generation 1 is the Stripe key, later ones are marked, and the Stripe key is read back from either", () => {
    expect(reservationGenerationKey("k_1_100", 1)).toBe("k_1_100");
    expect(reservationGenerationKey("k_1_100", 3)).toBe("k_1_100#3");
    expect(stripeKeyOfReservation("k_1_100#3")).toBe("k_1_100");
    expect(stripeKeyOfReservation("k_1_100")).toBe("k_1_100");
    expect(() => reservationGenerationKey("k#1", 1)).toThrow(MemberMoneyPlanError);
    expect(() => reservationGenerationKey("k", 0)).toThrow(MemberMoneyPlanError);
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
    await u.reserve(u.row, { scope: "cancellation", id: u.id }, u.key, 8_000);
    // The key arrives in the same delivery that says the refund failed: the failure wins, nothing answers it,
    // and (review L3) the reservation it never answered is released, REFUSED, with its funding.
    await u.refund(u.row, "re_failed", 8_000, "failed", u.key);
    expect(u.event(keys.refundAnswer("re_failed"))).toBeNull();
    expect(u.reversed(keys.refund("re_failed"))).toBe(true);
    expect(u.release(u.key)).toMatchObject({ reason: "REFUSED" });
    expect(u.family(u.root)).toMatchObject({ funded: 0, paid: 0, reserved: 0 });
  });

  it("MUTATION (review L3): only the delivery that first records a refused refund releases a reservation for it; a redelivery leaves a re-send's generation alone", async () => {
    const t = await cancelled();
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    await t.refund(t.row, "re_first", 8_000, "failed", t.key);
    expect(t.release(t.key)).toMatchObject({ reason: "REFUSED" });
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000); // generation 2, in flight
    // A redelivery of the same failure, keyed by its evidence, records nothing first.
    await t.refund(t.row, "re_first", 8_000, "failed", t.key);
    expect(t.release(`${t.key}#2`)).toBeNull();
    expect(await isRefundReservationOpen(t.db.tx, t.key)).toBe(true);
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

  it("MUTATION (review M1): two kept rests of one debt each post their own close-out, so neither is left open", async () => {
    const t = await cancelled();
    await close(t, "first", 4_000, 1_000, "club-keeps");
    await close(t, "second", 2_000, 1_000, "club-keeps");
    expect(t.event(keys.refundCloseOut("first"))).not.toBeNull();
    expect(t.event(keys.refundCloseOut("second"))).not.toBeNull();
    expect(t.family(t.root)).toMatchObject({ paid: 8_000 });
    expect(t.caps()).toEqual([]);
  });

  it("still owed: the debt stays open for the rest, and a later close pays only that", async () => {
    const t = await cancelled();
    await close(t, "part", 5_000, 3_000, "still-owed");
    expect(t.event(keys.refundCloseOut("part"))).toBeNull();
    expect(t.family(t.root)).toMatchObject({ paid: 5_000 });
    await close(t, "rest", 3_000, 0, null);
    expect(t.family(t.root)).toMatchObject({ funded: 8_000, paid: 8_000 });
    expect(t.caps()).toEqual([]);
  });

  it("MUTATION (probe 9): cash is never refused for a cap: a close whose receipts cannot fund it still posts its bank cash, funding trimmed", async () => {
    const t = await cancelled();
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    await t.refund(t.row, "re_cancel", 8_000, "succeeded", t.key); // the capture's 8000 refunded; 2000 left collected
    await t.r05("refund-request", "appeal", 3_000, { concession: true });
    const posted = await postPaidAnotherWayClose(t.db.tx, context, { bookingId: t.id, obligation: { scope: "refund-request", id: "appeal" }, recordId: "appeal-close",
      amountCents: 3_000, restCents: 0, rest: null, attemptKeys: [], transactionIds: [t.row.id], closedAt: new Date(context.effectiveAt), actorMemberId: OFFICER });
    expect(posted).toBeGreaterThan(0);
    expect(t.db.rows("memberMoneyLine", { journalId: t.journalOf(keys.paidAnotherWay("appeal-close"))!.id }).map((l) => `${l.side} ${l.account} ${l.amountCents}`).sort())
      .toEqual(["CREDIT BANK 3000", "DEBIT REFUND_PAYABLE 3000"]);
    expect(t.family(R05("refund-request", "appeal"))).toMatchObject({ funded: 2_000, paid: 3_000 });
    expect(t.caps()).toEqual([]);
  });

  it("MUTATION (review M3): a debt not in the journal, or a row that maps to none, still posts its bank cash, unapplied; an inactive journal posts nothing", async () => {
    const t = await cancelled();
    expect(await postPaidAnotherWayClose(t.db.tx, context, { bookingId: t.id, obligation: { scope: "modification", id: "missing" }, recordId: "r", amountCents: 100, restCents: 0, rest: null,
      attemptKeys: [], transactionIds: [], closedAt: new Date(context.effectiveAt), actorMemberId: OFFICER })).toBe(1);
    expect(t.db.rows("memberMoneyLine", { journalId: t.journalOf(keys.paidAnotherWay("r"))!.id }).map((l) => `${l.side} ${l.account} ${l.amountCents} ${l.memberId ?? ""}`).sort())
      .toEqual(["CREDIT BANK 100 ", `DEBIT MEMBER_RECEIVABLE 100 ${A}`]);
    expect(t.db.rows("memberMoneyApplication", { journalId: t.journalOf(keys.paidAnotherWay("r"))!.id })).toEqual([]);
    expect(await postPaidAnotherWayClose(t.db.tx, context, { bookingId: t.id, obligation: { scope: "modification", id: "missing" }, recordId: "r", amountCents: 100, restCents: 0, rest: null,
      attemptKeys: [], transactionIds: [], closedAt: new Date(context.effectiveAt), actorMemberId: OFFICER })).toBe(0);
    expect(await postPaidAnotherWayClose(t.db.tx, context, { bookingId: t.id, obligation: null, recordId: "r2", amountCents: 1, restCents: 0, rest: null,
      attemptKeys: [], transactionIds: [], closedAt: new Date(context.effectiveAt), actorMemberId: OFFICER })).toBe(1);
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
    const hand = { kind: "CANCELLED_BOOKING_HAND_BACK", status: "COMPLETED" };
    t.db.seed("paymentRecoveryOperation", { id: "op-cancel", type: "REFUND_BOOKING_MODIFICATION", idempotencyKey: `booking_cancel_refund_recovery_${t.id}`, bookingId: t.id, paymentIntentId: "pi", amountCents: 8_000 });
    t.db.seed("manualRefundTask", { id: "record-1", occurrenceKey: "card-refund-paid-another-way:op-cancel:no-xero-note", ...hand });
    expect(await resolveCardRefundObligation(t.db.tx, row("card_refund_still_owed_record-1"))).toEqual({ scope: "cancellation", id: t.id });
    // A rest of a rest is followed back to the row it was first owed on.
    t.db.seed("paymentRecoveryOperation", { id: "op-rest", type: "REFUND_BOOKING_MODIFICATION", idempotencyKey: "card_refund_still_owed_record-1", bookingId: t.id, paymentIntentId: "pi", amountCents: 3_000 });
    t.db.seed("manualRefundTask", { id: "record-2", occurrenceKey: "card-refund-paid-another-way:op-rest", ...hand });
    expect(await resolveCardRefundObligation(t.db.tx, row("card_refund_still_owed_record-2"))).toEqual({ scope: "cancellation", id: t.id });
    expect(await resolveCardRefundObligation(t.db.tx, row("card_refund_still_owed_missing"))).toBeNull();
    // A record of another kind is no close, so it names nothing.
    t.db.seed("manualRefundTask", { id: "record-3", occurrenceKey: "card-refund-paid-another-way:op-cancel", kind: "EDIT_FINANCIAL_REVIEW", status: "COMPLETED" });
    expect(await resolveCardRefundObligation(t.db.tx, row("card_refund_still_owed_record-3"))).toBeNull();
  });

  it("MUTATION (review L4): a failed refund's row resolves through the answer that applied an unapplied R12", async () => {
    const t = await cancelled();
    await t.refund(t.row, "re_answered", 8_000); // unapplied first
    await t.reserve(t.row, { scope: "cancellation", id: t.id }, t.key, 8_000);
    await t.refund(t.row, "re_answered", 8_000, "succeeded", t.key); // answered later
    expect(await resolveCardRefundObligation(t.db.tx, row("card_refund_failed_later_re_answered"))).toEqual({ scope: "cancellation", id: t.id });
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

  it("MUTATION (review M3): lists a close with no R14, and a kept rest with no close-out, from the close's own record", async () => {
    const t = await cancelled();
    t.db.seed("paymentRecoveryOperation", { id: "op", type: "REFUND_BOOKING_MODIFICATION", idempotencyKey: `booking_cancel_refund_recovery_${t.id}`, bookingId: t.id,
      paymentId: `${t.id}-payment`, paymentIntentId: t.row.stripePaymentIntentId, amountCents: 8_000 });
    t.db.seed("manualRefundTask", { id: "before", occurrenceKey: "card-refund-paid-another-way:op", kind: "CANCELLED_BOOKING_HAND_BACK", status: "COMPLETED", amountCents: 3_000, raisedAmountCents: 8_000 });
    expect(await t.census()).toEqual([{ bookingId: t.id, identity: "before", kind: "PAID_ANOTHER_WAY_WITHOUT_EVENT", cents: 3_000 }]);
    // R14 posts, but nothing closes out the 5000 its record says the club kept.
    await postPaidAnotherWayClose(t.db.tx, context, { bookingId: t.id, obligation: { scope: "cancellation", id: t.id }, recordId: "before", amountCents: 3_000, restCents: 5_000,
      rest: "still-owed", attemptKeys: [], transactionIds: [t.row.id], closedAt: new Date(context.effectiveAt), actorMemberId: OFFICER });
    expect(await t.census()).toEqual([{ bookingId: t.id, identity: "before", kind: "KEPT_REST_WITHOUT_CLOSE_OUT", cents: 5_000 }]);
  });

  it("a counted refund with no R12 is listed until the next cash-writer run posts it", async () => {
    const t = await cancelled();
    t.db.seed("paymentRefund", { id: "r", paymentId: `${t.id}-payment`, paymentTransactionId: t.row.id, stripeRefundId: "re_missing", stripePaymentIntentId: t.row.stripePaymentIntentId,
      amountCents: 500, status: "succeeded", stripeCreatedAt: null, createdAt: new Date(context.effectiveAt), updatedAt: new Date(context.effectiveAt) });
    expect((await t.census()).map((f) => f.kind)).toEqual(["CARD_REFUND_WITHOUT_EVENT"]);
  });
});

describe("a kept late capture (review M5)", () => {
  it("MUTATION: the keep reverses the capture's refund debt an automatic refund posted, once nothing pays or holds it", async () => {
    const t = await setup();
    await t.capture(10_000);
    const late = await t.capture(3_000, false);
    const root = R05("capture-return", late.stripePaymentIntentId);
    const keep = () => closeKeptCaptureReturn(t.db.tx, context, { bookingId: t.id, paymentIntentId: late.stripePaymentIntentId, actorMemberId: OFFICER });
    expect(await keep()).toBe(false); // nothing posted yet
    await t.reserve(late, { scope: "capture-return", id: late.stripePaymentIntentId, ensureFaceCents: 3_000 }, "late_key", 3_000);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    expect(await keep()).toBe(false); // held by an open reservation
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    await t.refund(late, "re_refused", 3_000, "failed", "late_key"); // Stripe refused it
    expect(await keep()).toBe(true);
    expect(t.reversed(root)).toBe(true);
    expect(await keep()).toBe(false);
    expect(await closeKeptCaptureReturn(t.db.tx, INACTIVE, { bookingId: t.id, paymentIntentId: late.stripePaymentIntentId, actorMemberId: OFFICER })).toBe(false);
    expect(t.caps()).toEqual([]);
  });
});

describe("the refund caps' codes (review L6)", () => {
  it("names a cap by its code, bare or with what broke it, and nothing else", () => {
    expect(isMemberMoneyCapProblem(MEMBER_MONEY_CAP_PROBLEMS.C3)).toBe(true);
    expect(isMemberMoneyCapProblem(`${MEMBER_MONEY_CAP_PROBLEMS.C1}: applications exceed their source line`)).toBe(true);
    expect(isMemberMoneyCapProblem("C2: collect exceeds the booking's live charge")).toBe(false);
    expect(isMemberMoneyCapProblem("C1")).toBe(false);
    expect(isMemberMoneyCapProblem("C4_capture_cap_extra")).toBe(false);
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
