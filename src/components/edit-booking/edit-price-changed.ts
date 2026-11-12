import type { ClubFormat } from "@/lib/club-format";
import type { EditQuotedFigures } from "@/lib/booking-modify-quote-request";
import { EDIT_PRICE_CHANGED_CODE } from "@/lib/edit-quoted-figures";
import { formatCents } from "@/lib/utils";

/**
 * #4924 (`INV-MOD-062`): the save's fresh figures from a 409
 * `EDIT_PRICE_CHANGED` body, or null when the body is any other refusal.
 */
export function readEditPriceChangedFigures(data: unknown): EditQuotedFigures | null {
  if (!data || typeof data !== "object") return null;
  const record = data as { code?: unknown; figures?: unknown };
  if (record.code !== EDIT_PRICE_CHANGED_CODE) return null;
  const figures = record.figures as Partial<Record<keyof EditQuotedFigures, unknown>> | null;
  if (
    !figures ||
    typeof figures.newFinalPriceCents !== "number" ||
    typeof figures.priceDiffCents !== "number" ||
    typeof figures.changeFeeCents !== "number" ||
    typeof figures.netChargeCents !== "number"
  ) {
    return null;
  }
  return {
    newFinalPriceCents: figures.newFinalPriceCents,
    priceDiffCents: figures.priceDiffCents,
    changeFeeCents: figures.changeFeeCents,
    netChargeCents: figures.netChargeCents,
  };
}

function describeNetCharge(cents: number, format: ClubFormat): string {
  if (cents > 0) return `an extra charge of ${formatCents(cents, format)}`;
  if (cents < 0) return `a reduction of ${formatCents(-cents, format)}`;
  return "no extra charge or reduction";
}

/**
 * The sentence the panel shows when the save refused because the price moved
 * since the preview: the figure the member approved and what it is now. The
 * amount owed or returned leads, because that is the money that moves; the
 * change fee and the new total are named only when the net is unchanged.
 */
export function editPriceChangedMessage(
  previewed: EditQuotedFigures | null | undefined,
  fresh: EditQuotedFigures,
  format: ClubFormat,
): string {
  const lead = "The price changed since you previewed it";
  const tail = "Review the new figures and save again.";
  let change: string | null = null;
  if (previewed && previewed.netChargeCents !== fresh.netChargeCents) {
    change = `${describeNetCharge(previewed.netChargeCents, format)} is now ${describeNetCharge(fresh.netChargeCents, format)}`;
  } else if (previewed && previewed.changeFeeCents !== fresh.changeFeeCents) {
    change = `the change fee of ${formatCents(previewed.changeFeeCents, format)} is now ${formatCents(fresh.changeFeeCents, format)}`;
  } else if (previewed && previewed.newFinalPriceCents !== fresh.newFinalPriceCents) {
    change = `the new total of ${formatCents(previewed.newFinalPriceCents, format)} is now ${formatCents(fresh.newFinalPriceCents, format)}`;
  }
  return change ? `${lead}: ${change}. ${tail}` : `${lead}. ${tail}`;
}
