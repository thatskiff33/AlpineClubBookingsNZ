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
  SameOwnerCoverageWouldBreakError,
  strandedCoverageStateKey,
  type HostingCoverageOverrideInput,
} from "@/lib/adult-member-hosting-same-owner";
import {
  modifyBookingBatch,
  type BatchModificationResponse,
} from "@/lib/booking-batch-modification-service";
import {
  modifyBookingDates,
  type DateModificationResponse,
  type ModifyBookingDatesInput,
} from "@/lib/booking-date-modification-service";
import type { BatchModifyInput } from "@/lib/booking-modify-validation";
import {
  InsufficientCapacityError,
  OverCapacityConfirmationRequiredError,
  WholeLodgeHoldBlockedError,
} from "@/lib/over-capacity-confirmation";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { ApiError } from "@/lib/api-error";
import { assertBookingEnvelopeInvariants } from "@/lib/booking-envelope-invariants";
import { BookingModificationSettlementMethodRequiredError } from "@/lib/booking-modify-settlement-required";
import type { CalendarDate } from "@/lib/club-time";
import { formatDateOnly } from "@/lib/date-only";
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

/**
 * A refusal that means "there are not beds for both", as opposed to any other
 * reason the second move could fail.
 *
 * ONLY THESE THREE, deliberately. A minimum-stay violation, a Xero lock date, a
 * member-night conflict or a membership-type policy block are not "cannot fit" —
 * they are reasons this particular linked move is wrong, and dressing them as a
 * capacity message would tell the member something false. They propagate, the
 * transaction rolls back, and the member sees the real refusal.
 *
 * `InsufficientCapacityError` IS THE ONE THAT ACTUALLY FIRES HERE, and its absence
 * made this whole arm dead code. `calculateModifiedPricing` branches on
 * `adminOverride` FIRST: the two over-capacity classes are raised only on the
 * override path, and the member path throws the plain refusal instead. A linked
 * move is reachable only for the booking's own member — an officer escalates
 * through `REQUIRE_OVERRIDE` and never gets here — so `adminOverride` is always
 * false, and keying on the classed pair alone meant a full lodge propagated a bare
 * 400 about beds on a booking the member had not asked to move, with no offer and
 * therefore no decline arm either. The two override classes are kept because an
 * admin-initiated caller supplying this service is a shape the type system allows
 * and the arm is right for it too.
 */
/**
 * The interactive-transaction budget, WIDENED because this transaction is roughly
 * two of them (`INV-LOCK-001`, `INV-LOCK-002`).
 *
 * Prisma's defaults are `maxWait: 2s / timeout: 5s`, and the wait for
 * `pg_advisory_xact_lock(1)` counts against them. Inside this one transaction:
 * that blocking global wait, the per-lodge capacity key, TWO full
 * `modifyBookingBatch` bodies (each a re-read, an eligibility pass, a pricing run,
 * a capacity check, a guest-row rewrite and a settlement), the envelope flush and
 * three supervision reconciles. On the defaults an ordinary cancel or a bed
 * assignment legitimately holding `lock(1)` would abort it — and it is the same
 * numbers `assignBedRange`, the longest-lived holder of that key in the tree,
 * already runs on, so a linked move contending with one no longer loses by
 * construction. `deleted-booking-modification-payment.ts` states the same
 * reasoning for the same reason; that caller takes a TIGHTER budget only because a
 * Stripe delivery timeout is its ceiling, and a member's save has no such ceiling.
 *
 * NOTHING IS COMMITTED WHEN IT DOES EXPIRE, which is why the caller can answer
 * "try again in a moment" honestly — see `LinkedDateMoveContendedError`.
 */
const LINKED_MOVE_TRANSACTION_BUDGET = {
  maxWait: 10_000,
  timeout: 30_000,
} as const;

