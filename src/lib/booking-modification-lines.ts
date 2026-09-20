/**
 * THE LINES THAT MAKE UP A BOOKING EDIT'S PRICE DELTA (#3530 stage 2a,
 * programme #3527).
 *
 * Until #3530 every path from an edit to a document collapsed to
 * `{ priceDiffCents, changeFeeCents }` before anything rendered, so a treasurer
 * reading "$80" had to believe it and a member asking why got a number. This
 * module computes, at edit time, the signed lines behind that number - per
 * guest category x rate x unit price x nights, plus one promotion delta - and
 * is the ONE home for their shape, their sum rule, their parser and their
 * sentence (`INV-SSOT`). Three readers share it: the edit's audit row, the
 * booking's own history, and (stage 2b) the Xero supplementary invoice and
 * modification credit notes.
 *
 * THE LINES ARE NARRATION. `priceDiffCents` stays the figure every settlement
 * decision reads; no idempotency key or outbox payload carries a line; the
 * modification row is the anchor and is immutable after the edit.
 *
 * THE RULES, each pinned in `booking-modification-lines.test.ts`:
 *
 *  - Night prices are the GROSS rate per night (`BookingGuestNight.priceCents`,
 *    `PriceBreakdown.perNightCents`). The promotion is one signed
 *    `PROMO_DELTA` line equal to the change in `promoAdjustmentCents`, because
 *    `finalPriceCents = totalPriceCents + promoAdjustmentCents`
 *    (`bookingFinalPriceCents`); the group discount is already inside the
 *    night prices and appears in no line.
 *  - Per guest key, the before and after night sets are diffed on
 *    `(stayDate, priceCents)`: a night on both sides at the same price cancels;
 *    a night only before is REMOVED; only after is ADDED; a repriced night is
 *    one removed and one added, NEVER netted - the sign is what stage 2b routes
 *    to `hutFeeRefunds` versus `hutFeesIncome`, and "removed at $50, added at
 *    $55" is two facts.
 *  - A guest's added and removed nights are cut into contiguous same-price runs
 *    by `splitNightsIntoPriceRuns` - the SAME cutter the original invoice uses
 *    - and runs are folded across guests per (sign, category, rate, unit price,
 *    night count, start date), so two identical guests read as one line with
 *    `guestCount: 2`.
 *  - ANY unpriced night on either side yields NO lines (`INV-MOD-028`): never a
 *    partial itemisation. So does a before-night whose stored price is not
 *    EXACT provenance (`EVEN_SPLIT`, `UNKNOWN`): such rows sum correctly to the
 *    strand's total but were never the price of that particular night, and
 *    diffing them against an exactly-priced after set would print a reprice
 *    that never happened. The same rule `classifyStoredSoldPriceEvidence`
 *    applies at individual-night grain.
 *  - POSTCONDITION: the lines sum to the delta the caller settles on. A caller
 *    passes its own `priceDiffCents`; a mismatch returns `null` - nothing
 *    stored - because a wrong itemisation is worse than none
 *    (`INV-MONEY-003`).
 *
 * Pure: no database, no provider, no clock. Dates travel as calendar-day
 * strings (`YYYY-MM-DD`) so the stored shape has no zone to get wrong
 * (`INV-DATE-026`).
 */

import type { AgeTier } from "@prisma/client";
import { formatClubDate, parseCalendarDate } from "@/lib/club-time";
import { formatDateOnly } from "@/lib/date-only";
import { splitNightsIntoPriceRuns } from "@/lib/night-price-runs";
import { formatCents } from "@/lib/utils";

export const MODIFICATION_LINES_VERSION = 1 as const;

export type ModificationLineSign = 1 | -1;

