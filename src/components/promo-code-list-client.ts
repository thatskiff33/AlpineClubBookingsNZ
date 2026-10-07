"use client";

import { useEffect, useMemo, useState } from "react";
import type { PromoResult } from "@/components/promo-code-input";
import { bookingFinalPriceCents } from "@/lib/booking-final-price";
import { normalizePromoCodeInput } from "@/lib/promo-code-list-rules";

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

/**
 * Where the lookup has got to. `loading` until it answers; `ready` once it has;
 * `rate-limited` (429) and `error` when it could not answer, which a surface
 * says out loud rather than reading as "no guest codes"; `unavailable` when the
 * promo-codes module is off (404), where there is nothing to say; `idle` when
 * there is nothing to ask yet.
 */
export type GuestPromoCodesStatus = "idle" | "loading" | "ready" | "rate-limited" | "error" | "unavailable";

export type GuestPromoCodesState = {
  /** The club's `multiPromoCodes` switch; null until the lookup answers. */
  multiPromoCodes: boolean | null;
  groups: GuestPromoCodeGroupResponse[];
  status: GuestPromoCodesStatus;
};

/** What a surface says when the lookup could not answer, or null when it did. */
export function guestPromoCodesProblem(status: GuestPromoCodesStatus): string | null {
  if (status === "rate-limited") {
    return "Too many requests. Your guests' promo codes can't be checked just now; please wait a few minutes and reload.";
  }
  if (status === "error") {
    return "We couldn't check your guests' promo codes just now. Please reload to try again.";
  }
  return null;
}

function unanswered(status: GuestPromoCodesStatus): GuestPromoCodesState {
  return { multiPromoCodes: null, groups: [], status };
}

/**
 * Ask which guest members' codes may be offered, once per distinct query. A
 * failed or refused lookup offers no guest chips and leaves the switch unknown
 * (null), which every surface reads as "one code", the safe direction — and
 * says why through `status`, so a surface never presents "couldn't ask" as
 * "nothing to offer".
 */
