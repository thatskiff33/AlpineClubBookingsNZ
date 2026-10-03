/**
 * WHAT A REVIEW CLOSURE'S `AGREED_ADJUSTMENT` LINES SHOULD SAY, READ FROM THE
 * BOOKING'S OWN ROWS (#3583 against #3791; design `docs/design/booking-ledger.md`
 * §5.3, §6).
 *
 * A stand-in records the share as typed, with one exception #3791 made: on a
 * booking paid by account credit, a closure completed AFTER the cancellation
 * credits only what is still owed once its slice is netted against the
 * restore, and its stand-in posts that (none at zero). And on a booking its
 * credit covered, the give-back beyond the closure's re-price posts under its
 * own `agreed-give-back:` key: a price below what the strands, and so
 * `finalPriceCents`, will ever say.
 *
 * Neither figure is stored per task. What is stored is the money each one is
 * made of: the review give-back rows (`BOOKING_APPLIED` naming the booking as
 * source and target, `reviewGiveBackRowsWhere`), the share credit minted
 * beside them, and each closure's re-price (its `PRICE_REBASE` row). So a line
 * is borne out only when those rows make it, each row used once, and a
 * give-back row no line accounts for on a live booking is evidence of a line
 * that is missing. Pure: the snapshot row in, the judgement out.
 */
import { liveLines } from "@/lib/booking-ledger-modification-posting";
import { isAgreedGiveBackKey } from "@/lib/booking-ledger-posting-keys";
import type { BookingLedgerCensusRow, CensusLedgerLine } from "@/lib/booking-ledger-projection-census-classes";
import { editReviewSettlementSign } from "@/lib/edit-financial-review-charge-shape";

export type ReviewAdjustmentEvidence = {
  /** A live review `AGREED_ADJUSTMENT` the rows do not bear out, by line id, with why. */
  drift: ReadonlyMap<string, string>;
  /** Σ live `agreed-give-back:` lines (≤ 0): a price below the strands', which `finalPriceCents` never carries. */
  agreedGiveBackLineCents: number;
  /**
   * What the give-back rows say those lines come to (≤ 0, a live booking's):
   * the lines the rows bear out, plus any give-back no line or re-price
   * accounts for — the line that should have recorded it is missing.
   */
  agreedGiveBackEvidenceCents: number;
};

function isReviewAdjustment(line: CensusLedgerLine): boolean {
  return line.kind === "AGREED_ADJUSTMENT" && line.anchorKind === "REVIEW_TASK";
}

/** Remove one `cents` from `pool`; false if it holds none. */
function take(pool: number[], cents: number): boolean {
  const index = pool.indexOf(cents);
  if (index < 0) return false;
  pool.splice(index, 1);
  return true;
}

/** What one closure's re-price took off the final price (`previous − new`), 0 where it wrote no row. */
function repricedAwayCents(row: BookingLedgerCensusRow, taskId: string): number {
  return row.modifications.reduce(
    (sum, modification) => (modification.reviewRebase?.taskId === taskId ? sum - modification.reviewRebase.movementCents : sum),
    0,
  );
}

/**
 * Can every credited figure be made of one give-back row, one share credit, or
 * one of each, no row used twice? A small exact search: a booking carries a
 * handful of reviews at most.
 */
function creditedFromRows(credited: readonly number[], giveBacks: readonly number[], minted: readonly number[]): boolean {
  const [first, ...rest] = credited;
  if (first === undefined) return true;
  for (const givenBack of [0, ...new Set(giveBacks)]) {
    for (const mint of [0, ...new Set(minted)]) {
      if (givenBack + mint !== first || first === 0) continue;
      const giveBacksLeft = [...giveBacks];
      const mintedLeft = [...minted];
      if (givenBack !== 0) take(giveBacksLeft, givenBack);
      if (mint !== 0) take(mintedLeft, mint);
      if (creditedFromRows(rest, giveBacksLeft, mintedLeft)) return true;
    }
  }
  return false;
}