export type ModificationLine =
  | {
      v: typeof MODIFICATION_LINES_VERSION;
      kind: "GUEST_NIGHTS";
      sign: ModificationLineSign;
      ageTier: AgeTier;
      isMember: boolean;
      rateMembershipTypeId: string | null;
      /** Gross price of one night for one guest, in cents. */
      unitCents: number;
      nightCount: number;
      guestCount: number;
      /** `guestCount * nightCount`: the Xero line's quantity. */
      quantity: number;
      /** Calendar days, `YYYY-MM-DD`; `endExclusive` is the morning after. */
      startDate: string;
      endExclusive: string;
      /** The guests folded into this line, for a person reading the history. */
      guestNames: string[];
      /** `sign * unitCents * quantity`. */
      amountCents: number;
    }
  | {
      v: typeof MODIFICATION_LINES_VERSION;
      kind: "PROMO_DELTA";
      sign: ModificationLineSign;
      promoCode: string | null;
      /** The signed change in `promoAdjustmentCents`. */
      amountCents: number;
    };

/** One side of an edit: every guest and the nights they hold, gross-priced. */
export interface ModificationPricingSide {
  guests: ReadonlyArray<{
    /** Stable across the two sides for a kept guest; unique for a new one. */
    guestKey: string;
    ageTier: AgeTier;
    isMember: boolean;
    rateMembershipTypeId: string | null;
    name: string;
    nights: ReadonlyArray<{
      stayDate: Date;
      priceCents: number | null;
      /**
       * Stored provenance where the side is the booking's own rows; omitted
       * for the freshly priced after side, whose every night is exact.
       */
      priceSource?: "SOLD" | "OFFICER_PRICED" | "EVEN_SPLIT" | "UNKNOWN";
    }>;
  }>;
  promoAdjustmentCents: number;
  promoCode?: string | null;
}

export type DiffBookingPricingResult =
  | { kind: "lines"; lines: ModificationLine[] }
  | {
      kind: "none";
      reason:
        | "UNPRICED_NIGHT"
        | "INEXACT_STORED_NIGHT_PRICE"
        | "SUM_MISMATCH";
      /** What the lines summed to when the sum was the problem. */
      linesSumCents?: number;
    };

const EXACT_PRICE_SOURCES = new Set(["SOLD", "OFFICER_PRICED"]);

/**
 * The signed lines from `before` to `after`, or why there are none.
 * `expectedDeltaCents` is the caller's own `priceDiffCents`, the figure it
 * settles on; the lines are stored only when they explain exactly that.
 */
