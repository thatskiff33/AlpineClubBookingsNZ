/**
 * #3642 (`INV-PAY-105`): the settle rule for a group settlement bound to its
 * emailed Internet Banking invoice — when a settle attempt may change it, and
 * the Xero check that clears an invoice for replacement. Split from
 * `group-settlement.ts`, whose transactions apply it under `lock(1)`.
 */
import { BookingStatus, PaymentSource, PaymentStatus } from "@prisma/client";
import { GroupBookingError } from "@/lib/group-booking";
import logger from "@/lib/logger";
import {
  groupSettlementTotalCents,
  type GroupSettlementChildWorth,
  isGroupSettlementBoundToInvoice,
} from "@/lib/group-settlement-invoice-binding";
import {
  describeGroupSettlementInvoiceMoney,
  readGroupSettlementInvoiceState,
  type GroupSettlementInvoiceState,
} from "@/lib/xero-group-settlement-invoice-voids";
import { alertGroupSettlementInvoice } from "@/lib/group-settlement-invoice-alerts";
import type { ClubFormat } from "@/lib/club-format";

/**
 * #3642 (`INV-PAY-105`): an invoice this settle was cleared to replace. Read in
 * Xero before any lock and found to carry no payment or credit; `null` when the
 * bound settlement had not raised its invoice yet. The commit and settle
 * transactions replace only this exact invoice: if the settlement points at a
 * different one by then, the organiser is asked to try again.
 */
export interface ClearedReplacement {
  xeroInvoiceId: string | null;
}

/**
 * What a settle attempt would do to the settlement: switch it to card, or
 * (re-)commit it to one Internet Banking invoice for `amountCents`.
 */
export type SettlementChange =
  | { method: "stripe" }
  | {
      method: "internet_banking";
      amountCents: number;
      /** A joiner this settle committed who was not on the settlement before. */
      claimedNewChild: boolean;
      replacement: ClearedReplacement | null;
    };

/**
 * Whether an Internet Banking settle changes a bound settlement: a joiner who
 * was not on its invoice (a late joiner, or one swapped in at the same total),
 * or a different total (a joiner who left or changed their booking).
 */
export function changesBoundInvoice(
  settlement: { amountCents: number },
  change: { amountCents: number; claimedNewChild: boolean }
): boolean {
  return change.claimedNewChild || change.amountCents !== settlement.amountCents;
}

/**
 * #3642 (`INV-PAY-105`): the settle rule for a settlement bound to its emailed
 * Internet Banking invoice.
 *
 * - A card attempt is refused: the invoice stays the bill until it is paid,
 *   replaced or lapses.
 * - An Internet Banking settle that changes nothing returns the same invoice.
 * - One that changes the group (orchestrator decision under the issue's item
 *   1: replace rather than refuse) is allowed only for the invoice it was
 *   cleared to replace (`ClearedReplacement`); the settle transaction then
 *   retires that invoice and asks for a new one at the new total.
 *
 * Called on the settlement row re-read under `lock(1)`; a throw inside the
 * commit transaction rolls back the children it claimed.
 */
export function refuseChangeToBoundSettlement(
  settlement:
    | {
        source: PaymentSource;
        status: PaymentStatus;
        amountCents: number;
        xeroInvoiceId: string | null;
      }
    | null
    | undefined,
  change: SettlementChange,
  /**
   * Set by the settle transaction, which runs after the claim transaction has
   * committed: its refusal cannot say nothing changed, because the beds it
   * claimed stay claimed until the organiser's next settle or the reaper.
   */
  options?: { afterClaim?: boolean }
): void {
  if (!isGroupSettlementBoundToInvoice(settlement)) return;
  const bound = settlement!;
  if (change.method === "stripe") {
    throw new GroupBookingError(
      "An Internet Banking invoice has already been sent for this group, so it can't be paid by card while that invoice is open. Pay the invoice by bank transfer. If anyone has joined, left or changed their booking since it was sent, choose Internet Banking again for an updated invoice.",
      409,
      {
        code: "GROUP_SETTLEMENT_INVOICE_OUTSTANDING",
        details: { invoicedCents: bound.amountCents },
      }
    );
  }
  if (!changesBoundInvoice(bound, change)) return;
  if (change.replacement && change.replacement.xeroInvoiceId === bound.xeroInvoiceId) {
    return;
  }
  throw new GroupBookingError(
    options?.afterClaim
      ? "Your group's invoice changed while it was being updated, so no new invoice was raised. Please try again to get an invoice for everyone."
      : "Your group's invoice changed while it was being updated. Nothing has been changed; please try again.",
    409,
    {
      code: "GROUP_SETTLEMENT_INVOICE_RETRY",
      details: { invoicedCents: bound.amountCents },
    }
  );
}

