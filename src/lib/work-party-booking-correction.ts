/**
 * "Add booking to work party" (fork triyder/AlpineClubBookingsNZ#119): an officer attaches an existing
 * booking to a work party the member was entitled to and missed, so the booking
 * gets the working-bee discount exactly as if the member had ticked "I am
 * attending a working bee" when booking.
 *
 * NOT A SECOND MONEY PATH (`INV-SSOT`). The change is the canonical booking edit,
 * `modifyBookingBatch`, run on this module's own transaction with the work
 * party's internal promo added to the booking's promo list. The repricing, the
 * promo redemption and adjustment rows, the booking ledger, the Xero documents
 * and the account-credit writer are that pipeline's own. What this module adds:
 *
 *  - the officer-only admission of ONE internal code
 *    (`officerWorkPartyCorrection`, a service argument the batch service
 *    receives beside `tx`; no request body can carry it), and the money rule
 *    that comes with it — no change fee, and the reduction returned in full;
 *  - the settlement (`workPartySettlementOptions`; upstream owner decision of
 *    15 Nov 2026 on #5149, triyder/AlpineClubBookingsNZ#129 decision 5): account credit by default;
 *    wherever the ordinary edit offers a refund (any paid booking: card, or
 *    Internet Banking), the officer may choose that refund instead, which goes
 *    back the way the booking was paid — to the card, or by the bank-transfer
 *    hand-back; a joiner's booking its group organiser paid goes back to the
 *    organiser, as every edit of one does. A refund is the pipeline's own
 *    (`settlementMethod: "card"`): this module calls no provider and writes no
 *    refund row or task of its own;
 *  - the eligibility rule (`workPartyBookingEligibility`), shared with the UI
 *    and read from one set of facts (`readWorkPartyBookingFacts`). It holds
 *    owner decision 3 of 18 Nov 2026 (maintainers' comment,
 *    https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/5149#issuecomment-6951626920):
 *    an officer never adds or removes their own or their family's booking —
 *    its owner, or the organiser who paid for a joiner, and their family
 *    groups — whatever the money does; another officer must;
 *  - a dry run for the confirm dialog and a figures check on the save, so the
 *    officer is charged-or-credited exactly what they were shown (#4030 C4),
 *    the edit's own quoted-figures check (`INV-MOD-062`) included;
 *  - a started stay (fork triyder/AlpineClubBookingsNZ#127) priced whole (`INV-MOD-063`), so every night in the
 *    window is discounted, slept or not; and Remove (fork triyder/AlpineClubBookingsNZ#130), the same edit with
 *    the code taken off, its increase owed on the booking.
 *
 * LOCKS (`INV-LOCK-001`/`-002`), the order #4533's executor and every booking
 * money writer use: global `pg_advisory_xact_lock(1)` — this edit moves
 * settlement money and must exclude a concurrent cancel, capture or refund —
 * then the per-lodge capacity key from the booking's immutable `lodgeId`, then
 * the booking row, and only then the mutable re-reads. Two concurrent clicks:
 * the second waits on the global key, then re-reads a booking that already
 * carries the work party and is refused, so the discount applies once.
 */
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { getDefaultLodgeId } from "@/lib/lodges";
import { lockBookingRowForOwnerRead } from "@/lib/booking-row-lock";
import { dateOnlyInstantOf, type CalendarDate } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";
import { ApiError } from "@/lib/api-error";
import { paidByOrganiser } from "@/lib/group-organiser-paid";
import { reauthorizeBookingOfficerFromDb } from "@/lib/booking-exception-approval";
import { bookingPromoRedemptions } from "@/lib/booking-promo-redemptions";
import {
  activeLifecycleEditRefusal,
  isFinishedStay,
} from "@/lib/booking-edit-policy";
import type { BookingModificationSettlementMethod } from "@/lib/booking-modify";
import { EditPriceChangedError } from "@/lib/edit-quoted-figures";
import { multiPromoCodesEnabled } from "@/lib/promo-redemption-slot";
import { promoCodeListRefusal } from "@/lib/promo-code-list-rules";
import {
  WORK_PARTY_CORRECTION_FIGURES_CHANGED_MESSAGE,
  WORK_PARTY_FIGURES_CHANGED_CODE,
} from "@/lib/work-party-figures-changed";
import {
  modifyBookingBatch,
  type BatchModificationPreTransaction,
} from "@/lib/booking-batch-modification-service";
import { workPartyEventRefusal } from "@/lib/work-party";
import { editTotalMoneyBackCents } from "@/lib/edit-money-back";
import { readWorkPartyBookingFacts, WORK_PARTY_BOOKING_SELECT } from "@/lib/work-party-booking-facts";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";
import {
  resolveWorkPartySettlementMethod,
  workPartyAskOffset,
  workPartyDefaultSettlementMethod,
  workPartySettlementOptions,
  type WorkPartySettlementOptions,
} from "@/lib/work-party-settlement-options";

