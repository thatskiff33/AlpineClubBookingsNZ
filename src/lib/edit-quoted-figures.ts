import { z } from "zod";

/**
 * #4924 (`INV-MOD-062`): an edit settles only the figures the member was shown.
 *
 * The preview (`POST /api/bookings/[id]/modify-quote`) returns `quotedFigures`,
 * the panel sends them back unchanged on Save, and the save compares them with
 * its own figures on the post-lock re-read before its first write. Any
 * difference — the club day crossed a change-fee band, a rate or promo moved,
 * or the two pricing paths drifted — refuses the save with the fresh figures,
 * so the member re-previews instead of being settled an amount they never saw.
 * Integer cents; `netChargeCents` is before the unpaid-ask offset. No server
 * imports: the panel parses the refusal's figures with this same schema.
 */
export const editQuotedFiguresSchema = z.object({
  newFinalPriceCents: z.number().int(),
  priceDiffCents: z.number().int(),
  changeFeeCents: z.number().int(),
  netChargeCents: z.number().int(),
});

export type EditQuotedFigures = z.infer<typeof editQuotedFiguresSchema>;

export const EDIT_PRICE_CHANGED_CODE = "EDIT_PRICE_CHANGED";

export class EditPriceChangedError extends Error {
  readonly code = EDIT_PRICE_CHANGED_CODE;
  readonly status = 409;

  constructor(public readonly figures: EditQuotedFigures) {
    super("The price changed since you previewed it. Review and save again.");
    this.name = "EditPriceChangedError";
  }
}

export function editPriceChangedBody(error: EditPriceChangedError) {
  return { code: error.code, error: error.message, figures: error.figures };
}

/** The figures of an edit that moves no money: a date shift, or no change at all. */
export function unchangedPriceQuotedFigures(finalPriceCents: number): EditQuotedFigures {
  return { newFinalPriceCents: finalPriceCents, priceDiffCents: 0, changeFeeCents: 0, netChargeCents: 0 };
}

// Read off the schema, so a figure added to it is compared without a second list.
const QUOTED_FIGURE_KEYS = editQuotedFiguresSchema.keyof().options;

/**
 * Throws `EditPriceChangedError` carrying `fresh` when any figure differs.
 *
 * `quoted` absent is the temporary blue-green compatibility window: a panel
 * bundle from before #4924, or a script, sends none and saves as it always did.
 * `netChargeCents` is `priceDiffCents + changeFeeCents` BEFORE the unpaid-ask
 * offset, which is what the preview reports under that name.
 */
export function assertEditQuotedFigures(
  quoted: EditQuotedFigures | undefined,
  fresh: EditQuotedFigures,
): void {
  if (!quoted) return;
  if (QUOTED_FIGURE_KEYS.some((key) => quoted[key] !== fresh[key])) {
    throw new EditPriceChangedError(fresh);
  }
}
