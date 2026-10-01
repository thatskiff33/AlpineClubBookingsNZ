/**
 * THE CHARGE LINES AN EDIT POSTS, AND WHAT A REVIEW CLOSURE POSTS BESIDE ITS
 * RE-PRICE (#3582, programme #3527).
 *
 * The rules live in the design, once: an edit per guest-night, reversal plus
 * re-post, sum or nothing — `docs/design/booking-ledger.md` §5.1; a closure's
 * share at booking grain — §5.3. This module implements them and states only
 * what the code itself must know.
 *
 * Pure: it takes the edit's own before and after and the lines the booking
 * already holds, and returns the lines to post. It reads nothing and writes
 * nothing; `booking-ledger-modification-sync.ts` does both, inside the edit's
 * own transaction. The per-night step is `diffGuestNights`, the same differ the
 * edit's folded Xero lines are cut from (`INV-SSOT`). A plan that cannot sum
 * returns its reason for the caller to log.
 */
import type { AgeTier, ManualRefundTaskDirection } from "@prisma/client";

import {
  chargeLineReversal,
  type PostedChargeLine,
  guestNightPosting,
  isSingleNightLine,
  promotionPosting,
} from "@/lib/booking-ledger-charge-line";
import {
  agreedAdjustmentKey,
  modificationChangeFeeKey,
  modificationNightKey,
  modificationPromotionKey,
  reversalKey,
} from "@/lib/booking-ledger-posting-keys";
import { ledgerLineAmountCents, type BookingLedgerPosting } from "@/lib/booking-ledger-write";
import {
  diffGuestNights,
  modificationPromoDeltaCents,
  normalisedPromoCents,
  type ModificationPricingSide,
} from "@/lib/booking-modification-lines";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";
import { editReviewSettlementSign } from "@/lib/edit-financial-review-charge-shape";

export type { PostedChargeLine } from "@/lib/booking-ledger-charge-line";

/**
 * The lines that stand: neither a reversal nor reversed by one.
 *
 * THIS IS THE CHAIN WALK. An edit reverses a night's line and re-posts it under
 * a new key; the next edit must reverse the RE-POST, not the original. The
 * original is reversed (a line names it), the reversal is a reversal, and the
 * re-post is the one line left — whatever the chain's length.
 */
export function liveLines<T extends { id: string; reversesLineId: string | null }>(
  lines: readonly T[],
): T[] {
  const reversed = new Set<string>();
  for (const line of lines) if (line.reversesLineId !== null) reversed.add(line.reversesLineId);
  return lines.filter((line) => line.reversesLineId === null && !reversed.has(line.id));
}

function nightIndexKey(bookingGuestId: string, stayDate: Date): string {
  return `${bookingGuestId}|${calendarDateOfDateOnlyInstant(stayDate)}`;
}

export type ModificationPostingNoneReason =
  | "UNPRICED_NIGHT"
  | "INEXACT_STORED_NIGHT_PRICE"
  | "NO_LIVE_LINE"
  | "AMBIGUOUS_LIVE_LINE"
  | "NIGHT_ALREADY_LIVE"
  | "LIVE_LINE_DISAGREES"
  | "LIVE_PROMOTION_DISAGREES"
  | "INVALID_CHANGE_FEE"
  | "SUM_MISMATCH";

export type ModificationPostingPlan =
  | { kind: "lines"; postings: BookingLedgerPosting[] }
  | { kind: "none"; reason: ModificationPostingNoneReason; plannedCents?: number };

export type ModificationPostingInput = {
  bookingId: string;
  lodgeId: string;
  /** The `BookingModification` row every line is anchored and keyed on. */
  bookingModificationId: string;
  before: ModificationPricingSide;
  after: ModificationPricingSide;
  /** What the edit charged as a fee; 0 where it charged none. */
  changeFeeCents: number;
  /**
   * What the lines must add up to. For an edit, its own
   * `priceDiffCents + changeFeeCents`; for a closure's re-price, the movement
   * of the booking's final price the re-base recorded.
   */
  expectedCents: number;
  /** Every charge line the booking holds, live or not. */
  postedLines: readonly PostedChargeLine[];
};