export function reviewAdjustmentEvidence(row: BookingLedgerCensusRow): ReviewAdjustmentEvidence {
  const bookingId = row.booking.id;
  const drift = new Map<string, string>();
  const tasks = new Map(row.tasks.map((task) => [task.id, task]));
  // #3791's `reviewGiveBackRowsWhere`, and the share credit minted beside it
  // (`createBookingModificationCredit`), as the snapshot holds them.
  const giveBacks = row.credits
    .filter((credit) => credit.type === "BOOKING_APPLIED" && credit.sourceBookingId === bookingId && credit.appliedToBookingId === bookingId && credit.amountCents > 0)
    .map((credit) => credit.amountCents);
  const minted = row.credits
    .filter((credit) => credit.type === "BOOKING_MODIFICATION_REFUND" && credit.sourceBookingId === bookingId && credit.amountCents > 0)
    .map((credit) => credit.amountCents);

  const lines = liveLines(row.lines).filter(isReviewAdjustment);
  let agreedGiveBackLineCents = 0;
  let borneOutCents = 0;
  const tasksWithGiveBackLine = new Set<string>();
  const standIns: CensusLedgerLine[] = [];
  for (const line of lines) {
    const task = tasks.get(line.anchorId);
    if (isAgreedGiveBackKey(line.postingKey)) agreedGiveBackLineCents += line.amountCents;
    // A missing or open task is the anchor's finding, not the amount's.
    if (!task || task.status !== "COMPLETED") continue;
    if (!isAgreedGiveBackKey(line.postingKey)) {
      standIns.push(line);
      continue;
    }
    // The writer posts `givenBack − repricedAway` where that is above zero.
    tasksWithGiveBackLine.add(task.id);
    const repriced = repricedAwayCents(row, task.id);
    const givenBack = repriced - line.amountCents;
    if (task.settlementDirection !== "REFUND_TO_MEMBER" || line.amountCents >= 0) {
      drift.set(line.id, `an agreed give-back of ${line.amountCents} on a share that gives nothing back`);
    } else if (givenBack > (task.amountCents ?? 0)) {
      drift.set(line.id, `an agreed give-back of ${line.amountCents} after a ${repriced} re-price is more than the ${task.amountCents ?? 0} share`);
    } else if (!take(giveBacks, givenBack)) {
      drift.set(line.id, `an agreed give-back of ${line.amountCents} after a ${repriced} re-price needs a review give-back of ${givenBack}; the booking holds [${giveBacks.join(", ")}] unused`);
    } else {
      borneOutCents += line.amountCents;
    }
  }

  // A give-back no line bears out is accounted for only by a re-price that
  // removed at least as much (no line posts then), or by the unpaid route's
  // headroom, which the booking's re-prices bound the same way.
  const repricedWithoutLineCents = row.modifications.reduce(
    (sum, modification) =>
      modification.reviewRebase && !tasksWithGiveBackLine.has(modification.reviewRebase.taskId)
        ? sum + Math.max(0, -modification.reviewRebase.movementCents)
        : sum,
    0,
  );
  const unaccountedCents = Math.max(0, giveBacks.reduce((sum, cents) => sum + cents, 0) - repricedWithoutLineCents);
  const cancelled = row.booking.status === "CANCELLED";

  // After a cancellation (which reverses every stand-in it found live), an
  // account-credit share credits what is still owed: up to the share, made of
  // a give-back and the credit minted beside it. Anything else is the share.
  const nettedShares = cancelled
    ? standIns.filter((line) => {
        const task = tasks.get(line.anchorId);
        return task?.settlementDirection === "REFUND_TO_MEMBER" && line.amountCents < 0 && -line.amountCents < (task.amountCents ?? 0);
      })
    : [];
  if (!creditedFromRows(nettedShares.map((line) => -line.amountCents), giveBacks, minted)) {
    // Name the lines the rows cannot make on their own; where each can, but
    // not all together, every one of them.
    const alone = nettedShares.filter((line) => !creditedFromRows([-line.amountCents], giveBacks, minted));
    for (const line of alone.length > 0 ? alone : nettedShares) {
      drift.set(line.id, `a share credited at ${-line.amountCents} after the cancellation, which no review give-back and share credit on this booking make`);
    }
  }
  for (const line of standIns) {
    const task = tasks.get(line.anchorId);
    if (!task || task.settlementDirection === null || nettedShares.includes(line)) continue;
    const expected = editReviewSettlementSign(task.settlementDirection) * (task.amountCents ?? 0);
    if (line.amountCents !== expected) drift.set(line.id, `task share is ${expected}, line ${line.amountCents}`);
  }

  return {
    drift,
    agreedGiveBackLineCents,
    agreedGiveBackEvidenceCents: cancelled ? 0 : borneOutCents - unaccountedCents,
  };
}
