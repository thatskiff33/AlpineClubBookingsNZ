import type { LineAmountTypes, LineItem } from "xero-node";
import type { MemberMoneyAccount, MemberMoneyExportConflictReason } from "@prisma/client";
import { invoiceLineItemsTotalCents } from "../../xero-modification-line-items";
import { sanitizeForJson } from "../../xero-sync";
import { stableDigest } from "../../stable-digest";
import { formatCentsPlain } from "../../utils";
import { frozenLineCodes } from "./primary-invoice-plan";

/**
 * A REFUND NOTE, ITS PAYMENT AND A FAILED-LATER REFUND'S REVERSAL, AS EXPORT PLANS
 * (#4525, Ledger M13, design section 7). Pure: no database, clock, settings or
 * provider. The sender keeps building and sending its own document; a plan
 * takes what it built and the one journal component that document answers,
 * and says whether the document covers that component whole, or why not.
 *
 * Every rule here covers one whole component or nothing: the cents must equal
 * the component's, and anything else is a conflict with no coverage rows
 * (`CENTS`), as is a component that could not be read (`COMPONENT_UNUSABLE`).
 * A refund document never covers BOOKING_REVENUE or FEE_REVENUE: the note
 * covers the refund debt (REFUND_PAYABLE), and its payment the cash slice (STRIPE_CLEARING or BANK), so a composite note cannot count
 * the price reduction a second time. The reversal invoice covers the R13 that
 * put the failed refund's cash back on STRIPE_CLEARING.
 */

/** The one component a refund document answers: its account and identity, and its whole cents. */
export interface RefundExportComponent {
  account: MemberMoneyAccount;
  chargeIdentity: string;
  cents: number;
}

/** A component the loader could not resolve, and why. */
export interface RefundExportProblem {
  problem: string;
}

export interface RefundExportCoverage {
  account: MemberMoneyAccount;
  chargeIdentity: string;
  coveredCents: number;
  taxCode: string | null;
}

interface RefundExportRendering {
  legacyKey: string;
  payloadHash: string;
  frozenMapping: Record<string, unknown>;
  lineTotalCents: number;
}

export type RefundExportPlan =
  | (RefundExportRendering & { outcome: "COVERED"; coverage: RefundExportCoverage[] })
  | (RefundExportRendering & { outcome: "CONFLICT"; reason: MemberMoneyExportConflictReason; problem: string });

/** What a sent body hashes to: the same bytes the sync operation stores (`sanitizeForJson`). */
export function refundExportPayloadHash(body: unknown): string {
  return stableDigest(sanitizeForJson(body));
}

/**
 * Cover `component` whole when `lineTotalCents` equals it; otherwise a conflict.
 * Shared by the refund roles so the rule is written once (`INV-SSOT`).
 */
export function coverRefundExportComponent(input: {
  rendering: RefundExportRendering;
  component: RefundExportComponent | RefundExportProblem;
  allowedAccounts: readonly MemberMoneyAccount[];
}): RefundExportPlan {
  const { rendering, component } = input;
  const conflict = (reason: MemberMoneyExportConflictReason, problem: string): RefundExportPlan =>
    ({ ...rendering, outcome: "CONFLICT", reason, problem });
  if ("problem" in component) return conflict("COMPONENT_UNUSABLE", component.problem);
  if (!input.allowedAccounts.includes(component.account)) {
    return conflict("COMPONENT_UNUSABLE", `a refund document never covers ${component.account}`);
  }
  if (component.cents <= 0) return conflict("COMPONENT_UNUSABLE", `component ${component.chargeIdentity} carries no positive cents`);
  if (rendering.lineTotalCents !== component.cents) {
    return conflict("CENTS", `the document's total ${formatCentsPlain(rendering.lineTotalCents)} is not component ${component.chargeIdentity}'s ${formatCentsPlain(component.cents)}`);
  }
  return {
    ...rendering,
    outcome: "COVERED",
    coverage: [{ account: component.account, chargeIdentity: component.chargeIdentity, coveredCents: component.cents, taxCode: null }],
  };
}

/** What `createXeroCreditNote` sent, and the one refund debt (R05) it answers. */
export interface RefundNotePlanInput {
  /** The lines it built (`buildRefundDocumentDescription`'s wording), or a replay's stored `creditNotes[0].lineItems`. */
  lines: LineItem[];
  /** `creditNoteIdempotencyKey`, or a replay's recorded key. */
  legacyKey: string;
  source: "BUILT" | "STORED_REQUEST";
  /**
   * The line-amount basis the note was sent with (#4632): the booking's tax
   * rendering for a note this run built, the stored request's own for a
   * replay (null when the request holds none). Frozen, never translated.
   */
  lineAmountTypes: LineAmountTypes | string | null;
  /** The live REFUND_PAYABLE obligation: its key and face, or why none could be named. */
  obligation: RefundExportComponent | RefundExportProblem;
}

/**
 * A document's lines as a rendering: their hash, codes and total, under the key
 * and the line-amount basis they were sent with (#4632: frozen, never
 * translated; line codes through `frozenLineCodes`, as every planner does).
 */
function linesRendering(
  lines: LineItem[],
  legacyKey: string,
  source: "BUILT" | "STORED_REQUEST",
  lineAmountTypes: LineAmountTypes | string | null,
): RefundExportRendering {
  return {
    legacyKey,
    payloadHash: refundExportPayloadHash(lines),
    frozenMapping: { source, lineAmountTypes, lineCodes: frozenLineCodes(lines) },
    lineTotalCents: invoiceLineItemsTotalCents(lines),
  };
}

/** Plan the refund credit note: its lines cover the whole live refund debt, or a conflict. */
export function planRefundNote(input: RefundNotePlanInput): RefundExportPlan {
  return coverRefundExportComponent({
    rendering: linesRendering(input.lines, input.legacyKey, input.source, input.lineAmountTypes),
    component: input.obligation,
    allowedAccounts: ["REFUND_PAYABLE"],
  });
}

/** What `createXeroCardRefundReversalInvoice` sent, and the one R13 it answers. */
export interface FailedLaterRefundReversalPlanInput {
  /** The one line it built (`hutFeeRefundLine`), or a replay's stored `invoices[0].lineItems`. */
  lines: LineItem[];
  /** `cardRefundReversalInvoiceKey(paymentId, closeTaskId)`. */
  legacyKey: string;
  source: "BUILT" | "STORED_REQUEST";
  /**
   * The line-amount basis the invoice was sent with (#4632): the booking's tax
   * rendering the sender built it under, or a replay's stored request's own
   * (null when the request holds none). Frozen, never translated.
   */
  lineAmountTypes: LineAmountTypes | string | null;
  /** The R13 that reversed the failed refund's R12 (`reversal:<journalId>`, Dr STRIPE_CLEARING), or why none could be named. */
  reversal: RefundExportComponent | RefundExportProblem;
}

/**
 * Plan the failed-later refund reversal invoice (design section 7). It covers
 * its R13's Stripe-clearing debit whole, or nothing: an invoice for less than
 * the failed refund (a close that paid back only part, or found the card note's
 * excess smaller) is a `CENTS` conflict, never a part cover.
 */
export function planFailedLaterRefundReversal(input: FailedLaterRefundReversalPlanInput): RefundExportPlan {
  return coverRefundExportComponent({
    rendering: linesRendering(input.lines, input.legacyKey, input.source, input.lineAmountTypes),
    component: input.reversal,
    allowedAccounts: ["STRIPE_CLEARING"],
  });
}
