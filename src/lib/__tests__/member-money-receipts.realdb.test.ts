import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { postBookingReceipts, postMemberMergeTransfer } from "@/lib/member-money/doors";
import { memberMoneyEventKeys, postMemberMoneyEvent } from "@/lib/member-money";
import { readMemberMoneyApplicationState } from "@/lib/member-money/internal/application-read";
import { memberMoneyApplicationTotals } from "@/lib/member-money/internal/application-state";
import { readBookingReceiptCensus } from "@/lib/member-money/internal/receipt-census";
import { syncBookingLedgerSettlements } from "@/lib/booking-ledger-settlement-sync";
import { cleanHistories, createHistoryBooking, historyNames, seedHistoryFixtures } from "./support/booking-ledger-history";
import { memberMoneyTestContext } from "./support/member-money-fixtures";
import { assertSafeRaceDbUrl } from "./support/race-db-url";

/** The one shared double: the LAST file to register a factory wins, so every realdb file registers this same one. */
vi.mock("@/lib/stripe", async (importOriginal) =>
  (await import("./support/stripe-race-double")).stripeRaceDouble(await importOriginal()),
);

/** A seam after the receipt hook's live-charge read: a test commits a price edit there, from another connection. */
const liveChargeRead = vi.hoisted(() => ({ after: null as null | (() => Promise<void>) }));
vi.mock("@/lib/member-money/internal/booking-journal-read", async (importOriginal) => {
  const original = (await importOriginal()) as typeof import("@/lib/member-money/internal/booking-journal-read");
  return { ...original, readBookingLiveChargeCents: async (...args: Parameters<typeof original.readBookingLiveChargeCents>) => {
    const cents = await original.readBookingLiveChargeCents(...args);
    const after = liveChargeRead.after;
    liveChargeRead.after = null;
    if (after) await after();
    return cents;
  } };
});

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const PREFIX = "race-m4b-";
/** Merges need members of their own: a merge's key is its pair, and a merge moves every booking the member owns. */
const MERGE_MEMBERS = `${PREFIX}x-${randomUUID().slice(0, 8)}-`;
const names = historyNames(PREFIX);
const context = memberMoneyTestContext();
let db: PrismaClient;
let sequence = 0;

