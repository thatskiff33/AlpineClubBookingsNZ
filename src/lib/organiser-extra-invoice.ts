/**
 * #4299 (`INV-PAY-142`; owner decisions on #4299, 22 and 25 Oct 2026): A
 * PLACE THE GROUP ORGANISER PAID FOR BY INTERNET BANKING THAT COSTS MORE IS
 * BILLED TO THE ORGANISER.
 *
 * Such a place (`paidByOrganiserInternetBanking`) has no card and no invoice of
 * its own: its money is on the group's combined invoice, which is PAID before
 * the place counts as organiser-paid, and Xero cannot add a line to a paid
 * invoice. So an edit that raises its price - the price change plus the
 * late-change fee, the same net every other door bills (decision 3) - bills
 * that net to the organiser on an EXTRA INVOICE of its own: a supplementary
 * invoice anchored on the change, addressed to the organiser's contact, naming
 * the combined invoice, raised unpaid (decision 1). The joiner is asked for
 * nothing. With no combined invoice on record the edit is refused (decision 4).
 *
 * This module is the save's half, light enough for every door's transaction:
 *
 *  - `planOrganiserBilledIncrease` - the one test and the one figure, asked by
 *    `applyPaymentAdjustments` (every door but the guest add) and by the guest
 *    add, which settles itself, and by the quote, which previews them;
 *  - `organiserBillingHistory` - what the change's own history row records;
 *  - `readUnpaidOrganiserExtras` / `readRefundableOrganiserExtras` and the pure
 *    newest-first allocation the netting takes (decisions N1-N3,
 *    `organiser-extra-netting.ts`).
 *
 * The record and its invoice are written by `recordOrganiserBilledChange`
 * (`organiser-extra-record.ts`) once the door's change row exists.
 */
