import type { Role } from "@prisma/client";

import {
  hostingCoverageActorOptions,
  inspectSameOwnerStrandingForOffer,
  reconcileAdultMemberHostingReviewWithSiblings,
} from "@/lib/adult-member-hosting-review";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import {
  SameOwnerCoverageLinkedMoveRequiredError,
  linkedMoveStateKey,
  type HostingCoverageLinkedMoveInput,
  type LinkedMoveBooking,
  type LinkedMoveFeasibility,
  type LinkedMoveQuote,
} from "@/lib/adult-member-hosting-linked-move";
import {
  SameOwnerCoverageWouldBreakError,
  strandedCoverageStateKey,
  type HostingCoverageOverrideInput,
} from "@/lib/adult-member-hosting-same-owner";
import {
  modifyBookingBatch,
  type BatchModificationResponse,
} from "@/lib/booking-batch-modification-service";
import type { BatchModifyInput } from "@/lib/booking-modify-validation";
import { OverCapacityConfirmationRequiredError } from "@/lib/over-capacity-confirmation";
import { WholeLodgeHoldBlockedError } from "@/lib/over-capacity-confirmation";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import type { CalendarDate } from "@/lib/club-time";
import { addDaysDateOnly, formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { getDefaultLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { formatBookingReference } from "@/lib/booking-reference";

/**
 * THE LINKED MOVE: move a member's booking and the booking of theirs that was
 * relying on it for adult supervision, together, atomically, on one combined
 * figure (#3232 D1/D2, `INV-HOST-050`, `INV-HOST-051`).
 *
 * ## What this module is for, in one paragraph
 *
 * A club can require a qualifying adult on a booking, and under the
 * `SAME_BOOKING_OWNER` scope an adult on one of your bookings can satisfy the rule
 * for another booking you own. Move the booking carrying the adult and the other
 * one loses its cover. Refusing the move deadlocks the member (moving the other
 * booking first is refused by the same rule from the other end), and letting it
 * through silently was the live defect #3232 was filed for. So the member is
 * offered the thing they are actually trying to do: move both.
 *
 * ## The shape, and why it is ONE transaction run in two modes
 *
 * The offer needs a price, and the price has to be the REAL price — the one the
 * member will actually be charged, from the same pricing engine that will charge
 * it. An estimator computed a second way would be a second definition of what a
 * date move costs (`INV-SSOT-001`), and it would be the definition the member was
 * shown while the other one billed them.
 *
 * So there is one procedure, `runLinkedDateMove`, and it does the whole job:
 * takes the locks, moves the primary, asks who that stranded, moves them too,
 * reconciles the supervision rule over the state that results, and totals the
 * money. `"quote"` mode ends by THROWING, which rolls the transaction back and
 * turns the totals into the offer; `"apply"` mode ends by returning, which commits
 * it. Nothing about the two paths differs except the last step, which is what makes
 * the quote trustworthy: it is not a prediction of what apply will do, it is apply,
 * not kept.
 *
 * ## Atomicity
 *
 * Every write happens inside one `prisma.$transaction`. There is therefore no
 * state in which one booking has moved and the other has not: any failure on the
 * second booking — no beds, a minimum-stay violation, a Xero lock date, a member-
 * night conflict, a supervision refusal over the FINAL state — rolls the first one
 * back with it. That is also why the "cannot" arm is cheap to be honest about: the
 * capacity refusal comes from the real capacity engine on a real attempt, not from
 * a hand-rolled bed count, and the attempt costs nothing because it is discarded.
 *
 * The provider work is the one thing that cannot be inside the transaction, and it
 * is not: `modifyBookingBatch` in caller-transaction mode returns its Stripe
 * refund, additional PaymentIntent, emails and Xero settlement as a
 * `deferredPostCommit` thunk, and this module runs every booking's thunk after the
 * commit. A provider call inside a transaction holding the global money lock and a
 * lodge capacity key is the shape the locking guide forbids.
 *
 * ## Locking (`INV-LOCK-001`, `INV-LOCK-002`, `INV-LOCK-003`)
 *
 * Global `pg_advisory_xact_lock(1)` FIRST, then the per-lodge capacity key, then —
 * inside the hosting seam — the participant `Member` rows and the per-owner
 * coverage key. That is the registered order, unchanged, and this module adds NO
 * new key.
 *
 * ONE LODGE KEY COVERS BOTH BOOKINGS, and that is a property of the predicate
 * rather than an assumption: `sameOwnerCoverageDependentOverStayUnionWhere` pins
 * `lodgeId` to the changed booking's lodge, so a same-owner dependent is ALWAYS at
 * the same lodge, and no writer in the tree moves a booking between lodges
 * (`bed-allocation-lock-topology-contract.test.ts` fails the build on one that
 * tries). If that ever stops being true, the keys would have to be taken in sorted
 * lodge order and this comment is where to start.
 *
 * The two `modifyBookingBatch` calls each re-enter both keys, which are re-entrant
 * no-ops for a transaction already holding them — the same property the
 * approve-and-execute path (#2525) already relies on. Taking them here first is
 * what guarantees the ORDER even if a future edit reorders the calls.
 *
 * ## What it does not do
 *
 * It does not touch the officer's override path, and it raises no new refusal for
 * anybody but the booking's own member. An actor who is not the owner never
 * reaches this code, because the disposition that raises the offer is the same one
 * that gates the bare stranded refusal, and that one escalates rather than
 * disclosing another account's booking.
 */

/** How a caller says what the member answered, if anything. */
export interface LinkedDateMoveAnswer {
  linkedMove?: HostingCoverageLinkedMoveInput | null;
}

interface LinkedDateMoveArgs {
  bookingId: string;
  actor: { id: string; role: Role };
  input: BatchModifyInput;
  ipAddress: string;
  todayAtClub: CalendarDate;
  hostingCoverageOverride?: HostingCoverageOverrideInput | null;
}

/**
 * Raised in `"quote"` mode purely to roll the probe transaction back.
 *
 * It carries BOTH keys because the two arms of the offer are bound to different
 * things: accepting is bound to the moves and the money, declining only to the
 * stranded set. See `hostingCoverageLinkedMoveSchema`.
 */
class LinkedMoveProbeComplete extends Error {
  readonly quote: LinkedMoveQuote;
  readonly acceptStateKey: string;
  readonly declineStateKey: string;

  constructor(
    quote: LinkedMoveQuote,
    keys: { acceptStateKey: string; declineStateKey: string },
  ) {
    super("linked-move probe complete");
    this.name = "LinkedMoveProbeComplete";
    this.quote = quote;
    this.acceptStateKey = keys.acceptStateKey;
    this.declineStateKey = keys.declineStateKey;
  }
}

/**
 * Where the dependent booking goes.
 *
 * IT SHIFTS BY THE SAME NUMBER OF DAYS AS THE PRIMARY'S ARRIVAL, KEEPING ITS OWN
 * LENGTH — not "to the same nights", which the issue's own wording uses and which
 * is only well defined when the two stays happen to match. Two bookings of
 * different lengths have no "same nights"; shifting by the arrival delta preserves
 * exactly the relationship the dependent was relying on, so a booking that was
 * covered before the move is covered after it, and it also preserves the
 * dependent's stay length, its per-guest stay ranges and the shape of its price.
 *
 * WHEN THE PRIMARY ALSO CHANGED LENGTH — arrival and departure moved by different
 * amounts — the dependent still follows the ARRIVAL delta and keeps its own length.
 * A member extending their own stay has not asked to extend anybody else's, and
 * lengthening a second booking would charge them for nights they never requested.
 *
 * THE MEMBER IS SHOWN THE RESULTING DATES OUTRIGHT rather than this rule, because
 * dates can be checked against a calendar and a rule cannot.
 */
export function linkedMoveTargetRange(
  primary: { previousCheckIn: Date; currentCheckIn: Date },
  dependent: { checkIn: string; checkOut: string },
): { checkIn: string; checkOut: string } {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const shiftDays = Math.round(
    (primary.currentCheckIn.getTime() - primary.previousCheckIn.getTime()) /
      MS_PER_DAY,
  );
  return {
    checkIn: formatDateOnly(
      addDaysDateOnly(parseDateOnly(dependent.checkIn), shiftDays),
    ),
    checkOut: formatDateOnly(
      addDaysDateOnly(parseDateOnly(dependent.checkOut), shiftDays),
    ),
  };
}

/**
 * Whether the club charges the change fee on both bookings (#3232 D2).
 *
 * Read from the club settings singleton, OUTSIDE any transaction, and passed in as
 * a value — the same rule every other policy read on these paths follows
 * (`INV-LOCK-004`): a settings read inside the transaction would take a second
 * pooled connection while the global money key and the lodge capacity key are both
 * held.
 *
 * Absent row means the default, which is `true`. A club that has never opened the
 * settings page has not chosen to waive anything.
 */
export async function loadLinkedMoveChargesBothChangeFees(): Promise<boolean> {
  const defaults = await prisma.bookingDefaults.findUnique({
    where: { id: "default" },
    select: { linkedMoveChargesBothChangeFees: true },
  });
  return defaults?.linkedMoveChargesBothChangeFees ?? true;
}

function combineQuote(input: {
  primary: BatchModificationResponse;
  primaryId: string;
  primaryRange: { checkIn: string; checkOut: string };
  linked: Array<{
    stranded: {
      bookingId: string;
      reference: string;
      lodgeName: string;
      nights: string[];
      checkIn: string;
      checkOut: string;
    };
    target: { checkIn: string; checkOut: string };
    result: BatchModificationResponse;
  }>;
  bothChangeFeesCharged: boolean;
  feasibility: LinkedMoveFeasibility;
}): LinkedMoveQuote {
  const linked: LinkedMoveBooking[] = input.linked
    .map((entry) => ({
      bookingId: entry.stranded.bookingId,
      reference: entry.stranded.reference,
      lodgeName: entry.stranded.lodgeName,
      uncoveredNights: entry.stranded.nights,
      currentCheckIn: entry.stranded.checkIn,
      currentCheckOut: entry.stranded.checkOut,
      proposedCheckIn: entry.target.checkIn,
      proposedCheckOut: entry.target.checkOut,
      priceDiffCents: entry.result.priceDiffCents,
      changeFeeCents: entry.result.changeFeeCents,
    }))
    .sort((left, right) => (left.bookingId < right.bookingId ? -1 : 1));

  const all = [input.primary, ...input.linked.map((entry) => entry.result)];
  const sum = (pick: (r: BatchModificationResponse) => number) =>
    all.reduce((total, result) => total + pick(result), 0);

  return {
    primary: {
      bookingId: input.primaryId,
      reference: formatBookingReference(input.primaryId),
      proposedCheckIn: input.primaryRange.checkIn,
      proposedCheckOut: input.primaryRange.checkOut,
      priceDiffCents: input.primary.priceDiffCents,
      changeFeeCents: input.primary.changeFeeCents,
    },
    linked,
    combinedPriceDiffCents: sum((r) => r.priceDiffCents),
    combinedChangeFeeCents: sum((r) => r.changeFeeCents),
    combinedAmountDueCents: sum((r) => r.additionalAmountCents),
    // A reduction can come back as a card refund OR as account credit, and the
    // member chose once for both. Summing the two is right rather than
    // double-counting: exactly one of them is non-zero per booking, because
    // `calculateModificationSettlementOptions` routes a given reduction down one
    // path or the other, never both.
    combinedRefundCents: sum(
      (r) => r.refundAmountCents + r.accountCreditAmountCents,
    ),
    settlementMethodRequired: all.some(
      (r) => r.refundAmountCents + r.accountCreditAmountCents > 0,
    ),
    bothChangeFeesCharged: input.bothChangeFeesCharged,
    feasibility: input.feasibility,
  };
}

/**
 * A refusal that means "there are not beds for both", as opposed to any other
 * reason the second move could fail.
 *
 * ONLY THESE TWO, deliberately. A minimum-stay violation, a Xero lock date, a
 * member-night conflict or a membership-type policy block are not "cannot fit" —
 * they are reasons this particular linked move is wrong, and dressing them as a
 * capacity message would tell the member something false. They propagate, the
 * transaction rolls back, and the member sees the real refusal.
 */
function isCapacityRefusal(error: unknown): boolean {
  return (
    error instanceof OverCapacityConfirmationRequiredError ||
    error instanceof WholeLodgeHoldBlockedError
  );
}

async function runLinkedDateMove(
  args: LinkedDateMoveArgs,
  mode: "quote" | "apply",
  answer: HostingCoverageLinkedMoveInput | null,
  bothChangeFeesCharged: boolean,
): Promise<{
  primary: BatchModificationResponse;
  deferred: Array<() => Promise<void>>;
  movedBookingIds: string[];
  quote: LinkedMoveQuote;
}> {
  return prisma.$transaction(async (tx) => {
    // The registered order, taken here so it cannot depend on the order the two
    // `modifyBookingBatch` calls happen to be written in. Both re-enter these same
    // keys as no-ops.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const lockTarget = await tx.booking.findUnique({
      where: { id: args.bookingId },
      select: { lodgeId: true, checkIn: true, checkOut: true },
    });
    const lodgeId = lockTarget?.lodgeId ?? (await getDefaultLodgeId(tx));
    await acquireLodgeCapacityLock(tx, lodgeId);

    // Re-read under the lock: the window the primary really holds is what the
    // dependent's shift is measured from, and a proposal is not evidence.
    const before = await tx.booking.findUnique({
      where: { id: args.bookingId },
      select: { checkIn: true, checkOut: true },
    });
    if (!before) throw new Error("Booking not found");

    const primary = await modifyBookingBatch({
      bookingId: args.bookingId,
      actor: args.actor,
      input: args.input,
      ipAddress: args.ipAddress,
      todayAtClub: args.todayAtClub,
      ...(args.hostingCoverageOverride
        ? { hostingCoverageOverride: args.hostingCoverageOverride }
        : {}),
      tx,
      hostingReconcile: "CALLER",
    });

    // WHO the primary's move has just stranded, read from the same code the
    // refusal uses, over the rows this transaction has written but not committed.
    const stranded = await inspectSameOwnerStrandingForOffer(
      args.bookingId,
      tx,
      { checkIn: before.checkIn, checkOut: before.checkOut },
    );

    const primaryRange = {
      checkIn: formatDateOnly(primary.booking.checkIn),
      checkOut: formatDateOnly(primary.booking.checkOut),
    };

    const linked: Array<{
      stranded: (typeof stranded)[number];
      target: { checkIn: string; checkOut: string };
      result: BatchModificationResponse;
    }> = [];
    let feasibility: LinkedMoveFeasibility = "AVAILABLE";

    for (const dependent of stranded) {
      const target = linkedMoveTargetRange(
        {
          previousCheckIn: before.checkIn,
          currentCheckIn: primary.booking.checkIn,
        },
        dependent,
      );
      try {
        const result = await modifyBookingBatch({
          bookingId: dependent.bookingId,
          actor: args.actor,
          input: {
            checkIn: target.checkIn,
            checkOut: target.checkOut,
            // ONE settlement choice covers both bookings — the member is asked
            // once and it is applied to each. Passing the primary's choice rather
            // than asking again is what makes "accepts once" true.
            ...(args.input.settlementMethod
              ? { settlementMethod: args.input.settlementMethod }
              : {}),
          },
          ipAddress: args.ipAddress,
          todayAtClub: args.todayAtClub,
          tx,
          hostingReconcile: "CALLER",
        });
        linked.push({ stranded: dependent, target, result });
      } catch (error) {
        if (!isCapacityRefusal(error)) throw error;
        // THE "CANNOT" ARM. There are not beds for both, so the linked move is
        // not offered — but the member is not failed either: the quote comes back
        // marked `NO_CAPACITY` with the warn-and-continue path in its sentence.
        //
        // The whole transaction is discarded whichever mode this is, so nothing
        // half-moved survives: in `"quote"` mode by the probe throw below, and in
        // `"apply"` mode because the state key cannot match a quote that was built
        // as unavailable, so the mismatch throw rolls it back.
        feasibility = "NO_CAPACITY";
        break;
      }
    }

    // The supervision rule, ONCE, over the state that will really commit — with
    // full enforcement, for every booking this transaction wrote. Deferred from
    // each `modifyBookingBatch` because an intermediate state in which one of two
    // linked bookings has moved would be refused by this very rule, over a state
    // that was never going to exist.
    await primary.pendingHostingReconcile?.();
    for (const entry of linked) {
      await entry.result.pendingHostingReconcile?.();
    }
    // A booking written with the deferral MUST be reconciled, so a missing thunk
    // is a wiring fault rather than a booking with no supervision check. Fail
    // loudly inside the transaction, where it rolls back.
    if (!primary.pendingHostingReconcile) {
      throw new Error(
        "The linked move wrote a booking without receiving its deferred hosting " +
          "reconciliation; refusing to commit an unchecked supervision state.",
      );
    }
    // And re-assert the rule over the primary once more only where the linked
    // moves changed the world after its own reconciliation ran, so the answer the
    // member gets is derived from the final rows rather than an intermediate one.
    if (linked.length > 0) {
      await reconcileAdultMemberHostingReviewWithSiblings(args.bookingId, tx, {
        ...hostingCoverageActorOptions({
          actorRole: args.actor.role,
          actorMemberId: args.actor.id,
          // The primary really did move, and the second pass has to look at where
          // it was as well as where it now is for the same reason the first did.
          vacatedRange: { checkIn: before.checkIn, checkOut: before.checkOut },
        }),
      });
    }

    const quote = combineQuote({
      primary,
      primaryId: args.bookingId,
      primaryRange,
      linked,
      bothChangeFeesCharged,
      feasibility,
    });
    const acceptStateKey = linkedMoveStateKey({
      stranded,
      sourceBookingId: args.bookingId,
      proposals: [
        { bookingId: args.bookingId, ...primaryRange },
        ...linked.map((entry) => ({
          bookingId: entry.stranded.bookingId,
          ...entry.target,
        })),
      ],
      combinedAmountDueCents: quote.combinedAmountDueCents,
      combinedRefundCents: quote.combinedRefundCents,
      combinedChangeFeeCents: quote.combinedChangeFeeCents,
    });
    // The DECLINE key, derived the way the hosting engine will re-derive it when it
    // honours the answer — from the stranded set alone, because declining carries
    // no price. Sharing `strandedCoverageStateKey` with the officer's override is
    // deliberate: two derivations of "is this the same situation" that could
    // disagree would let one prompt be answered with the other's evidence.
    const declineStateKey = strandedCoverageStateKey(stranded, args.bookingId);
    const keys = { acceptStateKey, declineStateKey };

    // `"quote"` mode ends HERE, by throwing, which is what rolls the whole probe
    // back. Nothing above this line is kept.
    if (mode === "quote") throw new LinkedMoveProbeComplete(quote, keys);

    // AND SO DOES A STALE ACCEPTANCE. The member accepted a specific set of moves
    // at a specific price; if either has changed the honest answer is a fresh
    // prompt, not a silent substitution of a figure they never saw.
    if (
      feasibility !== "AVAILABLE" ||
      !answer ||
      answer.choice !== "MOVE_BOTH" ||
      answer.stateKey !== acceptStateKey
    ) {
      throw new LinkedMoveProbeComplete(quote, keys);
    }

    const deferred = [
      primary.deferredPostCommit,
      ...linked.map((entry) => entry.result.deferredPostCommit),
    ].filter((thunk): thunk is () => Promise<void> => Boolean(thunk));

    return {
      primary,
      deferred,
      movedBookingIds: [
        args.bookingId,
        ...linked.map((entry) => entry.stranded.bookingId),
      ],
      quote,
    };
  });
}