export type WorkPartyBookingEligibility =
  | { ok: true }
  | { ok: false; reason: string };

/** What the rule needs to know about the booking, read by the caller. */
export interface WorkPartyEligibilityBooking {
  status: string;
  checkIn: Date;
  checkOut: Date;
  /** A work party's internal promo is already on the booking. */
  hasWorkParty: boolean;
  /** The booking's other (non-work-party) promo codes, as stored. */
  otherPromoCodes: readonly string[];
  /** A quote-priced booking (school, request quote), priced by its quote. */
  quotePriced: boolean;
  /** A member owns it (`bookingOwner`); an organisation's booking holds no credit. */
  memberOwned: boolean;
  /** Owner decision 3: the officer is the owner or paying organiser, or in their family (`workPartyActorIsOwnerOrFamily`). */
  actorIsOwnerOrFamily: boolean;
}

/** The facts outside the booking the rule reads. */
export interface WorkPartyEligibilityContext {
  /** The booking's effective lodge (its own, or the club default). */
  bookingLodgeId: string | null;
  /** The club's today as a date-only instant (`dateOnlyInstantOf(today)`). */
  today: Date;
  /** The club's several-codes switch (`multiPromoCodesEnabled`). */
  multiPromoCodes: boolean;
}

export interface WorkPartyEligibilityEvent {
  name: string;
  active: boolean;
  startDate: Date;
  endDate: Date;
  lodgeId: string | null;
  lodge?: { name: string } | null;
  promoCode: { active: boolean; archivedAt: Date | null };
}

export const WORK_PARTY_OWN_BOOKING_MESSAGE =
  "This is your own or your family's booking, so another officer must change its work party.";

/** Said whether the dispute is still open or already lost: either way the edit holds the money (`INV-PAY-154`). */
export const WORK_PARTY_DISPUTED_PAYMENT_MESSAGE =
  "This booking's card payment is disputed, so any money back would be held for the treasurer to settle by hand. Ask the treasurer.";

export const WORK_PARTY_PAID_WITH_NO_MONEY_MESSAGE =
  "This booking is marked paid, but no money was taken (it was paid with account credit, or nothing). Cancel it, or ask the treasurer.";

/**
 * The refusals Add and Remove share: owner decision 3 (never the officer's own
 * or family's booking), the edit doors' own editable-status answer
 * (`activeLifecycleEditRefusal`, #3245) and a finished stay. A stay that has
 * started is allowed (owner decision 1 of 18 Nov 2026, maintainers' comment
 * https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/5149#issuecomment-6951626920):
 * every night inside the work party's window is repriced, slept or not
 * (`getBookingEditPolicy`'s "work-party-correction" mode).
 */
function workPartyStayRefusal(
  booking: { status: string; checkOut: Date; quotePriced: boolean; actorIsOwnerOrFamily: boolean },
  today: Date,
): string | null {
  if (booking.actorIsOwnerOrFamily) return WORK_PARTY_OWN_BOOKING_MESSAGE;
  if (activeLifecycleEditRefusal(booking.status, "ADMIN") !== null) {
    return "This booking can't be changed in its current status (only a pending, confirmed or paid booking can).";
  }
  if (isFinishedStay(booking, today)) {
    return "This stay has finished, so its work party can't be changed here.";
  }
  if (booking.quotePriced) {
    return "This booking is priced by its quote, so its work party discount can't be changed.";
  }
  return null;
}

