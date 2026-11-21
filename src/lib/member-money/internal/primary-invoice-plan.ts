import type { LineAmountTypes, LineItem } from "xero-node";
import type { MemberMoneyExportConflictReason } from "@prisma/client";
import { buildXeroBookingInvoiceCorrelationKey } from "../../xero-booking-invoice-key";
import { CHANGE_FEE_LINE_DESCRIPTION, invoiceLineItemsTotalCents } from "../../xero-modification-line-items";
import { buildPrimaryInvoiceLines, type PrimaryInvoiceLineInput } from "../../xero-primary-invoice-lines";
import { sanitizeForJson } from "../../xero-sync";
import { stableDigest } from "../../stable-digest";
import { compareOrdinal } from "@/lib/ordinal-order";
import { bookingChargeIdentity } from "./booking-charges";
import { componentKey, componentsPostedBy, liveComponentSplit, type PostedRevenueLeg } from "./components";

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
      ...frozenHutFeeMapping(input.hutFeeMapping, input.hutFeeItemCodeMap),
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
 * The hut-fee account and item-code settings built lines were coded with, frozen
 * beside a manifest: the primary invoice's and the combined group invoice's.
 */
export function frozenHutFeeMapping(hutFeeMapping: PrimaryInvoiceLineInput["hutFeeMapping"], itemCodeMap: PrimaryInvoiceLineInput["hutFeeItemCodeMap"]) {
  return {
    hutFee: {
      accountCode: hutFeeMapping.code ?? "200",
      itemCode: hutFeeMapping.itemCode,
      codeExplicitlyConfigured: hutFeeMapping.codeExplicitlyConfigured,
    },
    itemCodeMap: {
      byKey: [...itemCodeMap.byKey].sort(([a], [b]) => compareOrdinal(a, b)),
      fullTypeId: itemCodeMap.fullTypeId,
      nonMemberTypeId: itemCodeMap.nonMemberTypeId,
      legacyItemCode: itemCodeMap.legacyItemCode,
    },
  };
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
      lineCodes: frozenLineCodes(input.storedLines),
    },
  });
}

/**
 * The account code, item code and tax type of each line sent, frozen beside a
 * manifest (every invoice planner). The tax type is the line's own (#4632): the
 * booking's rendering for a built line, the provider's for a stored or copied one.
 */
export function frozenLineCodes(
  lines: ReadonlyArray<LineItem>,
): { accountCode: string | null; itemCode: string | null; taxType: string | null }[] {
  return lines.map((line) => ({ accountCode: line.accountCode ?? null, itemCode: line.itemCode ?? null, taxType: line.taxType ?? null }));
}

/**
 * A line array's stay and change-fee cents, the fee line known by the words
 * `changeFeeLineItem` gives it. The one split every invoice planner uses.
 */
export function splitStayAndFeeCents(lines: ReadonlyArray<LineItem>): { stayCents: number; feeCents: number } {
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

  const covered = coverBookingInvoiceLines({ bookingId, stayCents, feeCents, postedLegs });
  if ("reason" in covered) return conflict(covered.reason, covered.problem);
  if (covered.coverage.reduce((sum, c) => sum + c.coveredCents, 0) !== lineTotalCents) {
    return conflict("STAY_CENTS", "the lines' total is not what the components carry");
  }
  return { outcome: "COVERED", lines, coverage: covered.coverage, ...rendering(covered.coverage) };
}

/** What one booking's invoice lines cover in whole, or why they cover nothing. */
export type BookingInvoiceCoverage =
  | { coverage: PrimaryInvoiceCoverage[] }
  | { reason: Extract<MemberMoneyExportConflictReason, "STAY_CENTS" | "FEE_CENTS" | "COMPONENT_UNUSABLE">; problem: string };

/**
 * THE PER-BOOKING MATCH (#4525): one booking's stay lines and change-fee line,
 * in cents, against its live journal components. The primary invoice runs it
 * for its booking; the combined group invoice runs it for each child (`INV-SSOT`).
 *
 * Guest and promo lines must equal the stay component's live gross
 * (`bookingChargeIdentity`), and the fee line the live change-fee components'
 * gross. A component whose legs disagree on booking or tax, one naming another
 * booking, a non-stay booking-revenue component (a close-out), or a missing stay
 * charge under non-zero lines is unusable. Coverage is whole components only.
 */
export function coverBookingInvoiceLines(input: {
  bookingId: string;
  stayCents: number;
  feeCents: number;
  postedLegs: readonly PostedRevenueLeg[];
}): BookingInvoiceCoverage {
  const { bookingId, stayCents, feeCents } = input;
  const live = liveBookingInvoiceComponents(bookingId, input.postedLegs);
  if ("reason" in live) return live;
  const { stay, fees } = live;
  const liveFeeCents = fees.reduce((sum, c) => sum + c.coveredCents, 0);
  if (!stay) {
    if (stayCents + feeCents === 0 && liveFeeCents === 0) return { coverage: [] };
    return { reason: "COMPONENT_UNUSABLE", problem: `the journal holds no stay charge ${bookingChargeIdentity(bookingId)}` };
  }
  if (stay.coveredCents !== stayCents) {
    return { reason: "STAY_CENTS", problem: "the stay lines do not bill the stay charge's live gross" };
  }
  if (liveFeeCents !== feeCents) {
    return { reason: "FEE_CENTS", problem: "the change-fee line does not bill the fee components' live gross" };
  }
  const coverage = [stay, ...fees].filter((c) => c.coveredCents !== 0);
  if (coverage.some((c) => c.coveredCents < 0)) return { reason: "COMPONENT_UNUSABLE", problem: "a component carries a negative gross" };
  return { coverage };
}