export function diffBookingPricing(
  before: ModificationPricingSide,
  after: ModificationPricingSide,
  expectedDeltaCents: number,
): DiffBookingPricingResult {
  for (const guest of before.guests) {
    for (const night of guest.nights) {
      if (typeof night.priceCents !== "number") {
        return { kind: "none", reason: "UNPRICED_NIGHT" };
      }
      if (night.priceSource !== undefined && !EXACT_PRICE_SOURCES.has(night.priceSource)) {
        return { kind: "none", reason: "INEXACT_STORED_NIGHT_PRICE" };
      }
    }
  }
  for (const guest of after.guests) {
    for (const night of guest.nights) {
      if (typeof night.priceCents !== "number") {
        return { kind: "none", reason: "UNPRICED_NIGHT" };
      }
    }
  }

  const beforeByKey = new Map(before.guests.map((guest) => [guest.guestKey, guest]));
  const afterByKey = new Map(after.guests.map((guest) => [guest.guestKey, guest]));
  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])];

  type Folded = Extract<ModificationLine, { kind: "GUEST_NIGHTS" }>;
  const folded = new Map<string, Folded>();

  for (const key of keys) {
    const beforeGuest = beforeByKey.get(key);
    const afterGuest = afterByKey.get(key);
    // The category and rate a line names come from the side that has the
    // guest; a kept guest is named by its AFTER shape, which is what the edit
    // sold. (A category change on a kept guest is a reprice: every night is
    // removed at the old shape and added at the new one, below.)
    const identity = afterGuest ?? beforeGuest;
    if (!identity) continue;

    const beforeNights = new Map(
      (beforeGuest?.nights ?? []).map((night) => [
        formatDateOnly(night.stayDate),
        night.priceCents as number,
      ]),
    );
    const afterNights = new Map(
      (afterGuest?.nights ?? []).map((night) => [
        formatDateOnly(night.stayDate),
        night.priceCents as number,
      ]),
    );
    // The shape a kept night is judged on is the CATEGORY - age tier and
    // membership - not the rate-type snapshot. The stored snapshot is kept
    // stale on purpose while a guest holds locked nights (#2543, D5), so the
    // before side may carry an older id than the freshly priced after side
    // for a night whose price did not move; treating that as a re-sale would
    // print a reprice that never happened. The rate id still travels on each
    // line, taken from the side that sold it.
    const sameShape =
      beforeGuest !== undefined &&
      afterGuest !== undefined &&
      beforeGuest.ageTier === afterGuest.ageTier &&
      beforeGuest.isMember === afterGuest.isMember;

    const removed: Array<{ stayDate: Date; priceCents: number }> = [];
    const added: Array<{ stayDate: Date; priceCents: number }> = [];
    for (const [day, priceCents] of beforeNights) {
      // A kept night cancels only when the guest's shape is unchanged too:
      // the line names a category and a rate, so a guest whose category moved
      // is re-sold night by night.
      if (sameShape && afterNights.get(day) === priceCents) continue;
      removed.push({ stayDate: parseDay(day), priceCents });
    }
    for (const [day, priceCents] of afterNights) {
      if (sameShape && beforeNights.get(day) === priceCents) continue;
      added.push({ stayDate: parseDay(day), priceCents });
    }

    const fold = (
      sign: ModificationLineSign,
      nights: Array<{ stayDate: Date; priceCents: number }>,
      shape: NonNullable<typeof identity>,
    ) => {
      for (const run of splitNightsIntoPriceRuns(nights)) {
        const startDate = formatDateOnly(run.startDate);
        const foldKey = [
          sign,
          shape.ageTier,
          shape.isMember,
          shape.rateMembershipTypeId ?? "",
          run.perNightCents,
          run.nightCount,
          startDate,
        ].join("|");
        const existing = folded.get(foldKey);
        if (existing) {
          existing.guestCount += 1;
          existing.quantity = existing.guestCount * existing.nightCount;
          existing.amountCents = sign * existing.unitCents * existing.quantity;
          existing.guestNames.push(shape.name);
          continue;
        }
        folded.set(foldKey, {
          v: MODIFICATION_LINES_VERSION,
          kind: "GUEST_NIGHTS",
          sign,
          ageTier: shape.ageTier,
          isMember: shape.isMember,
          rateMembershipTypeId: shape.rateMembershipTypeId ?? null,
          unitCents: run.perNightCents,
          nightCount: run.nightCount,
          guestCount: 1,
          quantity: run.nightCount,
          startDate,
          endExclusive: formatDateOnly(run.endExclusive),
          guestNames: [shape.name],
          amountCents: sign * run.perNightCents * run.nightCount,
        });
      }
    };
    // A removed night is named by the shape it was sold under; an added one by
    // the shape it is sold under now.
    if (beforeGuest) fold(-1, removed, beforeGuest);
    if (afterGuest) fold(1, added, afterGuest);
  }

  const lines: ModificationLine[] = [...folded.values()].sort(orderLines);

  // A promotion figure that is not a number (a legacy row read without the
  // column) counts as zero; the sum postcondition below still has to hold
  // against the caller's real delta, so a coerced zero can hide nothing.
  const promoDeltaCents =
    (Number.isFinite(after.promoAdjustmentCents) ? after.promoAdjustmentCents : 0) -
    (Number.isFinite(before.promoAdjustmentCents) ? before.promoAdjustmentCents : 0);
  if (promoDeltaCents !== 0) {
    lines.push({
      v: MODIFICATION_LINES_VERSION,
      kind: "PROMO_DELTA",
      sign: promoDeltaCents > 0 ? 1 : -1,
      promoCode: after.promoCode ?? before.promoCode ?? null,
      amountCents: promoDeltaCents,
    });
  }

  const linesSumCents = sumModificationLines(lines);
  if (linesSumCents !== expectedDeltaCents) {
    return { kind: "none", reason: "SUM_MISMATCH", linesSumCents };
  }
  return { kind: "lines", lines };
}

