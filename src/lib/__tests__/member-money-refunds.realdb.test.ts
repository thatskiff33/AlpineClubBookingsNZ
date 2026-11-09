import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  closeKeptCaptureReturn,
  postBookingReceipts,
  postMemberMergeTransfer,
  postPaidAnotherWayClose,
  postRefundObligation,
  reserveCardRefundSlice,
  withdrawRefundObligation,
  type CardRefundObligationRef,
} from "@/lib/member-money/doors";
import {
  memberMoneyEventKeys,
  MemberMoneyReservationRefused,
  postMemberMoneyEvent,
  readBookingReceiptCensus,
  readBookingRefundCensus,
  reconcileMadeRefundReservations,
  releaseReservationByOperator,
} from "@/lib/member-money";
import { readMemberMoneyApplicationState } from "@/lib/member-money/internal/application-read";
import { memberMoneyApplicationTotals, memberMoneyConservationProblems } from "@/lib/member-money/internal/application-state";
import { syncBookingLedgerSettlements } from "@/lib/booking-ledger-settlement-sync";
import { PartialRefundError, recordStripeRefundsAgainstTransaction, refundPaymentTransactions, syncRefundsFromStripeCharge } from "@/lib/payment-transactions";
import { buildBookingCancellationRefundMetadata, buildLateCaptureRefundStripeKeyPrefix, refundSliceStripeIdempotencyKey } from "@/lib/payment-recovery-keys";
import { refundRequestStripeMetadata } from "@/lib/refund-slice-evidence";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { resetStripeRaceHooks, stripeRaceHooks } from "./support/stripe-race-double";
import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures } from "./support/booking-ledger-history";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

/**
 * #4516 (Ledger M4c): card refunds on PostgreSQL, through the doors' own entry and the one cash writer, against the
 * journal's deferred checks: R05, the reservation step, R12 applied and unapplied, an answer, R13, the releases, a
 * "Paid another way" close, a withdrawn approval, a member merge, the census and the rollback rules.
 *
 * DATABASE_URL must point at the race database before any import builds the Prisma client (#4516 review).
 */
vi.hoisted(() => {
  if (process.env.RUN_CONCURRENCY_RACE_TESTS === "1" && process.env.CONCURRENCY_RACE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.CONCURRENCY_RACE_DATABASE_URL;
  }
});

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-m4c-";
const MERGE_MEMBERS = `${PREFIX}x-${randomUUID().slice(0, 8)}-`;
const names = historyNames(PREFIX);
const context = memberMoneyTestContext();
let db: PrismaClient;
let sequence = 0;

const charge = (id: string) => `booking:${id}:test`;

async function booking(cents = 10_000, memberId = names.memberId) {
  const id = `${PREFIX}${++sequence}`;
  await createHistoryBooking(db, { ...names, memberId }, id, { payment: { amountCents: cents, source: "STRIPE" } });
  const where = { bookingId: id, lodgeId: names.lodgeId };
  await db.$transaction((tx) => postMemberMoneyEvent(tx, context, {
    kind: "CHARGE", eventKey: memberMoneyEventKeys.bookingCharge(id), origin: "APP", source: { kind: "BOOKING", id, version: "1" }, reason: "Synthetic R01",
    obligations: [{ key: memberMoneyEventKeys.bookingCharge(id), kind: "CHARGE", debtor: { kind: "MEMBER", memberId }, faceCents: cents, evidence: {} }],
    legs: [
      { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: cents, booking: where, debtor: { kind: "MEMBER", memberId }, obligationKey: memberMoneyEventKeys.bookingCharge(id), evidence: {} },
      { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: cents, booking: where, chargeIdentity: charge(id), evidence: {} },
    ] }));
  return id;
}

/** A card capture, settled on the legacy ledger and collected by its R06. */
async function capture(id: string, cents: number) {
  const row = await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, source: "STRIPE", kind: "PRIMARY", status: "SUCCEEDED",
    amountCents: cents, stripePaymentIntentId: `${id}-capture-${++sequence}` } });
  await db.$transaction((tx) => syncBookingLedgerSettlements({ paymentId: `${id}-payment`, store: tx }));
  await db.$transaction((tx) => postBookingReceipts(tx, context, { paymentId: `${id}-payment`, decision: { paymentIntentId: row.stripePaymentIntentId!, collect: true } }));
  return row;
}

/** A synthetic R04: the whole charge corrected, the kept part charged again, under `lock(1)`. */
async function cancelKeeping(id: string, chargedCents: number, keptCents: number, memberId = names.memberId) {
  const where = { bookingId: id, lodgeId: names.lodgeId };
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    await postMemberMoneyEvent(tx, context, { kind: "ADJUSTMENT", eventKey: memberMoneyEventKeys.cancellation(id, 0), origin: "APP",
      source: { kind: "BOOKING", id, version: "cancel" }, reason: "Synthetic R04",
      legs: [
        { type: "revenue", account: "BOOKING_REVENUE", side: "DEBIT", grossCents: chargedCents, booking: where, chargeIdentity: charge(id), evidence: {} },
        ...(keptCents > 0 ? [{ type: "revenue" as const, account: "BOOKING_REVENUE" as const, side: "CREDIT" as const, grossCents: keptCents, booking: where, chargeIdentity: charge(id), evidence: {} }] : []),
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: chargedCents - keptCents, booking: where, debtor: { kind: "MEMBER", memberId }, evidence: {} },
      ] });
  });
}

