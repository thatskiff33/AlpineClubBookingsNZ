import type { BatchModifyInput } from "@/lib/booking-modify-validation";
import { normalizePromoCodeInput } from "@/lib/promo-code-list-rules";

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
      code: normalizePromoCodeInput(entry.code),
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
        code: normalizePromoCodeInput(input.promoCode),
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
 * carries (#3827). Every request shape — the plural `promoCodes` and the legacy
 * `promoCode` / `removePromoCode` alike — names the BOOKER's codes, and a
 * working-bee discount is not the booker's code: the system applied it, and the
 * booker cannot type it. So a stored internal code the list leaves out is
 * carried, first, rather than silently dropped (D-3813-3). The legacy fields
 * otherwise keep their meaning: they replace or remove the booker's code.
 */
export function requestedPromoCodeListFor(
  input: PromoCodeRequestFields,
  stored: ReadonlyArray<{ code: string; internal: boolean }>,
): RequestedPromoCode[] | null {
  const requested = requestedPromoCodeList(input);
  if (requested === null) return requested;
  const listed = new Set(requested.map((entry) => entry.code));
  const carried = stored
    .filter((code) => code.internal && !listed.has(code.code))
    .map((code) => ({ code: code.code, reapply: false }));
  return [...carried, ...requested];
}

/**
 * The stored redemption an entry KEEPS — re-priced in place, never released and
 * re-applied — or undefined when the entry applies its code fresh. One answer
 * for the save and the preview (#3827).
 */
export function keptStoredPromoRedemption<R>(
  entry: Pick<RequestedPromoCode, "code" | "reapply">,
  storedByCode: ReadonlyMap<string, R>,
): R | undefined {
  return entry.reapply ? undefined : storedByCode.get(entry.code);
}

/**
 * A requested list as `promoCodeListRefusal` reads it: the booker's own codes,
 * and whether a stored working-bee (internal) code rides beside them.
 */
export function splitRequestedPromoCodes(
  requested: readonly Pick<RequestedPromoCode, "code">[],
  stored: ReadonlyArray<{ promoCode: { code: string; internal: boolean } }>,
): { typedCodes: string[]; workPartyApplied: boolean } {
  const internal = new Set(
    stored.filter((redemption) => redemption.promoCode.internal).map((redemption) => redemption.promoCode.code),
  );
  return {
    typedCodes: requested.filter((entry) => !internal.has(entry.code)).map((entry) => entry.code),
    workPartyApplied: requested.some((entry) => internal.has(entry.code)),
  };
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