/**
 * Refused because the transaction could not take its locks in time, or lost a
 * write conflict.
 *
 * P2028 covers an exhausted `maxWait`/`timeout` and P2034 a write
 * conflict/deadlock; both mean a counterpart writer legitimately held `lock(1)` or
 * the lodge key, NOTHING WAS COMMITTED, and the remedy is "again shortly" rather
 * than "differently" (`docs/CONCURRENCY_AND_LOCKING.md`). It matters more here
 * than on most paths: unmapped, contention arrives at the member as an opaque 500
 * INSTEAD OF THE OFFER, which puts them back in the state of being unable to move
 * either booking — the deadlock this whole feature exists to remove, reappearing
 * under load.
 *
 * An `ApiError` subclass so both save routes answer it through the generic branch
 * they already have, rather than each growing its own copy of the mapping.
 */
export class LinkedDateMoveContendedError extends ApiError {
  readonly code = "LINKED_MOVE_CONTENDED";
  constructor() {
    super(
      "Something else is being changed on these bookings right now, so we could not " +
        "work out the combined change in time. Nothing was changed — please try " +
        "again in a moment.",
      503,
    );
    this.name = "LinkedDateMoveContendedError";
  }
}

/**
 * Prisma's transaction contention codes.
 *
 * The same pair, for the same reason, as `waitlist-confirm/route.ts`,
 * `admin/site-style/route.ts`, `deletion-request-decision.ts` and
 * `waitlist-return-contract.ts`. It is deliberately NOT hoisted into a shared
 * module here: two of the existing copies also carry `P2002`, which is a
 * unique-constraint retry rather than contention, so unifying them is a decision
 * about those paths and not a side effect of this one.
 */
function isTransactionContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "P2028" || code === "P2034";
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
  try {
    await runLinkedDateMove(args, "quote", null, bothChangeFeesCharged);
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

/**
 * The three arms of the offer, ONCE, over whichever single-booking edit the
 * surface performs (#3232 D1).
 *
 * WHY THE ARMS ARE HERE AND NOT IN THE ROUTES. Which refusals become an offer,
 * which stay a refusal, and what accepting means are a POLICY, not a rendering
 * concern. Two date-capable member surfaces exist (`/modify` and `/modify-dates`)
 * and they run different single-booking writers, so a route that assembled the
 * policy itself would be a second copy of it — and the arm that got copied wrong
 * would be the one that either deadlocks a member or silently strands a booking
 * (`INV-SSOT-001`). The surfaces therefore differ ONLY in the writer they hand in.
 *
 * WHAT IT DOES, in order:
 *
 *  - `MOVE_BOTH` answered → the atomic two-booking move, on one settlement.
 *  - otherwise → the surface's own ordinary single-booking edit. A
 *    `LEAVE_UNCOVERED` answer travels with it, which is what turns the stranded
 *    refusal into an escalation.
 *  - and if that edit is refused because it would strand a booking the member
 *    cannot reach, the refusal is priced and re-thrown as the OFFER.
 *
 * A refusal NOT marked `linkedMoveWouldAnswer` propagates untouched, because there
 * the member has real remedies on the affected booking and today's refusal is the
 * right answer. Deciding that here rather than at the throw site is deliberate:
 * the hosting engine knows which shape of stranding it found, and this module knows
 * what can be done about it.
 */
async function withLinkedMoveArms<T>(
  args: LinkedDateMoveArgs & LinkedDateMoveAnswer,
  performSingleBookingEdit: (
    linkedMove: HostingCoverageLinkedMoveInput | null,
  ) => Promise<T>,
): Promise<T | BatchModificationResponse> {
  const { linkedMove, ...rest } = args;
  if (linkedMove?.choice === "MOVE_BOTH") {
    return applyLinkedDateMove({ ...rest, linkedMove });
  }
  try {
    return await performSingleBookingEdit(linkedMove ?? null);
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

/**
 * The batch save path's entry point (`PUT /api/bookings/[id]/modify`, #3232).
 */
export async function modifyBookingWithLinkedMoveSupport(
  args: LinkedDateMoveArgs & LinkedDateMoveAnswer,
): Promise<BatchModificationResponse> {
  return withLinkedMoveArms(args, (linkedMove) =>
    modifyBookingBatch({
      bookingId: args.bookingId,
      actor: args.actor,
      input: args.input,
      ipAddress: args.ipAddress,
      todayAtClub: args.todayAtClub,
      ...(args.hostingCoverageOverride
        ? { hostingCoverageOverride: args.hostingCoverageOverride }
        : {}),
      ...(linkedMove ? { hostingCoverageLinkedMove: linkedMove } : {}),
    }),
  );
}

/**
 * The date-only save path's entry point (`PUT /api/bookings/[id]/modify-dates`,
 * #3232 D1 applied consistently).
 *
 * WHY THIS ROUTE NEEDS IT AT ALL, which is not obvious. `modifyBookingDates` is
 * one of the three writers that now hands the seam the window the booking VACATED
 * (`INV-HOST-049`), so it is one of the writers whose dependent fan-out NOTICES the
 * booking a date move leaves behind. Noticing is the fix — but on its own it turns
 * a move that used to succeed silently into a refusal, and this is precisely the
 * refusal the owner rejected: the member cannot move the affected booking either,
 * because the same rule refuses THAT edit from the other end. Widening the read
 * here without offering the move would therefore have shipped the deadlock on a
 * live member API. Both date-capable surfaces offer all three arms or neither does.
 *
 * THE QUOTE INPUT IS DATES AND THE SETTLEMENT CHOICE, AND NOTHING ELSE. The
 * admin-only flags this route also accepts (`adminOverride`, `confirmOverCapacity`,
 * `notifyMember`) are deliberately not carried into the linked move: the offer is
 * raised only where the acting member IS the booking owner, an officer's change
 * escalates through `REQUIRE_OVERRIDE` instead and never reaches here, and an
 * over-capacity CONFIRMATION is the opposite of what the `NO_CAPACITY` arm is for.
 * Deriving the same input for the quote and for the apply is what keeps the figure
 * the member accepted the figure they are charged.
 *
 * THE MOVE-BOTH ARM ANSWERS WITH THE BATCH WRITER, and that is a real difference
 * worth stating rather than hiding: a two-booking move must happen inside ONE
 * transaction, and `modifyBookingDates` is not transaction-aware, so the atomic arm
 * necessarily prices through `modifyBookingBatch`. The property the member is owed
 * survives it, because the QUOTE they accepted came from that same engine on that
 * same pair of moves — they are never charged a figure they were not shown. Its
 * response satisfies this route's `DateModificationResponse` contract in full,
 * which is why `policyRetainedAmountCents` and `capacityOverridden` are now on
 * `BatchModificationResponse`: an arm that dropped them would have to invent money.
 */
export async function modifyBookingDatesWithLinkedMoveSupport(
  args: Omit<LinkedDateMoveArgs, "input"> &
    LinkedDateMoveAnswer & { input: ModifyBookingDatesInput },
): Promise<DateModificationResponse> {
  const quoteInput: BatchModifyInput = {
    ...(args.input.checkIn !== undefined ? { checkIn: args.input.checkIn } : {}),
    ...(args.input.checkOut !== undefined
      ? { checkOut: args.input.checkOut }
      : {}),
    ...(args.input.settlementMethod
      ? { settlementMethod: args.input.settlementMethod }
      : {}),
  };
  return withLinkedMoveArms(
    { ...args, input: quoteInput },
    (linkedMove) =>
      modifyBookingDates({
        bookingId: args.bookingId,
        actor: args.actor,
        input: args.input,
        ipAddress: args.ipAddress,
        ...(args.hostingCoverageOverride
          ? { hostingCoverageOverride: args.hostingCoverageOverride }
          : {}),
        ...(linkedMove ? { hostingCoverageLinkedMove: linkedMove } : {}),
      }),
  );
}
