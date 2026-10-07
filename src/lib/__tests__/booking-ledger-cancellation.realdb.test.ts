/**
 * Real-PostgreSQL proof of a cancellation's ledger lines (#3611).
 *
 * The planner, the sync and each cancel path's call have unit tests. What a
 * mock cannot show is the posting against the table's real constraints — the
 * CHECKs, the unique `reversesLineId`, `ON CONFLICT DO NOTHING` on the key, and
 * the new `CANCELLATION_FEE` enum value — nor that a real cancel path posts in
 * its own transaction. Seven claims:
 *
 *  1. After an edit, a cancellation reverses the edit's re-post and never the
 *     line the edit already reversed; once the card refund posts, `owed(b)` is
 *     zero. A replay posts nothing and the transaction still commits.
 *  2. A booking not yet confirmed on the ledger posts nothing.
 *  3. The REAL `cancelBooking`, on a cash-settled booking at a 50% tier, posts
 *     the reversals and a CANCELLATION_FEE for what the policy kept, in the
 *     claim that flipped it CANCELLED; once the hand-back posts, `owed(b)` is
 *     zero.
 *  4. The REAL `cancelBooking` on an unpaid booking confirmed on the ledger
 *     (a mark-paid since reversed) reverses the stay and posts no fee.
 *  5. A stale replay — a cancellation planned from the lines as they stood
 *     before the first one posted — inserts nothing: the reversal key and,
 *     under a different key, the unique `reversesLineId` each skip it, and the
 *     transaction stays usable (review A3).
 *  6. A live review-share stand-in is reversed by the cancellation, and owed
 *     reaches zero once the cancellation's refund posts (review F1).
 *  7. The REAL settle's capacity void (`markBookingPaymentSucceeded`) on a
 *     booking a reversed mark-paid left confirmed reverses the stay, keeps
 *     nothing, and owed reaches zero once its card refund posts (review F4).
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-3611-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { bookingLedgerBalance } from "@/lib/booking-ledger-balance";
import type { ModificationPricingSide } from "@/lib/booking-modification-lines";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3611-member";
const LODGE_ID = "race-3611-lodge";
const BOOKING_ID = "race-3611-booking";
const UNCONFIRMED_ID = "race-3611-unconfirmed";
const PAYMENT_ID = "race-3611-payment";
const TXN_ID = "race-3611-txn";
const G1 = "race-3611-g1";
const G2 = "race-3611-g2";
// A stay well after today, so the policy's day count lands in its 50% tier.
const D1 = new Date("2027-08-01T00:00:00.000Z");
const D2 = new Date("2027-08-02T00:00:00.000Z");
const CHECK_OUT = new Date("2027-08-03T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeCancellationLedgerRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Cancellation-ledger proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run cancellation-ledger proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("Cancellation-ledger proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("Cancellation-ledger proof DB name must contain 'concurrency_race_1881'.");
  }
}

let prisma: PrismaClient;
let cancellationSync: typeof import("@/lib/booking-ledger-cancellation-sync");
let cancellationPosting: typeof import("@/lib/booking-ledger-cancellation-posting");
let paidMoney: typeof import("@/lib/paid-cancellation-money");
let ledgerRead: typeof import("@/lib/booking-ledger-read");
let modificationPosting: typeof import("@/lib/booking-ledger-modification-posting");
let modificationSync: typeof import("@/lib/booking-ledger-modification-sync");
let confirmation: typeof import("@/lib/booking-ledger-confirmation-posting");
let write: typeof import("@/lib/booking-ledger-write");

async function lines(bookingId = BOOKING_ID) {
  return prisma.bookingLedgerLine.findMany({
    where: { bookingId },
    orderBy: [{ postedAt: "asc" }, { id: "asc" }],
    select: { id: true, kind: true, side: true, amountCents: true, anchorKind: true, anchorId: true, reversesLineId: true, postingKey: true },
  });
}

async function clean(): Promise<void> {
  for (const id of [BOOKING_ID, UNCONFIRMED_ID]) {
    await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: id } });
    await prisma.bookingModification.deleteMany({ where: { bookingId: id } });
    await prisma.bookingEvent.deleteMany({ where: { bookingId: id } });
    await prisma.manualRefundTask.deleteMany({ where: { bookingId: id } });
    await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: id } });
    await prisma.payment.deleteMany({ where: { bookingId: id } });
    await prisma.bookingGuest.deleteMany({ where: { bookingId: id } });
    await prisma.booking.updateMany({ where: { id }, data: { status: "PAID" } });
  }
}

async function seedGuests(bookingId: string): Promise<void> {
  for (const id of [G1, G2]) {
    await prisma.bookingGuest.create({
      data: {
        id: bookingId === BOOKING_ID ? id : `${id}-u`,
        bookingId,
        firstName: "Ledger",
        lastName: id,
        ageTier: "ADULT",
        isMember: true,
        stayStart: D1,
        stayEnd: CHECK_OUT,
        priceCents: 10_000,
        nights: {
          create: [
            { stayDate: D1, priceCents: 5_000, priceSource: "SOLD" },
            { stayDate: D2, priceCents: 5_000, priceSource: "SOLD" },
          ],
        },
      },
    });
  }
}

/** The settle's own confirmation posting, from the real guest rows, and its capture line. */
async function confirmOnLedger(settlementKind: "CARD_CAPTURE" | "CASH_RECORDED", paidCents: number): Promise<void> {
  const guests = await prisma.bookingGuest.findMany({
    where: { bookingId: BOOKING_ID },
    select: { id: true, firstName: true, lastName: true, ageTier: true, rateMembershipTypeId: true, nights: { select: { stayDate: true, priceCents: true } } },
  });
  const plan = confirmation.planConfirmationChargeLines({ id: BOOKING_ID, lodgeId: LODGE_ID, totalPriceCents: 20_000, promoAdjustmentCents: 0, guests });
  await prisma.$transaction((tx) =>
    write.postBookingLedgerLines(tx, [
      ...plan.postings,
      {
        bookingId: BOOKING_ID,
        lodgeId: LODGE_ID,
        side: "SETTLEMENT",
        kind: settlementKind,
        sign: 1,
        quantity: 1,
        unitCents: paidCents,
        anchorKind: "PAYMENT_TRANSACTION",
        anchorId: TXN_ID,
        settlementMethod: settlementKind === "CARD_CAPTURE" ? "CARD" : "CASH",
        narration: "Paid",
        postingKey: `capture:${TXN_ID}`,
      },
    ]),
  );
}

