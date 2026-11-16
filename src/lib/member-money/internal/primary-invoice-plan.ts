import type { LineItem } from "xero-node";
import type { MemberMoneyExportConflictReason } from "@prisma/client";
import { buildXeroBookingInvoiceCorrelationKey } from "../../xero-booking-invoice-key";
import { CHANGE_FEE_LINE_DESCRIPTION, invoiceLineItemsTotalCents } from "../../xero-modification-line-items";
import { buildPrimaryInvoiceLines, type PrimaryInvoiceLineInput } from "../../xero-primary-invoice-lines";
import { sanitizeForJson } from "../../xero-sync";
import { stableDigest } from "../../stable-digest";
import { compareOrdinal } from "@/lib/ordinal-order";
import { bookingChargeIdentity } from "./booking-charges";
import { liveComponentSplit, type PostedRevenueLeg } from "./components";

/**
 * THE PRIMARY BOOKING INVOICE, PLANNED FROM THE JOURNAL (#4525, Ledger M13).
 * Pure: no database, clock, settings or provider. It builds the lines
 * `createXeroInvoiceForBooking` builds, by calling the one composition it
 * calls, `buildPrimaryInvoiceLines` (`INV-SSOT`), and says which journal
 * components those lines bill in whole, or why they do not. The sender keeps
 * sending its own lines; the export manifest records this answer beside the
 * invoice it raised, once `confirmBilledPrimaryInvoice` has held it to the
 * lines Xero says that invoice bills.
 *
 * The match, in cents through `invoiceLineItemsTotalCents`: guest and promo
 * lines equal the stay component's live gross, the change-fee line equals the
 * live change-fee components' gross, and the line total equals what is
 * covered. Anything else is a conflict and covers nothing. The Xero tax type
 * and line-amount basis the lines carry (the booking's treatment, #4632) and the
 * journal's tax codes are separate namespaces: both are frozen, neither is
 * translated, and a difference is never a conflict.
 */

/** The sender's own line input, and the booking's posted charge legs. */
export interface PrimaryInvoicePlanInput extends PrimaryInvoiceLineInput {
  bookingId: string;
  /** The booking's posted BOOKING_REVENUE and FEE_REVENUE legs (`readBookingChargeLegs`). */
  postedLegs: readonly PostedRevenueLeg[];
}

export interface PrimaryInvoiceCoverage {
  account: "BOOKING_REVENUE" | "FEE_REVENUE";
  chargeIdentity: string;
  coveredCents: number;
  taxCode: string | null;
}

interface PrimaryInvoiceRendering {
  legacyKey: string;
  payloadHash: string;
  frozenMapping: Record<string, unknown>;
  lineTotalCents: number;
}

export type PrimaryInvoicePlan =
  | (PrimaryInvoiceRendering & { outcome: "COVERED"; lines: LineItem[]; coverage: PrimaryInvoiceCoverage[] })
  | (PrimaryInvoiceRendering & { outcome: "CONFLICT"; lines: LineItem[]; reason: MemberMoneyExportConflictReason; problem: string });

/** What a line array hashes to: the same bytes the sync operation stores (`sanitizeForJson`). */
export function primaryInvoicePayloadHash(lines: ReadonlyArray<LineItem>): string {
  return stableDigest(sanitizeForJson(lines));
}

