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

import { postHistoryEdit, stripAllLines, type HistoryNames } from "@/lib/__tests__/support/booking-ledger-history";
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
export async function settleGroupHistory(g: GroupHistory): Promise<void> {
  tick();
  const amountCents = GROUP_CHILD_CENTS * g.children.length;
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

export const GROUP_HISTORIES = [
  "group-card",
  "group-bank",
  "group-legacy-cancel",
  "group-bank-cancel",
  "group-refund",
  "group-pre3854-refund",
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
  } satisfies Record<GroupHistoryName, GroupHistory>;
  for (const g of Object.values(groups)) {
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
  return groups;
}