async function mergePair(): Promise<[string, string]> {
  const ids: [string, string] = [`${MERGE_MEMBERS}${++sequence}`, `${MERGE_MEMBERS}${++sequence}`];
  for (const id of ids) await db.member.create({ data: { id, email: `${id}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Merge", lastName: "Proof", ageTier: "ADULT" } });
  return ids;
}

async function merge(id: string, from: string, to: string) {
  await db.$transaction(async (tx) => {
    await tx.booking.update({ where: { id }, data: { memberId: to } });
    await postMemberMergeTransfer(tx, context, { fromMemberId: from, toMemberId: to, actorMemberId: names.officerId });
  });
}

async function booking(charge = 10_000, zero = false, memberId = names.memberId) {
  const id = `${PREFIX}${++sequence}`;
  await createHistoryBooking(db, { ...names, memberId }, id, { payment: { amountCents: charge, source: "STRIPE" } });
  await db.$transaction((tx) => postMemberMoneyEvent(tx, context, zero
    ? { kind: "ZERO", eventKey: memberMoneyEventKeys.bookingCharge(id), origin: "APP", source: { kind: "BOOKING", id, version: "1" }, reason: "Synthetic zero R01" }
    : { kind: "CHARGE", eventKey: memberMoneyEventKeys.bookingCharge(id), origin: "APP", source: { kind: "BOOKING", id, version: "1" }, reason: "Synthetic R01",
      obligations: [{ key: memberMoneyEventKeys.bookingCharge(id), kind: "CHARGE", debtor: { kind: "MEMBER", memberId }, faceCents: charge, evidence: {} }],
      legs: [
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: charge, booking: { bookingId: id, lodgeId: names.lodgeId }, debtor: { kind: "MEMBER", memberId }, obligationKey: memberMoneyEventKeys.bookingCharge(id), evidence: {} },
        { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: charge, booking: { bookingId: id, lodgeId: names.lodgeId }, chargeIdentity: `booking:${id}:test`, evidence: {} },
      ] }));
  return id;
}

async function cash(id: string, cents: number, source: "STRIPE" | "INTERNET_BANKING" = "STRIPE", manual = false) {
  const row = await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, source, kind: "PRIMARY", status: "SUCCEEDED", amountCents: cents,
    stripePaymentIntentId: source === "STRIPE" ? `${id}-capture-${++sequence}` : null } });
  await db.$transaction(async (tx) => {
    if (manual) await tx.payment.update({ where: { id: `${id}-payment` }, data: { manuallyMarkedPaidAt: new Date(context.effectiveAt), manuallyMarkedPaidByMemberId: names.officerId } });
    await syncBookingLedgerSettlements({ paymentId: `${id}-payment`, store: tx });
  });
  return row;
}
const post = (id: string, decision?: Parameters<typeof postBookingReceipts>[2]["decision"]) => db.$transaction((tx) => postBookingReceipts(tx, context, { paymentId: `${id}-payment`, decision }));
const totals = (id: string) => db.$transaction(async (tx) => memberMoneyApplicationTotals(await readMemberMoneyApplicationState(tx, id)));
const census = (id: string) => db.$transaction((tx) => readBookingReceiptCensus(tx, `${id}-payment`));
const successorOf = (id: string, memberId: string) =>
  db.memberMoneyObligation.findUnique({ where: { obligationKey: `${memberMoneyEventKeys.bookingCharge(id)}|for|MEMBER|${memberId}` } });

/**
 * The booking's open CHARGE faces (each live tip's face less what was applied to it), what is still owed by the
 * journal's own figures (live charge less collected), and each member's receivable balance on the booking.
 */
async function chargeChain(id: string) {
  return db.$transaction(async (tx) => {
    const state = await readMemberMoneyApplicationState(tx, id);
    const applied = memberMoneyApplicationTotals(state);
    const tips = state.obligations.filter((o) => o.kind === "CHARGE" && !state.obligations.some((c) => c.key.startsWith(`${o.key}|for|`)));
    const live = await tx.memberMoneyLine.findMany({ where: { bookingId: id, account: { in: ["BOOKING_REVENUE", "FEE_REVENUE"] } }, select: { side: true, grossCents: true, amountCents: true } });
    const charge = live.reduce((n, l) => n + (l.side === "CREDIT" ? 1 : -1) * (l.grossCents ?? l.amountCents), 0);
    const lines = await tx.memberMoneyLine.findMany({ where: { bookingId: id, account: "MEMBER_RECEIVABLE", debtorKind: "MEMBER" }, select: { memberId: true, side: true, amountCents: true } });
    const balances: Record<string, number> = {};
    for (const l of lines) balances[l.memberId!] = (balances[l.memberId!] ?? 0) + (l.side === "DEBIT" ? 1 : -1) * l.amountCents;
    return {
      openFaces: tips.reduce((n, o) => n + o.faceCents - (applied.obligations.get(o.id) ?? 0), 0),
      tipOwners: tips.map((o) => o.memberId),
      outstanding: charge - applied.collected,
      chargeOwners: [...new Set(state.obligations.filter((o) => o.kind === "CHARGE").map((o) => o.memberId))],
      balances,
    };
  });
}

/** A transaction client that records each delegate call, to prove what the hook reads under its caller's locks. */
function counting(tx: Prisma.TransactionClient) {
  const calls: string[] = [];
  const proxy = new Proxy(tx, { get(target, model) {
    const delegate = Reflect.get(target, model) as unknown;
    if (typeof delegate === "function") return (delegate as (...a: unknown[]) => unknown).bind(target);
    if (!delegate || typeof delegate !== "object") return delegate;
    return new Proxy(delegate, { get(inner, op) {
      const fn = Reflect.get(inner, op) as unknown;
      return typeof fn === "function" ? (...args: unknown[]) => { calls.push(`${String(model)}.${String(op)}`); return (fn as (...a: unknown[]) => unknown).apply(inner, args); } : fn;
    } });
  } });
  return { proxy, calls };
}

(RUN ? describe : describe.skip)("M4b receipts on synthetic PostgreSQL bookings", () => {
  beforeAll(async () => {
    const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
    assertSafeRaceDbUrl(url, "M4b receipts");
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

  it("collects only the exact instrument each writer chose, up to C2, keeping full cash", async () => {
    const id = await booking();
    const first = await cash(id, 7_000);
    expect((await census(id)).filter((f) => f.kind === "RECEIPT_WITHOUT_EVENT")).toHaveLength(1);
    expect(await post(id, { paymentIntentId: first.stripePaymentIntentId!, collect: true })).toBe(2);
    expect((await totals(id)).collected).toBe(7_000);
    const second = await cash(id, 8_000);
    expect(await post(id, { paymentIntentId: second.stripePaymentIntentId!, collect: true })).toBe(2);
    expect((await totals(id)).collected).toBe(10_000);
    expect(await post(id, { paymentIntentId: second.stripePaymentIntentId!, collect: true })).toBe(0);
    const money = await db.memberMoneyLine.aggregate({ where: { bookingId: id, account: "STRIPE_CLEARING", side: "DEBIT" }, _sum: { amountCents: true } });
    expect(money._sum.amountCents).toBe(15_000);
    expect((await census(id)).filter((f) => f.kind === "RECEIPT_WITHOUT_EVENT")).toEqual([]);
  });

  it("never collects a receipt a catch-up or a final hold posted, but collects one its writer deferred (#4516 review item 5)", async () => {
    const id = await booking();
    const caught = await cash(id, 2_000, "INTERNET_BANKING");
    expect(await post(id)).toBe(1);
    expect(await post(id, { transactionIds: [caught.id], collect: true })).toBe(0);
    expect((await totals(id)).collected).toBe(0);
    const held = await cash(id, 3_000);
    await post(id, { paymentIntentId: held.stripePaymentIntentId!, collect: false });
    expect(await post(id, { paymentIntentId: held.stripePaymentIntentId!, collect: true })).toBe(0);
    expect((await totals(id)).collected).toBe(0);
    const deferred = await cash(id, 4_000);
    await post(id, { paymentIntentId: deferred.stripePaymentIntentId!, collect: false, deferred: true });
    expect((await totals(id)).collected).toBe(0);
    expect(await post(id, { paymentIntentId: deferred.stripePaymentIntentId!, collect: true })).toBe(1);
    expect((await totals(id)).collected).toBe(4_000);
    expect((await census(id)).filter((f) => f.kind === "RECEIPT_WITHOUT_EVENT")).toEqual([]);
  });

  it("uses the provider capture instant and its club day, not the processing day", async () => {
    const id = await booking(); const row = await cash(id, 1_000);
    await post(id, { paymentIntentId: row.stripePaymentIntentId!, collect: false, effectiveAt: new Date("2026-06-29T11:59:00Z") });
    const event = await db.memberMoneyEvent.findUniqueOrThrow({ where: { eventKey: memberMoneyEventKeys.capture(row.stripePaymentIntentId!) } });
    expect(event.effectiveAt.toISOString()).toBe("2026-06-29T11:59:00.000Z");
    expect(event.effectiveDate.toISOString()).toBe("2026-06-29T00:00:00.000Z");
  });

  it("reverses exactly an officer receipt and its later collection once, then records the revived bank receipt separately", async () => {
    const id = await booking(); const row = await cash(id, 10_000, "INTERNET_BANKING", true);
    await post(id, { transactionIds: [row.id], collect: true });
    expect((await totals(id)).collected).toBe(10_000);
    await db.$transaction(async (tx) => {
      await tx.paymentTransaction.update({ where: { id: row.id }, data: { status: "FAILED" } });
      await tx.payment.update({ where: { id: `${id}-payment` }, data: { manuallyMarkedPaidAt: null, manuallyMarkedPaidByMemberId: null } });
      await syncBookingLedgerSettlements({ paymentId: `${id}-payment`, store: tx });
      await postBookingReceipts(tx, context, { paymentId: `${id}-payment` });
    });
    expect((await totals(id)).collected).toBe(0);
    expect(await post(id)).toBe(0);
    await db.$transaction(async (tx) => {
      await tx.paymentTransaction.update({ where: { id: row.id }, data: { status: "SUCCEEDED" } });
      await syncBookingLedgerSettlements({ paymentId: `${id}-payment`, store: tx });
      await postBookingReceipts(tx, context, { paymentId: `${id}-payment`, decision: { transactionIds: [row.id], collect: true } });
    });
    expect((await totals(id)).collected).toBe(10_000);
    const legs = await db.memberMoneyLine.findMany({ where: { bookingId: id, account: { in: ["CASH", "BANK"] } } });
    expect(legs.map((l) => [l.account, l.side, l.amountCents]).sort()).toEqual([["BANK", "DEBIT", 10_000], ["CASH", "CREDIT", 10_000], ["CASH", "DEBIT", 10_000]]);
  });

  it("opens the obligation lazily after ZERO R01 without charging revenue twice", async () => {
    const id = await booking(10_000, true);
    await db.$transaction((tx) => postMemberMoneyEvent(tx, context, { kind: "ADJUSTMENT", eventKey: memberMoneyEventKeys.modification(id), origin: "APP",
      source: { kind: "BOOKING", id, version: "edit" }, reason: "Synthetic increase from zero", legs: [
        { type: "amount", account: "MEMBER_RECEIVABLE", side: "DEBIT", amountCents: 10_000, debtor: { kind: "MEMBER", memberId: names.memberId }, booking: { bookingId: id, lodgeId: names.lodgeId }, evidence: {} },
        { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: 10_000, chargeIdentity: `booking:${id}:test`, booking: { bookingId: id, lodgeId: names.lodgeId }, evidence: {} },
      ] }));
    const row = await cash(id, 5_000);
    await post(id, { transactionIds: [row.id], collect: true });
    expect((await totals(id)).collected).toBe(5_000);
    expect(await db.memberMoneyEvent.count({ where: { eventKey: memberMoneyEventKeys.chargeOpen(id) } })).toBe(1);
    expect((await db.memberMoneyObligation.findUniqueOrThrow({ where: { obligationKey: memberMoneyEventKeys.bookingCharge(id) } })).faceCents).toBe(10_000);
  });

  it("D4: merge posts no successor; the survivor's first collection posts it under the Payment row, preserving prior collection", async () => {
    const [from, to] = await mergePair();
    const id = await booking(10_000, false, from); const row = await cash(id, 4_000);
    await post(id, { transactionIds: [row.id], collect: true });
    await merge(id, from, to);
    expect(await successorOf(id, to)).toBeNull();
    const next = await cash(id, 6_000);
    await post(id, { transactionIds: [next.id], collect: true });
    expect((await successorOf(id, to))?.faceCents).toBe(6_000);
    expect((await totals(id)).collected).toBe(10_000);
    expect((await census(id)).filter((f) => f.kind === "MERGED_DEBTOR_BALANCE")).toEqual([]);
  });

  it("a merge beside an uncommitted Payment-only collection cannot overstate the survivor's obligation (#4516 review item 1)", async () => {
    const [from, to] = await mergePair();
    const id = await booking(10_000, false, from);
    const held = await cash(id, 4_000);
    await post(id, { paymentIntentId: held.stripePaymentIntentId!, collect: false, deferred: true });
    let collected!: () => void; let release!: () => void;
    const applied = new Promise<void>((resolve) => { collected = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const collector = db.$transaction(async (tx) => {
      await postBookingReceipts(tx, context, { paymentId: `${id}-payment`, decision: { paymentIntentId: held.stripePaymentIntentId!, collect: true } });
      collected();
      await gate;
    }, { timeout: 30_000 });
    await applied;
    // The merge runs to its commit while the collection is applied but not committed: it holds no Payment row.
    await merge(id, from, to);
    release();
    await collector;
    expect((await totals(id)).collected).toBe(4_000);
    const next = await cash(id, 6_000);
    await post(id, { transactionIds: [next.id], collect: true });
    expect((await successorOf(id, to))?.faceCents).toBe(6_000);
    expect((await totals(id)).collected).toBe(10_000);
  });

  it("collects a receipt its writer deferred before a merge onto the owner's live obligation, never skipping it (#4516 review item 2)", async () => {
    const [from, to] = await mergePair();
    const id = await booking(10_000, false, from);
    const held = await cash(id, 4_000);
    await post(id, { paymentIntentId: held.stripePaymentIntentId!, collect: false, deferred: true });
    await merge(id, from, to);
    expect(await post(id, { paymentIntentId: held.stripePaymentIntentId!, collect: true })).toBeGreaterThan(0);
    expect((await totals(id)).collected).toBe(4_000);
    // The survivor's successor took the uncollected face; the merge-carried receipt was collected on it.
    expect((await successorOf(id, to))?.faceCents).toBe(10_000);
    const next = await cash(id, 6_000);
    await post(id, { transactionIds: [next.id], collect: true });
    expect((await totals(id)).collected).toBe(10_000);
    expect(await chargeChain(id)).toMatchObject({ openFaces: 0, outstanding: 0, tipOwners: [to] });
  });

  it("two hops: a receipt deferred before A merged into B, collected after B's own collection, lands on B's live tip (#4516 re-review B)", async () => {
    const [a, b] = await mergePair();
    const id = await booking(10_000, false, a);
    const held = await cash(id, 3_000);
    await post(id, { paymentIntentId: held.stripePaymentIntentId!, collect: false, deferred: true });
    await merge(id, a, b);
    const own = await cash(id, 4_000);
    await post(id, { transactionIds: [own.id], collect: true });
    expect(await post(id, { paymentIntentId: held.stripePaymentIntentId!, collect: true })).toBeGreaterThan(0);
    const chain = await chargeChain(id);
    expect(chain).toMatchObject({ openFaces: 3_000, outstanding: 3_000, tipOwners: [b] });
    expect(chain.balances).toEqual({ [a]: 0, [b]: 3_000 });
    expect((await census(id)).filter((f) => ["MERGED_DEBTOR_BALANCE", "UNAPPLIED_RECEIPT_ON_OPEN_CHARGE", "OVER_COLLECTED"].includes(f.kind))).toEqual([]);
  });

  it("three hops: A into B into C, deferred receipts of A and of B land on C's live tip and nothing is minted for B (#4516 re-review B)", async () => {
    const [a, b] = await mergePair();
    const [c] = await mergePair();
    const id = await booking(10_000, false, a);
    const heldA = await cash(id, 2_000);
    await post(id, { paymentIntentId: heldA.stripePaymentIntentId!, collect: false, deferred: true });
    await merge(id, a, b);
    const heldB = await cash(id, 1_000);
    await post(id, { paymentIntentId: heldB.stripePaymentIntentId!, collect: false, deferred: true });
    await merge(id, b, c);
    const own = await cash(id, 2_500);
    await post(id, { transactionIds: [own.id], collect: true });
    expect(await post(id, { paymentIntentId: heldA.stripePaymentIntentId!, collect: true })).toBeGreaterThan(0);
    expect(await post(id, { paymentIntentId: heldB.stripePaymentIntentId!, collect: true })).toBeGreaterThan(0);
    const chain = await chargeChain(id);
    expect(chain).toMatchObject({ openFaces: 4_500, outstanding: 4_500, tipOwners: [c] });
    expect(chain.chargeOwners.sort()).toEqual([a, c].sort());
    expect(chain.balances).toEqual({ [a]: 0, [b]: 0, [c]: 4_500 });
    expect((await census(id)).filter((f) => ["MERGED_DEBTOR_BALANCE", "UNAPPLIED_RECEIPT_ON_OPEN_CHARGE", "OVER_COLLECTED"].includes(f.kind))).toEqual([]);
  });

  it("moves only a receipt that landed on the merged-away member after the snapshot", async () => {
    const [from, to] = await mergePair();
    const id = await booking(10_000, false, from);
    const early = await cash(id, 4_000);
    await post(id, { paymentIntentId: early.stripePaymentIntentId!, collect: false });
    await merge(id, from, to);
    const strayIntent = `${id}-stray`;
    await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, source: "STRIPE", kind: "ADDITIONAL", status: "SUCCEEDED", amountCents: 2_000, stripePaymentIntentId: strayIntent } });
    await db.$transaction(async (tx) => {
      await syncBookingLedgerSettlements({ paymentId: `${id}-payment`, store: tx });
      const line = await tx.bookingLedgerLine.findFirstOrThrow({ where: { bookingId: id, anchorId: { not: early.id }, side: "SETTLEMENT", kind: "CARD_CAPTURE" } });
      await postMemberMoneyEvent(tx, context, { kind: "RECEIPT", eventKey: memberMoneyEventKeys.capture(strayIntent), origin: "STRIPE",
        source: { kind: "PAYMENT", id: line.anchorId!, version: line.id }, reason: "Receipt read the owner before the merge committed",
        legs: [
          { type: "amount", account: "STRIPE_CLEARING", side: "DEBIT", amountCents: 2_000, booking: { bookingId: id, lodgeId: names.lodgeId }, evidence: {} },
          { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 2_000, debtor: { kind: "MEMBER", memberId: from }, booking: { bookingId: id, lodgeId: names.lodgeId }, evidence: {} },
        ] });
    });
    expect((await census(id)).some((f) => f.kind === "MERGED_DEBTOR_BALANCE" && f.identity === from)).toBe(true);
    await post(id);
    expect((await census(id)).filter((f) => f.kind === "MERGED_DEBTOR_BALANCE")).toEqual([]);
    expect(await db.memberMoneyEvent.findUnique({ where: { eventKey: memberMoneyEventKeys.mergeResidue(from, to, memberMoneyEventKeys.capture(strayIntent)) } })).not.toBeNull();
    expect(await db.memberMoneyEvent.count({ where: { eventKey: { startsWith: `merge-residue:${to}` } } })).toBe(0);
  });

  it("reports drift without rewriting cash", async () => {
    const id = await booking(); const row = await cash(id, 8_000);
    await post(id);
    await db.paymentTransaction.update({ where: { id: row.id }, data: { amountCents: 9_000 } });
    expect((await census(id)).filter((f) => f.kind === "RECEIPT_AMOUNT_DRIFT")).toEqual([expect.objectContaining({ cents: 1_000 })]);
    expect(await post(id)).toBe(0);
  });
  it("ignores organiser-share mirrors and bookings outside the R01 population", async () => {
    const id = await booking();
    const row = await cash(id, 1_000);
    const { ORGANISER_SHARE_RECEIPT_REASON } = await import("@/lib/organiser-extra-state");
    await db.paymentTransaction.update({ where: { id: row.id }, data: { reason: ORGANISER_SHARE_RECEIPT_REASON } });
    expect(await post(id)).toBe(0);
    const outside = `${PREFIX}outside`;
    await createHistoryBooking(db, names, outside, { payment: { amountCents: 1_000, source: "STRIPE" } });
    await cash(outside, 1_000);
    expect(await post(outside)).toBe(0);
  });

  it("serialises two collectors under the Payment row, preserving both full cash receipts", async () => {
    const { markPaymentIntentTransactionSucceeded } = await import("@/lib/payment-transactions");
    const id = await booking();
    const intents = [`${id}-additional-a`, `${id}-additional-b`];
    for (const intent of intents) await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: intent, status: "PENDING", amountCents: 8_000 } });
    await Promise.all(intents.map((intent) => db.$transaction(async (tx) => {
      await markPaymentIntentTransactionSucceeded({ paymentIntentId: intent, amountCents: 8_000, store: tx, journal: context });
    })));
    expect((await totals(id)).collected).toBe(10_000);
    const receipts = await db.memberMoneyLine.aggregate({ where: { bookingId: id, account: "STRIPE_CLEARING", side: "DEBIT" }, _sum: { amountCents: true } });
    expect(receipts._sum.amountCents).toBe(16_000);
  });

  it("rolls back the writer's legacy change with a journal refusal", async () => {
    const id = await booking(); const row = await cash(id, 1_000);
    await expect(db.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: `${id}-payment` }, data: { manualPaymentNote: "must roll back" } });
      await postBookingReceipts(tx, { ...context, currency: "INVALID" }, { paymentId: `${id}-payment`, decision: { transactionIds: [row.id], collect: true } });
    })).rejects.toThrow();
    expect((await db.payment.findUniqueOrThrow({ where: { id: `${id}-payment` } })).manualPaymentNote).toBeNull();
    expect(await db.memberMoneyEvent.count({ where: { eventKey: memberMoneyEventKeys.capture(row.stripePaymentIntentId!) } })).toBe(0);
  });

  it("the real additional-capture writer decides collect under the Payment row from the booking as it stands (#4516 review item 3)", async () => {
    const { markPaymentIntentTransactionSucceeded } = await import("@/lib/payment-transactions");
    for (const booked of [{ status: "CONFIRMED", deleted: false, collect: true }, { status: "CANCELLED", deleted: false, collect: false },
      { status: "CANCELLED", deleted: true, collect: false }, { status: "CONFIRMED", deleted: true, collect: false }] as const) {
      const id = await booking();
      const intent = `${id}-additional`;
      await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: intent, status: "PENDING", amountCents: 5_000 } });
      // The caller read the booking live before its provider call; it changed before this writer's lock.
      await db.booking.update({ where: { id }, data: { status: booked.status, deletedAt: booked.deleted ? new Date(context.effectiveAt) : null } });
      await db.$transaction((tx) => markPaymentIntentTransactionSucceeded({ paymentIntentId: intent, amountCents: 5_000, store: tx, journal: context,
        capturedAt: new Date(context.effectiveAt) }));
      expect((await totals(id)).collected, JSON.stringify(booked)).toBe(booked.collect ? 5_000 : 0);
      expect(await db.memberMoneyEvent.count({ where: { eventKey: memberMoneyEventKeys.capture(intent) } })).toBe(1);
    }
  });

  it("the real saved-card writer records the full capture held before the settlement decides collect", async () => {
    const { settleSavedCardChargeAttempt } = await import("@/lib/saved-card-charge-settle");
    const id = await booking();
    const row = await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, kind: "PRIMARY", source: "STRIPE", status: "PENDING", amountCents: 10_000 } });
    const result = await db.$transaction((tx) => settleSavedCardChargeAttempt({ attemptRowId: row.id, paymentId: `${id}-payment`, store: tx, journal: context,
      paymentIntent: { id: `${id}-capture`, amount: 10_000, status: "succeeded", payment_method: null, created: 1_782_864_000 } }));
    expect(result.newlyCaptured).toBe(true);
    expect((await totals(id)).collected).toBe(0);
    expect(await db.memberMoneyEvent.count({ where: { eventKey: memberMoneyEventKeys.capture(`${id}-capture`) } })).toBe(1);
    await post(id, { paymentIntentId: `${id}-capture`, collect: true });
    expect((await totals(id)).collected).toBe(10_000);
  });

  it("the real officer settle posts cash and its real reversal restores both cash and collection", async () => {
    const { markBookingPaymentManuallySettled, reverseManualBookingPayment } = await import("@/lib/payment-reconciliation");
    const { CLUB_FORMAT_TEST } = await import("./support/club-format-fixture");
    const id = await booking(20_000);
    await markBookingPaymentManuallySettled({ bookingId: id, actingAdminMemberId: names.officerId, expectedAmountCents: 20_000, note: "Synthetic cash", notifyMember: false, format: CLUB_FORMAT_TEST });
    expect((await totals(id)).collected).toBe(20_000);
    await reverseManualBookingPayment({ bookingId: id, actingAdminMemberId: names.officerId, note: "Synthetic correction" });
    expect((await totals(id)).collected).toBe(0);
    const cashLegs = await db.memberMoneyLine.findMany({ where: { bookingId: id, account: "CASH" } });
    expect(cashLegs.reduce((n, l) => n + (l.side === "DEBIT" ? l.amountCents : -l.amountCents), 0)).toBe(0);
  });

  it("a price edit committing after the collect's live-charge read never refuses the legacy capture write (#4516 review item 6)", async () => {
    const id = await booking();
    const row = await cash(id, 8_000);
    // The edit lowers the live charge to 6000 under lock(1), without the Payment row, right after the hook's read.
    liveChargeRead.after = () => db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await postMemberMoneyEvent(tx, context, { kind: "ADJUSTMENT", eventKey: memberMoneyEventKeys.modification(id), origin: "APP",
        source: { kind: "BOOKING", id, version: "price-edit" }, reason: "Synthetic price edit racing the collect", legs: [
          { type: "revenue", account: "BOOKING_REVENUE", side: "DEBIT", grossCents: 10_000, chargeIdentity: `booking:${id}:test`, booking: { bookingId: id, lodgeId: names.lodgeId }, evidence: {} },
          { type: "revenue", account: "BOOKING_REVENUE", side: "CREDIT", grossCents: 6_000, chargeIdentity: `booking:${id}:test`, booking: { bookingId: id, lodgeId: names.lodgeId }, evidence: {} },
          { type: "amount", account: "MEMBER_RECEIVABLE", side: "CREDIT", amountCents: 4_000, debtor: { kind: "MEMBER", memberId: names.memberId }, booking: { bookingId: id, lodgeId: names.lodgeId }, evidence: {} },
        ] });
    }).then(() => undefined);
    await db.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: `${id}-payment` }, data: { manualPaymentNote: "legacy capture write" } });
      await postBookingReceipts(tx, context, { paymentId: `${id}-payment`, decision: { paymentIntentId: row.stripePaymentIntentId!, collect: true } });
    }, { timeout: 30_000 });
    expect(liveChargeRead.after).toBeNull();
    expect((await db.payment.findUniqueOrThrow({ where: { id: `${id}-payment` } })).manualPaymentNote).toBe("legacy capture write");
    // Serialised as the collect before the edit: the accepted C2 limit, which the census reports.
    expect((await totals(id)).collected).toBe(8_000);
    expect((await census(id)).filter((f) => f.kind === "OVER_COLLECTED")).toEqual([expect.objectContaining({ cents: 2_000 })]);
  });

  it("a superseded capture's flip re-checks the row under the Payment lock and posts nothing when the claim is lost (#4516 review item 7)", async () => {
    const { queueSupersededPaymentIntentRefundRecovery } = await import("@/lib/payment-recovery");
    const id = await booking();
    const intent = `${id}-superseded`;
    const row = await db.paymentTransaction.create({ data: { paymentId: `${id}-payment`, kind: "ADDITIONAL", source: "STRIPE", stripePaymentIntentId: intent,
      status: "PENDING", amountCents: 5_000 } });
    await db.paymentRecoveryOperation.create({ data: { type: "CANCEL_PAYMENT_INTENT", status: "PENDING", bookingId: id, paymentId: `${id}-payment`,
      paymentTransactionId: row.id, paymentIntentId: intent, amountCents: 5_000, idempotencyKey: `${id}-cancel-superseded` } });
    // Read as uncaptured by the caller; captured and part refunded by another writer before this flip's lock.
    await db.paymentTransaction.update({ where: { id: row.id }, data: { status: "PARTIALLY_REFUNDED", refundedAmountCents: 1_000, amountCents: 4_000 } });
    await queueSupersededPaymentIntentRefundRecovery({ id: intent, amount: 5_000, payment_method: null });
    const after = await db.paymentTransaction.findUniqueOrThrow({ where: { id: row.id } });
    expect([after.status, after.amountCents, after.reason]).toEqual(["PARTIALLY_REFUNDED", 4_000, null]);
    expect(await db.memberMoneyEvent.count({ where: { eventKey: memberMoneyEventKeys.capture(intent) } })).toBe(0);
  });

  it("returns before any further read when nothing is selected, every receipt is bridged and no residue exists (#4516 review item 8)", async () => {
    const id = await booking();
    await cash(id, 3_000); await cash(id, 4_000, "INTERNET_BANKING");
    expect(await post(id)).toBe(2);
    const { proxy, calls } = await db.$transaction(async (tx) => {
      const counted = counting(tx);
      expect(await postBookingReceipts(counted.proxy, context, { paymentId: `${id}-payment` })).toBe(0);
      return counted;
    });
    expect(proxy).toBeDefined();
    expect(calls.filter((call) => call.startsWith("memberMoneyEvent."))).toEqual(["memberMoneyEvent.findUnique"]);
    expect(calls.filter((call) => /^memberMoney(Line|Obligation|Application)\./.test(call))).toEqual(["memberMoneyLine.findMany"]);
  });

});
