import type { LineAmountTypes, LineItem } from "xero-node";
import type { MemberMoneyExportConflictReason } from "@prisma/client";
import { buildXeroBookingInvoiceCorrelationKey } from "../../xero-booking-invoice-key";
import { CHANGE_FEE_LINE_DESCRIPTION, invoiceLineItemsTotalCents } from "../../xero-modification-line-items";
import { buildPrimaryInvoiceLines, type PrimaryInvoiceLineInput } from "../../xero-primary-invoice-lines";
import { sanitizeForJson } from "../../xero-sync";
import { stableDigest } from "../../stable-digest";
import { lineTaxMismatches } from "../../xero-line-tax-mismatches";
import { compareOrdinal } from "@/lib/ordinal-order";
import { bookingChargeIdentity } from "./booking-charges";
import { componentKey, componentsPostedBy, liveComponentSplit, type PostedRevenueLeg } from "./components";
import { allocateTaxAcrossLines } from "./tax";

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
 *
 * THE JOURNAL'S GST IS THE FIGURE OF RECORD (#5208, owner decision 18 Nov 2026,
 * Option A). A COVERED plan for a registered club, with overrides ON, carries
 * each line's `taxAmount`: the stay component's live tax shared across the stay
 * lines and the fee components' tax across the fee line
 * (`allocateTaxAcrossLines`), so the invoice's tax equals the journal's to the
 * cent. With overrides PAUSED (`xero-tax-override-safeguard.ts`), unregistered,
 * replayed or in conflict, the lines are exactly the builders' and Xero works the
 * tax out line by line. What was done is frozen as `taxAllocation`.
 */

/** The sender's own line input, and the booking's posted charge legs. */
export interface PrimaryInvoicePlanInput extends PrimaryInvoiceLineInput {
  bookingId: string;
  /** The booking's posted BOOKING_REVENUE and FEE_REVENUE legs (`readBookingChargeLegs`). */
  postedLegs: readonly PostedRevenueLeg[];
  /** #5208: whether the journal's tax is sent per line, or paused after Xero changed some (`readXeroTaxOverridePause`). */
  taxOverrides: XeroTaxOverrides;
}

/** #5208: whether a new primary invoice carries the journal's tax on each line. */
export type XeroTaxOverrides = "ON" | "PAUSED";

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

/**
 * Plan the primary invoice the sender builds: the same lines, then their coverage
 * or conflict. A COVERED plan's lines are what the sender sends (#5208): the
 * builders' own, with the journal's tax on each line when the overrides apply.
 */