export function planModificationChargeLines(
  input: ModificationPostingInput,
): ModificationPostingPlan {
  const nights = diffGuestNights(input.before, input.after);
  if (nights.kind === "none") return { kind: "none", reason: nights.reason };
  if (!Number.isSafeInteger(input.changeFeeCents) || input.changeFeeCents < 0) {
    return { kind: "none", reason: "INVALID_CHANGE_FEE" };
  }

  const live = liveLines(input.postedLines);
  const liveByNight = new Map<string, PostedChargeLine[]>();
  for (const line of live) {
    if (!isSingleNightLine(line)) continue;
    const key = nightIndexKey(line.bookingGuestId, line.nightStart);
    liveByNight.set(key, [...(liveByNight.get(key) ?? []), line]);
  }

  const anchor = {
    bookingId: input.bookingId,
    lodgeId: input.lodgeId,
    anchorKind: "MODIFICATION" as const,
    anchorId: input.bookingModificationId,
  };
  const base = { ...anchor, side: "CHARGE" as const };
  const postings: BookingLedgerPosting[] = [];
  const reversedHere = new Set<string>();
  const reverse = (line: PostedChargeLine): void => {
    reversedHere.add(line.id);
    postings.push(chargeLineReversal(anchor, line, reversalKey(line.id)));
  };

  for (const change of nights.guests) {
    for (const night of change.removed) {
      const candidates = liveByNight.get(nightIndexKey(change.guestKey, night.stayDate)) ?? [];
      if (candidates.length === 0) return { kind: "none", reason: "NO_LIVE_LINE" };
      if (candidates.length > 1) return { kind: "none", reason: "AMBIGUOUS_LIVE_LINE" };
      const line = candidates[0]!;
      // The live line must be the night the edit says it gave back, at the price
      // the edit says it was. Two disagreeing figures that happen to cancel in
      // the sum below would otherwise post a wrong pair of lines that add up.
      if (line.unitCents !== night.priceCents) {
        return { kind: "none", reason: "LIVE_LINE_DISAGREES" };
      }
      reverse(line);
    }
    const shape = change.after;
    if (!shape) continue;
    for (const night of change.added) {
      // A night the ledger already charges, and this edit is not reversing, is
      // one the edit's before side did not know about. Posting it again would
      // charge the night twice, and the sum below cannot see that: it is the
      // edit's own figure, not the ledger's.
      const standing = (liveByNight.get(nightIndexKey(change.guestKey, night.stayDate)) ?? []).filter(
        (line) => !reversedHere.has(line.id),
      );
      if (standing.length > 0) return { kind: "none", reason: "NIGHT_ALREADY_LIVE" };
      postings.push(
        guestNightPosting(anchor, {
          bookingGuestId: change.guestKey,
          name: shape.name,
          rateMembershipTypeId: shape.rateMembershipTypeId,
          ageTier: shape.ageTier,
          stayDate: night.stayDate,
          priceCents: night.priceCents,
          postingKey: modificationNightKey(input.bookingModificationId, change.guestKey, night.stayDate),
        }),
      );
    }
  }

  if (modificationPromoDeltaCents(input.before, input.after) !== 0) {
    const livePromotions = live.filter((line) => line.kind === "PROMOTION");
    const liveCents = livePromotions.reduce((sum, line) => sum + ledgerLineAmountCents(line), 0);
    // The ledger's promotion must be the one the edit started from, or the
    // reversal below would take away a figure the edit never saw.
    if (liveCents !== normalisedPromoCents(input.before.promoAdjustmentCents)) {
      return { kind: "none", reason: "LIVE_PROMOTION_DISAGREES" };
    }
    for (const line of livePromotions) reverse(line);
    const promotion = promotionPosting(
      anchor,
      normalisedPromoCents(input.after.promoAdjustmentCents),
      modificationPromotionKey(input.bookingModificationId),
    );
    if (promotion) postings.push(promotion);
  }

  if (input.changeFeeCents > 0) {
    postings.push({
      ...base,
      kind: "CHANGE_FEE",
      sign: 1,
      quantity: 1,
      unitCents: input.changeFeeCents,
      narration: "Change fee",
      postingKey: modificationChangeFeeKey(input.bookingModificationId),
    });
  }

  const plannedCents = postings.reduce((sum, posting) => sum + ledgerLineAmountCents(posting), 0);
  if (plannedCents !== input.expectedCents) {
    return { kind: "none", reason: "SUM_MISMATCH", plannedCents };
  }
  return { kind: "lines", postings };
}