/** Plan the primary invoice the sender builds: the same lines, then their coverage or conflict. */
export function planPrimaryBookingInvoice(input: PrimaryInvoicePlanInput): PrimaryInvoicePlan {
  const { lines, stayLines, feeLines } = buildPrimaryInvoiceLines(input);
  return coverPrimaryInvoiceLines({
    bookingId: input.bookingId,
    lines,
    stayCents: invoiceLineItemsTotalCents(stayLines),
    feeCents: invoiceLineItemsTotalCents(feeLines),
    postedLegs: input.postedLegs,
    mapping: {
      source: "BUILT",
      // #4632: the treatment the built lines carry, resolved from the booking's tax anchor.
      taxType: input.taxRendering.taxType ?? null,
      lineAmountTypes: input.taxRendering.lineAmountTypes,
      hutFee: {
        accountCode: input.hutFeeMapping.code ?? "200",
        itemCode: input.hutFeeMapping.itemCode,
        codeExplicitlyConfigured: input.hutFeeMapping.codeExplicitlyConfigured,
      },
      itemCodeMap: {
        byKey: [...input.hutFeeItemCodeMap.byKey].sort(([a], [b]) => compareOrdinal(a, b)),
        fullTypeId: input.hutFeeItemCodeMap.fullTypeId,
        nonMemberTypeId: input.hutFeeItemCodeMap.nonMemberTypeId,
        legacyItemCode: input.hutFeeItemCodeMap.legacyItemCode,
      },
      seasonType: input.seasonType,
      promoCodes: (input.promo.redemptions ?? []).map((redemption) => ({
        code: redemption.promoCode?.code ?? null,
        xeroItemCode: redemption.promoCode?.xeroItemCode ?? null,
        xeroAccountCode: redemption.promoCode?.xeroAccountCode ?? null,
      })),
    },
  });
}

/**
 * The replay's plan (#4525): an invoice already raised, its lines read back from
 * the sync operation's stored request. Nothing is rebuilt. The change-fee line is
 * the one `changeFeeLineItem` words; the rest is the stay. The mapping frozen is
 * what the stored request carries, because the settings it was built from are
 * gone: each line's codes and tax type, and the invoice's line-amount basis.
 */
export function planReplayedPrimaryBookingInvoice(input: {
  bookingId: string;
  storedLines: LineItem[];
  /** The stored invoice's `lineAmountTypes`, or null when the request holds none. */
  storedLineAmountTypes: string | null;
  postedLegs: readonly PostedRevenueLeg[];
}): PrimaryInvoicePlan {
  return coverPrimaryInvoiceLines({
    bookingId: input.bookingId,
    lines: input.storedLines,
    ...splitStayAndFeeCents(input.storedLines),
    postedLegs: input.postedLegs,
    mapping: {
      source: "STORED_REQUEST",
      lineAmountTypes: input.storedLineAmountTypes,
      lineCodes: input.storedLines.map((line) => ({
        accountCode: line.accountCode ?? null,
        itemCode: line.itemCode ?? null,
        taxType: line.taxType ?? null,
      })),
    },
  });
}

/** A line array's stay and change-fee cents, the fee line known by the words `changeFeeLineItem` gives it. */
function splitStayAndFeeCents(lines: ReadonlyArray<LineItem>): { stayCents: number; feeCents: number } {
  const isFee = (line: LineItem) => line.description === CHANGE_FEE_LINE_DESCRIPTION;
  return {
    stayCents: invoiceLineItemsTotalCents(lines.filter((line) => !isFee(line))),
    feeCents: invoiceLineItemsTotalCents(lines.filter(isFee)),
  };
}

/**
 * Hold a built plan to the invoice Xero returned (#4525 review). A create replayed
 * under the same idempotency key returns the ORIGINAL invoice, which may bill
 * lines built before the booking last changed. A COVERED plan stands only when
 * the returned lines bill the same stay and fee cents as the lines planned;
 * otherwise it becomes a conflict that covers nothing, because the manifest is
 * write-once and must never claim the invoice bills what it does not.
 */
export function confirmBilledPrimaryInvoice(plan: PrimaryInvoicePlan, billedLines: ReadonlyArray<LineItem>): PrimaryInvoicePlan {
  if (plan.outcome !== "COVERED") return plan;
  const planned = splitStayAndFeeCents(plan.lines);
  const billed = splitStayAndFeeCents(billedLines);
  if (planned.stayCents === billed.stayCents && planned.feeCents === billed.feeCents) return plan;
  const reason: MemberMoneyExportConflictReason = planned.stayCents !== billed.stayCents ? "STAY_CENTS" : "FEE_CENTS";
  return {
    legacyKey: plan.legacyKey,
    payloadHash: plan.payloadHash,
    lineTotalCents: plan.lineTotalCents,
    lines: plan.lines,
    outcome: "CONFLICT",
    reason,
    problem: "the invoice Xero returned bills other lines than were planned",
    frozenMapping: { ...plan.frozenMapping, componentTaxCodes: [] },
  };
}

