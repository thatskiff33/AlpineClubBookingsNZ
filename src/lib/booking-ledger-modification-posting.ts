/**
 * THE CHARGE LINES AN EDIT POSTS, AND THE ADJUSTMENT A REVIEW AGREES (#3582,
 * programme #3527; design `docs/design/booking-ledger.md` §5.1 and §5.3).
 *
 * Pure: it takes the edit's own before and after, and the charge lines the
 * booking already holds, and returns the lines to post. It reads nothing and
 * writes nothing; `booking-ledger-modification-sync.ts` does both, inside the
 * edit's own transaction.
 *
 * AN EDIT IS A REVERSAL PLUS A RE-POST, NEVER A DELTA, and it is posted PER
 * GUEST-NIGHT from the edit's OWN before and after (the shape decision on
 * #3582): the per-night step is `diffGuestNights`, the same differ the edit's
 * folded Xero and history lines are cut from (`INV-SSOT`), so the two cannot
 * disagree about which nights an edit touched.
 *
 *  - every night the differ says was REMOVED (gone, repriced, or re-sold under a
 *    new category) reverses that night's LIVE line — the one no later line has
 *    reversed, so an edit never reverses a line an earlier edit already
 *    reversed. The reversal copies the line it reverses and is keyed by that
 *    line's id (`reversalKey`), so it can be posted at most once;
 *  - every night the differ says was ADDED posts one fresh `GUEST_NIGHT`, keyed
 *    on the modification (`modificationNightKey`);
 *  - a moved promotion reverses the live `PROMOTION` line(s) and re-posts what
 *    the promotion now comes to;
 *  - a change fee posts one `CHANGE_FEE`.
 *
 * SUM OR NOTHING. The lines must add up to exactly what the edit says it moved
 * — `priceDiffCents + changeFeeCents` — or nothing posts and the reason is
 * returned for the caller to log (`INV-MOD-058`'s discipline, applied to the
 * ledger). A night with no live line (never confirmed, or taken away by an
 * earlier edit that posted nothing) or a live line whose figure is not the
 * price the edit says it gave back can therefore never produce a wrong figure;
 * C4's census (#3583) counts the gap. Every reversal is anchored on THIS edit's
 * modification, not on the line it reverses, so the edit's own slice of the
 * ledger is what the edit changed (C6, #3585, renders it).
 */
import type { AgeTier, ManualRefundTaskDirection } from "@prisma/client";

import { morningAfter } from "@/lib/booking-ledger-confirmation-posting";
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
  type ModificationPricingSide,
} from "@/lib/booking-modification-lines";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";

/** A charge line already on the ledger, with what a reversal must copy. */
export type PostedChargeLine = {
  id: string;
  kind: "GUEST_NIGHT" | "PROMOTION";
  sign: 1 | -1;
  quantity: number;
  unitCents: number;
  bookingGuestId: string | null;
  nightStart: Date | null;
  nightEndExclusive: Date | null;
  rateMembershipTypeId: string | null;
  ageTier: AgeTier | null;
  guestNames: string[];
  narration: string;
  reversesLineId: string | null;
};

/**
 * The lines that stand: neither a reversal nor reversed by one.
 *
 * THIS IS THE CHAIN WALK. An edit reverses a night's line and re-posts it under
 * a new key; the next edit must reverse the RE-POST, not the original. The
 * original is reversed (a line names it), the reversal is a reversal, and the
 * re-post is the one line left — whatever the chain's length.
 */
export function liveChargeLines(lines: readonly PostedChargeLine[]): PostedChargeLine[] {
  const reversed = new Set<string>();
  for (const line of lines) if (line.reversesLineId !== null) reversed.add(line.reversesLineId);
  return lines.filter((line) => line.reversesLineId === null && !reversed.has(line.id));
}

function nightIndexKey(bookingGuestId: string, stayDate: Date): string {
  return `${bookingGuestId}|${calendarDateOfDateOnlyInstant(stayDate)}`;
}