const r05 = (id: string, scope: CardRefundObligationRef["scope"], scopeId: string, amountCents: number, concession = false) =>
  db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    return postRefundObligation(tx, context, { bookingId: id, scope, id: scopeId, amountCents, origin: "APP", debtorRead: "booking-row", concession });
  });

/** A key's sender: the slice keys of a cancel or an appeal by their own prefix; any other test key is its own. */
const senderOf = (id: string, row: { id: string }, attemptKey: string) => attemptKey.startsWith(`booking_cancel_refund_${id}`) ? `booking_cancel_refund_${id}`
  : attemptKey.includes(`_${row.id}_`) ? attemptKey.slice(0, attemptKey.indexOf(`_${row.id}_`)) : attemptKey;
const reserve = (id: string, row: { id: string }, obligation: CardRefundObligationRef, attemptKey: string, amountCents: number, planAttemptKeys = [attemptKey],
  senderKeyPrefix = senderOf(id, row, attemptKey)) =>
  db.$transaction((tx) => reserveCardRefundSlice(tx, context, { paymentId: `${id}-payment`, obligation, attemptKey, senderKeyPrefix, paymentTransactionId: row.id, amountCents, planAttemptKeys }));

/** Stripe's answer for a refund, recorded through the one cash writer, with its slice key as Stripe returns it. */
const refund = (id: string, row: { id: string; stripePaymentIntentId: string | null }, refundId: string, amountCents: number,
  options: { status?: string; evidence?: string; senderKey?: string } = {}) =>
  recordStripeRefundsAgainstTransaction({ paymentId: `${id}-payment`, paymentTransactionId: row.id, journal: context,
    refunds: [{ id: refundId, amount: amountCents, currency: "nzd", status: options.status ?? "succeeded", created: 1_782_864_000,
      payment_intent: row.stripePaymentIntentId, metadata: options.evidence ? { refundSliceKey: options.evidence } : {} }],
    ...(options.senderKey ? { attemptKeys: new Map([[refundId, options.senderKey]]) } : {}) });

const state = (id: string) => db.$transaction((tx) => readMemberMoneyApplicationState(tx, id));
const totals = async (id: string) => memberMoneyApplicationTotals(await state(id));
const capsHold = async (id: string) => expect(memberMoneyConservationProblems(await state(id))).toEqual([]);
const refundCensus = (id: string) => db.$transaction((tx) => readBookingRefundCensus(tx, `${id}-payment`));
const receiptCensus = (id: string) => db.$transaction((tx) => readBookingReceiptCensus(tx, `${id}-payment`));
const event = (eventKey: string) => db.memberMoneyEvent.findUnique({ where: { eventKey }, include: { journal: { include: { reversedBy: true, applications: true, lines: true } } } });
const reservationOf = (attemptKey: string) => db.memberMoneyRefundReservation.findUnique({ where: { attemptKey }, include: { release: true } });
const family = (key: string, id: string) => totals(id).then((t) => t.families.get(key) ?? { funded: 0, paid: 0, reserved: 0 });
const R05 = (scope: CardRefundObligationRef["scope"], scopeId: string) => memberMoneyEventKeys.refundObligation(scope, scopeId);

/** A paid card booking cancelled keeping a fee: charge 10000 collected by one capture, 8000 owed back. */
async function cancelledPaidBooking() {
  const id = await booking();
  const row = await capture(id, 10_000);
  await cancelKeeping(id, 10_000, 2_000);
  await r05(id, "cancellation", id, 8_000);
  return { id, row, key: `booking_cancel_refund_${id}_${row.id}_8000` };
}

