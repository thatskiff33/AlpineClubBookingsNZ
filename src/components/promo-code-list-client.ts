"use client";

import { useEffect, useMemo, useState } from "react";
import type { PromoResult } from "@/components/promo-code-input";
import { bookingFinalPriceCents } from "@/lib/booking-final-price";

/**
 * The client half of several promo codes on one booking (#3492, epic #3813 C4):
 * the guest-code chips' lookup, the several-code preview, and the totals and
 * request fields every booking surface derives from an ordered code list. The
 * component that draws it is `promo-code-list.tsx`; the server rules it asks are
 * `promo-guest-codes.ts` (who may be offered) and `promo-codes-preview.ts`
 * (what the codes are worth, in the booker's order).
 */

/** One guest's offerable codes, as `POST /api/promo-codes/guest-codes` answers. */
export type GuestPromoCodeGroupResponse = {
  guestRef: string;
  codes: Array<{ code: string; benefit: string }>;
};

/** What the lookup is asked about: a booking that exists, or a party before it does. */
export type GuestPromoCodeQuery =
  | { bookingId: string }
  | { lodgeId: string; guestMemberIds: string[]; forMemberId?: string };

export type GuestPromoCodesState = {
  /** The club's `multiPromoCodes` switch; null until the lookup answers. */
  multiPromoCodes: boolean | null;
  groups: GuestPromoCodeGroupResponse[];
};

/**
 * Ask which guest members' codes may be offered, once per distinct query. A
 * failed or refused lookup offers no guest chips and leaves the switch unknown
 * (null), which every surface reads as "one code", the safe direction.
 */