/**
 * Quote the linked move and raise the offer (#3232 D1).
 *
 * Called when a member's date change has been refused because it would strand
 * another of their own bookings. Always throws: either the offer, or whatever real
 * refusal the probe hit on the way — a minimum-stay violation on the dependent's
 * new nights is not something to hide behind an offer the member cannot take.
 */
export async function offerLinkedDateMove(
  args: LinkedDateMoveArgs,
): Promise<never> {
  const bothChangeFeesCharged = await loadLinkedMoveChargesBothChangeFees();
  try {
    await runLinkedDateMove(args, "quote", null, bothChangeFeesCharged);
  } catch (error) {
    if (error instanceof LinkedMoveProbeComplete) {
      throw new SameOwnerCoverageLinkedMoveRequiredError(error.quote, {
        acceptStateKey: error.acceptStateKey,
        declineStateKey: error.declineStateKey,
      });
    }
    throw error;
  }
  // Unreachable: `"quote"` mode always throws.
  throw new Error("The linked-move probe returned without a quote");
}

/**
 * Apply the linked move the member accepted (#3232 D1).
 *
 * Commits both bookings or neither. A changed situation or a changed price throws
 * the offer again with the fresh figures rather than charging the member something
 * they did not agree to.
 */
export async function applyLinkedDateMove(
  args: LinkedDateMoveArgs & { linkedMove: HostingCoverageLinkedMoveInput },
): Promise<BatchModificationResponse> {
  const bothChangeFeesCharged = await loadLinkedMoveChargesBothChangeFees();
  let outcome;
  try {
    outcome = await runLinkedDateMove(
      args,
      "apply",
      args.linkedMove,
      bothChangeFeesCharged,
    );
  } catch (error) {
    if (error instanceof LinkedMoveProbeComplete) {
      throw new SameOwnerCoverageLinkedMoveRequiredError(error.quote, {
        acceptStateKey: error.acceptStateKey,
        declineStateKey: error.declineStateKey,
      });
    }
    throw error;
  }

  // AFTER THE COMMIT, and only after it. Each booking's provider work — Stripe
  // refund or charge, member email, Xero settlement, superseded-intent drain,
  // audit — was deferred because this module owned the commit.
  for (const thunk of outcome.deferred) {
    await thunk();
  }
  for (const bookingId of outcome.movedBookingIds) {
    await settleHostingCoverageAfterCommit({ bookingId });
  }
  return outcome.primary;
}