(RUN ? describe : describe.skip)("M4c card refunds on synthetic PostgreSQL bookings", () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "M4c refunds");
    process.env.DATABASE_URL = url;
    ({ prisma: db } = await import("@/lib/prisma"));
    await cleanHistories(db, PREFIX);
    await db.member.deleteMany({ where: { id: { startsWith: `${PREFIX}x-` } } });
    await seedHistoryFixtures(db, PREFIX);
  }, 60_000);
  afterAll(async () => {
    if (!db) return;
    await cleanHistories(db, PREFIX);
    await db.member.deleteMany({ where: { id: { startsWith: `${PREFIX}x-` } } });
  }, 60_000);

  it("R05 moves a cancellation's card debt to its own obligation once; the receipt census's over-collection is settled by the refund", async () => {
    const { id, row, key } = await cancelledPaidBooking();
    expect(await r05(id, "cancellation", id, 8_000)).toBe(R05("cancellation", id)); // a retry posts nothing new
    expect(await db.memberMoneyEvent.count({ where: { eventKey: { startsWith: "refund-obligation|" }, sourceIdentity: id } })).toBe(1);
    expect((await receiptCensus(id)).map((f) => f.kind)).toContain("OVER_COLLECTED");
    expect(await reserve(id, row, { scope: "cancellation", id }, key, 8_000)).toMatchObject({ outcome: "reserved", replayed: false });
    expect(await family(R05("cancellation", id), id)).toMatchObject({ funded: 8_000, paid: 0, reserved: 8_000 });
    expect((await totals(id)).collected).toBe(2_000);
    await refund(id, row, "re_m4c_cancel", 8_000, { evidence: key });
    expect(await family(R05("cancellation", id), id)).toMatchObject({ funded: 8_000, paid: 8_000, reserved: 0 });
    expect((await reservationOf(key))?.release?.reason).toBe("ANSWERED");
    const r12 = await event(memberMoneyEventKeys.refund("re_m4c_cancel"));
    expect(r12?.journal?.lines.map((l) => `${l.side} ${l.account} ${l.amountCents}`).sort()).toEqual(["CREDIT STRIPE_CLEARING 8000", "DEBIT REFUND_PAYABLE 8000"]);
    await capsHold(id);
    expect((await receiptCensus(id)).map((f) => f.kind)).toEqual([]);
    expect(await refundCensus(id)).toEqual([]);
    // A redelivery of the same refund posts nothing.
    await refund(id, row, "re_m4c_cancel", 8_000, { evidence: key });
    expect(await db.memberMoneyEvent.count({ where: { eventKey: memberMoneyEventKeys.refund("re_m4c_cancel") } })).toBe(1);
  });

  it("MUTATION (probe 11): a refund with no reservation behind its key posts unapplied, never onto a debt; a key arriving later answers it once", async () => {
    const { id, row, key } = await cancelledPaidBooking();
    await refund(id, row, "re_m4c_dash", 8_000); // a dashboard refund, no evidence
    expect((await event(memberMoneyEventKeys.refund("re_m4c_dash")))?.journal?.applications).toEqual([]);
    expect((await refundCensus(id)).map((f) => f.kind)).toEqual(["UNAPPLIED_CARD_REFUND"]);
    await reserve(id, row, { scope: "cancellation", id }, key, 8_000);
    await refund(id, row, "re_m4c_dash", 8_000, { senderKey: key });
    expect(await event(memberMoneyEventKeys.refundAnswer("re_m4c_dash"))).not.toBeNull();
    expect(await family(R05("cancellation", id), id)).toMatchObject({ paid: 8_000, reserved: 0 });
    expect((await reservationOf(key))?.release?.reason).toBe("ANSWERED");
    await refund(id, row, "re_m4c_dash", 8_000, { senderKey: key });
    expect(await db.memberMoneyEvent.count({ where: { eventKey: memberMoneyEventKeys.refundAnswer("re_m4c_dash") } })).toBe(1);
    await capsHold(id);
    expect(await refundCensus(id)).toEqual([]);
  });

  it("R13: a refund that counted and then failed reverses its cash and its funding once; the re-send on the next key funds again without refusal", async () => {
    const { id, row, key } = await cancelledPaidBooking();
    await reserve(id, row, { scope: "cancellation", id }, key, 8_000);
    await refund(id, row, "re_m4c_fail", 8_000, { evidence: key, status: "pending" });
    expect(await family(R05("cancellation", id), id)).toMatchObject({ funded: 8_000, paid: 8_000 });
    await refund(id, row, "re_m4c_fail", 8_000, { evidence: key, status: "failed" });
    await refund(id, row, "re_m4c_fail", 8_000, { evidence: key, status: "failed" }); // a duplicate delivery
    expect(await family(R05("cancellation", id), id)).toMatchObject({ funded: 0, paid: 0, reserved: 0 });
    expect((await event(memberMoneyEventKeys.refund("re_m4c_fail")))?.journal?.reversedBy).not.toBeNull();
    const r12 = await event(memberMoneyEventKeys.refund("re_m4c_fail"));
    expect(await db.memberMoneyEvent.count({ where: { eventKey: memberMoneyEventKeys.reversal(r12!.journal!.id) } })).toBe(1);
    const next = `${key}_refused1`;
    expect(await reserve(id, row, { scope: "cancellation", id }, next, 8_000, [next])).toMatchObject({ outcome: "reserved" });
    await refund(id, row, "re_m4c_resent", 8_000, { evidence: next });
    expect(await family(R05("cancellation", id), id)).toMatchObject({ funded: 8_000, paid: 8_000, reserved: 0 });
    await capsHold(id);
  });

  it("an answer after the refund failed is refused: nothing answers a refund that no longer counts", async () => {
    const { id, row, key } = await cancelledPaidBooking();
    await refund(id, row, "re_m4c_late", 8_000, { status: "pending" }); // unapplied
    await refund(id, row, "re_m4c_late", 8_000, { status: "failed" });
    await reserve(id, row, { scope: "cancellation", id }, key, 8_000);
    await refund(id, row, "re_m4c_late", 8_000, { status: "failed", senderKey: key });
    expect(await event(memberMoneyEventKeys.refundAnswer("re_m4c_late"))).toBeNull();
    expect((await reservationOf(key))?.release).toBeNull();
  });

  it("REFUSED: a refund Stripe refused before it ever counted releases its reservation with its funding", async () => {
    const { id, row, key } = await cancelledPaidBooking();
    await reserve(id, row, { scope: "cancellation", id }, key, 8_000);
    await refund(id, row, "re_m4c_refused", 8_000, { evidence: key, status: "failed" });
    expect((await reservationOf(key))?.release?.reason).toBe("REFUSED");
    expect(await event(memberMoneyEventKeys.refund("re_m4c_refused"))).toBeNull();
    expect(await family(R05("cancellation", id), id)).toMatchObject({ funded: 0, reserved: 0 });
    await capsHold(id);
  });

  it("MUTATION (probe 14): a re-plan to a new key releases the superseded reservation and reverses its funding, then funds again", async () => {
    const { id, row, key } = await cancelledPaidBooking();
    await reserve(id, row, { scope: "cancellation", id }, key, 8_000);
    const moved = `${key}_refused1`;
    await reserve(id, row, { scope: "cancellation", id }, moved, 8_000, [moved]);
    expect((await reservationOf(key))?.release?.reason).toBe("SUPERSEDED_KEY");
    expect((await event(memberMoneyEventKeys.refundFunding(key)))?.journal?.reversedBy).not.toBeNull();
    expect(await family(R05("cancellation", id), id)).toMatchObject({ funded: 8_000, reserved: 8_000 });
    await capsHold(id);
  });

  it("MUTATION (probes 2, 4): a second debt on the same capture that it cannot fund is refused before Stripe, and nothing of it commits", async () => {
    const { id, row, key } = await cancelledPaidBooking();
    await reserve(id, row, { scope: "cancellation", id }, key, 8_000);
    await r05(id, "refund-request", `${id}-appeal`, 5_000, true);
    const appeal = `refund_request_${id}-appeal_${row.id}_5000`;
    await expect(reserve(id, row, { scope: "refund-request", id: `${id}-appeal` }, appeal, 5_000)).rejects.toBeInstanceOf(MemberMoneyReservationRefused);
    expect(await reservationOf(appeal)).toBeNull();
    expect(await event(memberMoneyEventKeys.refundFunding(appeal))).toBeNull();
    expect(await event(memberMoneyEventKeys.refundUncollect(memberMoneyEventKeys.refundFunding(appeal)))).toBeNull();
    // An appeal the capture CAN still fund (the kept 2000) reserves without refusal.
    await r05(id, "refund-request", `${id}-small`, 2_000, true);
    const small = `refund_request_${id}-small_${row.id}_2000`;
    expect(await reserve(id, row, { scope: "refund-request", id: `${id}-small` }, small, 2_000)).toMatchObject({ outcome: "reserved" });
    await capsHold(id);
  });

  it("a slice whose capture has no receipt, or whose debt is not in the journal, is sent as today with no reservation", async () => {
    const { id, row } = await cancelledPaidBooking();
    expect(await reserve(id, row, { scope: "modification", id: "no-such-edit" }, "k_no_debt", 1_000)).toEqual({ outcome: "skipped", reason: "no-obligation" });
    const bare = await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, source: "STRIPE", kind: "ADDITIONAL", status: "SUCCEEDED", amountCents: 500, stripePaymentIntentId: `${id}-bare` } });
    expect(await reserve(id, bare, { scope: "cancellation", id }, "k_no_receipt", 500)).toEqual({ outcome: "skipped", reason: "no-receipt" });
  });

  it("a superseded capture's deferred R05 posts at its reservation, sized as its row, and its refund pays it", async () => {
    const id = await booking();
    await capture(id, 10_000);
    const late = await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, source: "STRIPE", kind: "ADDITIONAL", status: "SUCCEEDED", amountCents: 3_000, stripePaymentIntentId: `${id}-superseded` } });
    await db.$transaction((tx) => syncBookingLedgerSettlements({ paymentId: `${id}-payment`, store: tx }));
    await db.$transaction((tx) => postBookingReceipts(tx, context, { paymentId: `${id}-payment`, decision: { paymentIntentId: late.stripePaymentIntentId!, collect: false } }));
    const key = `payment_recovery_refund_${late.id}_${late.stripePaymentIntentId}`;
    expect(await reserve(id, late, { scope: "capture-return", id: late.stripePaymentIntentId!, ensureFaceCents: 3_000 }, key, 3_000)).toMatchObject({ outcome: "reserved" });
    await refund(id, late, "re_m4c_superseded", 3_000, { senderKey: key });
    expect(await family(R05("capture-return", late.stripePaymentIntentId!), id)).toMatchObject({ funded: 3_000, paid: 3_000, reserved: 0 });
    await capsHold(id);
    expect(await refundCensus(id)).toEqual([]);
  });

  it("Paid another way, part, the club keeps the rest: closes the reservation without a refund, pays and funds the bank cash, retains the rest", async () => {
    const { id, row, key } = await cancelledPaidBooking();
    await reserve(id, row, { scope: "cancellation", id }, key, 8_000);
    const posted = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      return postPaidAnotherWayClose(tx, context, { bookingId: id, obligation: { scope: "cancellation", id }, recordId: `${id}-close`, amountCents: 5_000,
        restCents: 3_000, rest: "club-keeps", attemptKeys: [key], transactionIds: [row.id], closedAt: new Date(context.effectiveAt), actorMemberId: names.officerId });
    });
    expect(posted).toBeGreaterThan(0);
    expect((await reservationOf(key))?.release?.reason).toBe("CLOSED_WITHOUT_REFUND");
    expect(await family(R05("cancellation", id), id)).toMatchObject({ funded: 5_000, paid: 8_000, reserved: 0 });
    expect(await event(memberMoneyEventKeys.refundCloseOut(`${id}-close`))).not.toBeNull();
    const t = await totals(id);
    expect(t.collected).toBe(5_000); // the kept fee and the retained rest, both collected from the one receipt
    await capsHold(id);
    expect((await receiptCensus(id)).map((f) => f.kind)).toEqual([]);
  });

  it("Paid another way, part, still owed: the debt stays open for the rest, and a later close pays only that", async () => {
    const { id, row, key } = await cancelledPaidBooking();
    await reserve(id, row, { scope: "cancellation", id }, key, 8_000);
    const close = (recordId: string, amountCents: number, restCents: number, rest: "still-owed" | null) => db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      return postPaidAnotherWayClose(tx, context, { bookingId: id, obligation: { scope: "cancellation", id }, recordId, amountCents, restCents, rest,
        attemptKeys: [key], transactionIds: [row.id], closedAt: new Date(context.effectiveAt), actorMemberId: names.officerId });
    });
    await close(`${id}-part`, 5_000, 3_000, "still-owed");
    expect(await family(R05("cancellation", id), id)).toMatchObject({ paid: 5_000, reserved: 0 });
    expect(await event(memberMoneyEventKeys.refundCloseOut(`${id}-part`))).toBeNull();
    await close(`${id}-rest`, 3_000, 0, null);
    expect(await family(R05("cancellation", id), id)).toMatchObject({ funded: 8_000, paid: 8_000 });
    await capsHold(id);
  });

  it("Paid another way against a refund Stripe made late: the late refund posts unapplied, never paying the debt twice", async () => {
    const { id, row, key } = await cancelledPaidBooking();
    await reserve(id, row, { scope: "cancellation", id }, key, 8_000);
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await postPaidAnotherWayClose(tx, context, { bookingId: id, obligation: { scope: "cancellation", id }, recordId: `${id}-paw`, amountCents: 8_000,
        restCents: 0, rest: null, attemptKeys: [key], transactionIds: [row.id], closedAt: new Date(context.effectiveAt), actorMemberId: names.officerId });
    });
    await refund(id, row, "re_m4c_paid_twice", 8_000, { evidence: key });
    expect((await event(memberMoneyEventKeys.refund("re_m4c_paid_twice")))?.journal?.applications).toEqual([]);
    expect(await family(R05("cancellation", id), id)).toMatchObject({ paid: 8_000 });
    await capsHold(id);
    expect((await refundCensus(id)).map((f) => f.kind)).toEqual(["UNAPPLIED_CARD_REFUND"]);
  });

  it("an approval withdrawn before Stripe was asked releases its reservation and reverses its R05; a re-approval posts under the chain's next key", async () => {
    const { id, row } = await cancelledPaidBooking();
    const requestId = `${id}-withdrawn`;
    await r05(id, "refund-request", requestId, 1_000, true);
    const key = `refund_request_${requestId}_${row.id}_1000`;
    await reserve(id, row, { scope: "refund-request", id: requestId }, key, 1_000);
    expect(await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      return withdrawRefundObligation(tx, context, { bookingId: id, scope: "refund-request", id: requestId, reason: "release_claim", senderKeyPrefix: `refund_request_${requestId}` });
    })).toBe(true);
    expect((await reservationOf(key))?.release?.reason).toBe("SUPERSEDED_KEY");
    expect((await event(R05("refund-request", requestId)))?.journal?.reversedBy).not.toBeNull();
    const again = await r05(id, "refund-request", requestId, 1_000, true);
    expect(String(again).startsWith(`${R05("refund-request", requestId)}|after|`)).toBe(true);
    await capsHold(id);

    // Review F4: the re-approval sends the same Stripe key, so a refund Stripe made under it is replayed, never
    // repeated; the journal reserves the key's next generation against the new R05, and the refund pays it.
    resetStripeRaceHooks();
    stripeRaceHooks.refund = async (args) => ({ id: `re_${args.idempotencyKey}`, object: "refund", amount: args.amountCents, currency: "nzd", status: "succeeded",
      created: 1_782_864_000, payment_intent: args.paymentIntentId, charge: `ch_${args.paymentIntentId}`, metadata: refundRequestStripeMetadata(args), reason: args.reason });
    try {
      await refundPaymentTransactions({ format: CLUB_FORMAT_TEST, paymentId: `${id}-payment`, amountCents: 1_000, allocation: [{ paymentTransactionId: row.id, amountCents: 1_000 }],
        metadata: { bookingId: id, reason: "refund_appeal_approved" }, idempotencyKeyPrefix: `refund_request_${requestId}`, obligation: { scope: "refund-request", id: requestId } });
    } finally {
      resetStripeRaceHooks();
    }
    expect((await reservationOf(`${key}#2`))?.release?.reason).toBe("ANSWERED");
    expect(await family(String(again), id)).toMatchObject({ paid: 1_000, reserved: 0 });
    await capsHold(id);
    expect(await refundCensus(id)).toEqual([]);
  });

  it("MUTATION (review F3): a second sender of one capture-return debt never releases the first's reservation in flight, and is refused", async () => {
    const id = await booking();
    await capture(id, 10_000);
    const late = await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, source: "STRIPE", kind: "ADDITIONAL", status: "SUCCEEDED", amountCents: 3_000, stripePaymentIntentId: `${id}-late` } });
    await db.$transaction((tx) => syncBookingLedgerSettlements({ paymentId: `${id}-payment`, store: tx }));
    await db.$transaction((tx) => postBookingReceipts(tx, context, { paymentId: `${id}-payment`, decision: { paymentIntentId: late.stripePaymentIntentId!, collect: false } }));
    const debt = { scope: "capture-return" as const, id: late.stripePaymentIntentId!, ensureFaceCents: 3_000 };
    // Round-2 review G: the senders' keys as their own builders make them (the repair tool's prefix is built inline there).
    const slice = { paymentTransactionId: late.id, amountCents: 3_000 };
    const webhookPrefix = buildLateCaptureRefundStripeKeyPrefix(id, late.stripePaymentIntentId!);
    const webhookKey = refundSliceStripeIdempotencyKey(webhookPrefix, slice);
    const repairPrefix = `late_cancel_refund_repair_${id}`;
    const repairKey = refundSliceStripeIdempotencyKey(repairPrefix, slice);
    await reserve(id, late, debt, webhookKey, 3_000, [webhookKey], webhookPrefix);
    await expect(reserve(id, late, debt, repairKey, 3_000, [repairKey], repairPrefix)).rejects.toBeInstanceOf(MemberMoneyReservationRefused);
    expect((await reservationOf(webhookKey))?.release).toBeNull();
    expect(await reservationOf(repairKey)).toBeNull();
    expect(await family(R05("capture-return", late.stripePaymentIntentId!), id)).toMatchObject({ funded: 3_000, reserved: 3_000, paid: 0 });
    await capsHold(id);

    // Review M5: Stripe refuses the webhook's refund, and the treasurer keeps the capture: its debt is reversed.
    await refund(id, late, "re_m4c_kept", 3_000, { evidence: webhookKey, status: "failed" });
    expect((await reservationOf(webhookKey))?.release?.reason).toBe("REFUSED");
    expect(await db.$transaction((tx) => closeKeptCaptureReturn(tx, context, { bookingId: id, paymentIntentId: late.stripePaymentIntentId!, actorMemberId: names.officerId }))).toBe(true);
    expect((await event(R05("capture-return", late.stripePaymentIntentId!)))?.journal?.reversedBy).not.toBeNull();
    await capsHold(id);
  });

  it("MUTATION (review M1): two closes of one debt that each let the club keep a rest post a close-out each, so nothing is left open", async () => {
    const { id, row } = await cancelledPaidBooking();
    const close = (recordId: string, amountCents: number, restCents: number) => db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      return postPaidAnotherWayClose(tx, context, { bookingId: id, obligation: { scope: "cancellation", id }, recordId, amountCents, restCents, rest: "club-keeps",
        attemptKeys: [], transactionIds: [row.id], closedAt: new Date(context.effectiveAt), actorMemberId: names.officerId });
    });
    await close(`${id}-first`, 3_000, 1_000);
    await close(`${id}-second`, 3_000, 1_000);
    expect(await event(memberMoneyEventKeys.refundCloseOut(`${id}-first`))).not.toBeNull();
    expect(await event(memberMoneyEventKeys.refundCloseOut(`${id}-second`))).not.toBeNull();
    expect(await family(R05("cancellation", id), id)).toMatchObject({ paid: 8_000, reserved: 0 });
    await capsHold(id);
  });

  it("MUTATION (review M3): a close whose debt is not in the journal still posts its bank cash, unapplied, to the owner", async () => {
    const { id } = await cancelledPaidBooking();
    const posted = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      return postPaidAnotherWayClose(tx, context, { bookingId: id, obligation: { scope: "modification", id: `${id}-before-m4c` }, recordId: `${id}-old-row`, amountCents: 2_500,
        restCents: 0, rest: null, attemptKeys: [], transactionIds: [], closedAt: new Date(context.effectiveAt), actorMemberId: names.officerId });
    });
    expect(posted).toBe(1);
    const r14 = await event(memberMoneyEventKeys.paidAnotherWay(`${id}-old-row`));
    expect(r14?.journal?.lines.map((l) => `${l.side} ${l.account} ${l.amountCents} ${l.memberId ?? ""}`).sort()).toEqual(["CREDIT BANK 2500 ", `DEBIT MEMBER_RECEIVABLE 2500 ${names.memberId}`]);
    expect(r14?.journal?.applications).toEqual([]);
    await capsHold(id);
  });

  it("a merge between the reservation and the refund: the refund pays the survivor's successor, and the family's caps hold", async () => {
    const [from, to] = await mergePair();
    const id = await booking(10_000, from);
    const row = await capture(id, 10_000);
    await cancelKeeping(id, 10_000, 2_000, from);
    await r05(id, "cancellation", id, 8_000);
    const key = `booking_cancel_refund_${id}_${row.id}_8000`;
    await reserve(id, row, { scope: "cancellation", id }, key, 8_000);
    await db.$transaction(async (tx) => {
      await tx.booking.update({ where: { id }, data: { memberId: to } });
      await postMemberMergeTransfer(tx, context, { fromMemberId: from, toMemberId: to, actorMemberId: names.officerId });
    });
    await refund(id, row, "re_m4c_merged", 8_000, { evidence: key });
    const s = await state(id);
    const successor = s.obligations.find((o) => o.key === `${R05("cancellation", id)}|for|MEMBER|${to}`);
    expect(successor).toMatchObject({ memberId: to, faceCents: 8_000 });
    expect(memberMoneyApplicationTotals(s).obligations.get(successor!.id)).toBe(8_000);
    expect(memberMoneyApplicationTotals(s).families.get(R05("cancellation", id))).toMatchObject({ paid: 8_000, reserved: 0 });
    expect(memberMoneyConservationProblems(s)).toEqual([]);
  });

  it("rollback rules: a reservation an old colour stranded is answered from its row's exact made mark; one nothing names is released only by the OPERATOR", async () => {
    const { id, row, key } = await cancelledPaidBooking();
    await reserve(id, row, { scope: "cancellation", id }, key, 8_000);
    // An old colour recorded the refund without the journal's key: unapplied, the reservation left open.
    await recordStripeRefundsAgainstTransaction({ paymentId: `${id}-payment`, paymentTransactionId: row.id, journal: { inactive: "unusable-currency", detail: "old colour" },
      refunds: [{ id: "re_m4c_stranded", amount: 8_000, currency: "nzd", status: "succeeded", created: 1_782_864_000, payment_intent: row.stripePaymentIntentId }] });
    await refund(id, row, "re_m4c_stranded", 8_000);
    expect((await refundCensus(id)).map((f) => f.kind).sort()).toEqual(["STRANDED_RESERVATION", "UNAPPLIED_CARD_REFUND"]);
    await db.paymentRecoveryOperation.create({ data: { type: "REFUND_BOOKING_MODIFICATION", status: "SUCCEEDED", bookingId: id, paymentId: `${id}-payment`,
      paymentIntentId: row.stripePaymentIntentId!, amountCents: 8_000, idempotencyKey: `booking_cancel_refund_recovery_${id}`,
      allocationPlan: [{ paymentTransactionId: row.id, amountCents: 8_000, madeRefundId: "re_m4c_stranded" }] as unknown as Prisma.InputJsonValue } });
    expect((await refundCensus(id)).map((f) => f.kind).sort()).toEqual(["ANSWERABLE_RESERVATION", "UNAPPLIED_CARD_REFUND"]);
    expect(await db.$transaction((tx) => reconcileMadeRefundReservations(tx, context, `${id}-payment`))).toBe(1);
    expect(await refundCensus(id)).toEqual([]);
    expect(await family(R05("cancellation", id), id)).toMatchObject({ paid: 8_000, reserved: 0 });

    const other = await cancelledPaidBooking();
    await reserve(other.id, other.row, { scope: "cancellation", id: other.id }, other.key, 8_000);
    const reservation = await reservationOf(other.key);
    await db.$transaction((tx) => releaseReservationByOperator(tx, context, { reservationId: reservation!.id }));
    expect((await reservationOf(other.key))?.release?.reason).toBe("OPERATOR");
    expect(await family(R05("cancellation", other.id), other.id)).toMatchObject({ funded: 0, reserved: 0 });
    await capsHold(other.id);
  });

  it("concurrent senders of one slice: the Payment row serializes them, one reserves and the other replays it", async () => {
    const { id, row, key } = await cancelledPaidBooking();
    const outcomes = await Promise.all([reserve(id, row, { scope: "cancellation", id }, key, 8_000), reserve(id, row, { scope: "cancellation", id }, key, 8_000)]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["reserved", "reserved"]);
    expect(outcomes.filter((o) => o.outcome === "reserved" && o.replayed)).toHaveLength(1);
    expect(await family(R05("cancellation", id), id)).toMatchObject({ funded: 8_000, reserved: 8_000 });
  });

  describe("the real sender, end to end: reservation, Stripe's request, the one cash writer (#4361 keys and markers kept)", () => {
    type Sent = Parameters<NonNullable<typeof stripeRaceHooks.refund>>[0];
    const sent: Sent[] = [];
    let answer: (args: Sent) => string = () => "succeeded";
    const stripeAnswers = (args: Sent) => {
      sent.push(args);
      return { id: `re_${args.idempotencyKey ?? "unkeyed"}`.slice(0, 200), object: "refund", amount: args.amountCents, currency: "nzd", status: answer(args),
        created: 1_782_864_000, payment_intent: args.paymentIntentId, charge: `ch_${args.paymentIntentId}`, metadata: refundRequestStripeMetadata(args), reason: args.reason };
    };
    const send = (id: string, row: { id: string }, cents: number, options: { obligation?: CardRefundObligationRef; stripeKeySuffix?: string } = {}) =>
      refundPaymentTransactions({ format: CLUB_FORMAT_TEST, paymentId: `${id}-payment`, amountCents: cents,
        allocation: [{ paymentTransactionId: row.id, amountCents: cents, ...(options.stripeKeySuffix ? { stripeKeySuffix: options.stripeKeySuffix } : {}) }],
        metadata: buildBookingCancellationRefundMetadata(id), idempotencyKeyPrefix: `booking_cancel_refund_${id}`, obligation: options.obligation });
    const beforeEachSend = () => {
      sent.length = 0;
      answer = () => "succeeded";
      resetStripeRaceHooks();
      stripeRaceHooks.refund = async (args) => stripeAnswers(args);
    };

    it("MUTATION (probe 18): the inline sender reserves, sends exactly today's request, and R12 answers it; charge.refunded adds nothing", async () => {
      beforeEachSend();
      const { id, row, key } = await cancelledPaidBooking();
      const result = await send(id, row, 8_000, { obligation: { scope: "cancellation", id } });
      // The wire body: the cancel's own metadata plus its slice key as evidence (`INV-PAY-147`), as before M4c.
      expect(sent).toEqual([{ paymentIntentId: row.stripePaymentIntentId, amountCents: 8_000, reason: "requested_by_customer",
        metadata: { ...buildBookingCancellationRefundMetadata(id), refundSliceKey: key }, idempotencyKey: key, stampRefundSliceKey: true }]);
      expect((await reservationOf(key))?.release?.reason).toBe("ANSWERED");
      expect(await family(R05("cancellation", id), id)).toMatchObject({ paid: 8_000, reserved: 0 });
      await syncRefundsFromStripeCharge({ paymentIntentId: row.stripePaymentIntentId!, stripeChargeId: `ch_${row.stripePaymentIntentId}`, refundedAmountCents: 8_000,
        refunds: [stripeAnswers({ paymentIntentId: row.stripePaymentIntentId!, amountCents: 8_000, reason: "requested_by_customer", metadata: buildBookingCancellationRefundMetadata(id), idempotencyKey: key, stampRefundSliceKey: true }) as never] });
      expect(await db.memberMoneyEvent.count({ where: { eventKey: memberMoneyEventKeys.refund(result.refunds[0]!.refundId) } })).toBe(1);
      await capsHold(id);
      expect(await refundCensus(id)).toEqual([]);

      // The same request for a booking outside the journal, byte for byte but its own ids: no journal touches Stripe.
      const outside = `${PREFIX}${++sequence}`;
      await createHistoryBooking(db, names, outside, { payment: { amountCents: 8_000, source: "STRIPE" } });
      const bare = await db.paymentTransaction.create({ data: { paymentId: `${outside}-payment`, source: "STRIPE", kind: "PRIMARY", status: "SUCCEEDED", amountCents: 8_000, stripePaymentIntentId: `${outside}-capture` } });
      sent.length = 0;
      await send(outside, bare, 8_000, { obligation: { scope: "cancellation", id: outside } });
      const outsideKey = `booking_cancel_refund_${outside}_${bare.id}_8000`;
      expect(sent).toEqual([{ paymentIntentId: bare.stripePaymentIntentId, amountCents: 8_000, reason: "requested_by_customer",
        metadata: { ...buildBookingCancellationRefundMetadata(outside), refundSliceKey: outsideKey }, idempotencyKey: outsideKey, stampRefundSliceKey: true }]);
      expect(await db.memberMoneyRefundReservation.count({ where: { attemptKey: { startsWith: `booking_cancel_refund_${outside}_` } } })).toBe(0);
    });

    it("#4361 keys kept: a refusal releases its reservation, and the re-plan's next key (`_refused1`) reserves and is answered", async () => {
      beforeEachSend();
      const { id, row, key } = await cancelledPaidBooking();
      answer = () => "failed";
      const refused = await send(id, row, 8_000, { obligation: { scope: "cancellation", id } });
      expect(refused.refunds[0]!.status).toBe("failed");
      expect((await reservationOf(key))?.release?.reason).toBe("REFUSED");
      answer = () => "succeeded";
      await send(id, row, 8_000, { obligation: { scope: "cancellation", id }, stripeKeySuffix: "refused1" });
      expect(sent.map((args) => args.idempotencyKey)).toEqual([key, `${key}_refused1`]);
      expect((await reservationOf(`${key}_refused1`))?.release?.reason).toBe("ANSWERED");
      expect(await family(R05("cancellation", id), id)).toMatchObject({ funded: 8_000, paid: 8_000, reserved: 0 });
      await capsHold(id);
    });

    it("a refused reservation asks Stripe for nothing: the sender throws before the slice, as the refusal", async () => {
      beforeEachSend();
      const { id, row, key } = await cancelledPaidBooking();
      await reserve(id, row, { scope: "cancellation", id }, key, 8_000);
      await r05(id, "refund-request", `${id}-appeal`, 5_000, true);
      const failure = await refundPaymentTransactions({ format: CLUB_FORMAT_TEST, paymentId: `${id}-payment`, amountCents: 5_000,
        allocation: [{ paymentTransactionId: row.id, amountCents: 5_000 }], metadata: { bookingId: id, reason: "refund_appeal_approved" },
        idempotencyKeyPrefix: `refund_request_${id}-appeal`, obligation: { scope: "refund-request", id: `${id}-appeal` } }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PartialRefundError);
      expect((failure as PartialRefundError).cause).toBeInstanceOf(MemberMoneyReservationRefused);
      expect(sent).toEqual([]);
      expect(await db.auditLog.count({ where: { targetId: id, action: "booking-payment.card-refund.reservation-refused" } })).toBe(1);
    });
  });

  it("a journal refusal inside a door rolls the door back with it (INV-MONEY-044)", async () => {
    const id = await booking();
    await capture(id, 10_000);
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await tx.booking.update({ where: { id }, data: { notes: "door wrote this" } });
      await postRefundObligation(tx, context, { bookingId: id, scope: "cancellation", id, amountCents: 2 ** 31, origin: "APP", debtorRead: "booking-row" });
    })).rejects.toThrow();
    expect((await db.booking.findUniqueOrThrow({ where: { id }, select: { notes: true } })).notes).not.toBe("door wrote this");
    expect(await event(R05("cancellation", id))).toBeNull();
  });
});

async function mergePair(): Promise<[string, string]> {
  const ids: [string, string] = [`${MERGE_MEMBERS}${++sequence}`, `${MERGE_MEMBERS}${++sequence}`];
  for (const id of ids) await db.member.create({ data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Merge", lastName: "Proof", ageTier: "ADULT" } });
  return ids;
}