/**
 * Whether this booking may be added to this work party — the ONE rule the GET
 * list, the service (again, under the locks) and so the dialog all use. Each
 * refusal is one the canonical edit would make anyway, stated up front in an
 * officer's words rather than discovered at the preview. A started stay is
 * allowed (fork triyder/AlpineClubBookingsNZ#127); a finished one is not. An organiser-paid joiner is allowed
 * (triyder/AlpineClubBookingsNZ#129 decision 5); the officer's own or family's booking never is (owner
 * decision 3). A disputed card payment is refused on the edit's own answer,
 * only where it would really hold money back (`refundHeldForDispute`, #5151),
 * so it is not a fact this rule reads. The event answer is
 * `workPartyEventRefusal`; it is not copied.
 */
export function workPartyBookingEligibility(
  booking: WorkPartyEligibilityBooking,
  context: WorkPartyEligibilityContext,
  event: WorkPartyEligibilityEvent,
): WorkPartyBookingEligibility {
  const stayRefusal = workPartyStayRefusal(booking, context.today);
  if (stayRefusal) return { ok: false, reason: stayRefusal };
  if (!booking.memberOwned) {
    return {
      ok: false,
      reason: "This booking belongs to an organisation, which has no account credit to return the discount to.",
    };
  }
  if (booking.hasWorkParty) {
    return { ok: false, reason: "This booking already has a work party." };
  }
  // The one list rule the edit itself asks (`promoCodeListRefusal`), in an officer's words.
  const listRefusal = promoCodeListRefusal({
    typedCodes: booking.otherPromoCodes,
    workPartyApplied: true,
    multiPromoCodes: context.multiPromoCodes,
    audience: "officer",
  });
  if (listRefusal) return { ok: false, reason: listRefusal };
  switch (
    workPartyEventRefusal(event, booking.checkIn, booking.checkOut, context.bookingLodgeId)
  ) {
    case "inactive":
      return { ok: false, reason: `"${event.name}" is not active.` };
    case "no-overlap":
      return { ok: false, reason: `None of this booking's nights fall inside "${event.name}".` };
    case "other-lodge":
      return {
        ok: false,
        reason: `"${event.name}" is held at ${event.lodge?.name ?? "another lodge"}, not this booking's lodge.`,
      };
    case null:
      return { ok: true };
  }
}

/** What "Remove from work party" (fork triyder/AlpineClubBookingsNZ#130) reads about the booking. */
export interface WorkPartyRemovalEligibilityBooking {
  status: string;
  checkOut: Date;
  quotePriced: boolean;
  /** The work party whose internal promo is on the booking, or null. */
  workPartyEventId: string | null;
  /** Owner decision 3, as for an Add. */
  actorIsOwnerOrFamily: boolean;
  /** PAID with no money taken: nothing, or account credit alone (`workPartyPaidWithNoMoneyTaken`). */
  paidWithNoMoneyTaken: boolean;
}

export const WORK_PARTY_NOT_ON_BOOKING_MESSAGE = "This booking is not on that work party.";

/**
 * Whether this booking may be taken off this work party (fork triyder/AlpineClubBookingsNZ#130; kept by
 * owner decision 2 of 18 Nov 2026): the stay rules Add has, owner decision 3
 * included, and the booking must carry exactly this work party. The event's
 * own state does not matter: an inactive work party can still be removed from
 * a booking it was added to by mistake. A booking PAID with no money taken is
 * refused: with nothing taken (owner decision, 18 Nov 2026, maintainers' comment
 * https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/5149#issuecomment-6952444211),
 * or with account credit alone (owner decision, 20 Nov 2026,
 * https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/5149#issuecomment-7035299228).
 * An Add brought it to $0 owed and gave it its beds, and a Remove would leave
 * it paid and holding them while owing what the work party took off.
 */
export function workPartyRemovalEligibility(
  booking: WorkPartyRemovalEligibilityBooking,
  context: Pick<WorkPartyEligibilityContext, "today">,
  workPartyEventId: string,
): WorkPartyBookingEligibility {
  const stayRefusal = workPartyStayRefusal(booking, context.today);
  if (stayRefusal) return { ok: false, reason: stayRefusal };
  if (booking.workPartyEventId !== workPartyEventId) {
    return { ok: false, reason: WORK_PARTY_NOT_ON_BOOKING_MESSAGE };
  }
  if (booking.paidWithNoMoneyTaken) return { ok: false, reason: WORK_PARTY_PAID_WITH_NO_MONEY_MESSAGE };
  return { ok: true };
}