export function planPrimaryBookingInvoice(input: PrimaryInvoicePlanInput): PrimaryInvoicePlan {
  const { lines, stayLines, feeLines } = buildPrimaryInvoiceLines(input);
  return coverPrimaryInvoiceLines({
    bookingId: input.bookingId,
    lines,
    stayCents: invoiceLineItemsTotalCents(stayLines),
    feeCents: invoiceLineItemsTotalCents(feeLines),
    postedLegs: input.postedLegs,
    // Only a built invoice for a registered club takes the journal's tax.
    taxOverrides: input.taxRendering.taxType === undefined ? null : { mode: input.taxOverrides, stayLineCount: stayLines.length },
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
 * the returned lines bill the same stay and fee cents as the lines planned, and
 * (#5208) keep the tax planned on every line that carried it; otherwise it
 * becomes a conflict that covers nothing, because the manifest is write-once and
 * must never claim the invoice bills what it does not.
 */
export function confirmBilledPrimaryInvoice(plan: PrimaryInvoicePlan, billedLines: ReadonlyArray<LineItem>): PrimaryInvoicePlan {
  if (plan.outcome !== "COVERED") return plan;
  const planned = splitStayAndFeeCents(plan.lines);
  const billed = splitStayAndFeeCents(billedLines);
  let reason: MemberMoneyExportConflictReason;
  let problem = "the invoice Xero returned bills other lines than were planned";
  if (planned.stayCents !== billed.stayCents) reason = "STAY_CENTS";
  else if (planned.feeCents !== billed.feeCents) reason = "FEE_CENTS";
  else if (lineTaxMismatches(plan.lines, billedLines).length > 0) {
    reason = "TAX_CENTS";
    problem = "the invoice Xero returned holds other tax than the journal's on a line";
  } else return plan;
  return {
    legacyKey: plan.legacyKey,
    payloadHash: plan.payloadHash,
    lineTotalCents: plan.lineTotalCents,
    lines: plan.lines,
    outcome: "CONFLICT",
    reason,
    problem,
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
  /** #5208: null for a replay or an unregistered club, whose lines are never touched. */
  taxOverrides?: { mode: XeroTaxOverrides; stayLineCount: number } | null;
}): PrimaryInvoicePlan {
  const { bookingId, lines, stayCents, feeCents, postedLegs } = input;
  const lineTotalCents = invoiceLineItemsTotalCents(lines);
  const rendering = (
    componentTaxCodes: PrimaryInvoiceCoverage[],
    renderedLines: LineItem[] = lines,
    taxAllocation?: TaxAllocation,
  ): PrimaryInvoiceRendering => ({
    legacyKey: buildXeroBookingInvoiceCorrelationKey(bookingId),
    payloadHash: primaryInvoicePayloadHash(renderedLines),
    frozenMapping: {
      ...input.mapping,
      componentTaxCodes: componentTaxCodes.map(({ account, chargeIdentity, taxCode }) => ({ account, chargeIdentity, taxCode })),
      ...(taxAllocation === undefined ? {} : { taxAllocation }),
    },
    lineTotalCents,
  });
  const conflict = (reason: MemberMoneyExportConflictReason, problem: string): PrimaryInvoicePlan =>
    ({ outcome: "CONFLICT", lines, reason, problem, ...rendering([]) });

  const stayIdentity = bookingChargeIdentity(bookingId);
  const identities = componentsPostedBy({ lines: postedLegs }).sort((a, b) =>
    compareOrdinal(componentKey(a.account, a.chargeIdentity), componentKey(b.account, b.chargeIdentity)));
  const components: CoveredComponent[] = [];
  for (const identity of identities) {
    const account = identity.account as PrimaryInvoiceCoverage["account"];
    const { chargeIdentity } = identity;
    const split = liveComponentSplit(postedLegs, account, chargeIdentity);
    if (!split) continue;
    if ("problem" in split) return conflict("COMPONENT_UNUSABLE", split.problem);
    if (split.bookingId !== bookingId) return conflict("COMPONENT_UNUSABLE", `component ${chargeIdentity} names another booking`);
    components.push({ account, chargeIdentity, coveredCents: split.grossCents, taxCode: split.taxCode, taxCents: split.taxCents });
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
  const covered = [stay, ...fees].filter((c) => c.coveredCents !== 0);
  if (covered.some((c) => c.coveredCents < 0)) return conflict("COMPONENT_UNUSABLE", "a component carries a negative gross");
  if (covered.reduce((sum, c) => sum + c.coveredCents, 0) !== lineTotalCents) {
    return conflict("STAY_CENTS", "the lines' total is not what the components carry");
  }
  const coverage = covered.map(({ account, chargeIdentity, coveredCents, taxCode }) => ({ account, chargeIdentity, coveredCents, taxCode }));
  const overrides = input.taxOverrides;
  if (!overrides) return { outcome: "COVERED", lines, coverage, ...rendering(coverage) };
  if (overrides.mode === "PAUSED") return { outcome: "COVERED", lines, coverage, ...rendering(coverage, lines, "PAUSED") };
  if (covered.some((c) => c.taxCode === null)) {
    return conflict("TAX_CENTS", "the journal records no tax on a component the invoice's lines are taxed under");
  }
  const stayLines = lines.slice(0, overrides.stayLineCount);
  const feeLines = lines.slice(overrides.stayLineCount);
  const stayTax = allocateTaxAcrossLines(stay.taxCents, stayLines.map(lineCents));
  const feeTax = allocateTaxAcrossLines(fees.reduce((sum, c) => sum + c.taxCents, 0), feeLines.map(lineCents));
  if ("problem" in stayTax) return conflict("TAX_CENTS", `the stay's tax cannot be shared across its lines: ${stayTax.problem}`);
  if ("problem" in feeTax) return conflict("TAX_CENTS", `the change fee's tax cannot be shared across its line: ${feeTax.problem}`);
  const lineTaxCents = [...stayTax.lineTaxCents, ...feeTax.lineTaxCents];
  const taxed = lines.map((line, index) => ({ ...line, taxAmount: lineTaxCents[index]! / 100 })); // Xero uses dollars
  return {
    outcome: "COVERED",
    lines: taxed,
    coverage,
    ...rendering(coverage, taxed, { method: "JOURNAL_LARGEST_REMAINDER", lineTaxCents }),
  };
}

/** A covered component, with the live tax its lines' `taxAmount` is shared from (#5208). */
type CoveredComponent = PrimaryInvoiceCoverage & { taxCents: number };

/** What a plan froze about the tax on its lines (#5208): the cents each line carries, or that overrides were paused. */
type TaxAllocation = { method: "JOURNAL_LARGEST_REMAINDER"; lineTaxCents: number[] } | "PAUSED";

const lineCents = (line: LineItem) => invoiceLineItemsTotalCents([line]);

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