export function sumModificationLines(lines: ReadonlyArray<ModificationLine>): number {
  return lines.reduce((sum, line) => sum + line.amountCents, 0);
}

/** Removals before additions, then by start date, then by category. */
function orderLines(
  a: Extract<ModificationLine, { kind: "GUEST_NIGHTS" }>,
  b: Extract<ModificationLine, { kind: "GUEST_NIGHTS" }>,
): number {
  if (a.sign !== b.sign) return a.sign - b.sign;
  if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
  if (a.isMember !== b.isMember) return a.isMember ? -1 : 1;
  if (a.ageTier !== b.ageTier) return a.ageTier < b.ageTier ? -1 : 1;
  return a.unitCents - b.unitCents;
}

function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

// ---------------------------------------------------------------------------
// Reading stored lines back
// ---------------------------------------------------------------------------

function isLine(value: unknown): value is ModificationLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  if (line.v !== MODIFICATION_LINES_VERSION) return false;
  if (line.sign !== 1 && line.sign !== -1) return false;
  if (!Number.isInteger(line.amountCents)) return false;
  if (line.kind === "PROMO_DELTA") {
    return line.promoCode === null || typeof line.promoCode === "string";
  }
  if (line.kind !== "GUEST_NIGHTS") return false;
  return (
    typeof line.ageTier === "string" &&
    typeof line.isMember === "boolean" &&
    (line.rateMembershipTypeId === null || typeof line.rateMembershipTypeId === "string") &&
    Number.isInteger(line.unitCents) &&
    Number.isInteger(line.nightCount) &&
    Number.isInteger(line.guestCount) &&
    Number.isInteger(line.quantity) &&
    typeof line.startDate === "string" &&
    typeof line.endExclusive === "string" &&
    Array.isArray(line.guestNames) &&
    line.guestNames.every((name) => typeof name === "string") &&
    line.amountCents === (line.sign as number) * (line.unitCents as number) * (line.quantity as number)
  );
}

/**
 * The stored column read back, or `null` for a legacy row, a NULL, or a value
 * this version does not recognise. A half-readable array is `null` in full -
 * a partial itemisation is the thing every reader must never show.
 */
export function parseModificationLines(value: unknown): ModificationLine[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every(isLine) ? (value as ModificationLine[]) : null;
}

// ---------------------------------------------------------------------------
// The sentence a person reads
// ---------------------------------------------------------------------------

const AGE_TIER_WORD: Record<AgeTier, string> = {
  ADULT: "Adult",
  YOUTH: "Youth",
  CHILD: "Child",
  INFANT: "Infant",
  NOT_APPLICABLE: "Guest",
};

/** "Non-member Adult" / "Member Youth". */
export function describeModificationLineCategory(
  line: Extract<ModificationLine, { kind: "GUEST_NIGHTS" }>,
): string {
  return `${line.isMember ? "Member" : "Non-member"} ${AGE_TIER_WORD[line.ageTier]}`;
}

function formatDay(day: string): string {
  const parsed = parseCalendarDate(day);
  return parsed ? formatClubDate(parsed) : day;
}

/**
 * `2 x Non-member Adult removed - 2 nights - 14 Aug 2026 - 16 Aug 2026` or
 * `Promotion SUMMER25 reduced by $20.00`. The same words on the Xero line
 * (2b), in the booking's history and in the audit row (`INV-SSOT`).
 */