/**
 * THE BEFORE SIDE OF A REVIEW CLOSURE'S RE-PRICE, read from the ledger (#3582).
 *
 * A parked edit posts nothing (`INV-MOD-040`) and writes no night-grain record
 * of what it started from, so when its review closes by re-pricing
 * (`INV-MOD-055`) the only statement of "before" is what the ledger still
 * holds. That IS the parked edit's own before: an open review fences every edit
 * door (`INV-PAY-066`), and the one it does not, the admin date shift, posts
 * its own lines in step (#3741). The closure's sum check proves it rather than
 * assuming it — the
 * lines must add up to exactly the re-base's own movement, which holds only if
 * the live lines equal the frozen headline the re-base started from.
 *
 * A live night line at any grain but one night is not a before this reader can
 * state, so the whole side is `null` and nothing posts. The member flag is the
 * guest's CURRENT one (a line records the rate and the age tier, not
 * membership), so a kept night is judged on its age tier and its price.
 */
export function pricingSideFromLiveLedger(
  postedLines: readonly PostedChargeLine[],
  currentGuests: ReadonlyArray<{ id: string; isMember: boolean }>,
  promoAdjustmentCents: number,
): ModificationPricingSide | null {
  const isMemberById = new Map(currentGuests.map((guest) => [guest.id, guest.isMember]));
  const byGuest = new Map<string, { lines: Array<PostedChargeLine & { nightStart: Date }> }>();
  for (const line of liveLines(postedLines)) {
    if (line.kind !== "GUEST_NIGHT") continue;
    if (!isSingleNightLine(line) || line.ageTier === null) return null;
    const entry = byGuest.get(line.bookingGuestId) ?? { lines: [] };
    entry.lines.push(line);
    byGuest.set(line.bookingGuestId, entry);
  }
  return {
    guests: [...byGuest.entries()].map(([guestId, { lines }]) => ({
      guestKey: guestId,
      ageTier: lines[0]!.ageTier as AgeTier,
      isMember: isMemberById.get(guestId) ?? false,
      rateMembershipTypeId: lines[0]!.rateMembershipTypeId,
      name: lines[0]!.guestNames.join(", "),
      nights: lines.map((line) => ({ stayDate: line.nightStart, priceCents: line.unitCents })),
    })),
    promoAdjustmentCents,
  };
}

/** A live-or-not `AGREED_ADJUSTMENT` on the ledger, with what a reversal copies. */
export type PostedAdjustmentLine = {
  id: string;
  sign: 1 | -1;
  quantity: number;
  unitCents: number;
  narration: string;
  reversesLineId: string | null;
};

/**
 * THE ONE BUILDER FOR TAKING BACK A STAND-IN (INV-SSOT): a review closure whose
 * re-price now carries the price (§5.3), and a cancellation (§5.1, #3611), both
 * reverse a live `AGREED_ADJUSTMENT` through here, keyed by its line id. The
 * person whose decision the reversal records is named where there is one.
 */
export function agreedAdjustmentReversal(
  anchor: Pick<BookingLedgerPosting, "bookingId" | "lodgeId" | "anchorKind" | "anchorId">,
  line: PostedAdjustmentLine,
  postedByMemberId?: string,
): BookingLedgerPosting {
  return {
    ...anchor,
    side: "ADJUSTMENT",
    kind: "AGREED_ADJUSTMENT",
    sign: line.sign === 1 ? -1 : 1,
    quantity: line.quantity,
    unitCents: line.unitCents,
    narration: `Reversed: ${line.narration}`,
    ...(postedByMemberId === undefined ? {} : { postedByMemberId }),
    reversesLineId: line.id,
    postingKey: reversalKey(line.id),
  };
}