/**
 * #3642: before an Internet Banking settle may change a bound settlement, read
 * its invoice in Xero. An invoice that has started being paid or credited is
 * never replaced automatically: the organiser is told the club will sort it
 * out, and the operators are alerted. Xero out of reach refuses rather than
 * replacing an invoice nobody could check. Returns null when the settle
 * changes nothing (or the settlement is not bound).
 */
export async function clearBoundInvoiceForReplacement(
  settlement:
    | {
        id: string;
        source: PaymentSource;
        status: PaymentStatus;
        amountCents: number;
        xeroInvoiceId: string | null;
      }
    | null
    | undefined,
  children: ReadonlyArray<GroupSettlementChildWorth & { status: BookingStatus }>,
  format: ClubFormat
): Promise<ClearedReplacement | null> {
  if (!isGroupSettlementBoundToInvoice(settlement)) return null;
  const bound = settlement!;
  const changed = changesBoundInvoice(bound, {
    amountCents: groupSettlementTotalCents(children),
    claimedNewChild: children.some(
      (child) => child.status === BookingStatus.PAYMENT_PENDING
    ),
  });
  if (!changed) return null;
  if (!bound.xeroInvoiceId) return { xeroInvoiceId: null };
  let state: GroupSettlementInvoiceState;
  try {
    state = await readGroupSettlementInvoiceState(bound.xeroInvoiceId, "replace group invoice");
  } catch (err) {
    logger.error(
      { err, settlementId: bound.id, invoiceId: bound.xeroInvoiceId },
      "Could not read the group settlement invoice before replacing it"
    );
    throw new GroupBookingError(
      "We couldn't check your group's current invoice just now, so nothing has been changed. Please try again in a few minutes.",
      503,
      { code: "GROUP_SETTLEMENT_INVOICE_UNVERIFIED" }
    );
  }
  if (state.kind === "not_found") {
    // Deleted in Xero, or Xero now points at another organisation: nothing
    // here can be paid or voided, so the settlement is no longer bound to it.
    await alertGroupSettlementInvoice(
      {
        kind: "invoice_not_found",
        settlementId: bound.id,
        invoiceId: bound.xeroInvoiceId,
        errorMessage: `The organiser asked for an updated group invoice, and the current one (${bound.xeroInvoiceId}) is not in the connected Xero organisation (deleted, or Xero was reconnected elsewhere). A new invoice is being raised; check the old one in the organisation it was raised in.`,
      },
      format
    );
    return { xeroInvoiceId: bound.xeroInvoiceId };
  }
  if (state.kind === "has_money") {
    await alertGroupSettlementInvoice(
      {
        kind: "replace_blocked_by_money",
        settlementId: bound.id,
        invoiceId: bound.xeroInvoiceId,
        errorMessage: `The organiser's group changed and they asked for an updated invoice, but the current combined invoice ${bound.xeroInvoiceId} already has ${describeGroupSettlementInvoiceMoney(state, format)}, so it was not replaced. Work out with the organiser what is owed for the joiners not on it.`,
      },
      format
    );
    throw new GroupBookingError(
      "A payment has already been made against your group's invoice, so it can't be updated automatically. The club has been told and will be in touch about the joiners who aren't on it.",
      409,
      { code: "GROUP_SETTLEMENT_INVOICE_PAYMENT_RECEIVED" }
    );
  }
  return { xeroInvoiceId: bound.xeroInvoiceId };
}