export function renderModificationLineDescription(line: ModificationLine): string {
  if (line.kind === "PROMO_DELTA") {
    const code = line.promoCode ? `Promotion ${line.promoCode}` : "Promotion";
    // A promotion adjustment is negative money; it "increases" when the
    // adjustment moves further below zero.
    return line.amountCents < 0
      ? `${code} increased by ${formatCents(-line.amountCents)}`
      : `${code} reduced by ${formatCents(line.amountCents)}`;
  }
  const verb = line.sign > 0 ? "added" : "removed";
  const nights = `${line.nightCount} night${line.nightCount === 1 ? "" : "s"}`;
  return `${line.guestCount} x ${describeModificationLineCategory(line)} ${verb} - ${nights} - ${formatDay(line.startDate)} - ${formatDay(line.endExclusive)}`;
}

/** The description with its signed money, for history and audit text. */
export function renderModificationLineWithAmount(line: ModificationLine): string {
  const amount =
    line.amountCents < 0
      ? `-${formatCents(-line.amountCents)}`
      : formatCents(line.amountCents);
  return `${renderModificationLineDescription(line)} (${amount})`;
}

// ---------------------------------------------------------------------------
// Composing the two sides at an edit site
// ---------------------------------------------------------------------------

/** What a booking's own guest rows carry, as every edit site loads them. */
export interface StoredGuestForLines {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  rateMembershipTypeId: string | null;
  /**
   * Loaded rows; a legacy guest may carry none, and a row loaded without the
   * price column (`priceCents` undefined) is read as an unpriced night.
   */
  nights?: ReadonlyArray<{
    stayDate: Date;
    priceCents?: number | null;
    priceSource: "SOLD" | "OFFICER_PRICED" | "EVEN_SPLIT" | "UNKNOWN";
  }>;
}

/**
 * The BEFORE side, from the snapshot an edit loaded before it wrote anything.
 * Always the in-memory rows, never a re-read: by the time the modification row
 * is written the edit has rewritten or deleted the night rows it is about to
 * describe.
 */
export function pricingSideFromStoredGuests(
  guests: ReadonlyArray<StoredGuestForLines>,
  promo: { promoAdjustmentCents: number; promoCode?: string | null },
): ModificationPricingSide {
  return {
    guests: guests.map((guest) => ({
      guestKey: guest.id,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      rateMembershipTypeId: guest.rateMembershipTypeId ?? null,
      name: `${guest.firstName} ${guest.lastName}`.trim(),
      nights: (guest.nights ?? []).map((night) => ({
        stayDate: night.stayDate,
        priceCents: night.priceCents ?? null,
        priceSource: night.priceSource,
      })),
    })),
    promoAdjustmentCents: promo.promoAdjustmentCents,
    promoCode: promo.promoCode ?? null,
  };
}

/**
 * The AFTER side, from the guest rows an edit has just WRITTEN, re-read inside
 * the same transaction. Every night here is this edit's own output, so no
 * provenance rule applies to it - a kept night carries its locked price and a
 * bought night its fresh one, both exactly as sold.
 */
export function pricingSideFromWrittenGuests(
  guests: ReadonlyArray<Omit<StoredGuestForLines, "nights"> & {
    nights: ReadonlyArray<{ stayDate: Date; priceCents: number | null }>;
  }>,
  promo: { promoAdjustmentCents: number; promoCode?: string | null },
): ModificationPricingSide {
  return {
    guests: guests.map((guest) => ({
      guestKey: guest.id,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      rateMembershipTypeId: guest.rateMembershipTypeId ?? null,
      name: `${guest.firstName} ${guest.lastName}`.trim(),
      nights: guest.nights.map((night) => ({
        stayDate: night.stayDate,
        priceCents: night.priceCents,
      })),
    })),
    promoAdjustmentCents: promo.promoAdjustmentCents,
    promoCode: promo.promoCode ?? null,
  };
}

