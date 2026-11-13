/**
 * "Add booking to work party" (fork #119): an officer attaches an existing
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
 *  - the settlement: account credit (owner decision 6, fork #118), never a refund.
 *    A joiner's booking its group organiser paid — whose money would go back to
 *    the organiser — is refused instead (fork #119 decision 4);
 *  - the eligibility rule (`workPartyBookingEligibility`), shared with the UI;
 *  - a dry run for the confirm dialog and a figures check on the save, so the
 *    officer is charged-or-credited exactly what they were shown (#4030 C4).
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
import { defaultCorrectionSettlementMethod } from "@/lib/booking-finished-stay-correction";
import { bookingPromoRedemptions } from "@/lib/booking-promo-redemptions";
import { bookingOwner } from "@/lib/booking-owner";
import {
  activeLifecycleEditRefusal,
  bookingStayHasStarted,
} from "@/lib/booking-edit-policy";
import { isQuotePricedBooking } from "@/lib/booking-modify-validation";
import type { BookingModificationSettlementMethod } from "@/lib/booking-modify";
import { multiPromoCodesEnabled } from "@/lib/promo-redemption-slot";
import { PROMO_WORK_PARTY_EXCLUSION_MESSAGE } from "@/lib/promo-code-list-rules";
import {
  modifyBookingBatch,
  type BatchModificationPreTransaction,
} from "@/lib/booking-batch-modification-service";
import { workPartyEventRefusal } from "@/lib/work-party";

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
  /** Another (non-work-party) promo code is on the booking. */
  hasOtherPromoCode: boolean;
  /** A joiner's booking its group organiser paid (`paidByOrganiser`). */
  paidByOrganiser: boolean;
  /** A quote-priced booking (school, request quote), priced by its quote. */
  quotePriced: boolean;
  /** A member owns it (`bookingOwner`); an organisation's booking holds no credit. */
  memberOwned: boolean;
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

/**
 * Whether this booking may be added to this work party — the ONE rule the GET
 * list, the service (again, under the locks) and so the dialog all use. Each
 * refusal is one the canonical edit would make anyway, stated up front in an
 * officer's words rather than discovered at the preview, plus the owner's two
 * (fork #119 decisions 3 and 4): a started stay, and an organiser-paid joiner. The
 * editable-status answer is the edit doors' own (`activeLifecycleEditRefusal`,
 * #3245) and the event answer is `workPartyEventRefusal`; neither is copied.
 */