/** A live line that prices exactly one guest's one night — the grain C1 posts at. */
function isSingleNightLine(line: PostedChargeLine): line is PostedChargeLine & {
  bookingGuestId: string;
  nightStart: Date;
  nightEndExclusive: Date;
} {
  return (
    line.kind === "GUEST_NIGHT" &&
    line.sign === 1 &&
    line.quantity === 1 &&
    line.bookingGuestId !== null &&
    line.nightStart !== null &&
    line.nightEndExclusive !== null &&
    line.nightEndExclusive.getTime() === morningAfter(line.nightStart).getTime()
  );
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

function normalisedPromo(cents: number): number {
  return Number.isFinite(cents) ? cents : 0;
}

export function planModificationChargeLines(
  input: ModificationPostingInput,
): ModificationPostingPlan {
  const nights = diffGuestNights(input.before, input.after);
  if (nights.kind === "none") return { kind: "none", reason: nights.reason };
  if (!Number.isSafeInteger(input.changeFeeCents) || input.changeFeeCents < 0) {
    return { kind: "none", reason: "INVALID_CHANGE_FEE" };
  }

  const live = liveChargeLines(input.postedLines);
  const liveByNight = new Map<string, PostedChargeLine[]>();
  for (const line of live) {
    if (!isSingleNightLine(line)) continue;
    const key = nightIndexKey(line.bookingGuestId, line.nightStart);
    liveByNight.set(key, [...(liveByNight.get(key) ?? []), line]);
  }

  const base = {
    bookingId: input.bookingId,
    lodgeId: input.lodgeId,
    side: "CHARGE" as const,
    anchorKind: "MODIFICATION" as const,
    anchorId: input.bookingModificationId,
  };
  const postings: BookingLedgerPosting[] = [];
  const reversedHere = new Set<string>();
  const reverse = (line: PostedChargeLine): void => {
    reversedHere.add(line.id);
    postings.push({
      ...base,
      kind: line.kind,
      sign: line.sign === 1 ? -1 : 1,
      quantity: line.quantity,
      unitCents: line.unitCents,
      // Copied from the line, never re-derived: the guest row it names may be
      // gone by now (a removal deletes it), and the line outlives it.
      bookingGuestId: line.bookingGuestId,
      nightStart: line.nightStart,
      nightEndExclusive: line.nightEndExclusive,
      rateMembershipTypeId: line.rateMembershipTypeId,
      ageTier: line.ageTier,
      guestNames: line.guestNames,
      narration: `Reversed: ${line.narration}`,
      reversesLineId: line.id,
      postingKey: reversalKey(line.id),
    });
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
      postings.push({
        ...base,
        kind: "GUEST_NIGHT",
        sign: 1,
        quantity: 1,
        unitCents: night.priceCents,
        bookingGuestId: change.guestKey,
        nightStart: night.stayDate,
        nightEndExclusive: morningAfter(night.stayDate),
        rateMembershipTypeId: shape.rateMembershipTypeId,
        ageTier: shape.ageTier,
        guestNames: shape.name ? [shape.name] : [],
        narration: `${shape.name || "Guest"} — one night`,
        postingKey: modificationNightKey(input.bookingModificationId, change.guestKey, night.stayDate),
      });
    }
  }

  if (modificationPromoDeltaCents(input.before, input.after) !== 0) {
    const livePromotions = live.filter((line) => line.kind === "PROMOTION");
    const liveCents = livePromotions.reduce((sum, line) => sum + ledgerLineAmountCents(line), 0);
    // The ledger's promotion must be the one the edit started from, or the
    // reversal below would take away a figure the edit never saw.
    if (liveCents !== normalisedPromo(input.before.promoAdjustmentCents)) {
      return { kind: "none", reason: "LIVE_PROMOTION_DISAGREES" };
    }
    for (const line of livePromotions) reverse(line);
    const afterCents = normalisedPromo(input.after.promoAdjustmentCents);
    if (afterCents !== 0) {
      const sign = afterCents < 0 ? -1 : 1;
      postings.push({
        ...base,
        kind: "PROMOTION",
        sign,
        quantity: 1,
        unitCents: Math.abs(afterCents),
        narration: sign < 0 ? "Promotion applied" : "Promotion, price raised",
        postingKey: modificationPromotionKey(input.bookingModificationId),
      });
    }
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
 * door (`INV-PAY-066`), so nothing else moved the booking between the park and
 * the close. The closure's sum check proves it rather than assuming it — the
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
  for (const line of liveChargeLines(postedLines)) {
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

/**
 * The one line a completed review share posts when nothing else records its
 * money (§5.3): `AGREED_ADJUSTMENT`, signed by the direction the officer chose
 * (`CHARGE_TO_MEMBER` +, `REFUND_TO_MEMBER` −), naming the officer, with the
 * task's note as narration (`INV-MONEY-007`). The settlement that follows posts
 * its own line through its own writer (§5.2), never here.
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
    sign: direction === "CHARGE_TO_MEMBER" ? 1 : -1,
    quantity: 1,
    unitCents: amountCents,
    anchorKind: "REVIEW_TASK",
    anchorId: manualRefundTaskId,
    narration: `Adjustment agreed with member: ${note ?? ""}`.trimEnd(),
    postedByMemberId: officerMemberId,
    postingKey: agreedAdjustmentKey(manualRefundTaskId),
  };
}