/** One priced guest of a `PriceBreakdown`, as the pricing engine returns it. */
export interface PricedGuestForLines {
  ageTier: AgeTier;
  isMember: boolean;
  rateMembershipTypeId: string;
  perNightCents: ReadonlyArray<number>;
  nightDates: ReadonlyArray<Date>;
}

/**
 * The AFTER side, from the breakdown the edit priced. `identities` is
 * index-aligned with the breakdown's guests and says which stored guest each
 * priced one IS (`guestKey` = the `BookingGuest.id` for a kept guest, any
 * unique string for one this edit adds), because the engine returns shapes,
 * not rows. Every night here is freshly priced, so it carries no provenance.
 */
export function pricingSideFromPriceBreakdown(
  identities: ReadonlyArray<{ guestKey: string; name: string }>,
  pricedGuests: ReadonlyArray<PricedGuestForLines>,
  promo: { promoAdjustmentCents: number; promoCode?: string | null },
): ModificationPricingSide {
  if (identities.length !== pricedGuests.length) {
    throw new Error(
      `pricingSideFromPriceBreakdown: ${identities.length} identities for ${pricedGuests.length} priced guests`,
    );
  }
  return {
    guests: pricedGuests.map((guest, index) => ({
      guestKey: identities[index]!.guestKey,
      ageTier: guest.ageTier,
      isMember: guest.isMember,
      rateMembershipTypeId: guest.rateMembershipTypeId,
      name: identities[index]!.name,
      nights: (guest.nightDates ?? []).map((stayDate, nightIndex) => ({
        stayDate,
        priceCents: guest.perNightCents?.[nightIndex] ?? null,
      })),
    })),
    promoAdjustmentCents: promo.promoAdjustmentCents,
    promoCode: promo.promoCode ?? null,
  };
}

/**
 * What an edit site stores: the lines, or nothing. An edit that moved no
 * night and no promotion has no lines to store - NULL, never `[]` - and one
 * whose lines could not be computed stores NULL for the reason the result
 * carries, which the site logs.
 */
export function modificationPriceLinesToStore(
  result: DiffBookingPricingResult,
): ModificationLine[] | null {
  return result.kind === "lines" && result.lines.length > 0 ? result.lines : null;
}

/**
 * THE ONE WAY AN EDIT SITE COMPUTES ITS LINES. The lines are narration: no
 * edit may fail, and no money may move differently, because the narration
 * could not be written. So the composition runs inside this guard - a result
 * of "none" is logged with its reason and stored as NULL, and a THROW (a
 * fixture shape the composer did not expect, a wiring slip) is logged as an
 * error and stored as NULL too, never rethrown into the transaction.
 */
export function computeModificationPriceLines(
  context: { bookingId: string; site: string },
  build: () => DiffBookingPricingResult,
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  },
): ModificationLine[] | null {
  try {
    const result = build();
    if (result.kind === "none") {
      log.info(
        { bookingId: context.bookingId, site: context.site, reason: result.reason, linesSumCents: result.linesSumCents },
        "Booking edit stores no itemised price lines",
      );
    }
    return modificationPriceLinesToStore(result);
  } catch (err) {
    log.error(
      { err, bookingId: context.bookingId, site: context.site },
      "Booking edit could not compute its itemised price lines; storing none",
    );
    return null;
  }
}

/**
 * What an edit's audit row carries about its lines (#3530): the lines
 * themselves under `priceLines`, and the sentences a person reads under
 * `priceLinesText`, in dollars. Nothing when the edit stored none - the row
 * then reads exactly as it did before the column existed.
 */
export function modificationLinesAuditFields(
  lines: ReadonlyArray<ModificationLine> | null | undefined,
): { priceLines: ModificationLine[]; priceLinesText: string[] } | Record<string, never> {
  if (!lines || lines.length === 0) return {};
  return {
    priceLines: [...lines],
    priceLinesText: lines.map(renderModificationLineWithAmount),
  };
}
