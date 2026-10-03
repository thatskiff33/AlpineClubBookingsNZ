/**
 * ONE PROMOTION-DELTA LINE PER CODE ON AN EDIT'S STORED LINES (#3828, epic
 * #3813 C3; `INV-MONEY-039`).
 *
 * A booking may carry several promo codes (#3492). An edit that moves more than
 * one of them stores one `PROMO_DELTA` line per code whose adjustment changed,
 * each naming its code, so the supplementary invoice or credit note the edit
 * raises codes each code's change to that code (`xero-modification-line-items.ts`).
 * The stored line's shape is unchanged — `v, kind, sign, promoCode,
 * amountCents` — so a reader that predates this accepts several lines as it
 * accepts one.
 *
 * Split only when BOTH sides state their codes' figures and at least one side
 * carries more than one code, and only when the per-code changes add up to the
 * aggregate change the lines must explain. Otherwise `null`, and the caller
 * writes the single aggregate line it always wrote — which is every one-code
 * booking, byte for byte.
 *
 * The home of an edit's promotion figures — the normalised side, the aggregate
 * change, and the per-code split. Pure; its own module because
 * `booking-modification-lines.ts` is at its size budget.
 */

/** A side's codes, in application order, each with its own signed adjustment. */
export type PromoSideCodes = ReadonlyArray<{ code: string; amountCents: number }>;

export function splitPromoDeltaByCode(
  before: { promoByCode?: PromoSideCodes | null },
  after: { promoByCode?: PromoSideCodes | null },
  aggregateDeltaCents: number,
): Array<{ promoCode: string; amountCents: number }> | null {
  const beforeCodes = before.promoByCode;
  const afterCodes = after.promoByCode;
  if (!beforeCodes || !afterCodes) return null;
  if (beforeCodes.length <= 1 && afterCodes.length <= 1) return null;

  const beforeByCode = new Map(beforeCodes.map((entry) => [entry.code, entry.amountCents]));
  const afterByCode = new Map(afterCodes.map((entry) => [entry.code, entry.amountCents]));
  // The codes the booking carries after the edit in their order, then any it
  // no longer carries in theirs.
  const codes = [
    ...afterCodes.map((entry) => entry.code),
    ...beforeCodes.map((entry) => entry.code).filter((code) => !afterByCode.has(code)),
  ];
  const deltas = codes
    .map((code) => ({
      promoCode: code,
      amountCents: (afterByCode.get(code) ?? 0) - (beforeByCode.get(code) ?? 0),
    }))
    .filter((delta) => delta.amountCents !== 0);
  const sum = deltas.reduce((total, delta) => total + delta.amountCents, 0);
  return sum === aggregateDeltaCents ? deltas : null;
}

/** A side as the promotion figures read it. */
type PromoSide = {
  promoAdjustmentCents: number;
  promoCode?: string | null;
  promoByCode?: PromoSideCodes | null;
};

/**
 * A side's promotion figure; a non-number (a legacy row read without the column)
 * counts as zero. Every caller's sum still holds against its real delta.
 */
export function normalisedPromoCents(promoAdjustmentCents: number): number {
  return Number.isFinite(promoAdjustmentCents) ? promoAdjustmentCents : 0;
}

/** The signed change in the promotion adjustment, each side normalised. */
export function modificationPromoDeltaCents(
  before: Pick<PromoSide, "promoAdjustmentCents">,
  after: Pick<PromoSide, "promoAdjustmentCents">,
): number {
  return normalisedPromoCents(after.promoAdjustmentCents) - normalisedPromoCents(before.promoAdjustmentCents);
}

/**
 * The promotion deltas an edit stores: one per code that moved where the split
 * holds, else the one aggregate delta naming the after side's codes (the
 * before side's when none remain) — or none when nothing moved.
 */
export function modificationPromoDeltas(
  before: PromoSide,
  after: PromoSide,
): Array<{ promoCode: string | null; amountCents: number }> {
  const deltaCents = modificationPromoDeltaCents(before, after);
  return (
    splitPromoDeltaByCode(before, after, deltaCents) ??
    (deltaCents !== 0
      ? [{ promoCode: after.promoCode ?? before.promoCode ?? null, amountCents: deltaCents }]
      : [])
  );
}
