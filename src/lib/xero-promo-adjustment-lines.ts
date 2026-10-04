/**
 * THE PROMOTION LINES ON A BOOKING'S XERO INVOICE (#3828, epic #3813 C3;
 * `INV-MONEY-039`).
 *
 * A booking may carry several promo codes (#3492, D-3813-1), and the treasurer
 * reconciles each code's discount on its own coded line. So a booking invoice
 * — the per-booking invoice and each child of a combined group invoice — carries
 * ONE `Promo adjustment - CODE` line per code whose adjustment is not zero, in
 * the booker's order (`bookingPromoRedemptions`), each coded by
 * `resolvePromoLineCodes` for its own code, at that code's own recorded
 * build-up (`INV-MONEY-029`).
 *
 * THE FALLBACK. A code's figure is taken from its recorded rows only when those
 * rows reconcile to that redemption (`deriveNightAdjustmentState` over the one
 * redemption — the same check the writer enforces per redemption), and the
 * per-code lines are used only when they add up to the aggregate the invoice
 * bills. Otherwise the invoice carries today's single aggregate line, naming
 * every code, at the generic promotion coding, and the caller records the
 * classified fallback on its sync operation (`promoAdjustmentLineRecord`). A
 * wrong split is worse than an honest aggregate: the invoice's total never
 * depends on the split.
 *
 * A BOOKING WITH ONE CODE (or none) is not split at all: it takes the
 * `ONE_CODE` arm, which is the line this invoice always carried — the same
 * description, `taxType`, quantity 1, signed unit amount and code precedence —
 * and records nothing, so its invoice and its operation payload are
 * byte-identical to before #3828.
 *
 * Pure: no database, no provider. The caller loads the redemptions, their
 * allocations and the adjustment rows in the same query as the invoice.
 */
import type { LineItem } from "xero-node";

import {
  bookingPromoCodeLabel,
  bookingPromoRedemptions,
} from "@/lib/booking-promo-redemptions";
import {
  combinedPromoRedemptionEvidence,
  deriveNightAdjustmentState,
} from "@/lib/night-adjustment-write";
import {
  applyHutFeeLineCodes,
  resolvePromoLineCodes,
} from "@/lib/xero-hut-fee-line-codes";

/** A promo code as an invoice line names and codes it. */
export type PromoLineCode = {
  code: string;
  xeroItemCode?: string | null;
  xeroAccountCode?: string | null;
};

/** One redemption, as the invoice query loads it. */
export type PromoLineRedemption = {
  id?: string | null;
  applicationOrder?: number | null;
  priceAdjustmentCents?: number | null;
  allocations?: ReadonlyArray<{ memberId: string | null; priceAdjustmentCents: number }> | null;
  promoCode?: PromoLineCode | null;
};

/** One recorded adjustment row (`BookingGuestNightAdjustment`). */
export type PromoLineAdjustmentRow = {
  promoRedemptionId?: string | null;
  beneficiaryMemberId: string;
  amountCents: number | null;
};

export type PromoLineFallbackReason =
  /** A code's rows are missing, unknown, or do not reconcile to its redemption. */
  | "CODE_BUILDUP_NOT_KNOWN"
  /** Every code is known, but together they are not the aggregate billed. */
  | "CODE_LINES_DO_NOT_SUM";

export type PromoAdjustmentLinePlan =
  | { kind: "ONE_CODE"; promo: PromoLineCode | null; amountCents: number }
  | {
      kind: "PER_CODE";
      amountCents: number;
      codes: Array<{ promo: PromoLineCode | null; amountCents: number }>;
    }
  | {
      kind: "AGGREGATE_FALLBACK";
      reason: PromoLineFallbackReason;
      amountCents: number;
      label: string | null;
      /** Each code's own figure where it was known, in order; null where not. */
      codes: Array<{ promo: PromoLineCode | null; amountCents: number | null }>;
    };

/**
 * Decide the promotion lines for one booking. `aggregateCents` is the signed
 * figure the invoice bills for the promotion (the booking's selected build-up
 * on a per-booking invoice, the child's `promoAdjustmentCents` on a group
 * invoice); the plan's lines always add up to exactly it.
 */