/** A settlement line as its own writer (§5.2) posts it — never the cancellation. */
async function settle(kind: "CARD_REFUND" | "BANK_REFUND", cents: number, anchorId: string, postingKey: string): Promise<void> {
  await prisma.$transaction((tx) =>
    write.postBookingLedgerLines(tx, [
      {
        bookingId: BOOKING_ID,
        lodgeId: LODGE_ID,
        side: "SETTLEMENT",
        kind,
        sign: -1,
        quantity: 1,
        unitCents: cents,
        anchorKind: kind === "CARD_REFUND" ? "PAYMENT_REFUND" : "REVIEW_TASK",
        anchorId,
        settlementMethod: kind === "CARD_REFUND" ? "CARD" : "INTERNET_BANKING",
        narration: "Returned",
        postingKey,
      },
    ]),
  );
}

function guestSide(id: string, second: number): ModificationPricingSide["guests"][number] {
  return {
    guestKey: id,
    ageTier: "ADULT",
    isMember: true,
    rateMembershipTypeId: null,
    name: `Ledger ${id}`,
    nights: [
      { stayDate: D1, priceCents: 5_000, priceSource: "SOLD" },
      { stayDate: D2, priceCents: second, priceSource: "SOLD" },
    ],
  };
}

function reversedTwice(all: Awaited<ReturnType<typeof lines>>): boolean {
  const targets = all.flatMap((line) => (line.reversesLineId ? [line.reversesLineId] : []));
  return new Set(targets).size !== targets.length;
}

