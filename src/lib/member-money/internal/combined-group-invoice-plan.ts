import type { LineItem } from "xero-node";
import type { MemberMoneyAccount, MemberMoneyExportConflictReason } from "@prisma/client";
import { invoiceLineItemsTotalCents } from "../../xero-modification-line-items";
import type { PrimaryInvoiceLineInput } from "../../xero-primary-invoice-lines";
import type { XeroTaxRendering } from "../../xero-tax-rendering";
import type { PostedRevenueLeg } from "./components";
import {
  coverBookingInvoiceLines,
  frozenHutFeeMapping,
  frozenLineCodes,
  liveBookingInvoiceComponents,
  primaryInvoicePayloadHash,
  splitStayAndFeeCents,
  withoutTax,
  type PrimaryInvoiceCoverage,
  type PrimaryInvoicePlan,
} from "./primary-invoice-plan";

/**
 * THE ORGANISER'S COMBINED GROUP INVOICE, PLANNED FROM THE JOURNAL (#4525,
 * Ledger M13, ALP-437). Pure: no database, clock, settings or provider.
 * `createXeroInvoiceForGroupSettlement` builds one invoice for every committed
 * child of an organiser-paid group; this says which of each child's journal
 * components those lines bill in whole, or why they do not. The sender keeps
 * sending its own lines; the export manifest records this answer.
 *
 * Each child goes through the primary invoice's own match
 * (`coverBookingInvoiceLines`, `INV-SSOT`): its stay lines against its stay
 * charge, its change-fee line against its live fee components. Any child's
 * conflict is the invoice's conflict and nothing is covered. A component a
 * primary invoice or another combined invoice still covers, an earlier attempt
 * of the same settlement included, is `ALREADY_COVERED` (owner decision,
 * 25 Nov 2026). The recorder plans again under the conflict's successor key
 * once that cover is released, and this then answers COVERED.
 * The Xero tax type and line-amount basis (the organiser's booking's treatment,
 * #4632) and the journal's tax codes are separate namespaces: both are frozen,
 * neither is translated.
 */

/** The plan's shape is the primary invoice's: lines, key, hash, mapping, and coverage or a conflict. */
export type CombinedGroupInvoicePlan = PrimaryInvoicePlan;

/** A component an invoice-family document still covers (`readLiveInvoiceCoverage`). */
export interface LiveInvoiceCoverage {
  account: MemberMoneyAccount;
  chargeIdentity: string;
}

/** One child as the sender built it, with its posted charge legs. */
export interface CombinedGroupInvoiceChild {
  bookingId: string;
  lodgeId: string;
  seasonType: string | null;
  stayLines: LineItem[];
  feeLines: LineItem[];
  /** The child's posted BOOKING_REVENUE and FEE_REVENUE legs (`readBookingChargeLegs`). */
  postedLegs: readonly PostedRevenueLeg[];
}

interface CombinedGroupInvoiceKey {
  /** `groupSettlementInvoiceCreateKey(settlementId, attempt)`: the CREATE attempt the invoice was raised under. */
  legacyKey: string;
  liveCoverage: readonly LiveInvoiceCoverage[];
}

/** Plan the combined invoice the sender built, child by child. */
export function planCombinedGroupInvoice(input: CombinedGroupInvoiceKey & {
  children: readonly CombinedGroupInvoiceChild[];
  taxRendering: XeroTaxRendering;
  hutFeeMapping: PrimaryInvoiceLineInput["hutFeeMapping"];
  hutFeeItemCodeMap: PrimaryInvoiceLineInput["hutFeeItemCodeMap"];
}): CombinedGroupInvoicePlan {
  const lines = input.children.flatMap((child) => [...child.stayLines, ...child.feeLines]);
  const coverage: PrimaryInvoiceCoverage[] = [];
  let conflict: { reason: MemberMoneyExportConflictReason; problem: string } | null = null;
  for (const child of input.children) {
    const covered = coverBookingInvoiceLines({
      bookingId: child.bookingId,
      stayCents: invoiceLineItemsTotalCents(child.stayLines),
      feeCents: invoiceLineItemsTotalCents(child.feeLines),
      postedLegs: child.postedLegs,
    });
    if ("reason" in covered) {
      conflict = { reason: covered.reason, problem: `child ${child.bookingId}: ${covered.problem}` };
      break;
    }
    coverage.push(...covered.coverage);
  }
  return settle(input, lines, conflict, coverage, {
    source: "BUILT",
    // #4632: the treatment the built lines carry, resolved from the organiser's booking's tax anchor.
    taxType: input.taxRendering.taxType ?? null,
    lineAmountTypes: input.taxRendering.lineAmountTypes,
    ...frozenHutFeeMapping(input.hutFeeMapping, input.hutFeeItemCodeMap),
    children: input.children.map(({ bookingId, lodgeId, seasonType }) => ({ bookingId, lodgeId, seasonType })),
  });
}