export function planPromoAdjustmentLines(args: {
  aggregateCents: number;
  redemptions: ReadonlyArray<PromoLineRedemption> | null | undefined;
  adjustmentRows: ReadonlyArray<PromoLineAdjustmentRow> | null | undefined;
}): PromoAdjustmentLinePlan {
  const ordered = bookingPromoRedemptions({ promoRedemptions: args.redemptions ?? [] });
  if (ordered.length <= 1) {
    return {
      kind: "ONE_CODE",
      promo: ordered[0]?.promoCode ?? null,
      amountCents: args.aggregateCents,
    };
  }

  const rows = args.adjustmentRows ?? [];
  const codes = ordered.map((redemption) => {
    const own = redemption.id
      ? rows.filter((row) => row.promoRedemptionId === redemption.id)
      : [];
    const state = deriveNightAdjustmentState({
      rows: own,
      redemption: combinedPromoRedemptionEvidence([
        {
          priceAdjustmentCents: redemption.priceAdjustmentCents ?? 0,
          allocations: redemption.allocations ?? [],
        },
      ]),
    });
    // KNOWN means every row has an amount and they reconcile to the
    // redemption; a redemption with no id cannot be matched to its rows and
    // is never treated as known.
    const amountCents =
      redemption.id && typeof redemption.priceAdjustmentCents === "number" && state === "KNOWN"
        ? own.reduce((sum, row) => sum + (row.amountCents as number), 0)
        : null;
    return { promo: redemption.promoCode ?? null, amountCents };
  });

  const fallback = (reason: PromoLineFallbackReason): PromoAdjustmentLinePlan => ({
    kind: "AGGREGATE_FALLBACK",
    reason,
    amountCents: args.aggregateCents,
    label: bookingPromoCodeLabel({ promoRedemptions: ordered }),
    codes,
  });

  if (codes.some((code) => code.amountCents === null)) {
    return fallback("CODE_BUILDUP_NOT_KNOWN");
  }
  const known = codes as Array<{ promo: PromoLineCode | null; amountCents: number }>;
  if (known.reduce((sum, code) => sum + code.amountCents, 0) !== args.aggregateCents) {
    return fallback("CODE_LINES_DO_NOT_SUM");
  }
  return {
    kind: "PER_CODE",
    amountCents: args.aggregateCents,
    codes: known,
  };
}

const PROMO_ADJUSTMENT_LINE_PHRASE = "Promo adjustment";

/** The line's words: `Promo adjustment - CODE`, or the bare phrase with no code. */
export function promoAdjustmentLineDescription(code: string | null | undefined): string {
  return code ? `${PROMO_ADJUSTMENT_LINE_PHRASE} - ${code}` : PROMO_ADJUSTMENT_LINE_PHRASE;
}

/**
 * Is this an invoice line `promoAdjustmentLineDescription` wrote — the bare
 * phrase or `Promo adjustment - CODE`, any case, trimmed? The reader of the
 * words, beside their one writer.
 */
export function isPromoAdjustmentLineDescription(description: string | null | undefined): boolean {
  const normalized = (description ?? "").trim().toLowerCase();
  const phrase = PROMO_ADJUSTMENT_LINE_PHRASE.toLowerCase();
  return normalized === phrase || normalized.startsWith(`${phrase} -`);
}

/**
 * Render a plan as Xero line items. The codes each line takes are
 * `resolvePromoLineCodes` for that line's own code; the aggregate fallback
 * takes the generic promotion coding, because no one code owns its figure.
 */
export function promoAdjustmentLineItems(
  plan: PromoAdjustmentLinePlan,
  coding: Omit<Parameters<typeof resolvePromoLineCodes>[0], "promo">,
): LineItem[] {
  const line = (
    description: string,
    promo: PromoLineCode | null,
    amountCents: number,
  ): LineItem =>
    applyHutFeeLineCodes(
      {
        description,
        quantity: 1,
        unitAmount: amountCents / 100,
        taxType: "OUTPUT2",
      },
      resolvePromoLineCodes({ ...coding, promo }),
    );

  switch (plan.kind) {
    case "ONE_CODE":
      return plan.amountCents === 0
        ? []
        : [line(promoAdjustmentLineDescription(plan.promo?.code), plan.promo, plan.amountCents)];
    case "PER_CODE":
      // A code that took nothing off this booking is no line.
      return plan.codes
        .filter((code) => code.amountCents !== 0)
        .map((code) =>
          line(promoAdjustmentLineDescription(code.promo?.code), code.promo, code.amountCents),
        );
    case "AGGREGATE_FALLBACK":
      return plan.amountCents === 0
        ? []
        : [line(promoAdjustmentLineDescription(plan.label), null, plan.amountCents)];
  }
}

/** What a sync operation records about a several-code split (`INV-MONEY-039`). */
export type PromoAdjustmentLineRecord = {
  promoLineSource: "PER_CODE" | "AGGREGATE_FALLBACK";
  promoLineReason: PromoLineFallbackReason | null;
  promoLineAggregateCents: number;
  promoLineCodes: Array<{ code: string | null; amountCents: number | null }>;
};

/**
 * The record a sync operation carries beside a several-code invoice — `null`
 * for one code or none, whose payload therefore stays exactly as it was.
 */
export function promoAdjustmentLineRecord(
  plan: PromoAdjustmentLinePlan,
): PromoAdjustmentLineRecord | null {
  if (plan.kind === "ONE_CODE") return null;
  return {
    promoLineSource: plan.kind,
    promoLineReason: plan.kind === "AGGREGATE_FALLBACK" ? plan.reason : null,
    promoLineAggregateCents: plan.amountCents,
    promoLineCodes: plan.codes.map((code) => ({
      code: code.promo?.code ?? null,
      amountCents: code.amountCents,
    })),
  };
}
