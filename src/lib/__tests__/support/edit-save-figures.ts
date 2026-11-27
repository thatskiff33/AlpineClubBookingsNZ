import type { EditQuotedFigures } from "@/lib/edit-quoted-figures";

/**
 * #5238 (`INV-MOD-062`): every save at an edit door carries the figures its
 * preview showed, or is refused 409 `EDIT_FIGURES_REQUIRED`. Route tests whose
 * service is mocked pin something else, so their bodies carry these well-formed
 * figures; the comparison itself is pinned where the services run.
 */
export const SAVE_FIGURES: EditQuotedFigures = {
  newFinalPriceCents: 10_000,
  priceDiffCents: 0,
  changeFeeCents: 0,
  netChargeCents: 0,
};

/** The body as an up-to-date panel sends it: with figures, unless it set its own. */
export function withSaveFigures(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body) || "quotedFigures" in body) {
    return body;
  }
  return { ...body, quotedFigures: SAVE_FIGURES };
}
