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
 * that is missing. Where a row could instead be absorbed by another task's
 * re-price, or two rows sit beside give-back lines, nothing says which task a
 * row is: that live booking fails closed as `AMBIGUOUS_REVIEW_GIVE_BACK`
 * (#3583's delta review).
 *
 * #3835 (#3907): on a CAPTURED payment the same netting sends the capture's
 * part back to the capture - a card refund (the task's frozen Stripe debt,
 * `buildEditFinancialReviewRefundRecoveryIdempotencyKey`) or a hand-back (its
 * `BANK_REFUND` line) - and only the credit's part comes back as a give-back.
 * So after a cancellation a stand-in is borne out by that task's own refund
 * plus the rows, the facts #3835's `settledSinceCancellation` reads, and a
 * hand-back smaller than the share is borne out only by such a stand-in. Pure:
 * the snapshot row in, the judgement out.
 */
import { liveLines } from "@/lib/booking-ledger-modification-posting";
import { isAgreedGiveBackKey } from "@/lib/booking-ledger-posting-keys";
import type { BookingLedgerCensusRow, CensusLedgerLine } from "@/lib/booking-ledger-projection-census-row";
import { editReviewSettlementSign } from "@/lib/edit-financial-review-charge-shape";
import { buildEditFinancialReviewRefundRecoveryIdempotencyKey } from "@/lib/payment-recovery-keys";

export type ReviewAdjustmentEvidence = {
  /** A live review `AGREED_ADJUSTMENT` the rows do not bear out, by line id, with why. */
  drift: ReadonlyMap<string, string>;
  /** Σ live `agreed-give-back:` lines (≤ 0): a price below the strands', which `finalPriceCents` never carries. */
  agreedGiveBackLineCents: number;
  /**
   * What the give-back rows say those lines come to (≤ 0, a live booking's):
   * the lines the rows bear out, plus any give-back no line or re-price
   * accounts for — the line that should have recorded it is missing. Exact
   * only where no row could be absorbed elsewhere; the class below says when.
   */
  agreedGiveBackEvidenceCents: number;
  /**
   * A live booking whose give-back rows cannot be attributed to its tasks
   * (`AMBIGUOUS_REVIEW_GIVE_BACK`), with the figures the owner signs off, all
   * as positive cents; null where every row is attributed exactly.
   */
  ambiguous: { giveBackLineCents: number; giveBackRowCents: number; repricedWithoutLineCents: number } | null;
  /** #3835: hand-backs smaller than their share, each borne out by its task's stand-in (by line id). */
  nettedHandBackLineIds: ReadonlySet<string>;
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

/** A stand-in after the cancellation: what it credited, and what its task's own route returned to the capture. */
type CreditedShare = { creditedCents: number; ownRefundCents: number };

/**
 * Can every credited figure be made of its task's own refund plus one
 * give-back row, one share credit, or one of each, no row used twice? A
 * figure the refund makes alone needs no row; nothing makes a figure of zero.
 * A small exact search: a booking carries a handful of reviews at most.
 */
function creditedFromRows(credited: readonly CreditedShare[], giveBacks: readonly number[], minted: readonly number[]): boolean {
  const [first, ...rest] = credited;
  if (first === undefined) return true;
  const fromRowsCents = first.creditedCents - first.ownRefundCents;
  if (fromRowsCents < 0) return false;
  if (fromRowsCents === 0) return first.ownRefundCents > 0 && creditedFromRows(rest, giveBacks, minted);
  for (const givenBack of [0, ...new Set(giveBacks)]) {
    for (const mint of [0, ...new Set(minted)]) {
      if (givenBack + mint !== fromRowsCents) continue;
      const giveBacksLeft = [...giveBacks];
      const mintedLeft = [...minted];
      if (givenBack !== 0) take(giveBacksLeft, givenBack);
      if (mint !== 0) take(mintedLeft, mint);
      if (creditedFromRows(rest, giveBacksLeft, mintedLeft)) return true;
    }
  }
  return false;
}

/**
 * What one review's captured route returned to the capture (#3835), from its
 * own rows: the card refund it froze as a debt, and the hand-back it posted.
 */
function ownRefundOf(row: BookingLedgerCensusRow, taskId: string): { cents: number; handBackLineIds: string[] } {
  const key = buildEditFinancialReviewRefundRecoveryIdempotencyKey(taskId);
  const cardCents = row.recoveryOperations.filter((operation) => operation.idempotencyKey === key).reduce((sum, operation) => sum + operation.amountCents, 0);
  const handBacks = liveLines(row.lines).filter((line) => line.kind === "BANK_REFUND" && line.anchorKind === "REVIEW_TASK" && line.anchorId === taskId);
  return { cents: cardCents - handBacks.reduce((sum, line) => sum + line.amountCents, 0), handBackLineIds: handBacks.map((line) => line.id) };
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

  const giveBackRowCount = giveBacks.length;
  const giveBackRowCents = giveBacks.reduce((sum, cents) => sum + cents, 0);
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
  // Rows are matched to lines by amount, and no row names its task. That is
  // exact only while nothing else could absorb a row: a re-price drop on a
  // task with no give-back line (a dismissed review's included) can hide a
  // missing, forged or overstated line, and so, conservatively, can a second
  // row beside a give-back line. Such a live booking fails closed, as a class
  // the owner acknowledges to the cent, never as agreement.
  const ambiguous =
    !cancelled && giveBackRowCents > 0 && (repricedWithoutLineCents > 0 || (giveBackRowCount > 1 && agreedGiveBackLineCents !== 0))
      ? { giveBackLineCents: -agreedGiveBackLineCents || 0, giveBackRowCents, repricedWithoutLineCents }
      : null;

  // After a cancellation (which reverses every stand-in it found live), a
  // share credits what is still owed: up to the share, made of the task's own
  // refund to the capture (#3835) and a give-back and the credit minted beside
  // it (#3791). A stand-in whose task refunded the capture is judged so too,
  // since its hand-back is borne out only by it. Anything else is the share.
  const refunded = new Set<string>();
  const credited = cancelled
    ? standIns.flatMap((line) => {
        const task = tasks.get(line.anchorId);
        if (task?.settlementDirection !== "REFUND_TO_MEMBER" || line.amountCents >= 0) return [];
        // A task's own refund is used once: by its first live stand-in.
        const own = refunded.has(task.id) ? { cents: 0, handBackLineIds: [] } : ownRefundOf(row, task.id);
        refunded.add(task.id);
        return -line.amountCents < (task.amountCents ?? 0) || own.cents > 0
          ? [{ line, creditedCents: -line.amountCents, ownRefundCents: own.cents, handBackLineIds: own.handBackLineIds }]
          : [];
      })
    : [];
  const nettedShares = credited.filter(({ line }) => -line.amountCents < (tasks.get(line.anchorId)?.amountCents ?? 0)).map(({ line }) => line);
  if (!creditedFromRows(credited, giveBacks, minted)) {
    // Name the lines the rows cannot make on their own; where each can, but
    // not all together, every one of them.
    const alone = credited.filter((share) => !creditedFromRows([share], giveBacks, minted));
    for (const { line } of alone.length > 0 ? alone : credited) {
      drift.set(line.id, `a share credited at ${-line.amountCents} after the cancellation, which no refund of its own, review give-back and share credit on this booking make`);
    }
  }
  for (const line of standIns) {
    const task = tasks.get(line.anchorId);
    if (!task || task.settlementDirection === null || nettedShares.includes(line)) continue;
    const expected = editReviewSettlementSign(task.settlementDirection) * (task.amountCents ?? 0);
    if (line.amountCents !== expected) drift.set(line.id, `task share is ${expected}, line ${line.amountCents}`);
  }
  // Only after every check on the stand-ins: a hand-back is borne out only by
  // a stand-in accepted whole, and so within its share - one its refund made
  // above the share is drift above, and its hand-back with it (#3913 F1).
  const nettedHandBackLineIds = new Set(
    credited.filter(({ line }) => !drift.has(line.id)).flatMap((share) => share.handBackLineIds),
  );

  return {
    drift,
    agreedGiveBackLineCents,
    agreedGiveBackEvidenceCents: cancelled ? 0 : borneOutCents - unaccountedCents,
    ambiguous,
    nettedHandBackLineIds,
  };
}