/**
 * The components a booking's invoice can bill, each at its live gross: its stay
 * charge (or null when no leg posts it) and its live change-fee components. Any
 * component whose legs disagree on booking or tax, one naming another booking,
 * or a live booking-revenue component other than the stay charge is unusable.
 */
export function liveBookingInvoiceComponents(
  bookingId: string,
  postedLegs: readonly PostedRevenueLeg[],
): { stay: PrimaryInvoiceCoverage | null; fees: PrimaryInvoiceCoverage[] } | { reason: "COMPONENT_UNUSABLE"; problem: string } {
  const unusable = (problem: string) => ({ reason: "COMPONENT_UNUSABLE" as const, problem });
  const stayIdentity = bookingChargeIdentity(bookingId);
  const identities = componentsPostedBy({ lines: postedLegs }).sort((a, b) =>
    compareOrdinal(componentKey(a.account, a.chargeIdentity), componentKey(b.account, b.chargeIdentity)));
  const components: PrimaryInvoiceCoverage[] = [];
  for (const identity of identities) {
    const account = identity.account as PrimaryInvoiceCoverage["account"];
    const { chargeIdentity } = identity;
    const split = liveComponentSplit(postedLegs, account, chargeIdentity);
    if (!split) continue;
    if ("problem" in split) return unusable(split.problem);
    if (split.bookingId !== bookingId) return unusable(`component ${chargeIdentity} names another booking`);
    components.push({ account, chargeIdentity, coveredCents: split.grossCents, taxCode: split.taxCode });
  }
  // A close-out (`refundCloseOutIdentity`) or any other booking-revenue component is never the stay charge.
  const otherStay = components.find((c) => c.account === "BOOKING_REVENUE" && c.chargeIdentity !== stayIdentity && c.coveredCents !== 0);
  if (otherStay) return unusable(`booking revenue ${otherStay.chargeIdentity} is not the stay charge`);
  return {
    stay: components.find((c) => c.account === "BOOKING_REVENUE" && c.chargeIdentity === stayIdentity) ?? null,
    fees: components.filter((c) => c.account === "FEE_REVENUE"),
  };
}

/** The primary manifest an update stands on: the one recorded for the same booking's invoice. */
export interface PrimaryManifestForUpdate {
  id: string;
  outcome: "COVERED" | "CONFLICT";
  lineTotalCents: number;
  providerInvoiceId: string;
}

export type PrimaryInvoiceUpdatePlan =
  | (PrimaryInvoiceRendering & { outcome: "COVERED" })
  | (PrimaryInvoiceRendering & { outcome: "CONFLICT"; reason: "PRIMARY_UNMATCHED"; problem: string });

/**
 * THE UPDATE OF AN ISSUED PRIMARY INVOICE (#4525, ALP-436). Pure.
 * `updateXeroBookingInvoiceForBooking` rewrites descriptions and dates and
 * copies every amount from the invoice Xero holds, so an update bills nothing
 * of its own: it covers no component, and it matches when its total is the
 * total of the covered primary manifest for the same invoice. The database
 * holds the same rule (`member_money_require_export_coverage`). Null when no
 * primary manifest was recorded: there is nothing for an update to stand on.
 */
export function planPrimaryInvoiceUpdate(input: {
  legacyKey: string;
  providerInvoiceId: string;
  lines: LineItem[];
  /** What the update sends: the issued invoice's own, so the frozen value is the provider's. */
  lineAmountTypes: LineAmountTypes;
  /** The provider's gross invoice total, including discounts and tax, converted at its boundary. */
  providerTotalCents: number;
  primary: PrimaryManifestForUpdate | null;
}): PrimaryInvoiceUpdatePlan | null {
  const { lines, primary } = input;
  if (!primary) return null;
  const lineTotalCents = input.providerTotalCents;
  const rendering: PrimaryInvoiceRendering = {
    legacyKey: input.legacyKey,
    payloadHash: primaryInvoicePayloadHash(lines),
    frozenMapping: {
      source: "UPDATED_FROM_PROVIDER",
      primaryManifestId: primary.id,
      lineCodes: frozenLineCodes(lines),
      lineAmountTypes: input.lineAmountTypes,
    },
    lineTotalCents,
  };
  const unmatched = (problem: string): PrimaryInvoiceUpdatePlan =>
    ({ outcome: "CONFLICT", reason: "PRIMARY_UNMATCHED", problem, ...rendering });
  if (primary.providerInvoiceId !== input.providerInvoiceId) return unmatched("the primary manifest names another invoice");
  if (primary.outcome !== "COVERED") return unmatched("the primary manifest records a conflict");
  if (primary.lineTotalCents !== lineTotalCents) return unmatched("the updated lines' total is not the primary invoice's");
  return { outcome: "COVERED", ...rendering };
}
