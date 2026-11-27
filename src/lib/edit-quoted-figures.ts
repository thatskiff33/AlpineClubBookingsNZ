import { z } from "zod";

import type { HostingCoverageLinkedMoveChoice } from "@/lib/hosting-coverage-linked-move-client";

/**
 * #4924, #5238 (`INV-MOD-062`): an edit settles only the figures the member was shown.
 *
 * The preview (`POST /api/bookings/[id]/modify-quote`) returns `quotedFigures`,
 * the panel sends them back unchanged on Save, and the save compares them with
 * its own figures on the post-lock re-read, before anything leaves the
 * transaction (an earlier in-transaction write rolls back with it). Any
 * difference — the club day crossed a change-fee band, a rate or promo moved,
 * or the two pricing paths drifted — refuses the save with the fresh figures,
 * so the member re-previews instead of being settled an amount they never saw.
 * A linked move (#3232) binds every booking it moves the same way: its offer
 * carries each booking's figures and the acceptance echoes them.
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

/**
 * #5238: the figures a linked-move offer showed for each OTHER booking it moves,
 * echoed on `MOVE_BOTH` beside the primary's own `quotedFigures`. Keyed by
 * booking so a re-ordered or re-shaped stranded set cannot pair one booking's
 * figures with another's.
 */
const linkedQuotedFiguresSchema = z
  .array(z.object({ bookingId: z.string().min(1), figures: editQuotedFiguresSchema }).strict())
  .max(100);

export type LinkedQuotedFigures = z.infer<typeof linkedQuotedFiguresSchema>;

/**
 * The figure fields of a save request, one definition for both edit doors'
 * schemas. Optional in the shape so a save without them gets the reload
 * refusal (`requireEditQuotedFigures`), not a schema 400.
 */
export const editSaveFiguresShape = {
  quotedFigures: editQuotedFiguresSchema.optional(),
  linkedQuotedFigures: linkedQuotedFiguresSchema.optional(),
};

export const EDIT_PRICE_CHANGED_CODE = "EDIT_PRICE_CHANGED";
const EDIT_FIGURES_REQUIRED_CODE = "EDIT_FIGURES_REQUIRED";

export class EditPriceChangedError extends Error {
  readonly code = EDIT_PRICE_CHANGED_CODE;
  readonly status = 409;

  /**
   * `linkedMove` is the fresh linked-move offer body (#5238), present only when
   * an accepted linked move refused: the member re-answers the new offer, which
   * carries every booking's figures keyed by booking. `figures` are then those
   * of whichever booking refused first, kept for the body's shape only.
   */
  constructor(
    public readonly figures: EditQuotedFigures,
    public readonly linkedMove?: Record<string, unknown>,
  ) {
    super("The price changed since you previewed it. Review and save again.");
    this.name = "EditPriceChangedError";
  }
}

/**
 * #5238 (owner decision, 20 Nov 2026): a save at an HTTP edit door that carries
 * no figures is refused rather than re-priced. Only an out-of-date page or a
 * script sends none; every in-repo caller previews first.
 */
export class EditFiguresRequiredError extends Error {
  readonly code = EDIT_FIGURES_REQUIRED_CODE;
  readonly status = 409;

  constructor() {
    super("This page is out of date. Reload it, check the price and save again.");
    this.name = "EditFiguresRequiredError";
  }
}

/**
 * The wire answer for either figures refusal, or null for any other error. One
 * reader for both edit doors, tested ahead of their generic `ApiError` branch.
 */
export function editQuotedFiguresRefusal(
  error: unknown,
): { body: Record<string, unknown>; status: number } | null {
  if (error instanceof EditPriceChangedError) {
    const body = {
      code: error.code,
      error: error.message,
      figures: error.figures,
      ...(error.linkedMove ? { linkedMove: error.linkedMove } : {}),
    };
    return { body, status: error.status };
  }
  if (error instanceof EditFiguresRequiredError) {
    return { body: { code: error.code, error: error.message }, status: error.status };
  }
  return null;
}

/** The figures of an edit that moves no money: a date shift, or no change at all. */
export function unchangedPriceQuotedFigures(finalPriceCents: number): EditQuotedFigures {
  return { newFinalPriceCents: finalPriceCents, priceDiffCents: 0, changeFeeCents: 0, netChargeCents: 0 };
}

/**
 * The HTTP doors' rule (#5238): every save carries the figures its preview
 * showed, and accepting a linked move carries every other booking's too.
 * Throws `EditFiguresRequiredError` before any service runs. Officer callers
 * with no preview (exception approval, change-request execution) call the
 * services directly and never reach this.
 */
export function requireEditQuotedFigures(request: {
  quotedFigures?: EditQuotedFigures;
  linkedQuotedFigures?: LinkedQuotedFigures;
  hostingCoverageLinkedMove?: { choice: HostingCoverageLinkedMoveChoice };
}): void {
  if (!request.quotedFigures) throw new EditFiguresRequiredError();
  if (
    request.hostingCoverageLinkedMove?.choice === "MOVE_BOTH" &&
    !request.linkedQuotedFigures
  ) {
    throw new EditFiguresRequiredError();
  }
}

// Read off the schema, so a figure added to it is compared without a second list.
const QUOTED_FIGURE_KEYS = editQuotedFiguresSchema.keyof().options;

/**
 * Throws `EditPriceChangedError` carrying `fresh` when any figure differs.
 *
 * `quoted` absent means a caller with no preview to honour: an officer's
 * approval or change-request execution, or a quote-mode probe. The HTTP doors
 * never pass it absent (`requireEditQuotedFigures`). `netChargeCents` is
 * `priceDiffCents + changeFeeCents` BEFORE the unpaid-ask offset, which is what
 * the preview reports under that name.
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