/** What the correction does to the booking's money, shown before and checked on save. */
export interface WorkPartyCorrectionFigures {
  /** The booking's price before (integer cents). */
  previousFinalPriceCents: number;
  /** The booking's price after (integer cents). */
  newFinalPriceCents: number;
  /** The change in price: negative on an Add, positive on a Remove. */
  priceDiffCents: number;
  /** The edit's change fee: 0 by a correction's money rule, carried so the save checks it (#5149 review M2). */
  changeFeeCents: number;
  /** Paid money returned as account credit. */
  accountCreditAmountCents: number;
  /** A PAID booking's applied credit given back to the member's balance (#3809). */
  appliedCreditGivenBackCents: number;
  /**
   * An UNPAID booking's applied credit above its new total, returned to the
   * owner's balance by the lifecycle's clamp (F20, #1887). Never alongside
   * `appliedCreditGivenBackCents` (`edit-money-back.ts` says why).
   */
  refundedExcessCreditCents: number;
  /** Still to pay after the change (an unpaid ask's remainder), or 0. */
  additionalAmountCents: number;
  /** A Remove's increase invoiced to the group organiser, not this member (#4299), or 0. */
  billedToOrganiserCents: number;
  /**
   * Paid money refunded: to the member's card when the officer chose `card`,
   * or to the group organiser for an organiser-paid joiner; otherwise 0.
   */
  refundAmountCents: number;
  /**
   * The method the change settles by (`resolveWorkPartySettlementMethod`);
   * null on a Remove, which hands nothing back, and on an Add whose whole
   * reduction an unpaid ask took (`unpaidAskOffsetCents` with no method offered).
   */
  settlementMethod: BookingModificationSettlementMethod | null;
}

export class WorkPartyCorrectionFiguresChangedError extends Error {
  readonly code = WORK_PARTY_FIGURES_CHANGED_CODE;
  /** The fresh figures, and what may now be chosen for them (#5149 review M1). */
  constructor(
    readonly actual: WorkPartyCorrectionFigures,
    readonly settlementOptions: WorkPartySettlementOptions,
  ) {
    super(WORK_PARTY_CORRECTION_FIGURES_CHANGED_MESSAGE);
    this.name = "WorkPartyCorrectionFiguresChangedError";
  }
}

/** Thrown to roll a dry run back, carrying what it would have done. */
class WorkPartyCorrectionDryRun extends Error {
  constructor(
    readonly figures: WorkPartyCorrectionFigures,
    readonly settlementOptions: WorkPartySettlementOptions,
  ) {
    super("work-party correction dry run");
  }
}

export type WorkPartyCorrectionResult =
  | {
      outcome: "quoted";
      figures: WorkPartyCorrectionFigures;
      /** What the officer may choose between, for the confirm dialog. */
      settlementOptions: WorkPartySettlementOptions;
    }
  | {
      outcome: "applied";
      figures: WorkPartyCorrectionFigures;
      settlementOptions: WorkPartySettlementOptions;
      bookingModificationId: string | null;
      followUpFailed?: boolean;
    };

export type WorkPartyCorrectionMode =
  | { dryRun: true; expectedFigures?: never }
  | { dryRun: false; expectedFigures: WorkPartyCorrectionFigures };

/**
 * Every money figure the officer sees, and how it settles; any that moved
 * refuses the save — a changed method too (triyder/AlpineClubBookingsNZ#129), so a save is never refunded
 * where the officer was shown credit, or the reverse. A superset of the edit's
 * own four (`editQuotedFiguresSchema`, `INV-MOD-062`), which the save also runs:
 * `quotedFigures` below hands the edit the preview's price, difference and fee.
 */
const FIGURE_KEYS = [
  "newFinalPriceCents",
  "priceDiffCents",
  "changeFeeCents",
  "accountCreditAmountCents",
  "appliedCreditGivenBackCents",
  "refundedExcessCreditCents",
  "additionalAmountCents",
  "billedToOrganiserCents",
  "refundAmountCents",
  "settlementMethod",
] as const satisfies ReadonlyArray<keyof WorkPartyCorrectionFigures>;

