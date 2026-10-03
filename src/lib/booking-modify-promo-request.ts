import type { BatchModifyInput } from "@/lib/booking-modify-validation";

// #3827: how an edit's request names the promo codes the booking should carry
// — one reader of the plural `promoCodes` and the legacy `promoCode` /
// `removePromoCode`, shared by the save, the preview and the predicates that
// ask whether a request changes codes at all. Pure; no Prisma.

/** One entry of the code list an edit asks the booking to carry (#3827). */
export type RequestedPromoCode = {
  code: string;
  promoGuestIds?: string[];
  promoAddedGuestIndexes?: number[];
  /** Apply fresh even when the booking already carries this code. */
  reapply: boolean;
};

/**
 * The codes an edit asks the booking to carry afterwards, in order — or `null`
 * when it says nothing about codes and every code the booking has is simply
 * re-priced. THE ONE READING of the three request shapes (#3827): the plural
 * `promoCodes`; the legacy `removePromoCode` (none); and the legacy single
 * `promoCode`, which has always meant "replace the booking's code with this
 * one, applied fresh".
 */
export type PromoCodeRequestFields = Pick<
  BatchModifyInput,
  "promoCode" | "promoGuestIds" | "promoAddedGuestIndexes" | "removePromoCode" | "promoCodes"
>;

export function requestedPromoCodeList(input: PromoCodeRequestFields): RequestedPromoCode[] | null {
  if (input.promoCodes) {
    return input.promoCodes.map((entry) => ({
      code: entry.code.toUpperCase().trim(),
      ...(entry.promoGuestIds ? { promoGuestIds: entry.promoGuestIds } : {}),
      ...(entry.promoAddedGuestIndexes
        ? { promoAddedGuestIndexes: entry.promoAddedGuestIndexes }
        : {}),
      reapply: Boolean(entry.promoGuestIds?.length || entry.promoAddedGuestIndexes?.length),
    }));
  }
  if (input.removePromoCode) return [];
  if (input.promoCode) {
    return [
      {
        code: input.promoCode.toUpperCase().trim(),
        ...(input.promoGuestIds ? { promoGuestIds: input.promoGuestIds } : {}),
        ...(input.promoAddedGuestIndexes
          ? { promoAddedGuestIndexes: input.promoAddedGuestIndexes }
          : {}),
        reapply: true,
      },
    ];
  }
  return null;
}

/**
 * The code list an edit asks for, read against the codes the booking already
 * carries (#3827). The plural `promoCodes` is the BOOKER's list, and a
 * working-bee discount is not the booker's code — the system applied it, and
 * the booker cannot type it — so a stored internal code the list leaves out is
 * carried, first, rather than silently dropped. The legacy fields keep their
 * meaning exactly (they replace or remove whatever the booking carries).
 */
export function requestedPromoCodeListFor(
  input: PromoCodeRequestFields,
  stored: ReadonlyArray<{ code: string; internal: boolean }>,
): RequestedPromoCode[] | null {
  const requested = requestedPromoCodeList(input);
  if (requested === null || !input.promoCodes) return requested;
  const listed = new Set(requested.map((entry) => entry.code));
  const carried = stored
    .filter((code) => code.internal && !listed.has(code.code))
    .map((code) => ({ code: code.code, reapply: false }));
  return [...carried, ...requested];
}

/** Does this edit ask for any promo-code change at all? */
export function requestChangesPromoCodes(input: PromoCodeRequestFields): boolean {
  return requestedPromoCodeList(input) !== null;
}

/**
 * The promo change an edit asked for, as `describePromoChangeNotApplied` names
 * it when the change is dropped (#3179): the codes asked for, joined in order,
 * or a removal. Read through `requestedPromoCodeList`, so the plural and the
 * legacy fields cannot be described two ways (#3827).
 */
export function requestedPromoCodeChange(input: PromoCodeRequestFields): {
  requestedPromoCode: string | undefined;
  removePromoCodeRequested: boolean;
} {
  const list = requestedPromoCodeList(input);
  return {
    requestedPromoCode: list && list.length > 0 ? list.map((entry) => entry.code).join(", ") : undefined,
    removePromoCodeRequested: list !== null && list.length === 0,
  };
}