function coverPrimaryInvoiceLines(input: {
  bookingId: string;
  lines: LineItem[];
  stayCents: number;
  feeCents: number;
  postedLegs: readonly PostedRevenueLeg[];
  mapping: Record<string, unknown>;
}): PrimaryInvoicePlan {
  const { bookingId, lines, stayCents, feeCents, postedLegs } = input;
  const lineTotalCents = invoiceLineItemsTotalCents(lines);
  const rendering = (componentTaxCodes: PrimaryInvoiceCoverage[]): PrimaryInvoiceRendering => ({
    legacyKey: buildXeroBookingInvoiceCorrelationKey(bookingId),
    payloadHash: primaryInvoicePayloadHash(lines),
    frozenMapping: {
      ...input.mapping,
      componentTaxCodes: componentTaxCodes.map(({ account, chargeIdentity, taxCode }) => ({ account, chargeIdentity, taxCode })),
    },
    lineTotalCents,
  });
  const conflict = (reason: MemberMoneyExportConflictReason, problem: string): PrimaryInvoicePlan =>
    ({ outcome: "CONFLICT", lines, reason, problem, ...rendering([]) });

  const stayIdentity = bookingChargeIdentity(bookingId);
  const identities = [...new Set(postedLegs.flatMap((leg) => (leg.chargeIdentity === null ? [] : [`${leg.account}\u0000${leg.chargeIdentity}`])))].sort();
  const components: PrimaryInvoiceCoverage[] = [];
  for (const key of identities) {
    const [account, chargeIdentity] = key.split("\u0000") as [PrimaryInvoiceCoverage["account"], string];
    const split = liveComponentSplit(postedLegs, account, chargeIdentity);
    if (!split) continue;
    if ("problem" in split) return conflict("COMPONENT_UNUSABLE", split.problem);
    if (split.bookingId !== bookingId) return conflict("COMPONENT_UNUSABLE", `component ${chargeIdentity} names another booking`);
    components.push({ account, chargeIdentity, coveredCents: split.grossCents, taxCode: split.taxCode });
  }
  const stay = components.find((c) => c.account === "BOOKING_REVENUE" && c.chargeIdentity === stayIdentity);
  // A close-out (`refundCloseOutIdentity`) or any other booking-revenue component is never the stay charge.
  const otherStay = components.find((c) => c.account === "BOOKING_REVENUE" && c.chargeIdentity !== stayIdentity && c.coveredCents !== 0);
  if (otherStay) return conflict("COMPONENT_UNUSABLE", `booking revenue ${otherStay.chargeIdentity} is not the stay charge`);
  const fees = components.filter((c) => c.account === "FEE_REVENUE");
  const liveFeeCents = fees.reduce((sum, c) => sum + c.coveredCents, 0);
  if (!stay) {
    if (lineTotalCents === 0 && liveFeeCents === 0) return { outcome: "COVERED", lines, coverage: [], ...rendering([]) };
    return conflict("COMPONENT_UNUSABLE", `the journal holds no stay charge ${stayIdentity}`);
  }
  if (stay.coveredCents !== stayCents) {
    return conflict("STAY_CENTS", "the stay lines do not bill the stay charge's live gross");
  }
  if (liveFeeCents !== feeCents) {
    return conflict("FEE_CENTS", "the change-fee line does not bill the fee components' live gross");
  }
  const coverage = [stay, ...fees].filter((c) => c.coveredCents !== 0);
  if (coverage.some((c) => c.coveredCents < 0)) return conflict("COMPONENT_UNUSABLE", "a component carries a negative gross");
  if (coverage.reduce((sum, c) => sum + c.coveredCents, 0) !== lineTotalCents) {
    return conflict("STAY_CENTS", "the lines' total is not what the components carry");
  }
  return { outcome: "COVERED", lines, coverage, ...rendering(coverage) };
}
