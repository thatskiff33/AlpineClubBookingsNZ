/**
 * GROUP-SETTLED HISTORIES FROM BEFORE #3854, BUILT BY THE REAL WRITERS (#3854
 * scope 3, on #3583 PR 2's back-post).
 *
 * Each group is settled by the real settle (the card webhook's door, or the
 * combined Internet Banking invoice's inbound reconcile), cancelled by the real
 * organiser cancel, refunded by the real #3653 executor — and then its
 * children's ledger lines are deleted, which leaves what a group settled before
 * #3854 holds: rows and columns, no `GROUP_SETTLEMENT` line. One history keeps
 * the line a #3653 refund posted after #3854 shipped on a child settled before
 * it. Shared by the back-post proof and the CI seed run, as
 * `booking-ledger-history.ts` is.
 *
 * Stripe is an in-memory double handed to the #3653 executor's seam. The
 * organiser cancel's own inline Stripe call has no key here and fails, as a
 * Stripe outage would; the one pre-#3653 history then stands in for the
 * provider's later success (the settlement's refund flip) and lets the real
 * replay (`executeGroupSettlementRefundPlan`) write the mirrors.
 *
 * Test support only: it deletes ledger lines, which no application code may do.
 */
import type { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { expect, vi } from "vitest";

import { historyPromoCodePrefix, postHistoryEdit, stripAllLines, type HistoryNames } from "@/lib/__tests__/support/booking-ledger-history";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const D1 = new Date("2027-10-01T00:00:00.000Z");
const D2 = new Date("2027-10-02T00:00:00.000Z");
const CHECK_OUT = new Date("2027-10-03T00:00:00.000Z");
export const GROUP_NIGHT_CENTS = 2_250;
export const GROUP_CHILD_CENTS = 2 * GROUP_NIGHT_CENTS;

export type GroupHistory = { organiser: string; group: string; settlement: string; pi: string | null; invoice: string | null; children: string[] };

export function groupHistory(prefix: string, key: string, source: "STRIPE" | "INTERNET_BANKING", children: number): GroupHistory {
  return {
    organiser: `${prefix}${key}-organiser`,
    group: `${prefix}${key}-group`,
    settlement: `${prefix}${key}-settlement`,
    pi: source === "STRIPE" ? `pi_${prefix}${key}` : null,
    invoice: source === "INTERNET_BANKING" ? `${prefix}${key}-invoice` : null,
    children: Array.from({ length: children }, (_, index) => `${prefix}${key}-child-${index + 1}`),
  };
}

function tick(): void {
  vi.setSystemTime(new Date(Date.now() + 60_000));
}

/** An organiser-pays group: its children committed (CONFIRMED), one guest and two nights each, and an open settlement. */
export async function createGroupHistory(prisma: PrismaClient, names: HistoryNames, g: GroupHistory): Promise<void> {
  // The organiser's own booking holds no money here: only the children are under test.
  await prisma.booking.create({
    data: { id: g.organiser, memberId: names.memberId, lodgeId: names.lodgeId, checkIn: D1, checkOut: CHECK_OUT, status: "CONFIRMED", totalPriceCents: 0, finalPriceCents: 0 },
  });
  await prisma.groupBooking.create({
    data: { id: g.group, organiserBookingId: g.organiser, organiserMemberId: names.memberId, joinCode: g.group, paymentMode: "ORGANISER_PAYS" },
  });
  await prisma.groupBookingSettlement.create({
    data: {
      id: g.settlement,
      groupBookingId: g.group,
      amountCents: GROUP_CHILD_CENTS * g.children.length,
      status: "PENDING",
      ...(g.pi ? { source: "STRIPE" as const, stripePaymentIntentId: g.pi } : { source: "INTERNET_BANKING" as const, xeroInvoiceId: g.invoice }),
    },
  });
  for (const id of g.children) {
    await prisma.booking.create({
      data: {
        id,
        memberId: names.memberId,
        lodgeId: names.lodgeId,
        checkIn: D1,
        checkOut: CHECK_OUT,
        status: "CONFIRMED",
        totalPriceCents: GROUP_CHILD_CENTS,
        finalPriceCents: GROUP_CHILD_CENTS,
        parentBookingId: g.organiser,
        organiserSettled: true,
        capacityOverriddenAt: new Date("2026-06-01T00:00:00.000Z"),
        capacityOverriddenByMemberId: names.officerId,
      },
    });
    await prisma.bookingGuest.create({
      data: {
        id: `${id}-g1`,
        bookingId: id,
        firstName: "Joiner",
        lastName: id,
        ageTier: "ADULT",
        isMember: true,
        stayStart: D1,
        stayEnd: CHECK_OUT,
        priceCents: GROUP_CHILD_CENTS,
        nights: {
          create: [
            { stayDate: D1, priceCents: GROUP_NIGHT_CENTS, priceSource: "SOLD" },
            { stayDate: D2, priceCents: GROUP_NIGHT_CENTS, priceSource: "SOLD" },
          ],
        },
      },
    });
  }
}

/** The real settle: the card webhook's door, or the paid combined invoice's inbound reconcile. */
export async function settleGroupHistory(g: GroupHistory, amountCents = GROUP_CHILD_CENTS * g.children.length): Promise<void> {
  tick();
  if (g.pi) {
    const { applyGroupSettlementSucceeded } = await import("@/lib/group-settlement");
    expect(await applyGroupSettlementSucceeded({ id: g.pi, amount: amountCents }, CLUB_FORMAT_TEST)).toMatchObject({ outcome: "settled" });
    return;
  }
  const { syncGroupSettlementForPaidInvoice } = await import("@/lib/xero-inbound/invoice-paid-effects");
  const invoice = { invoiceID: g.invoice, status: "PAID", amountPaid: amountCents / 100 } as never;
  expect(await syncGroupSettlementForPaidInvoice(invoice, CLUB_FORMAT_TEST)).toMatchObject({ settledGroupSettlements: 1 });
}

/** The real organiser cancel (its inline Stripe call fails here: no key). */
export async function cancelGroupHistory(names: HistoryNames, g: GroupHistory): Promise<void> {
  tick();
  const { settleGroupBookingOnOrganiserCancel } = await import("@/lib/group-cancel");
  await settleGroupBookingOnOrganiserCancel(g.organiser, names.memberId, "127.0.0.1", CLUB_FORMAT_TEST);
}

export async function stripGroupLines(prisma: PrismaClient, g: GroupHistory): Promise<void> {
  for (const id of g.children) await stripAllLines(prisma, id);
}

/** An in-memory Stripe for the #3653 executor's seam: one refund per idempotency key, succeeded. */
export function groupHistoryStripe() {
  const byKey = new Map<string, Stripe.Refund>();
  return {
    async processRefund(input: { paymentIntentId: string; amountCents: number; metadata?: Record<string, string>; idempotencyKey?: string }) {
      const key = input.idempotencyKey ?? `nokey-${byKey.size}`;
      let refund = byKey.get(key);
      if (!refund) {
        refund = {
          id: `re_${key.replace(/[^A-Za-z0-9_]/g, "_")}`,
          amount: input.amountCents,
          currency: "nzd",
          status: "succeeded",
          reason: null,
          created: Math.floor(Date.now() / 1000),
          charge: "ch_group_history",
          payment_intent: input.paymentIntentId,
          metadata: input.metadata ?? {},
        } as unknown as Stripe.Refund;
        byKey.set(key, refund);
      }
      return refund;
    },
    async listRefundsForPaymentIntent(paymentIntentId: string) {
      return [...byKey.values()].filter((refund) => refund.payment_intent === paymentIntentId);
    },
  };
}

/**
 * A #3653 reduction on a card-settled child: the edit takes `cents` off its
 * second night (the edit door's rows and posting), and the door's refund debt
 * out of the combined payment is reserved under lock(1). Returns the debt.
 */
export async function reserveGroupChildReduction(prisma: PrismaClient, names: HistoryNames, g: GroupHistory, childId: string, cents: number) {
  const modificationId = `${childId}-reduction`;
  await postHistoryEdit(prisma, names, childId, modificationId, {
    reprice: { guestId: `${childId}-g1`, stayDate: D2, priceCents: GROUP_NIGHT_CENTS - cents },
    changeFeeCents: 0,
  });
  const settlement = await prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: g.settlement } });
  const { reserveOrganiserChildModificationRefund } = await import("@/lib/organiser-child-refund");
  const debt = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const payment = await tx.payment.findUniqueOrThrow({ where: { bookingId: childId } });
    return reserveOrganiserChildModificationRefund(tx, {
      plan: { settlement: { id: settlement.id, stripePaymentIntentId: g.pi!, amountCents: settlement.amountCents }, amountCents: cents },
      bookingId: childId,
      payment,
      bookingModificationId: modificationId,
    });
  });
  return debt!;
}