export function workPartyBookingEligibility(
  booking: WorkPartyEligibilityBooking,
  context: WorkPartyEligibilityContext,
  event: WorkPartyEligibilityEvent,
): WorkPartyBookingEligibility {
  if (activeLifecycleEditRefusal(booking.status, "ADMIN") !== null) {
    return {
      ok: false,
      reason: "This booking can't be changed in its current status (only a pending, confirmed or paid booking can).",
    };
  }
  if (bookingStayHasStarted(booking.checkIn, context.today)) {
    return {
      ok: false,
      reason: "This stay has already started, so its prices are fixed and a work party can't be added.",
    };
  }
  if (booking.paidByOrganiser) {
    return {
      ok: false,
      reason: "This booking was paid by its group organiser, so it can't be added to a work party.",
    };
  }
  if (!booking.memberOwned) {
    return {
      ok: false,
      reason: "This booking belongs to an organisation, which has no account credit to return the discount to.",
    };
  }
  if (booking.quotePriced) {
    return {
      ok: false,
      reason: "This booking is priced by its quote, so a work party discount can't be added.",
    };
  }
  if (booking.hasWorkParty) {
    return { ok: false, reason: "This booking already has a work party." };
  }
  if (booking.hasOtherPromoCode && !context.multiPromoCodes) {
    return { ok: false, reason: PROMO_WORK_PARTY_EXCLUSION_MESSAGE };
  }
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

/** What the correction does to the booking's money, shown before and checked on save. */
export interface WorkPartyCorrectionFigures {
  /** The booking's price before (integer cents). */
  previousFinalPriceCents: number;
  /** The booking's price after (integer cents). */
  newFinalPriceCents: number;
  /** The change in price: negative. */
  priceDiffCents: number;
  /** Paid money returned as account credit. */
  accountCreditAmountCents: number;
  /** Account credit the booking had used, given back to the member's balance. */
  appliedCreditGivenBackCents: number;
  /** Still to pay after the change (an unpaid ask's remainder), or 0. */
  additionalAmountCents: number;
  /** Always 0: organiser-paid bookings are refused, so nothing is refunded. */
  refundAmountCents: number;
  settlementMethod: BookingModificationSettlementMethod;
}

export const WORK_PARTY_CORRECTION_FIGURES_CHANGED_MESSAGE =
  "The booking changed since the figures were shown. Check the new figures and confirm again.";

export class WorkPartyCorrectionFiguresChangedError extends Error {
  readonly code = "FIGURES_CHANGED";
  constructor(readonly actual: WorkPartyCorrectionFigures) {
    super(WORK_PARTY_CORRECTION_FIGURES_CHANGED_MESSAGE);
    this.name = "WorkPartyCorrectionFiguresChangedError";
  }
}

/** Thrown to roll a dry run back, carrying what it would have done. */
class WorkPartyCorrectionDryRun extends Error {
  constructor(readonly figures: WorkPartyCorrectionFigures) {
    super("work-party correction dry run");
  }
}

export type WorkPartyCorrectionResult =
  | { outcome: "quoted"; figures: WorkPartyCorrectionFigures }
  | {
      outcome: "applied";
      figures: WorkPartyCorrectionFigures;
      bookingModificationId: string | null;
      followUpFailed?: boolean;
    };

export type WorkPartyCorrectionMode =
  | { dryRun: true; expectedFigures?: never }
  | { dryRun: false; expectedFigures: WorkPartyCorrectionFigures };

/** Every money figure the officer sees; any that moved refuses the save. */
const FIGURE_KEYS = [
  "newFinalPriceCents",
  "priceDiffCents",
  "accountCreditAmountCents",
  "appliedCreditGivenBackCents",
  "additionalAmountCents",
  "refundAmountCents",
] as const satisfies ReadonlyArray<keyof WorkPartyCorrectionFigures>;

export async function addBookingToWorkParty(
  params: {
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
  } & WorkPartyCorrectionMode,
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
        select: {
          status: true,
          checkIn: true,
          checkOut: true,
          lodgeId: true,
          memberId: true,
          finalPriceCents: true,
          organiserSettled: true,
          parentBookingId: true,
          payment: { select: { amountCents: true, creditAppliedCents: true, source: true } },
          promoRedemptions: {
            select: {
              id: true,
              applicationOrder: true,
              promoCode: {
                select: { code: true, workPartyEvent: { select: { id: true } } },
              },
            },
          },
        },
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

      const redemptions = bookingPromoRedemptions(booking);
      const eligibility = workPartyBookingEligibility(
        {
          status: booking.status,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          hasWorkParty: redemptions.some((row) => row.promoCode?.workPartyEvent),
          hasOtherPromoCode: redemptions.some((row) => row.promoCode && !row.promoCode.workPartyEvent),
          paidByOrganiser: paidByOrganiser(booking),
          quotePriced: await isQuotePricedBooking(tx, params.bookingId),
          memberOwned: Boolean(bookingOwner(booking).memberId),
        },
        {
          bookingLodgeId,
          today: dateOnlyInstantOf(params.todayAtClub),
          multiPromoCodes: await multiPromoCodesEnabled(tx),
        },
        event,
      );
      if (!eligibility.ok) throw new ApiError(eligibility.reason, 409);

      // (4) The canonical edit, on THIS transaction: the booking's codes in
      // their order, then the work party's (the promotion engine applies an
      // internal code first regardless). Its refusals throw and roll back.
      // Organiser-paid bookings were refused above, so this is always credit.
      const settlementMethod = defaultCorrectionSettlementMethod(booking.payment, {
        changesPromoCodes: true,
      });
      const modified = await modifyBookingBatch({
        bookingId: params.bookingId,
        actor: { id: params.actorMemberId, role: "ADMIN" },
        input: {
          promoCodes: [
            ...redemptions.flatMap((row) => (row.promoCode ? [{ code: row.promoCode.code }] : [])),
            { code: event.promoCode.code },
          ],
          settlementMethod,
          ...(params.notifyMember === undefined ? {} : { notifyMember: params.notifyMember }),
        },
        ipAddress: params.ipAddress,
        todayAtClub: params.todayAtClub,
        format: params.format,
        tx,
        preTransaction: params.preTransaction,
        officerWorkPartyCorrection: {
          workPartyEventId: params.workPartyEventId,
          promoCodeId: event.promoCode.id,
        },
      });

      // (5) The discount must actually have landed, and can only lower the
      // price. An in-progress stay keeps its agreed prices and runs no promo,
      // which is a refusal here rather than a silent no-op.
      const applied = await tx.promoRedemption.findFirst({
        where: { bookingId: params.bookingId, promoCodeId: event.promoCode.id },
        select: { id: true },
      });
      if (!applied || modified.promoChangeNotApplied) {
        throw new ApiError(
          modified.promoChangeNotApplied?.message ??
            "The work party discount could not be applied to this booking.",
          409,
        );
      }
      if (modified.priceDiffCents > 0) {
        throw new ApiError("Adding the work party would raise this booking's price.", 409);
      }

      const figures: WorkPartyCorrectionFigures = {
        previousFinalPriceCents: booking.finalPriceCents,
        newFinalPriceCents: modified.booking.finalPriceCents,
        priceDiffCents: modified.priceDiffCents,
        accountCreditAmountCents: modified.accountCreditAmountCents,
        appliedCreditGivenBackCents: modified.appliedCreditGivenBackCents,
        additionalAmountCents: modified.additionalAmountCents,
        refundAmountCents: modified.refundAmountCents,
        settlementMethod,
      };
      // Decision 2 (fork #119): account credit, never a refund. A refund here would
      // mean a path the eligibility rule missed; refuse rather than pay it.
      if (figures.refundAmountCents > 0) {
        throw new ApiError("This booking's change would be refunded, not credited, so it can't be added here.", 409);
      }
      if (params.dryRun) throw new WorkPartyCorrectionDryRun(figures);

      // (6) Only what the officer was shown (#4030 C4). A throw rolls it all back.
      const expected = params.expectedFigures;
      if (FIGURE_KEYS.some((key) => expected[key] !== figures[key])) {
        throw new WorkPartyCorrectionFiguresChangedError(figures);
      }

      deferredPostCommit = modified.deferredPostCommit ?? null;
      return {
        outcome: "applied",
        figures,
        bookingModificationId: modified.bookingModificationId ?? null,
      };
    })
    .catch((error: unknown) => {
      if (error instanceof WorkPartyCorrectionDryRun) {
        return { outcome: "quoted" as const, figures: error.figures };
      }
      throw error;
    });

  // (7) After commit: the edit's own follow-up work (emails, Xero dispatch).
  if (result.outcome === "applied" && deferredPostCommit) {
    try {
      await (deferredPostCommit as () => Promise<void>)();
    } catch (error) {
      logger.error(
        { err: error, bookingId: params.bookingId },
        "Booking added to a work party, but post-commit follow-up work failed",
      );
      return { ...result, followUpFailed: true };
    }
  }
  return result;
}