/**
 * The replay's plan: an invoice already raised and bound, its lines read back
 * from the CREATE operation's stored request. Nothing is rebuilt. The stored
 * lines do not say which child each belongs to, so the match is across the
 * children together: their stay charges against the stored stay lines, their
 * live fee components against the stored change-fee lines. Each child's
 * components are read by the same rules as a built plan's.
 */
export function planReplayedCombinedGroupInvoice(input: CombinedGroupInvoiceKey & {
  storedLines: LineItem[];
  /** The stored invoice's `lineAmountTypes`, or null when the request holds none. */
  storedLineAmountTypes: string | null;
  children: ReadonlyArray<{ bookingId: string; postedLegs: readonly PostedRevenueLeg[] }>;
}): CombinedGroupInvoicePlan {
  const lines = input.storedLines;
  const billed = splitStayAndFeeCents(lines);
  const stays: PrimaryInvoiceCoverage[] = [];
  const fees: PrimaryInvoiceCoverage[] = [];
  let conflict: { reason: MemberMoneyExportConflictReason; problem: string } | null = null;
  for (const child of input.children) {
    const live = liveBookingInvoiceComponents(child.bookingId, child.postedLegs);
    if ("reason" in live) {
      conflict = { reason: live.reason, problem: `child ${child.bookingId}: ${live.problem}` };
      break;
    }
    if (!live.stay && live.fees.some((c) => c.coveredCents !== 0)) {
      conflict = { reason: "COMPONENT_UNUSABLE", problem: `child ${child.bookingId}: the journal holds no stay charge` };
      break;
    }
    if (live.stay) stays.push(withoutTax(live.stay));
    fees.push(...live.fees.map(withoutTax));
  }
  const sum = (components: PrimaryInvoiceCoverage[]) => components.reduce((total, c) => total + c.coveredCents, 0);
  if (!conflict && sum(stays) !== billed.stayCents) {
    conflict = { reason: "STAY_CENTS", problem: "the stored stay lines do not bill the children's stay charges" };
  } else if (!conflict && sum(fees) !== billed.feeCents) {
    conflict = { reason: "FEE_CENTS", problem: "the stored change-fee lines do not bill the children's fee components" };
  }
  const coverage = [...stays, ...fees].filter((c) => c.coveredCents !== 0);
  if (!conflict && coverage.some((c) => c.coveredCents < 0)) {
    conflict = { reason: "COMPONENT_UNUSABLE", problem: "a component carries a negative gross" };
  }
  return settle(input, lines, conflict, coverage, {
    source: "STORED_REQUEST",
    lineAmountTypes: input.storedLineAmountTypes,
    lineCodes: frozenLineCodes(lines),
    children: input.children.map(({ bookingId }) => ({ bookingId })),
  });
}

/** The plan from a child conflict or the merged coverage: ALREADY_COVERED, then the total, then COVERED. */
function settle(
  key: CombinedGroupInvoiceKey,
  lines: LineItem[],
  childConflict: { reason: MemberMoneyExportConflictReason; problem: string } | null,
  coverage: PrimaryInvoiceCoverage[],
  mapping: Record<string, unknown>,
): CombinedGroupInvoicePlan {
  const lineTotalCents = invoiceLineItemsTotalCents(lines);
  const rendering = (covered: PrimaryInvoiceCoverage[]) => ({
    legacyKey: key.legacyKey,
    payloadHash: primaryInvoicePayloadHash(lines),
    frozenMapping: {
      ...mapping,
      componentTaxCodes: covered.map(({ account, chargeIdentity, taxCode }) => ({ account, chargeIdentity, taxCode })),
    },
    lineTotalCents,
  });
  const conflictPlan = (reason: MemberMoneyExportConflictReason, problem: string): CombinedGroupInvoicePlan =>
    ({ outcome: "CONFLICT", lines, reason, problem, ...rendering([]) });
  if (childConflict) return conflictPlan(childConflict.reason, childConflict.problem);
  const taken = coverage.find((c) => key.liveCoverage.some((live) => live.account === c.account && live.chargeIdentity === c.chargeIdentity));
  if (taken) return conflictPlan("ALREADY_COVERED", `${taken.chargeIdentity} is already covered by another invoice`);
  if (coverage.reduce((sum, c) => sum + c.coveredCents, 0) !== lineTotalCents) {
    return conflictPlan("STAY_CENTS", "the lines' total is not what the components carry");
  }
  return { outcome: "COVERED", lines, coverage, ...rendering(coverage) };
}