/**
 * WHAT A REVIEW CLOSURE POSTS BESIDE ITS RE-PRICE, decided at booking grain:
 * the reversals of superseded stand-ins, the share as a stand-in, or nothing.
 * The rule and why: design `docs/design/booking-ledger.md` §5.3.
 */
export function planReviewClosureShareLines({
  bookingId,
  lodgeId,
  manualRefundTaskId,
  officerMemberId,
  note,
  settlement,
  rebasedFinalPriceCents,
  chargeLinesAfter,
  repriceRecordsMovement,
  postedAdjustmentLines,
}: {
  bookingId: string;
  lodgeId: string;
  manualRefundTaskId: string;
  officerMemberId: string;
  note: string | null;
  /** The completed share, or null on a dismissal. */
  settlement: { direction: ManualRefundTaskDirection; amountCents: number } | null;
  /** The booking's final price after the re-base, or null where it declined. */
  rebasedFinalPriceCents: number | null;
  /** Every GUEST_NIGHT and PROMOTION line, posted or about to be, reversals included. */
  chargeLinesAfter: ReadonlyArray<Pick<BookingLedgerPosting, "sign" | "unitCents" | "quantity">>;
  /** Whether this closure's own re-price rows recorded a non-zero movement. */
  repriceRecordsMovement: boolean;
  /** Every AGREED_ADJUSTMENT the booking holds, live or not. */
  postedAdjustmentLines: readonly PostedAdjustmentLine[];
}): BookingLedgerPosting[] {
  const chargedCents = chargeLinesAfter.reduce((sum, line) => sum + ledgerLineAmountCents(line), 0);
  // A re-price that posted re-prices every strand from the live ledger, so it
  // carries every sibling's money even where an unrelated drift makes the
  // totals miss (#3740 delta L1): either way, no stand-in survives beside it.
  const chargesCarryThePrice =
    rebasedFinalPriceCents !== null && (chargedCents === rebasedFinalPriceCents || repriceRecordsMovement);
  if (chargesCarryThePrice) {
    return liveLines(postedAdjustmentLines).map((line) =>
      agreedAdjustmentReversal(
        { bookingId, lodgeId, anchorKind: "REVIEW_TASK", anchorId: manualRefundTaskId },
        line,
        officerMemberId,
      ),
    );
  }
  if (settlement === null) return [];
  return [
    planAgreedAdjustmentLine({
      bookingId,
      lodgeId,
      manualRefundTaskId,
      direction: settlement.direction,
      amountCents: settlement.amountCents,
      note,
      officerMemberId,
    }),
  ];
}

/**
 * The one line a completed review share posts when it stands in for money the
 * booking's charge lines do not carry (§5.3): `AGREED_ADJUSTMENT`, signed by
 * the direction the officer chose (`CHARGE_TO_MEMBER` +, `REFUND_TO_MEMBER` −),
 * naming the officer, with the task's note as narration (`INV-MONEY-007`). The
 * settlement that follows posts its own line through its own writer (§5.2).
 */
export function planAgreedAdjustmentLine({
  bookingId,
  lodgeId,
  manualRefundTaskId,
  direction,
  amountCents,
  note,
  officerMemberId,
}: {
  bookingId: string;
  lodgeId: string;
  manualRefundTaskId: string;
  direction: ManualRefundTaskDirection;
  amountCents: number;
  note: string | null;
  officerMemberId: string;
}): BookingLedgerPosting {
  return {
    bookingId,
    lodgeId,
    side: "ADJUSTMENT",
    kind: "AGREED_ADJUSTMENT",
    sign: editReviewSettlementSign(direction),
    quantity: 1,
    unitCents: amountCents,
    anchorKind: "REVIEW_TASK",
    anchorId: manualRefundTaskId,
    narration: `Adjustment agreed with member: ${note ?? ""}`.trimEnd(),
    postedByMemberId: officerMemberId,
    postingKey: agreedAdjustmentKey(manualRefundTaskId),
  };
}
