import type { Role } from "@prisma/client";

import {
  hostingCoverageActorOptions,
  inspectSameOwnerStrandingForOffer,
  reconcileAdultMemberHostingReviewWithSiblings,
} from "@/lib/adult-member-hosting-review";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import {
  SameOwnerCoverageLinkedMoveRequiredError,
  combineLinkedMoveQuote,
  linkedMoveStateKey,
  linkedMoveTargetRange,
  type HostingCoverageLinkedMoveInput,
  type LinkedMoveCandidate,
  type LinkedMoveFeasibility,
  type LinkedMoveQuote,
} from "@/lib/adult-member-hosting-linked-move";
import {
  strandedCoverageStateKey,
  type HostingCoverageOverrideInput,
} from "@/lib/adult-member-hosting-same-owner";
import {
  modifyBookingBatch,
  type BatchModificationPreTransaction,
  type BatchModificationResponse,
} from "@/lib/booking-batch-modification-service";
import type { BatchModifyInput } from "@/lib/booking-modify-validation";
import {
  InsufficientCapacityError,
  OverCapacityConfirmationRequiredError,
  WholeLodgeHoldBlockedError,
} from "@/lib/over-capacity-confirmation";
import { ApiError } from "@/lib/api-error";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { assertBookingEnvelopeInvariants } from "@/lib/booking-envelope-invariants";
import { BookingModificationSettlementMethodRequiredError } from "@/lib/booking-modify-settlement-required";
import type { CalendarDate } from "@/lib/club-time";
import { formatDateOnly } from "@/lib/date-only";
import {
  LINKED_MOVE_TRANSACTION_BUDGET,
  LinkedDateMoveContendedError,
  isTransactionContention,
  loadLinkedMoveChargesBothChangeFees,
  prepareLinkedMovePreTransaction,
} from "@/lib/booking-linked-date-move-preflight";
import { getDefaultLodgeId } from "@/lib/lodges";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

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
 * Provider work cannot be inside the transaction, and there are TWO ways it could
 * have been. AFTER the commit: `modifyBookingBatch` in caller-transaction mode
 * returns its Stripe refund, additional PaymentIntent, emails and Xero settlement
 * as a `deferredPostCommit` thunk, and this module runs every booking's thunk
 * after the commit, each contained separately. BEFORE it: that service's own
 * preamble reads the club's settings, its subscription-lockout mode and the Xero
 * organisation's lock dates, and it sits above `withOptionalTransaction` — which
 * READS as "before the transaction" and is false for a caller that supplies one,
 * so on this path it ran INSIDE the transaction, twice, with a live HTTPS request
 * among it. That is why `prepareLinkedMovePreTransaction` exists and why the
 * service now REFUSES a caller transaction without it. An earlier version of this
 * paragraph said the provider work "is not" inside the transaction and was half
 * right, which is worse than saying nothing: the half it named was the half that
 * had been dealt with.
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
 * It does not touch the officer's override path. An actor who is not the owner is
 * never OFFERED the move — the disposition that raises the offer is the same one
 * that gates the bare stranded refusal, and that one escalates rather than
 * disclosing another account's booking — and, since the fix round, cannot ACCEPT
 * one either: `runLinkedDateMove` refuses a non-owner before it writes anything.
 * The offer path and the accept path are reachable through different doors, so
 * both need the check; only the first had it.
 */