/** What both directions take. */
export type WorkPartyCorrectionParams = {
  bookingId: string;
  workPartyEventId: string;
  actorMemberId: string;
  /** Absent means notify, as every officer edit does by default. */
  notifyMember?: boolean;
  ipAddress: string;
  /** The club's day, resolved before the transaction (`INV-LOCK-004`). */
  todayAtClub: CalendarDate;
  /** The club's format, resolved before the transaction (#3565). */
  format: ClubFormat;
  /** `prepareBatchModificationForCallerTransaction({ audience: "admin" })`. */
  preTransaction: BatchModificationPreTransaction;
} & WorkPartyCorrectionMode;

export function addBookingToWorkParty(
  params: WorkPartyCorrectionParams & {
    /**
     * The officer's choice (triyder/AlpineClubBookingsNZ#129 decision 1); absent means the default — club
     * credit, or the organiser's disposition. `card` (a refund, to the card or
     * by bank transfer) is refused (409) unless `workPartySettlementOptions`
     * offers it.
     */
    settlementMethod?: BookingModificationSettlementMethod;
  },
): Promise<WorkPartyCorrectionResult> {
  return correctWorkParty("add", params);
}

/**
 * fork triyder/AlpineClubBookingsNZ#130, kept by owner decision 2 of 18 Nov 2026 (maintainers' comment
 * https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/5149#issuecomment-6951626920):
 * Add with the work party's code left out. The difference is owed like any
 * price rise (paid: the ordinary additional ask, `INV-ADDPAY`); credit given
 * and refunds paid are left alone.
 */
export function removeBookingFromWorkParty(
  params: WorkPartyCorrectionParams,
): Promise<WorkPartyCorrectionResult> {
  return correctWorkParty("remove", params);
}

export const WORK_PARTY_REMOVAL_MONEY_BACK_MESSAGE =
  "Removing the work party would hand money back, so it can't be done here.";

/** The edit's four quoted figures (`EditQuotedFigures`), from the work party's shown ones. */
function workPartyQuotedFigures(shown: WorkPartyCorrectionFigures) {
  return {
    newFinalPriceCents: shown.newFinalPriceCents,
    priceDiffCents: shown.priceDiffCents,
    changeFeeCents: shown.changeFeeCents,
    // Before the unpaid-ask offset, as the preview reports it (`EditQuotedFigures`).
    netChargeCents: shown.priceDiffCents + shown.changeFeeCents,
  };
}