/** The recovery runner's claim of a debt, then the real #3653 executor with the Stripe double. */
export async function runGroupChildRefund(prisma: PrismaClient, operationId: string, stripe: ReturnType<typeof groupHistoryStripe>): Promise<void> {
  tick();
  const claimed = await prisma.paymentRecoveryOperation.update({
    where: { id: operationId },
    data: { status: "PROCESSING", attempts: { increment: 1 }, nextRetryAt: new Date() },
  });
  const { processOrganiserChildRefundOperation } = await import("@/lib/organiser-child-refund-executor");
  await processOrganiserChildRefundOperation(claimed, CLUB_FORMAT_TEST, stripe);
}

/**
 * EPIC #3813'S SHAPE ON A GROUP CHILD: two promo codes — a free night, then $5
 * off — priced and redeemed by the booking create's own writers
 * (`resolvePromotionsInTransaction`, which runs every code through
 * `applyBookingPromotions`; `redeemPromoCode` per code in the booker's order;
 * `recordBookingNightAdjustments`), on a child created as the others are. The
 * `multiPromoCodes` switch is on only for the write, as an operator turns it on
 * after cut-over. Returns the child's final price.
 */
export async function priceGroupChildWithPromoCodes(prisma: PrismaClient, names: HistoryNames, g: GroupHistory, childId: string): Promise<number> {
  const codes = [`${historyPromoCodePrefix(g.group)}FREE`, `${historyPromoCodePrefix(g.group)}FIVE`];
  await prisma.promoCode.create({ data: { code: codes[0]!, type: "FREE_NIGHTS", freeNightsPerIndividual: 1 } });
  await prisma.promoCode.create({ data: { code: codes[1]!, type: "FIXED_AMOUNT", valueCents: 500 } });
  const { getPromoTargetBookingGuestIds, resolvePromotionsInTransaction } = await import("@/lib/booking-create-promo");
  const { redeemPromoCode } = await import("@/lib/promo");
  const { recordBookingNightAdjustments } = await import("@/lib/night-adjustment-write");
  const { bookingDiscountCents, bookingFinalPriceCents } = await import("@/lib/booking-final-price");
  const { clubToday } = await import("@/lib/club-time");
  const { readClubTimeZoneOutsideRequest } = await import("@/lib/club-time-zone-runtime");
  const todayAtClub = clubToday(await readClubTimeZoneOutsideRequest());
  const switchBefore = await prisma.clubModuleSettings.findUnique({ where: { id: "default" }, select: { multiPromoCodes: true } });
  await prisma.clubModuleSettings.upsert({ where: { id: "default" }, create: { id: "default", multiPromoCodes: true }, update: { multiPromoCodes: true }, select: { id: true } });
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const booking = await tx.booking.findUniqueOrThrow({
        where: { id: childId },
        select: {
          checkIn: true,
          lodgeId: true,
          totalPriceCents: true,
          guests: {
            orderBy: { id: "asc" },
            select: { id: true, firstName: true, lastName: true, ageTier: true, isMember: true, stayStart: true, stayEnd: true, nights: { orderBy: { stayDate: "asc" }, select: { stayDate: true, priceCents: true } } },
          },
        },
      });
      const promotions = await resolvePromotionsInTransaction(tx, {
        sources: codes.map((code) => ({ promoCodeStr: code, allowInternal: false })),
        lockRows: true,
        effectiveMemberId: names.memberId,
        checkIn: booking.checkIn,
        guests: booking.guests.map(({ firstName, lastName, ageTier, isMember, stayStart, stayEnd }) => ({ firstName, lastName, ageTier, isMember, stayStart, stayEnd })),
        totalPriceCents: booking.totalPriceCents,
        perNightCentsByGuest: booking.guests.map((guest) => guest.nights.map((night) => night.priceCents ?? 0)),
        nightDatesByGuest: booking.guests.map((guest) => guest.nights.map((night) => night.stayDate)),
        lodgeId: booking.lodgeId,
        todayAtClub,
      });
      expect(promotions.redemptions.map((redemption) => redemption.applicationOrder)).toEqual([0, 1]);
      for (const redemption of promotions.redemptions) {
        await redeemPromoCode(
          tx,
          redemption.promoCodeId,
          childId,
          names.memberId,
          redemption.discountCents,
          redemption.priceAdjustmentCents,
          redemption.freeNightsUsed || undefined,
          redemption.eligibleGuestCount || undefined,
          redemption.allocations,
          // The helper reads only each guest's id; the fixture's rows carry what this test selects.
          getPromoTargetBookingGuestIds(booking.guests as unknown as Parameters<typeof getPromoTargetBookingGuestIds>[0], redemption.selectedGuestIndexes),
          booking.lodgeId,
          redemption.applicationOrder,
        );
      }
      await recordBookingNightAdjustments(tx, {
        bookingId: childId,
        guestIds: booking.guests.map((guest) => guest.id),
        targets: promotions.promoAdjustmentTargets,
        writer: "group history (#3854)",
        format: CLUB_FORMAT_TEST,
      });
      const priced = { totalPriceCents: booking.totalPriceCents, promoAdjustmentCents: promotions.promoAdjustmentCents };
      const finalPriceCents = bookingFinalPriceCents(priced);
      await tx.booking.update({
        where: { id: childId },
        data: { promoAdjustmentCents: priced.promoAdjustmentCents, discountCents: bookingDiscountCents(priced), finalPriceCents },
      });
      return finalPriceCents;
    });
  } finally {
    // Back as it was: a row this created goes again, so every default reads as before.
    if (switchBefore) await prisma.clubModuleSettings.update({ where: { id: "default" }, data: { multiPromoCodes: switchBefore.multiPromoCodes }, select: { id: true } });
    else await prisma.clubModuleSettings.delete({ where: { id: "default" }, select: { id: true } });
  }
}