(RUN ? describe : describe.skip)("a cancellation's booking-ledger lines, against PostgreSQL (#3611)", () => {
  beforeAll(async () => {
    assertSafeCancellationLedgerRaceDbUrl(RACE_DB_URL);
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    cancellationSync = await import("@/lib/booking-ledger-cancellation-sync");
    cancellationPosting = await import("@/lib/booking-ledger-cancellation-posting");
    paidMoney = await import("@/lib/paid-cancellation-money");
    ledgerRead = await import("@/lib/booking-ledger-read");
    modificationPosting = await import("@/lib/booking-ledger-modification-posting");
    modificationSync = await import("@/lib/booking-ledger-modification-sync");
    confirmation = await import("@/lib/booking-ledger-confirmation-posting");
    write = await import("@/lib/booking-ledger-write");

    await clean();
    await prisma.booking.deleteMany({ where: { id: { in: [BOOKING_ID, UNCONFIRMED_ID] } } });
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    await prisma.member.create({
      data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Ledger", lastName: "Proof", ageTier: "ADULT" },
    });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3611 Lodge", slug: "race-3611" } });
    // One tier: half back, less a $20 fee, however far ahead.
    await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 2_000 } });
    for (const id of [BOOKING_ID, UNCONFIRMED_ID]) {
      await prisma.booking.create({
        data: { id, memberId: MEMBER_ID, lodgeId: LODGE_ID, checkIn: D1, checkOut: CHECK_OUT, status: "PAID", totalPriceCents: 20_000, finalPriceCents: 20_000 },
      });
    }
  });

  beforeEach(async () => {
    await clean();
    await seedGuests(BOOKING_ID);
  });

  afterAll(async () => {
    if (!prisma) return;
    await clean();
    await prisma.booking.deleteMany({ where: { id: { in: [BOOKING_ID, UNCONFIRMED_ID] } } });
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
  });

  it("AFTER AN EDIT: the cancellation reverses the edit's re-post, never a reversed line; a card refund brings owed to zero; a replay posts nothing", async () => {
    await confirmOnLedger("CARD_CAPTURE", 21_000);
    const edit = await prisma.bookingModification.create({
      data: { bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "BATCH_MODIFY", previousData: {}, newData: {}, priceDiffCents: 1_000, changeFeeCents: 0 },
      select: { id: true },
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await modificationSync.postModificationLedgerLines({
        store: tx,
        bookingId: BOOKING_ID,
        lodgeId: LODGE_ID,
        bookingModification: { id: edit.id, priceDiffCents: 1_000, changeFeeCents: 0 },
        sides: {
          before: { guests: [guestSide(G1, 5_000), guestSide(G2, 5_000)], promoAdjustmentCents: 0 },
          after: { guests: [guestSide(G1, 6_000), guestSide(G2, 5_000)], promoAdjustmentCents: 0 },
        },
        site: "race-3611",
      });
    });
    const repost = (await lines()).find((line) => line.anchorId === edit.id && line.reversesLineId === null);
    expect(repost).toMatchObject({ kind: "GUEST_NIGHT", amountCents: 6_000 });

    // $210 paid; 50% is $105, less the $20 fee: $85 back, $125 kept.
    const keptCents = paidMoney.cancellationKeptCents({ retainedAmountCents: 21_000 - 8_500, appliedCreditCents: 0, creditRestoredCents: 0 });
    const cancel = () =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
        await cancellationSync.postCancellationLedgerLines({ store: tx, bookingId: BOOKING_ID, lodgeId: LODGE_ID, keptCents, site: "race-3611" });
        // Still usable: a refused statement would have aborted it.
        await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { id: true } });
      });
    await cancel();
    const after = await lines();
    expect(after.filter((line) => line.anchorKind === "CANCELLATION").map((line) => line.reversesLineId)).toContain(repost!.id);
    expect(after.find((line) => line.kind === "CANCELLATION_FEE")).toMatchObject({ side: "CHARGE", amountCents: 12_500, anchorKind: "CANCELLATION", anchorId: BOOKING_ID, postingKey: `cancellation:${BOOKING_ID}:fee` });
    expect(reversedTwice(after)).toBe(false);

    await cancel();
    expect(await lines()).toHaveLength(after.length);

    await settle("CARD_REFUND", 8_500, "race-3611-refund", "refund:race-3611-refund");
    expect(bookingLedgerBalance(await lines()).owedCents).toBe(0);
  });

  it("posts nothing for a booking not yet confirmed on the ledger", async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await cancellationSync.postCancellationLedgerLines({ store: tx, bookingId: UNCONFIRMED_ID, lodgeId: LODGE_ID, keptCents: 5_000, site: "race-3611" });
    });
    expect(await lines(UNCONFIRMED_ID)).toEqual([]);
  });

  it("the REAL cancelBooking, cash-settled at a 50% tier: reversals and the kept fee post in the claim, and the hand-back brings owed to zero", async () => {
    await confirmOnLedger("CASH_RECORDED", 20_000);
    await prisma.payment.create({
      data: {
        id: PAYMENT_ID,
        bookingId: BOOKING_ID,
        amountCents: 20_000,
        status: "SUCCEEDED",
        manuallyMarkedPaidAt: new Date("2026-09-01T00:00:00.000Z"),
        transactions: { create: { id: TXN_ID, kind: "PRIMARY", amountCents: 20_000, status: "SUCCEEDED" } },
      },
    });
    const { cancelBooking } = await import("@/lib/booking-cancel");

    const result = await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");

    expect(result.status).toBe(200);
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } });
    expect(booking.status).toBe("CANCELLED");
    const task = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: BOOKING_ID }, select: { id: true, amountCents: true } });
    // $100 less the $20 fee goes back by hand; the club keeps $120.
    expect(task.amountCents).toBe(8_000);
    const all = await lines();
    expect(all.find((line) => line.kind === "CANCELLATION_FEE")?.amountCents).toBe(12_000);
    expect(all.filter((line) => line.anchorKind === "CANCELLATION" && line.reversesLineId !== null)).toHaveLength(4);
    expect(reversedTwice(all)).toBe(false);

    await settle("BANK_REFUND", task.amountCents!, task.id, `handback:${task.id}`);
    expect(bookingLedgerBalance(await lines())).toMatchObject({ chargedCents: 12_000, settledCents: 12_000, owedCents: 0 });
    // The first import of the cancel service's module graph is slow on a cold
    // worker, as the #3741 door test found.
  }, 60_000);

  it("the REAL cancelBooking on an unpaid booking confirmed on the ledger (its mark-paid since reversed): the stay is reversed and no fee posts", async () => {
    await confirmOnLedger("CASH_RECORDED", 20_000);
    const [captured] = await lines().then((all) => all.filter((line) => line.kind === "CASH_RECORDED"));
    await prisma.$transaction((tx) =>
      write.postBookingLedgerLines(tx, [
        { bookingId: BOOKING_ID, lodgeId: LODGE_ID, side: "SETTLEMENT", kind: "CASH_RECORDED", sign: -1, quantity: 1, unitCents: 20_000, anchorKind: "PAYMENT_TRANSACTION", anchorId: TXN_ID, settlementMethod: "CASH", narration: "Mark-paid reversed", reversesLineId: captured!.id, postingKey: `reversal:${captured!.id}` },
      ]),
    );
    await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "PAYMENT_PENDING" } });
    await prisma.payment.create({
      data: { id: PAYMENT_ID, bookingId: BOOKING_ID, amountCents: 20_000, status: "PENDING", transactions: { create: { id: TXN_ID, kind: "PRIMARY", amountCents: 20_000, status: "FAILED" } } },
    });
    const { cancelBooking } = await import("@/lib/booking-cancel");

    const result = await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");

    expect(result.status).toBe(200);
    const all = await lines();
    expect(all.some((line) => line.kind === "CANCELLATION_FEE")).toBe(false);
    expect(all.filter((line) => line.anchorKind === "CANCELLATION")).toHaveLength(4);
    expect(bookingLedgerBalance(all).owedCents).toBe(0);
  }, 60_000);

  it("A STALE REPLAY inserts nothing: the reversal key, and under another key the unique reversesLineId, each skip it, and the transaction stays usable", async () => {
    await confirmOnLedger("CARD_CAPTURE", 20_000);
    const staleCharges = await ledgerRead.findPostedCancellableChargeLines(prisma, BOOKING_ID);
    const staleAdjustments = await ledgerRead.findPostedAdjustmentLines(prisma, BOOKING_ID);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await cancellationSync.postCancellationLedgerLines({ store: tx, bookingId: BOOKING_ID, lodgeId: LODGE_ID, keptCents: 8_000, site: "race-3611" });
    });
    const once = await lines();

    const plan = cancellationPosting.planCancellationChargeLines({ bookingId: BOOKING_ID, lodgeId: LODGE_ID, keptCents: 8_000, chargeLines: staleCharges, adjustmentLines: staleAdjustments });
    if (plan.kind !== "lines") throw new Error("expected a plan");
    const reversals = plan.postings.filter((posting) => posting.reversesLineId);
    expect(reversals).toHaveLength(4);
    const sameKeys = write.buildBookingLedgerRows(plan.postings);
    // The same reversals under keys nothing holds: only reversesLineId can stop them.
    const freshKeys = write.buildBookingLedgerRows(reversals.map((posting) => ({ ...posting, postingKey: `${posting.postingKey}:stale` })));
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      expect(await write.writeBookingLedgerRows(tx, sameKeys)).toBe(0);
      expect(await write.writeBookingLedgerRows(tx, freshKeys)).toBe(0);
      await tx.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { id: true } });
    });
    expect(await lines()).toHaveLength(once.length);
  });

  it("a live review-share stand-in is reversed by the cancellation, and owed reaches zero once its refund posts (review F1)", async () => {
    await confirmOnLedger("CARD_CAPTURE", 20_000);
    // A $30 share refunded to the card while the charge lines stayed as they were.
    await prisma.$transaction((tx) =>
      write.postBookingLedgerLines(tx, [
        modificationPosting.planAgreedAdjustmentLine({ bookingId: BOOKING_ID, lodgeId: LODGE_ID, manualRefundTaskId: "race-3611-task", direction: "REFUND_TO_MEMBER", amountCents: 3_000, note: "share", officerMemberId: MEMBER_ID }),
      ]),
    );
    await settle("CARD_REFUND", 3_000, "race-3611-share", "refund:race-3611-share");
    const money = paidMoney.paidCancellationMoney({
      payment: { amountCents: 20_000, refundedAmountCents: 3_000, changeFeeCents: 0, creditAppliedCents: 0 },
      openNonCancellationHandBackCents: 0,
      finalPriceCents: 20_000,
      appliedCreditCents: 0,
      restoresToMemberLedger: true,
      // #3809: no edit ran through the give-back, so main's uncapped credit (`INV-PAY-115`).
      capAppliedCredit: false,
      days: 30,
      policy: [{ daysBeforeStay: 0, refundPercentage: 50, fixedFeeCents: 2_000 }],
      refundMethod: "card",
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await cancellationSync.postCancellationLedgerLines({ store: tx, bookingId: BOOKING_ID, lodgeId: LODGE_ID, keptCents: money.ledgerKeptCents, site: "race-3611" });
    });
    const all = await lines();
    expect(all.some((line) => line.kind === "AGREED_ADJUSTMENT" && line.reversesLineId !== null && line.anchorKind === "CANCELLATION")).toBe(true);
    await settle("CARD_REFUND", money.refundAmountCents, "race-3611-refund", "refund:race-3611-refund");
    expect(bookingLedgerBalance(await lines()).owedCents).toBe(0);
  });

  it("the REAL settle's capacity void on a booking a reversed mark-paid left confirmed: the stay is reversed, nothing kept, and owed reaches zero once the card refund posts (review F4)", async () => {
    // Confirmed on the ledger by a mark-paid, then the mark-paid reversed.
    await confirmOnLedger("CASH_RECORDED", 20_000);
    const [cashLine] = await lines().then((all) => all.filter((line) => line.kind === "CASH_RECORDED"));
    await prisma.$transaction((tx) =>
      write.postBookingLedgerLines(tx, [
        { bookingId: BOOKING_ID, lodgeId: LODGE_ID, side: "SETTLEMENT", kind: "CASH_RECORDED", sign: -1, quantity: 1, unitCents: 20_000, anchorKind: "PAYMENT_TRANSACTION", anchorId: TXN_ID, settlementMethod: "CASH", narration: "Mark-paid reversed", reversesLineId: cashLine!.id, postingKey: `reversal:${cashLine!.id}` },
      ]),
    );
    await prisma.booking.update({ where: { id: BOOKING_ID }, data: { status: "PAYMENT_PENDING" } });
    // This lodge has no configured capacity, so the card payment cannot claim beds.
    const { markBookingPaymentSucceeded } = await import("@/lib/payment-reconciliation");

    const result = await markBookingPaymentSucceeded({
      bookingId: BOOKING_ID,
      paymentIntentId: "pi_race_3611_void",
      amountCents: 20_000,
      paymentMethodId: null,
      format: CLUB_FORMAT_TEST,
    });

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).status).toBe("CANCELLED");
    expect(result.outcome).not.toBe("paid");
    const all = await lines();
    expect(all.filter((line) => line.anchorKind === "CANCELLATION" && line.reversesLineId !== null)).toHaveLength(4);
    expect(all.some((line) => line.kind === "CANCELLATION_FEE")).toBe(false);
    // The capture the void must hand back; its refund is the provider's to make.
    expect(all.some((line) => line.kind === "CARD_CAPTURE" && line.amountCents === 20_000)).toBe(true);
    await settle("CARD_REFUND", 20_000, "race-3611-void-refund", "refund:race-3611-void-refund");
    expect(bookingLedgerBalance(await lines()).owedCents).toBe(0);
  }, 60_000);
});