export function useGuestPromoCodes(query: GuestPromoCodeQuery | null): GuestPromoCodesState {
  const key = query ? JSON.stringify(query) : null;
  const [state, setState] = useState<{ key: string | null; value: GuestPromoCodesState }>({
    key: null,
    value: { multiPromoCodes: null, groups: [] },
  });
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    fetch("/api/promo-codes/guest-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: key,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        setState({
          key,
          value: {
            multiPromoCodes: typeof data?.multiPromoCodes === "boolean" ? data.multiPromoCodes : null,
            groups: Array.isArray(data?.guests) ? data.guests : [],
          },
        });
      })
      .catch(() => {
        if (!cancelled) setState({ key, value: { multiPromoCodes: null, groups: [] } });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return useMemo(
    () => (state.key === key ? state.value : { multiPromoCodes: null, groups: [] }),
    [state, key],
  );
}

/** One entry of the list the booker asks for, in their order. */
export type PromoCodeListEntry = { code: string; promoGuestIndexes?: number[] };

/** The list a set of applied codes stands for, with only the booker's own guest choices. */
export function promoCodeListEntries(applied: readonly PromoResult[]): PromoCodeListEntry[] {
  return applied
    .filter((promo) => promo.code && !promo.workPartyEvent)
    .map((promo) => ({
      code: promo.code!,
      ...(promo.promoGuestIndexes?.length ? { promoGuestIndexes: promo.promoGuestIndexes } : {}),
    }));
}

/** The booking's signed promo adjustment across every applied code (or working bee). */
export function appliedPromosAdjustmentCents(applied: readonly PromoResult[]): number {
  return applied.reduce((sum, promo) => sum + promo.promoAdjustmentCents, 0);
}

/** The price after every applied code, through the one final-price relation. */
export function appliedPromosFinalPriceCents(
  totalPriceCents: number,
  applied: readonly PromoResult[],
): number {
  return bookingFinalPriceCents({
    totalPriceCents,
    promoAdjustmentCents: appliedPromosAdjustmentCents(applied),
  });
}

/**
 * The create request's promo fields. ONE code travels as the legacy
 * `promoCode` / `promoGuestIndexes`, byte-identical to what a single-code booking
 * has always sent; SEVERAL travel as `promoCodes`, in the booker's order. The
 * create route refuses both at once (#3827), so the legacy field carries the
 * first code only when it is the only one.
 */
export function createRequestPromoFields(applied: readonly PromoResult[]): {
  promoCode?: string;
  promoGuestIndexes?: number[];
  promoCodes?: PromoCodeListEntry[];
} {
  const codes = applied.filter((promo) => promo.code && !promo.workPartyEvent);
  if (codes.length === 0) return {};
  if (codes.length === 1) {
    return { promoCode: codes[0]!.code!, promoGuestIndexes: codes[0]!.selectedGuestIndexes };
  }
  return { promoCodes: promoCodeListEntries(codes) };
}

export type PromoListValidation =
  | { ok: true; applied: PromoResult[] }
  | {
      ok: false;
      error: string;
      /** Set when the newest code asks the booker which guests it is for. */
      guestSelection?: { code: string; selectableGuestIndexes: number[] };
    };

type PreviewGuest = {
  ageTier: string;
  isMember: boolean;
  memberId?: string;
  stayStart?: string;
  stayEnd?: string;
};

type PerCodePreview = {
  code: string;
  valid: boolean;
  error?: string;
  requiresGuestSelection?: boolean;
  selectableGuestIndexes?: number[];
  description?: string | null;
  type?: string;
  discountCents?: number;
  promoAdjustmentCents?: number;
  selectedGuestIndexes?: number[];
};

/**
 * Price an ordered code list through `/api/promo-codes/validate`'s several-code
 * preview (#3827) — the orchestrator the save runs, so each code's amount is
 * what it will be in this order. The whole list is accepted or refused together;
 * a refusal names the first code that failed.
 */
export async function validatePromoCodeList(params: {
  entries: readonly PromoCodeListEntry[];
  /** Labels carried onto each applied code, by code (e.g. "applies to Sam only"). */
  appliesTo?: ReadonlyMap<string, string>;
  checkIn: string;
  checkOut: string;
  guests: readonly PreviewGuest[];
  lodgeId?: string | null;
  forMemberId?: string;
  forBookingEdit?: boolean;
}): Promise<PromoListValidation> {
  let data: {
    valid?: boolean;
    error?: string;
    codes?: PerCodePreview[];
    totalPriceCents?: number;
    finalPriceCents?: number;
  };
  try {
    const res = await fetch("/api/promo-codes/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codes: params.entries,
        checkIn: params.checkIn,
        checkOut: params.checkOut,
        guests: params.guests.map((guest) => ({
          ageTier: guest.ageTier,
          isMember: guest.isMember,
          ...(guest.memberId ? { memberId: guest.memberId } : {}),
          ...(guest.stayStart ? { stayStart: guest.stayStart } : {}),
          ...(guest.stayEnd ? { stayEnd: guest.stayEnd } : {}),
        })),
        ...(params.forMemberId ? { forMemberId: params.forMemberId } : {}),
        ...(params.lodgeId ? { lodgeId: params.lodgeId } : {}),
        ...(params.forBookingEdit ? { forBookingEdit: true } : {}),
      }),
    });
    data = await res.json();
  } catch {
    return { ok: false, error: "Failed to validate promo code" };
  }
  const perCode = Array.isArray(data.codes) ? data.codes : [];
  const byCode = new Map(perCode.map((entry) => [entry.code, entry]));
  const newest = params.entries[params.entries.length - 1]?.code.toUpperCase().trim();
  for (const entry of params.entries) {
    const answer = byCode.get(entry.code.toUpperCase().trim());
    if (answer && !answer.valid) {
      if (answer.requiresGuestSelection && answer.code === newest) {
        return {
          ok: false,
          error: answer.error ?? "Choose which guests should receive this promo code",
          guestSelection: { code: answer.code, selectableGuestIndexes: answer.selectableGuestIndexes ?? [] },
        };
      }
      return { ok: false, error: `${answer.code}: ${answer.error ?? "Promo code could not be applied"}` };
    }
  }
  if (data.valid !== true || perCode.length !== params.entries.length) {
    return { ok: false, error: data.error ?? "Promo code could not be applied" };
  }
  return {
    ok: true,
    applied: params.entries.map((entry) => {
      const answer = byCode.get(entry.code.toUpperCase().trim())!;
      return {
        code: answer.code,
        description: answer.description ?? null,
        type: answer.type ?? "",
        discountCents: answer.discountCents ?? 0,
        promoAdjustmentCents: answer.promoAdjustmentCents ?? 0,
        totalPriceCents: data.totalPriceCents ?? 0,
        finalPriceCents: data.finalPriceCents ?? 0,
        selectedGuestIndexes: answer.selectedGuestIndexes,
        ...(entry.promoGuestIndexes ? { promoGuestIndexes: entry.promoGuestIndexes } : {}),
        ...(params.appliesTo?.get(answer.code) ? { appliesTo: params.appliesTo.get(answer.code) } : {}),
      };
    }),
  };
}