/**
 * Epic #3813 on an Internet Banking group (#3854's sync with it): the first
 * child carries two promo codes (`priceGroupChildWithPromoCodes`), so the
 * settlement collects its promo-reduced price. With `handBack`, after the
 * settle the second child's night is re-priced $15 down by the edit door's
 * rows and posting and — paid by internet banking — the edit's refund is
 * promised back by hand (`raiseEditRefundHandBackIfOwed`, the real raiser,
 * #3827 `INV-PAY-117`), so the real organiser cancel sizes that child's refund
 * net of the open hand-back. Returns that task's id (null without one).
 *
 * The hand-back stays OPEN: the real resolver cannot complete one on a child an
 * Internet Banking settlement paid, whose payment holds no captured
 * `PaymentTransaction` for `applyLocalRefundAllocation` to draw on (a main-side
 * limit of #3827 on group children, reported with #3854's sync).
 */
export async function buildPromoHandBackGroup(
  prisma: PrismaClient,
  names: HistoryNames,
  g: GroupHistory,
  options: { handBack: boolean },
): Promise<{ handBackTaskId: string | null; promoChildFinalCents: number }> {
  const [promoChild, editedChild] = g.children;
  await createGroupHistory(prisma, names, g);
  const promoChildFinalCents = await priceGroupChildWithPromoCodes(prisma, names, g, promoChild!);
  const amountCents = promoChildFinalCents + GROUP_CHILD_CENTS * (g.children.length - 1);
  await prisma.groupBookingSettlement.update({ where: { id: g.settlement }, data: { amountCents } });
  await settleGroupHistory(g, amountCents);
  if (!options.handBack) {
    await cancelGroupHistory(names, g);
    return { handBackTaskId: null, promoChildFinalCents };
  }

  const modificationId = `${editedChild}-reduction`;
  await postHistoryEdit(prisma, names, editedChild!, modificationId, {
    reprice: { guestId: `${editedChild}-g1`, stayDate: D2, priceCents: GROUP_NIGHT_CENTS - 1_500 },
    changeFeeCents: 0,
  });
  const { raiseEditRefundHandBackIfOwed } = await import("@/lib/edit-refund-hand-back");
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const payment = await tx.payment.findUniqueOrThrow({ where: { bookingId: editedChild! } });
    expect(
      await raiseEditRefundHandBackIfOwed(tx, {
        bookingId: editedChild!,
        paymentId: payment.id,
        bookingModificationId: modificationId,
        adjusted: { refundAmountCents: 1_500, hasSucceededPayment: false },
        editLabel: "night re-price",
      }),
    ).toBe(true);
  });
  const handBack = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: editedChild!, status: "OPEN" }, select: { id: true } });
  await cancelGroupHistory(names, g);
  return { handBackTaskId: handBack.id, promoChildFinalCents };
}