async function correctWorkParty(
  direction: "add" | "remove",
  params: WorkPartyCorrectionParams & { settlementMethod?: BookingModificationSettlementMethod },
): Promise<WorkPartyCorrectionResult> {
  let deferredPostCommit: (() => Promise<void>) | null = null;

  const result = await prisma
    .$transaction(async (tx): Promise<WorkPartyCorrectionResult> => {
      // (1) Only the immutable keys before the locks (#4845).
      const preRead = await tx.booking.findUnique({
        where: { id: params.bookingId },
        select: { lodgeId: true },
      });
      if (!preRead) throw new ApiError("Booking not found", 404);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const bookingLodgeId = preRead.lodgeId ?? (await getDefaultLodgeId(tx));
      await acquireLodgeCapacityLock(tx, bookingLodgeId);
      await lockBookingRowForOwnerRead(tx, params.bookingId);

      // (2) Fresh roles under the locks; nothing written yet.
      if (!(await reauthorizeBookingOfficerFromDb(tx, params.actorMemberId))) {
        throw new ApiError("Forbidden", 403);
      }

      // (3) The booking and the work party, fresh.
      const booking = await tx.booking.findUnique({
        where: { id: params.bookingId },
        select: WORK_PARTY_BOOKING_SELECT,
      });
      if (!booking) throw new ApiError("Booking not found", 404);
      const event = await tx.workPartyEvent.findUnique({
        where: { id: params.workPartyEventId },
        select: {
          name: true,
          active: true,
          startDate: true,
          endDate: true,
          lodgeId: true,
          lodge: { select: { name: true } },
          promoCode: {
            select: { id: true, code: true, active: true, archivedAt: true },
          },
        },
      });
      if (!event) throw new ApiError("Work party not found", 404);

      // The list's facts, re-read under the locks: owner decision 3 (the owner,
      // and for an organiser-paid joiner the organiser, and their family rows
      // as they stand now), a disputed card payment, a $0-settled booking.
      const facts = await readWorkPartyBookingFacts(tx, params.bookingId, booking, params.actorMemberId);
      const today = dateOnlyInstantOf(params.todayAtClub);
      const eligibility =
        direction === "add"
          ? workPartyBookingEligibility(
              facts.add,
              { bookingLodgeId, today, multiPromoCodes: await multiPromoCodesEnabled(tx) },
              event,
            )
          : workPartyRemovalEligibility(facts.remove, { today }, params.workPartyEventId);
      if (!eligibility.ok) throw new ApiError(eligibility.reason, 409);

      // (4) The canonical edit, on THIS transaction. Add: the booking's codes in
      // their order, then the work party's (the promotion engine applies an
      // internal code first regardless). Remove (fork triyder/AlpineClubBookingsNZ#130): the booking's
      // codes without the work party's. Its refusals throw and roll back. An
      // Add's settlement is the officer's choice among those the edit itself
      // offers (checked on its answer below); a refund it picks is the
      // pipeline's own ordinary settlement. An organiser-paid joiner's Add
      // always runs with the organiser's one disposition. A Remove hands
      // nothing back, so it carries no settlement method.
      const organiserPaid = paidByOrganiser(booking);
      const methodForEdit =
        direction === "remove"
          ? null
          : organiserPaid
            ? workPartyDefaultSettlementMethod(booking)
            : params.settlementMethod ?? workPartyDefaultSettlementMethod(booking);
      const keptCodes = bookingPromoRedemptions(booking).flatMap((row) =>
        row.promoCode && row.promoCode.code !== event.promoCode.code ? [{ code: row.promoCode.code }] : [],
      );
      const modified = await modifyBookingBatch({
        bookingId: params.bookingId,
        actor: { id: params.actorMemberId, role: "ADMIN" },
        input: {
          promoCodes: direction === "add" ? [...keptCodes, { code: event.promoCode.code }] : keptCodes,
          ...(methodForEdit === null ? {} : { settlementMethod: methodForEdit }),
          ...(params.notifyMember === undefined ? {} : { notifyMember: params.notifyMember }),
          // The edit's own check that the save matches the preview (`INV-MOD-062`),
          // at its own place before settlement (maintainers' comment D), built
          // from the figures the officer was shown.
          ...(params.dryRun ? {} : { quotedFigures: workPartyQuotedFigures(params.expectedFigures) }),
        },
        ipAddress: params.ipAddress,
        todayAtClub: params.todayAtClub,
        format: params.format,
        tx,
        preTransaction: params.preTransaction,
        officerWorkPartyCorrection: {
          workPartyEventId: params.workPartyEventId,
          promoCodeId: event.promoCode.id,
          direction,
        },
      });

      // (5) The change must actually have happened, in its one direction. A
      // stay that has finished, or any path that ran no promotion, refuses
      // here rather than saving a silent no-op.
      const onBooking = await tx.promoRedemption.findFirst({
        where: { bookingId: params.bookingId, promoCodeId: event.promoCode.id },
        select: { id: true },
      });
      if (modified.promoChangeNotApplied || Boolean(onBooking) !== (direction === "add")) {
        throw new ApiError(
          modified.promoChangeNotApplied?.message ??
            (direction === "add"
              ? "The work party discount could not be applied to this booking."
              : "The work party discount could not be removed from this booking."),
          409,
        );
      }
      if (direction === "add" ? modified.priceDiffCents > 0 : modified.priceDiffCents < 0) {
        throw new ApiError(
          direction === "add"
            ? "Adding the work party would raise this booking's price."
            : "Removing the work party would lower this booking's price.",
          409,
        );
      }

      // What the ordinary edit offers for this payment shape, on its own answer
      // (upstream owner decision, 15 Nov 2026): a method it does not offer is
      // refused here, rolling the edit back. Otherwise it is `methodForEdit`.
      // #5151 (`INV-PAY-154`): a dispute holds money this Add would hand back, on
      // the edit's own answer, so the treasurer settles it by hand; asked before
      // the method, which a hold leaves none of. An Add that hands nothing back
      // (an unpaid ask took it) holds nothing and goes ahead (#5149 review A2).
      if (direction === "add" && modified.refundHeldForDispute && editTotalMoneyBackCents(modified) > 0) {
        throw new ApiError(WORK_PARTY_DISPUTED_PAYMENT_MESSAGE, 409);
      }
      // What an unpaid ask took of an Add's reduction, on the edit's own answer:
      // all of it leaves no method to offer, as nothing comes back (B-L1 of the
      // maintainers' second comment); part of it is named (review M4).
      const settlementOptions = workPartySettlementOptions(
        booking,
        // #5212 (`INV-PAY-160`): where a refund goes is the answer the edit settled by, carried on its result.
        { asksForMethod: modified.requiresSettlementMethod, refundsToCard: modified.reductionRefundsToCard },
        direction === "add" ? workPartyAskOffset(modified) : undefined,
      );
      const settlementMethod =
        direction === "add" ? resolveWorkPartySettlementMethod(settlementOptions, params.settlementMethod, params.format) : null;
      const figures: WorkPartyCorrectionFigures = {
        previousFinalPriceCents: booking.finalPriceCents,
        newFinalPriceCents: modified.booking.finalPriceCents,
        priceDiffCents: modified.priceDiffCents,
        changeFeeCents: modified.changeFeeCents,
        accountCreditAmountCents: modified.accountCreditAmountCents,
        appliedCreditGivenBackCents: modified.appliedCreditGivenBackCents,
        refundedExcessCreditCents: modified.refundedExcessCreditCents,
        additionalAmountCents: modified.additionalAmountCents,
        billedToOrganiserCents: modified.billedToOrganiserCents,
        refundAmountCents: modified.refundAmountCents,
        settlementMethod,
      };
      if (direction === "remove") {
        // fork triyder/AlpineClubBookingsNZ#130: the money goes one way. Anything handed back is a path the
        // plan missed; refuse rather than pay it.
        if (editTotalMoneyBackCents(figures) > 0) {
          throw new ApiError(WORK_PARTY_REMOVAL_MONEY_BACK_MESSAGE, 409);
        }
      } else {
        // triyder/AlpineClubBookingsNZ#129: a refund only where it was meant — the officer chose the card
        // (`resolveWorkPartySettlementMethod` admits `card` only where offered),
        // or the organiser's money goes back to them. Any other refund is a path
        // the options missed; refuse rather than pay it.
        const refundExpected = settlementOptions.paidByOrganiser || settlementMethod === "card";
        if (figures.refundAmountCents > 0 && !refundExpected) {
          throw new ApiError("This booking's change would be refunded, not credited, so it can't be added here.", 409);
        }
      }
      if (params.dryRun) throw new WorkPartyCorrectionDryRun(figures, settlementOptions);

      // (6) Only what the officer was shown (#4030 C4). A throw rolls it all back.
      const expected = params.expectedFigures;
      if (FIGURE_KEYS.some((key) => expected[key] !== figures[key])) {
        throw new WorkPartyCorrectionFiguresChangedError(figures, settlementOptions);
      }

      deferredPostCommit = modified.deferredPostCommit ?? null;
      return {
        outcome: "applied",
        figures,
        settlementOptions,
        bookingModificationId: modified.bookingModificationId ?? null,
      };
    }, LOCK1_HOLDER_TRANSACTION_BUDGET)
    .catch(async (error: unknown): Promise<WorkPartyCorrectionResult> => {
      if (error instanceof WorkPartyCorrectionDryRun) {
        return {
          outcome: "quoted" as const,
          figures: error.figures,
          settlementOptions: error.settlementOptions,
        };
      }
      // The edit's own check (`INV-MOD-062`) refused a save whose figures moved:
      // answer as step (6) does, with the figures a fresh dry run now gives.
      if (error instanceof EditPriceChangedError && !params.dryRun) {
        const fresh = await correctWorkParty(direction, { ...params, dryRun: true, expectedFigures: undefined });
        throw new WorkPartyCorrectionFiguresChangedError(fresh.figures, fresh.settlementOptions);
      }
      throw error;
    });

  // (7) After commit: the edit's own follow-up work (emails, Xero dispatch).
  if (result.outcome === "applied" && deferredPostCommit) {
    try {
      await (deferredPostCommit as () => Promise<void>)();
    } catch (error) {
      logger.error(
        { err: error, bookingId: params.bookingId, direction },
        "Booking work party changed, but post-commit follow-up work failed",
      );
      return { ...result, followUpFailed: true };
    }
  }
  return result;
}