export interface LinkedDateMoveArgs {
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


function isCapacityRefusal(error: unknown): boolean {
  return (
    error instanceof InsufficientCapacityError ||
    error instanceof OverCapacityConfirmationRequiredError ||
    error instanceof WholeLodgeHoldBlockedError
  );
}

async function runLinkedDateMove(
  args: LinkedDateMoveArgs,
  mode: "quote" | "apply",
  answer: HostingCoverageLinkedMoveInput | null,
  bothChangeFeesCharged: boolean,
  preTransaction: BatchModificationPreTransaction,
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
      select: { checkIn: true, checkOut: true, memberId: true },
    });
    if (!before) throw new Error("Booking not found");

    // AND IT IS ONLY THE OWNER'S DOOR (#3232 D1, `INV-HOST-050`), checked here
    // because here is before anything is written on either mode.
    //
    // The offer is RAISED only for the booking's own member — the disposition that
    // marks a refusal answerable is the same one that escalates for anybody else —
    // but ACCEPTING was reachable by any actor authorised to modify the primary,
    // and a key mismatch answers with a valid `acceptStateKey`, so an officer could
    // resubmit it and commit an atomic two-booking move on a member's bookings with
    // the dependent's change fee waived under the club's supervision-rule setting.
    // No new authority is gained — they could already edit both — but the arm's own
    // docblocks, the invariant and the published changelog all say this door is the
    // member's, and §7 exists so that an officer who means to leave a booking
    // uncovered confirms it and says why. The same rule already gates the DECLINE
    // arm (`hostingCoverageActorOptions`); this is the half that was missing.
    //
    // ROLE IS NOT THE TEST — ownership is. An admin moving their OWN booking is
    // offered the linked move like anybody else, which is why neither save route
    // gates the answer on `adminOverride`.
    if (args.actor.id !== before.memberId) {
      throw new ApiError(
        "Moving both bookings together is only available to the member whose " +
          "bookings they are.",
        403,
      );
    }

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
      preTransaction,
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

    // See the note at the call below. `"apply"` never substitutes a choice: real
    // money moves there, and it goes where the member said or nowhere.
    const settlementMethodForDependent =
      args.input.settlementMethod ??
      (mode === "quote" ? ("card" as const) : undefined);

    const linked: LinkedMoveCandidate<BatchModificationResponse>[] = [];
    let feasibility: LinkedMoveFeasibility = "AVAILABLE";
    const targetOf = (dependent: (typeof stranded)[number]) =>
      linkedMoveTargetRange(
        {
          previousCheckIn: before.checkIn,
          currentCheckIn: primary.booking.checkIn,
        },
        dependent,
      );

    for (const dependent of stranded) {
      const target = targetOf(dependent);
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
            //
            // AND THE QUOTE PRICES A CHOICE THE MEMBER HAS NOT MADE YET, on the
            // card option, rather than refusing to quote at all. The dependent's
            // move can need a refund-or-credit choice when the PRIMARY's does not
            // — the primary unpaid or its price rising, the compelled move
            // reducing a settled booking — and the panel only collects the choice
            // when the primary's own quote asks for it. Without this the
            // dependent's write threw a bare 400 telling the member to choose
            // something there was no control for, the offer was never built, and
            // they could move NEITHER booking: the deadlock again, by a fourth
            // route. The quote instead comes back with `settlementMethodRequired`
            // set, which is what asks them.
            //
            // CARD, AND THE CHOICE STILL BINDS. The two options do not always
            // return the same amount (a card refund can carry a policy
            // percentage), so a member who then picks CREDIT gets a fresh offer
            // with the true figures rather than a silent substitution — the accept
            // key covers the combined money. One extra confirmation on that
            // branch, and never a figure they were not shown.
            ...(settlementMethodForDependent
              ? { settlementMethod: settlementMethodForDependent }
              : {}),
          },
          ipAddress: args.ipAddress,
          todayAtClub: args.todayAtClub,
          tx,
          hostingReconcile: "CALLER",
          // THE SAME pre-transaction value, so this booking's settings, lockout
          // mode and Xero lock dates are the ones resolved before the transaction
          // opened — not a second set read from inside it. One value covers both
          // bookings, which is what makes it usable for a booking this service
          // only discovers under the locks.
          preTransaction,
          // D2, AND IT HAS TO BE HERE RATHER THAN IN THE SENTENCE. The club's
          // setting decides whether the booking that was DRAGGED ALONG attracts
          // its own change fee; the booking the member chose to move always
          // attracts its own. Passing the waiver into the pricing engine is what
          // makes `bothChangeFeesCharged` on the quote a description of the money
          // instead of a claim beside it — the combined figure below is summed
          // from these results, so a waiver applied only to the message would
          // have told the member the fee was waived and charged it anyway.
          ...(bothChangeFeesCharged ? {} : { waiveChangeFee: true }),
        });
        linked.push({
          stranded: dependent,
          target,
          money: {
            priceDiffCents: result.priceDiffCents,
            changeFeeCents: result.changeFeeCents,
          },
          result,
        });
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

    // AND THE OFFER STILL NAMES EVERY BOOKING, which is what makes the "cannot"
    // arm reachable at all. The loop above stops at the first booking there are no
    // beds for, so the partial results describe a move that is not happening and
    // say nothing about the dependents it never reached. Replacing them with the
    // WHOLE stranded set, priced at nothing because nothing moves, is what the
    // member actually needs: which of their bookings will be left without adult
    // supervision, on which nights, if they go ahead.
    //
    // It is also load-bearing rather than cosmetic. The browser's reader for this
    // body fails closed on an empty `linkedBookings`, so a `NO_CAPACITY` offer
    // that named nobody was discarded in the panel and fell back to the plain
    // refusal — leaving the member refused with no door, which is the deadlock this
    // whole issue exists to remove. With one dependent, which is the ordinary case,
    // that was every single time.
    if (feasibility === "NO_CAPACITY") {
      linked.length = 0;
      for (const dependent of stranded) {
        linked.push({
          stranded: dependent,
          target: targetOf(dependent),
          money: null,
          result: null,
        });
      }
    }

    // The supervision rule, ONCE, over the state that will really commit — with
    // full enforcement, for every booking this transaction wrote. Deferred from
    // each `modifyBookingBatch` because an intermediate state in which one of two
    // linked bookings has moved would be refused by this very rule, over a state
    // that was never going to exist.
    //
    // NOT RUN AT ALL ON THE `NO_CAPACITY` ARM, and that is a correctness rule
    // rather than an optimisation. This transaction is CERTAIN to be discarded
    // there — `"quote"` mode always throws below, and an acceptance cannot match a
    // quote built as unavailable — so the only state the rule could judge is a
    // state that will never exist. What it actually did was worse than wasteful:
    // the primary has moved in this doomed transaction and the dependent has not,
    // which is precisely the stranding the rule refuses, so the check threw the
    // bare refusal and it propagated in place of the offer. The member was
    // therefore refused with no door on exactly the arm the owner added so that
    // a full lodge would never refuse anybody. The rule still governs every
    // committing path, which is the only kind there is once beds exist for both.
    if (feasibility === "AVAILABLE") {
      // THE ENVELOPE, ONCE, NOW THAT EVERY DATE WRITE IS DONE. Each
      // `modifyBookingBatch` skipped its own flush because this caller owns the
      // end of the transaction, and it had to: `SET CONSTRAINTS ... IMMEDIATE`
      // applies for the remainder of the transaction, so the primary's flush made
      // the triggers immediate for the DEPENDENT's writes — which legitimately
      // write guest stay ranges before the booking row, the very ordering the
      // triggers are deferrable to permit. That was a 500 on the real database,
      // not a theory.
      await assertBookingEnvelopeInvariants(tx);
      // EVERY BOOKING THIS TRANSACTION WROTE, AND THE GUARD COVERS EVERY ONE OF
      // THEM. A booking written with the deferral MUST be reconciled: deferral
      // moves the supervision check, it never removes it, so a missing thunk is a
      // wiring fault and not a booking that happens not to need checking. Failing
      // loudly here rolls the whole transaction back, which is the only safe answer
      // — committing would leave a booking whose supervision state nobody judged.
      //
      // IT USED TO GUARD THE PRIMARY ONLY, with the dependents calling the thunk
      // optionally, so the very fault the guard exists to catch went undetected on
      // exactly the bookings this service exists to write. One list, one loop, no
      // optional call.
      const written = [
        { bookingId: args.bookingId, result: primary },
        ...linked.flatMap((entry) =>
          entry.result
            ? [{ bookingId: entry.stranded.bookingId, result: entry.result }]
            : [],
        ),
      ];
      for (const { bookingId, result } of written) {
        const reconcile = result.pendingHostingReconcile;
        if (!reconcile) {
          throw new Error(
            "INV-HOST-051: the linked move wrote a booking without receiving its " +
              "deferred hosting reconciliation; refusing to commit an unchecked " +
              `supervision state (booking ${bookingId}).`,
          );
        }
        await reconcile();
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
    }

    const quote = combineLinkedMoveQuote({
      primary,
      primaryId: args.bookingId,
      primaryRange,
      linked,
      bothChangeFeesCharged,
      // Whether a card-or-credit choice ALREADY travelled with this request, which
      // decides whether the offer's money sentence promises a question. In
      // `"quote"` mode without one the dependents were priced on card above.
      settlementMethodChosen: Boolean(args.input.settlementMethod),
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
      // The figure the other three cannot see: on a booking that has taken no
      // money yet all three are 0 whatever its price does.
      combinedPriceDiffCents: quote.combinedPriceDiffCents,
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
      ...linked.map((entry) => entry.result?.deferredPostCommit),
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
  }, LINKED_MOVE_TRANSACTION_BUDGET);
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
  const preTransaction = await prepareLinkedMovePreTransaction(args);
  try {
    await runLinkedDateMove(
      args,
      "quote",
      null,
      bothChangeFeesCharged,
      preTransaction,
    );
  } catch (error) {
    if (error instanceof LinkedMoveProbeComplete) {
      throw new SameOwnerCoverageLinkedMoveRequiredError(error.quote, {
        acceptStateKey: error.acceptStateKey,
        declineStateKey: error.declineStateKey,
      });
    }
    // Contention is not a fault, and it must not reach the member as one: an
    // opaque 500 here replaces the OFFER, which is the only door they had.
    if (isTransactionContention(error)) throw new LinkedDateMoveContendedError();
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
  const preTransaction = await prepareLinkedMovePreTransaction(args);
  let outcome;
  try {
    outcome = await runLinkedDateMove(
      args,
      "apply",
      args.linkedMove,
      bothChangeFeesCharged,
      preTransaction,
    );
  } catch (error) {
    if (error instanceof LinkedMoveProbeComplete) {
      throw new SameOwnerCoverageLinkedMoveRequiredError(error.quote, {
        acceptStateKey: error.acceptStateKey,
        declineStateKey: error.declineStateKey,
      });
    }
    // Nothing was committed, so "try again in a moment" is the whole truth. The
    // member's acceptance is still good: the state key is re-derived on the retry
    // from the same situation and the same figures.
    if (isTransactionContention(error)) throw new LinkedDateMoveContendedError();
    // A DEPENDENT THAT NEEDS A REFUND-OR-CREDIT CHOICE THE REQUEST DID NOT CARRY.
    // Re-raise the OFFER, which states the requirement, rather than the bare 400
    // that tells the member to choose something with no control in front of them —
    // the choice belongs to the prompt they are answering, and a dead-end 400 here
    // leaves them unable to move either booking. Nothing was committed.
    if (error instanceof BookingModificationSettlementMethodRequiredError) {
      await offerLinkedDateMove(args);
    }
    throw error;
  }

  // AFTER THE COMMIT, and only after it. Each booking's provider work — Stripe
  // refund or charge, member email, Xero settlement, superseded-intent drain,
  // audit — was deferred because this module owned the commit.
  //
  // EACH BOOKING'S WORK IS CONTAINED SEPARATELY, and that is the difference
  // between one booking's follow-up failing and the other booking's not happening
  // at all. The transaction has COMMITTED: both bookings really have moved, so a
  // failure here can never mean "the move did not happen", and re-raising it says
  // exactly that — the route answers 500, the member is told their change failed,
  // and a resubmit is refused because the acceptance no longer matches. Meanwhile
  // the SECOND booking, whose thunk was never reached, has new dates with no
  // Stripe charge for its increase, no recovery row (that enqueue lives inside the
  // thunk's own catch), no Xero leg, no audit row and no member email.
  //
  // The throw sites are ordinary reads — the member row for the email, the
  // open-financial-review check — and pool pressure straight after a long doubled
  // transaction is exactly when they fail. `booking-exception-execution.ts` is the
  // other caller that owns a commit and it contains its post-commit work for the
  // same stated reason; this follows it.
  const followUpErrors: unknown[] = [];
  for (const thunk of outcome.deferred) {
    try {
      await thunk();
    } catch (error) {
      followUpErrors.push(error);
    }
  }
  // AND A DRAIN PER MOVED BOOKING, which looks redundant beside the thunks above
  // and is not. Every `deferredPostCommit` calls `settleHostingCoverageAfterCommit`
  // as its first act, so for an ordinary run this is a second idempotent call that
  // re-reads committed facts and writes nothing. It earns its place twice: the
  // `deferred` list is FILTERED to the thunks that exist, so a moved booking whose
  // thunk was absent is reached by nothing else; and a drain that throws inside a
  // thunk takes that thunk's Stripe, Xero and email work down with it, so retrying
  // it here is the one follow-up that gets a second chance.
  for (const bookingId of outcome.movedBookingIds) {
    try {
      await settleHostingCoverageAfterCommit({ bookingId });
    } catch (error) {
      followUpErrors.push(error);
    }
  }
  if (followUpErrors.length > 0) {
    // Logged rather than surfaced, because there is nothing the member can do
    // about it and the thing they asked for did happen. The Stripe, Xero and
    // email paths each already have their own recovery or outbox backstop; what
    // this containment protects is their CHANCE TO RUN.
    logger.error(
      { errs: followUpErrors, bookingIds: outcome.movedBookingIds },
      "Linked date move committed, but post-commit follow-up work failed",
    );
  }
  return outcome.primary;
}