import type { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/api-error";
import { isSettledBookingStatus } from "@/lib/booking-payment-state";
import {
  ORGANISER_BILLING_NO_COMBINED_INVOICE_MESSAGE,
  readOrganiserBillingTarget,
  type OrganiserBillingTarget,
} from "@/lib/group-organiser-billing-target";
import { paidByOrganiserInternetBanking } from "@/lib/group-organiser-paid";

/** Who wrote an extra invoice's row: the change's own door, or the back-bill repair for a change made before #4299. */
export const ORGANISER_EXTRA_SOURCE = { EDIT: "EDIT", BACK_BILL: "BACK_BILL" } as const;
export type OrganiserExtraSource = (typeof ORGANISER_EXTRA_SOURCE)[keyof typeof ORGANISER_EXTRA_SOURCE];

/** The outbox payload's marker on the change's supplementary invoice: addressed to the group organiser. */
export const ORGANISER_BILL_TO = "group-organiser" as const;

/** An increase billed to the organiser: the target, and the net the extra invoice bills. */
export type OrganiserBilledIncrease = {
  target: OrganiserBillingTarget;
  priceDiffCents: number;
  changeFeeCents: number;
  /** priceDiffCents + changeFeeCents: always positive. */
  billedCents: number;
};

/** Decision 4: refused inside the edit's transaction, so nothing is saved; the doors answer 409. */
export class OrganiserBillingRefusedError extends ApiError {
  constructor(message: string = ORGANISER_BILLING_NO_COMBINED_INVOICE_MESSAGE) {
    super(message, 409);
  }
}

type BillableBooking = Parameters<typeof paidByOrganiserInternetBanking>[0] & { status: string };

/** Pure half: is this change's net one the organiser is billed for? */
export function billsOrganiserForIncrease(booking: BillableBooking, netChargeCents: number): boolean {
  return netChargeCents > 0 && isSettledBookingStatus(booking.status) && paidByOrganiserInternetBanking(booking);
}

/**
 * THE ONE ANSWER: the organiser-billed increase this change makes, or null.
 * Asked under the door's `lock(1)` with the booking re-read after it, so the
 * combined invoice it reads cannot move before the commit (every writer of
 * `GroupBookingSettlement.xeroInvoiceId` holds `lock(1)`). Throws
 * {@link OrganiserBillingRefusedError} when the group has no combined invoice.
 *
 * `netChargeCents` is the change's net after any unpaid ask took its share
 * (`ReductionAgainstUnpaidAsk.netChargeLeftCents`); an increase takes none, so
 * it is the price change plus the fee, which the invoice bills line by line.
 */
export async function planOrganiserBilledIncrease(
  store: Pick<Prisma.TransactionClient, "groupBooking">,
  booking: BillableBooking,
  change: { priceDiffCents: number; changeFeeCents: number; netChargeCents: number },
): Promise<OrganiserBilledIncrease | null> {
  if (!billsOrganiserForIncrease(booking, change.netChargeCents)) return null;
  const billedCents = change.priceDiffCents + change.changeFeeCents;
  if (billedCents !== change.netChargeCents) {
    throw new Error(
      `INV-PAY-142 (#4299): an organiser-billed increase on booking ${booking.parentBookingId ?? "?"}'s joiner nets ${change.netChargeCents}, not its price change plus fee (${billedCents}); an increase takes no unpaid-ask offset.`,
    );
  }
  const read = await readOrganiserBillingTarget(store, booking);
  if (!read.ok) throw new OrganiserBillingRefusedError();
  return { target: read.target, priceDiffCents: change.priceDiffCents, changeFeeCents: change.changeFeeCents, billedCents };
}

/**
 * The quote's answer, unlocked and advisory, from the same two halves: what
 * the organiser would be invoiced, or the refusal the save would give.
 */
export async function previewOrganiserBilling(
  store: Pick<Prisma.TransactionClient, "groupBooking">,
  booking: BillableBooking,
  netChargeCents: number,
): Promise<{ organiserBilledCents: number; refusal: string | null }> {
  if (!billsOrganiserForIncrease(booking, netChargeCents)) return { organiserBilledCents: 0, refusal: null };
  const read = await readOrganiserBillingTarget(store, booking);
  return read.ok
    ? { organiserBilledCents: netChargeCents, refusal: null }
    : { organiserBilledCents: 0, refusal: ORGANISER_BILLING_NO_COMBINED_INVOICE_MESSAGE };
}

/** One cut a reduction or cancel took off an organiser's extra invoice, as the change's history records it. */
export type OrganiserExtraOffset = {
  organiserExtraInvoiceId: string;
  /** The change the extra invoice bills. */
  bookingModificationId: string;
  cents: number;
  kind: OrganiserExtraAdjustKind;
};

/**
 * What a cut does to an extra invoice in Xero (decision N2): `void` when it
 * takes the whole invoice and nothing was paid or credited on it before;
 * `credit-unpaid` for a smaller cut (allocated against it, so the rest stays
 * owed); `credit-refund` for a refund of what the organiser paid on it (N3).
 */
export type OrganiserExtraAdjustKind = "void" | "credit-unpaid" | "credit-refund";

/** The history fields a change writes: what it billed the organiser, and what it took off their extra invoices. */
export function organiserBillingHistory(result: {
  organiserBilling: OrganiserBilledIncrease | null;
  organiserExtraOffsets: readonly OrganiserExtraOffset[];
}): Record<string, unknown> {
  return {
    ...(result.organiserBilling
      ? {
          organiserBilled: {
            billedCents: result.organiserBilling.billedCents,
            groupSettlementId: result.organiserBilling.target.settlementId,
            combinedInvoiceId: result.organiserBilling.target.combinedInvoiceId,
            combinedInvoiceNumber: result.organiserBilling.target.combinedInvoiceNumber,
          },
        }
      : {}),
    ...(result.organiserExtraOffsets.length > 0 ? { organiserExtraOffsets: result.organiserExtraOffsets } : {}),
  };
}

/** The counters of one extra invoice. */
export type OrganiserExtraCounters = {
  id: string;
  bookingModificationId: string;
  billedCents: number;
  paidCents: number;
  reducedCents: number;
  refundedCents: number;
  createdAt: Date;
};

/** What the organiser still owes on it: billed, less what they paid and what later cuts took off. */
export function organiserExtraUnpaidCents(extra: Pick<OrganiserExtraCounters, "billedCents" | "paidCents" | "reducedCents">): number {
  return Math.max(0, extra.billedCents - extra.paidCents - extra.reducedCents);
}

/** What the organiser paid on it and has not had back. */
export function organiserExtraRefundableCents(extra: Pick<OrganiserExtraCounters, "paidCents" | "refundedCents">): number {
  return Math.max(0, extra.paidCents - extra.refundedCents);
}

const COUNTERS_SELECT = {
  id: true,
  bookingModificationId: true,
  billedCents: true,
  paidCents: true,
  reducedCents: true,
  refundedCents: true,
  createdAt: true,
} as const;

type ExtrasStore = Pick<Prisma.TransactionClient, "organiserExtraInvoice">;

async function readExtras(store: ExtrasStore, bookingId: string): Promise<OrganiserExtraCounters[]> {
  // Newest first (decision N1: the latest extra comes off first, as the card
  // rule retires the latest ask); `id` breaks a same-instant tie stably.
  return store.organiserExtraInvoice.findMany({
    where: { bookingId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: COUNTERS_SELECT,
  });
}

/** The booking's extra invoices with something still owed on them, newest first. */
export async function readUnpaidOrganiserExtras(store: ExtrasStore, bookingId: string): Promise<OrganiserExtraCounters[]> {
  return (await readExtras(store, bookingId)).filter((extra) => organiserExtraUnpaidCents(extra) > 0);
}

/** The booking's extra invoices with paid money not yet refunded, newest first. */
export async function readRefundableOrganiserExtras(store: ExtrasStore, bookingId: string): Promise<OrganiserExtraCounters[]> {
  return (await readExtras(store, bookingId)).filter((extra) => organiserExtraRefundableCents(extra) > 0);
}

/**
 * Spread `cents` over `rows` in order, each up to its `capacity`; what is left
 * over is the caller's (the rest of a refund comes from the original share).
 */
export function allocateInOrder<T>(
  rows: readonly T[],
  capacity: (row: T) => number,
  cents: number,
): { row: T; cents: number }[] {
  const taken: { row: T; cents: number }[] = [];
  let left = Math.max(0, cents);
  for (const row of rows) {
    if (left <= 0) break;
    const share = Math.min(left, Math.max(0, capacity(row)));
    if (share > 0) {
      taken.push({ row, cents: share });
      left -= share;
    }
  }
  return taken;
}