export const GROUP_HISTORIES = [
  "group-card",
  "group-bank",
  "group-legacy-cancel",
  "group-bank-cancel",
  "group-refund",
  "group-pre3854-refund",
  "group-bank-promo-cancel",
] as const;
export type GroupHistoryName = (typeof GROUP_HISTORIES)[number];

/**
 * Build every group history under `prefix` (fixtures from `seedHistoryFixtures`:
 * its lodge's one tier hands half back). Returns each group.
 */
export async function buildGroupLedgerHistories(prisma: PrismaClient, names: HistoryNames, prefix: string): Promise<Record<GroupHistoryName, GroupHistory>> {
  const stripe = groupHistoryStripe();
  const groups = {
    "group-card": groupHistory(prefix, "group-card", "STRIPE", 2),
    "group-bank": groupHistory(prefix, "group-bank", "INTERNET_BANKING", 2),
    "group-legacy-cancel": groupHistory(prefix, "group-legacy-cancel", "STRIPE", 2),
    "group-bank-cancel": groupHistory(prefix, "group-bank-cancel", "INTERNET_BANKING", 2),
    "group-refund": groupHistory(prefix, "group-refund", "STRIPE", 1),
    "group-pre3854-refund": groupHistory(prefix, "group-pre3854-refund", "STRIPE", 1),
    "group-bank-promo-cancel": groupHistory(prefix, "group-bank-promo-cancel", "INTERNET_BANKING", 2),
  } satisfies Record<GroupHistoryName, GroupHistory>;
  for (const g of Object.values(groups)) {
    if (g === groups["group-bank-promo-cancel"]) continue;
    await createGroupHistory(prisma, names, g);
    await settleGroupHistory(g);
  }

  // Settled by card and by Internet Banking, nothing since.
  await stripGroupLines(prisma, groups["group-card"]);
  await stripGroupLines(prisma, groups["group-bank"]);

  // A card plan frozen before #3653 (`{childId: cents}`, half each), cancelled
  // by the real organiser cancel. Its inline refund fails and the durable retry
  // is queued; then the provider's refund succeeds (the settlement's flip, as
  // the replay's own Stripe leg makes it), the real replay writes each child's
  // mirror, and the retry closes.
  const legacy = groups["group-legacy-cancel"];
  await prisma.groupBookingSettlement.update({
    where: { id: legacy.settlement },
    data: { refundPlan: Object.fromEntries(legacy.children.map((id) => [id, GROUP_CHILD_CENTS / 2])) },
  });
  await cancelGroupHistory(names, legacy);
  await prisma.groupBookingSettlement.update({ where: { id: legacy.settlement }, data: { status: "PARTIALLY_REFUNDED" } });
  const { executeGroupSettlementRefundPlan } = await import("@/lib/group-cancel");
  expect(await executeGroupSettlementRefundPlan(legacy.settlement, CLUB_FORMAT_TEST)).toMatchObject({ outcome: "already_refunded", mirroredChildren: 2 });
  const { markGroupSettlementRefundRecoverySucceeded } = await import("@/lib/payment-recovery");
  await markGroupSettlementRefundRecoverySucceeded({ settlementId: legacy.settlement });
  await stripGroupLines(prisma, legacy);

  // Internet Banking: the organiser cancel freezes the mirror plan (half each)
  // and writes the mirrors in each child's claim.
  await cancelGroupHistory(names, groups["group-bank-cancel"]);
  await stripGroupLines(prisma, groups["group-bank-cancel"]);

  // #3653: $15 off a card-settled child, refunded out of the combined payment.
  const refund = groups["group-refund"];
  await runGroupChildRefund(prisma, (await reserveGroupChildReduction(prisma, names, refund, refund.children[0]!, 1_500)).id, stripe);
  await stripGroupLines(prisma, refund);

  // Settled before #3854 (no lines), then refunded the same way after it
  // shipped: the executor's own settlement sync posts the refund line alone.
  const pre = groups["group-pre3854-refund"];
  await stripGroupLines(prisma, pre);
  await runGroupChildRefund(prisma, (await reserveGroupChildReduction(prisma, names, pre, pre.children[0]!, 1_500)).id, stripe);

  // Epic #3813: a child carrying two promo codes beside one with none, settled
  // by Internet Banking and cancelled by the organiser (the mirror plan, half
  // each), then every line stripped.
  const promo = groups["group-bank-promo-cancel"];
  await buildPromoHandBackGroup(prisma, names, promo, { handBack: false });
  await stripGroupLines(prisma, promo);
  return groups;
}