/**
 * The one entry point a date-capable member surface should call (#3232).
 *
 * WHY A WRAPPER RATHER THAN LOGIC IN THE ROUTE. The three arms of the offer are a
 * policy, not a rendering concern: which refusals become an offer, which stay a
 * refusal, and what accepting means. A route that assembled that itself would be a
 * second copy of it the moment a second surface appeared, and the arm that got
 * copied wrong would be the one that either deadlocks a member or silently strands
 * a booking. So the routes call this and catch two error types.
 *
 * WHAT IT DOES, in order:
 *
 *  - `MOVE_BOTH` answered → the atomic two-booking move, on one settlement.
 *  - otherwise → the ordinary single-booking edit. A `LEAVE_UNCOVERED` answer
 *    travels with it, which is what turns the stranded refusal into an escalation.
 *  - and if that edit is refused because it would strand a booking the member
 *    cannot reach, the refusal is priced and re-thrown as the OFFER.
 *
 * A refusal NOT marked `linkedMoveWouldAnswer` propagates untouched, because there
 * the member has real remedies on the affected booking and today's refusal is the
 * right answer. Deciding that here rather than at the throw site is deliberate:
 * the hosting engine knows which shape of stranding it found, and this module knows
 * what can be done about it.
 */
export async function modifyBookingWithLinkedMoveSupport(
  args: LinkedDateMoveArgs & LinkedDateMoveAnswer,
): Promise<BatchModificationResponse> {
  const { linkedMove, ...rest } = args;
  if (linkedMove?.choice === "MOVE_BOTH") {
    return applyLinkedDateMove({ ...rest, linkedMove });
  }
  try {
    return await modifyBookingBatch({
      bookingId: rest.bookingId,
      actor: rest.actor,
      input: rest.input,
      ipAddress: rest.ipAddress,
      todayAtClub: rest.todayAtClub,
      ...(rest.hostingCoverageOverride
        ? { hostingCoverageOverride: rest.hostingCoverageOverride }
        : {}),
      ...(linkedMove ? { hostingCoverageLinkedMove: linkedMove } : {}),
    });
  } catch (error) {
    if (
      error instanceof SameOwnerCoverageWouldBreakError &&
      error.linkedMoveWouldAnswer
    ) {
      // Always throws — either the offer, or whatever real refusal the priced
      // attempt hits on the way. A minimum-stay violation on the dependent's new
      // nights must not be hidden behind an offer the member cannot take.
      await offerLinkedDateMove(rest);
    }
    throw error;
  }
}