export function useGuestPromoCodes(query: GuestPromoCodeQuery | null): GuestPromoCodesState {
  const key = query ? JSON.stringify(query) : null;
  const [state, setState] = useState<{ key: string | null; value: GuestPromoCodesState }>({
    key: null,
    value: unanswered("idle"),
  });
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    fetch("/api/promo-codes/guest-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: key,
    })
      .then(async (res) => {
        if (res.status === 429) return unanswered("rate-limited");
        if (res.status === 404) return unanswered("unavailable");
        if (!res.ok) return unanswered("error");
        const data = await res.json();
        return {
          multiPromoCodes: typeof data?.multiPromoCodes === "boolean" ? data.multiPromoCodes : null,
          groups: Array.isArray(data?.guests) ? data.guests : [],
          status: "ready" as const,
        };
      })
      .catch(() => unanswered("error"))
      .then((value) => {
        if (!cancelled) setState({ key, value });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return useMemo(
    () => (state.key === key ? state.value : unanswered(key ? "loading" : "idle")),
    [state, key],
  );
}

/** One guest chip group as a surface draws it: one or more holders, their codes. */
export type GuestPromoChipGroup = {
  /** Stable and unique: the holders' guest references, never a name. */
  key: string;
  /** Every guest holding these codes, as a reader says them ("Sam and Alex"). */
  holders: string;
  codes: Array<{ code: string; detail: string | null }>;
};

const HOLDER_LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/**
 * The lookup's per-guest answer as the chips a booker sees (#3492 review,
 * privacy 5). A code is offered ONCE, labelled with every staying guest who
 * holds it, so "applies to Sam only" is never said of a code Alex holds too;
 * a code the booker holds themselves is left to their own chip (which says
 * nothing about whose nights), so a guest chip never claims "only" for a code
 * that also covers the booker. Groups are keyed by guest reference, so two
 * guests with the same name never collide.
 */
export function guestPromoChipGroups(params: {
  groups: readonly GuestPromoCodeGroupResponse[];
  /** The guest's display name for a lookup reference; null drops the guest. */
  nameFor: (guestRef: string) => string | null;
  /** The booker's own chip codes. */
  ownCodes: readonly string[];
}): GuestPromoChipGroup[] {
  const own = new Set(params.ownCodes.map(normalizePromoCodeInput));
  const byCode = new Map<string, { detail: string | null; refs: string[]; names: string[] }>();
  for (const group of params.groups) {
    const name = params.nameFor(group.guestRef);
    if (!name) continue;
    for (const chip of group.codes) {
      const code = normalizePromoCodeInput(chip.code);
      if (own.has(code)) continue;
      const entry = byCode.get(code) ?? { detail: chip.benefit, refs: [], names: [] };
      if (!entry.refs.includes(group.guestRef)) {
        entry.refs.push(group.guestRef);
        entry.names.push(name);
      }
      byCode.set(code, entry);
    }
  }
  const groups = new Map<string, GuestPromoChipGroup>();
  for (const [code, entry] of byCode) {
    const key = entry.refs.join("|");
    const group = groups.get(key) ?? { key, holders: HOLDER_LIST.format(entry.names), codes: [] };
    group.codes.push({ code, detail: entry.detail });
    groups.set(key, group);
  }
  return [...groups.values()];
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
  /** On an edit: the row this guest already is, so their stored consent counts. */
  bookingGuestId?: string;
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
  /**
   * An edit preview: the booking being edited. The server reads its guests'
   * stored consent (owner-checked), so a confirmed guest already on the booking
   * is priced the way the save prices them (D-3492-4). Implies `forBookingEdit`.
   */
  bookingId?: string;
  /**
   * A working bee the booking also takes (D-3813-3): it claims its in-window
   * nights first, and the result starts with its own entry.
   */
  workPartyEventId?: string;
}): Promise<PromoListValidation> {
  let data: {
    valid?: boolean;
    error?: string;
    codes?: PerCodePreview[];
    discountCents?: number;
    promoAdjustmentCents?: number;
    totalPriceCents?: number;
    finalPriceCents?: number;
    workPartyEvent?: { id: string; name: string; discountPercent: number } | null;
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
          ...(params.bookingId && guest.bookingGuestId ? { bookingGuestId: guest.bookingGuestId } : {}),
        })),
        ...(params.forMemberId ? { forMemberId: params.forMemberId } : {}),
        ...(params.lodgeId ? { lodgeId: params.lodgeId } : {}),
        ...(params.bookingId ? { forBookingEdit: true, bookingId: params.bookingId } : {}),
        ...(params.workPartyEventId ? { workPartyEventId: params.workPartyEventId } : {}),
      }),
    });
    data = await res.json();
  } catch {
    return { ok: false, error: "Failed to validate promo code" };
  }
  const perCode = Array.isArray(data.codes) ? data.codes : [];
  const byCode = new Map(perCode.map((entry) => [entry.code, entry]));
  const newestEntry = params.entries[params.entries.length - 1];
  const newest = newestEntry ? normalizePromoCodeInput(newestEntry.code) : undefined;
  for (const entry of params.entries) {
    const answer = byCode.get(normalizePromoCodeInput(entry.code));
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
  const codes: PromoResult[] = params.entries.map((entry) => {
      const answer = byCode.get(normalizePromoCodeInput(entry.code))!;
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
    });
  if (!params.workPartyEventId || !data.workPartyEvent) return { ok: true, applied: codes };
  // The working bee's own share: the booking's total less every code's, since
  // it claims first and the server answers it only as part of the total.
  const codeAdjustmentCents = appliedPromosAdjustmentCents(codes);
  const codeDiscountCents = codes.reduce((sum, promo) => sum + promo.discountCents, 0);
  const workParty: PromoResult = {
    code: null,
    description: null,
    type: "",
    discountCents: (data.discountCents ?? 0) - codeDiscountCents,
    promoAdjustmentCents: (data.promoAdjustmentCents ?? 0) - codeAdjustmentCents,
    totalPriceCents: data.totalPriceCents ?? 0,
    finalPriceCents: data.finalPriceCents ?? 0,
    workPartyEvent: data.workPartyEvent,
  };
  return { ok: true, applied: [workParty, ...codes] };
}
