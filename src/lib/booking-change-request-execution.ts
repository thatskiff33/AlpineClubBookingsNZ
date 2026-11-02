import type { Prisma } from "@prisma/client";

import logger from "@/lib/logger";
import { bookingOwner } from "@/lib/booking-owner";
import { prisma } from "@/lib/prisma";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { getDefaultLodgeId } from "@/lib/lodges";
import { calendarDateOfDateOnlyInstant, type CalendarDate } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";
import { finishedStayEligibility } from "@/lib/booking-edit-policy";
import { ApiError } from "@/lib/api-error";
import { dateOnlyInstantOf } from "@/lib/club-time";
import { paidByOrganiser } from "@/lib/group-organiser-paid";
import { promoChangeRefusalFor } from "@/lib/booking-change-request-promo-server";
import { reauthorizeBookingOfficerFromDb } from "@/lib/booking-exception-approval";
import {
  modifyBookingBatch,
  type BatchModificationPreTransaction,
} from "@/lib/booking-batch-modification-service";
import type { BookingModificationSettlementMethod } from "@/lib/booking-modify";
import { defaultCorrectionSettlementMethod } from "@/lib/booking-finished-stay-correction";
import {
  keptNightsByGuest,
  lockedPeriodRequestToBatchInput,
  storedLockedPeriodRequestSchema,
  storedRequestNamesOnlyPromoChange,
  withKeptNightsRecord,
  type StoredLockedPeriodRequest,
} from "@/lib/booking-change-request-stored";
import {
  bookingPromoCodeSnapshot,
  carriedPromoCodes,
  NOTIFY_CHOICE_PROMO_ONLY_MESSAGE,
  OFFICER_PROMO_ON_PROMO_REQUEST_MESSAGE,
  PROMO_CORRECTION_RAISES_PRICE_MESSAGE,
  promoChangeCodes,
  promoCodesDriftedFromRequest,
  withPromoChange,
  type ChangeRequestPromoChange,
  type PromoChangeStamp,
} from "@/lib/booking-change-request-promo";
import {
  checkOwnDependantIdentityForParty,
  claimedMemberPathIds,
} from "@/lib/booking-dependant-identity";
import { sameNightKeys } from "@/lib/booking-guest-stay-ranges";
import {
  addedGuestNightsRefusal,
  guestNightKeys,
  storedGuestNightsAsDays,
  OFFICER_ENTRY_DEPENDANT_TYPED_MESSAGE,
  withOfficerEnteredGuests,
  type OfficerEnteredGuest,
} from "@/lib/booking-change-request-guests";

/**
 * Approve-and-execute for a LOCKED_PERIOD change request on a FINISHED stay
 * (#3750).
 *
 * THE OWNER'S DECISION (6 Oct 2026, on #3750): approving a locked-period change
 * request on a stay that is fully past or `COMPLETED` APPLIES it — every part of
 * it: guests added, removed or swapped, and date or stay-range changes — prices
 * it, raises the payment due through the ordinary additional-payment ask, and
 * runs the ordinary settlement (Xero included). Member self-service on a finished
 * stay stays locked; this is reachable only from an officer's approval.
 *
 * WHAT THIS MODULE OWNS is the concurrency of turning the request into a
 * modification, copied in shape from the policy-exception engine
 * (`booking-exception-execution.ts`) but not reusing it: that engine needs a
 * proposal hash and frozen evidence a locked-period row never had. Everything
 * the change DOES is the canonical `modifyBookingBatch`, run on this
 * transaction under its `finishedStayCorrection` argument — one pricing home,
 * one settlement home, one email.
 *
 * Sequence, all inside one transaction:
 *
 *  1. Pre-read only the request's booking's immutable `lodgeId`, then take the
 *     global lock(1) and the per-lodge capacity lock — global -> lodge, with the
 *     member keys left to the service, which takes them after (`INV-LOCK-001`,
 *     `INV-LOCK-002`).
 *  2. Re-authorise the officer from FRESH roles (`bookings: edit`).
 *  3. Re-read the request under the locks: it must be REQUESTED, LOCKED_PERIOD
 *     and at the expected `version`, or this is a lost claim with no effect.
 *  4. Drift: the booking's dates and its guest set must still be the ones the
 *     request was written against, and its status must still be one a
 *     finished-stay correction may edit. A request about a booking that has
 *     moved since is not executed; it stays REQUESTED.
 *  5. Map the request to the canonical input. Nothing structural to apply is
 *     refused, and the request stays REQUESTED — unless the officer entered
 *     the guests a free-text request described (#4030 Part B), or a promo
 *     code on the member's behalf (#4533), which are written into the request
 *     here and mapped with it.
 *  6. Guarded claim: REQUESTED -> APPROVED with `version + 1`. A lost claim runs
 *     no side effect. An officer's entry is written by this same statement, so
 *     a request never holds officer-entered guests without the approval that
 *     applied them: any refusal after it rolls both back.
 *  7. Run `modifyBookingBatch` on THIS transaction. Any refusal it raises (a
 *     member-night clash, a missing season, an unconfirmed overbooking, a Xero
 *     lock date) rolls the claim back with it, so the request is still
 *     REQUESTED at its old version.
 *  8. Link the modification onto the request.
 *  9. AFTER commit: the service's deferred provider work — the additional
 *     PaymentIntent, Stripe refund, Xero settlement, member email and audit. A
 *     failure there is `followUpFailed`, never a failed approval: the change is
 *     already committed.
 */

/**
 * The booking must still be the one the request was written about: the same
 * dates, the same guests and, where the request stored them, each guest's same
 * nights. Anything else means somebody changed it since, and executing the
 * member's delta against a different party is how a removal lands on the wrong
 * person.
 *
 * #4030 round 7 (F1): a request carries every guest's range, unchanged ones
 * included, and approval applies them all. So a guest whose nights an officer
 * trimmed (and refunded) after the request was sent would have the stale range
 * re-applied and be charged again. A row stored before ranges were recorded
 * names none, and keeps the dates-and-ids check alone.
 *
 * #4088: where the request also stored each guest's night rows, a night
 * trimmed from inside the range since (the range unmoved) is drift too, for
 * the same reason: a grid request's night set would put it back and charge it.
 */
function bookingDriftedFromRequest(
  stored: StoredLockedPeriodRequest,
  booking: {
    checkIn: Date;
    checkOut: Date;
    guests: Array<{
      id: string;
      stayStart: Date;
      stayEnd: Date;
      nights: Array<{ stayDate: Date }>;
    }>;
    promoRedemptions: Array<{ promoCode: { code: string } | null }>;
  },
): boolean {
  if (stored.original.checkIn !== calendarDateOfDateOnlyInstant(booking.checkIn)) {
    return true;
  }
  if (stored.original.checkOut !== calendarDateOfDateOnlyInstant(booking.checkOut)) {
    return true;
  }
  const before = stored.original.guests.map((guest) => guest.id).sort();
  const now = booking.guests.map((guest) => guest.id).sort();
  if (before.length !== now.length || before.some((id, i) => id !== now[i])) {
    return true;
  }
  // #4533: a promo code applied or released since the officer entered the
  // request's promo change is drift too — approving would re-decide codes
  // against a booking nobody looked at.
  if (
    stored.original.promoCodes &&
    promoCodesDriftedFromRequest(stored.original.promoCodes, bookingPromoCodeSnapshot(booking.promoRedemptions))
  ) {
    return true;
  }
  const live = new Map(booking.guests.map((guest) => [guest.id, guest]));
  return stored.original.guests.some((guest) => {
    const current = live.get(guest.id);
    if (!current || !guest.stayStart || !guest.stayEnd) return false;
    const now = storedGuestNightsAsDays(current);
    if (guest.stayStart !== now.stayStart || guest.stayEnd !== now.stayEnd) return true;
    // A row stored before #4088 recorded no night rows: nothing to compare.
    if (guest.nights == null) return false;
    const before = guestNightKeys({ stayStart: guest.stayStart, stayEnd: guest.stayEnd, nights: guest.nights });
    return !sameNightKeys(before, guestNightKeys(now));
  });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const LOCKED_PERIOD_REQUEST_DRIFT_MESSAGE =
  "This booking has changed since the request was made, so nothing has been applied. The request is still pending: reject it with a note, or ask the member to send a new one against the booking as it stands now.";
export const LOCKED_PERIOD_REQUEST_UNREADABLE_MESSAGE =
  "This request's stored change could not be read, so nothing has been applied. The request is still pending: reject it with a note and ask the member to send a new one.";
export const LOCKED_PERIOD_REQUEST_NOTHING_TO_APPLY_MESSAGE =
  "This request names no guest, date or promo change that can be applied, so nothing has been changed. Enter the guests the member described or the promo code to apply, or reject it with a note explaining what happens next. The request is still pending.";
/** #4533 review: the booking's stay has not finished, so nothing is applied as a correction. */
export const FINISHED_STAY_NOT_FINISHED_MESSAGE =
  "This booking's stay has not finished, so approving cannot apply this request. Reload the queue; nothing has been changed and the request is still pending.";
/** #4030: an officer's entry is only for a request that names no change itself. */
export const OFFICER_ENTRY_ON_STRUCTURED_REQUEST_MESSAGE =
  "This request already names the change it asks for, so guests cannot be entered for it. Reload the queue; nothing has been changed and the request is still pending.";

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

type ExecutionDb = Pick<typeof prisma, "$transaction">;

export type LockedPeriodExecutionResult =
  | { outcome: "notFound" }
  | { outcome: "notAuthorized" }
  | { outcome: "claimLost" }
  | { outcome: "keptPending"; message: string }
  | {
      outcome: "executed";
      requestId: string;
      bookingId: string;
      requestedByMemberId: string;
      modificationId: string;
      addedGuestCount: number;
      removedGuestCount: number;
      priceDiffCents: number;
      changeFeeCents: number;
      additionalAmountCents: number;
      refundAmountCents: number;
      accountCreditAmountCents: number;
      capacityOverridden: boolean;
      /** The refund arm actually used — the officer's choice or the way it was paid. */
      settlementMethod: BookingModificationSettlementMethod;
      /** #4030: the guests the officer entered on the member's behalf, if any. */
      officerEnteredGuests: OfficerEnteredGuest[] | null;
      /** #4533: the promo change applied, with who entered it and where. */
      promoChange: { codes: string[]; enteredBy: PromoChangeStamp } | null;
      /** #4533: the officer's email choice (false only on a promo-only correction they withheld). */
      notifyMember: boolean;
      /**
       * #4533 review: whether the change email is really sent — the officer's
       * choice AND the booking's "No emails" switch off (#2259) — which is
       * what the officer's toast says.
       */
      memberEmailed: boolean;
      followUpFailed?: true;
    }
  | ({ outcome: "quoted" } & FinishedStayCorrectionFigures);

/**
 * The figures an executed approval would produce (P2 on #3955), returned by a
 * dry run: the same transaction, the same claim and the same canonical edit,
 * rolled back before commit so the officer sees exactly what approving does.
 */
export interface FinishedStayCorrectionFigures {
  priceDiffCents: number;
  changeFeeCents: number;
  additionalAmountCents: number;
  refundAmountCents: number;
  accountCreditAmountCents: number;
  capacityOverridden: boolean;
  settlementMethod: BookingModificationSettlementMethod;
}

/**
 * #4030 review C4: the money figures the officer was shown before approving.
 * An approval is applied only if the edit it runs, under the locks, produces
 * exactly these; anything else (a season rate, the capacity, the payment
 * moved since the check) refuses and rolls back, so nobody is charged a
 * figure the officer never saw.
 */
export interface FinishedStayExpectedFigures {
  additionalAmountCents: number;
  refundAmountCents: number;
  accountCreditAmountCents: number;
}

export const FINISHED_STAY_FIGURES_CHANGED_MESSAGE =
  "The figures changed since you checked them, so nothing has been applied. Check the figures again before approving; the request is still pending.";

/** Thrown to roll an approval back when its figures moved (#4030 review C4). */
export class FinishedStayFiguresChangedError extends Error {
  readonly code = "FIGURES_CHANGED";
  constructor(readonly actual: FinishedStayExpectedFigures) {
    super(FINISHED_STAY_FIGURES_CHANGED_MESSAGE);
    this.name = "FinishedStayFiguresChangedError";
  }
}

/** Thrown to roll a dry run back, carrying what it would have done. */
class FinishedStayDryRun extends Error {
  constructor(readonly figures: FinishedStayCorrectionFigures) {
    super("finished-stay correction dry run");
  }
}

/**
 * #4030 re-review of 72c933ffc: an applying approval cannot be built without
 * the figures the officer was shown. A call is either a dry run (which is how
 * those figures are produced, so it carries none) or an approval carrying them;
 * leaving them off an approval does not type-check.
 */
export type FinishedStayApprovalMode =
  | {
      /**
       * P2 on #3955: run everything — locks, claim, the canonical edit — and
       * roll it back before commit, answering `quoted` with the figures. No
       * provider work runs and nothing is written.
       */
      dryRun: true;
      expectedFigures?: never;
    }
  | {
      dryRun?: false;
      /**
       * #4030 review C4: the figures the officer's check showed. An executed
       * approval whose own figures differ is refused and rolled back.
       */
      expectedFigures: FinishedStayExpectedFigures;
    };

export async function approveAndExecuteLockedPeriodChangeRequest(params: {
  requestId: string;
  /** The `version` the officer's screen was read at; a moved row is a lost claim. */
  expectedVersion: number;
  actorMemberId: string;
  /** MEMBER-VISIBLE decision explanation (`INV-REQ-002`). */
  adminNotes: string | null;
  /** NEVER member-visible (`INV-REQ-003`). */
  internalNotes: string | null;
  /** The officer confirmed an over-capacity past night (#3750 decision 3). */
  confirmOverCapacity: boolean;
  /**
   * Where a reduction goes when the club's policy offers a choice. Absent means
   * "back the way it was paid", which is what the owner's decision names.
   */
  settlementMethod?: BookingModificationSettlementMethod;
  /** The club's day, resolved before the transaction (`INV-LOCK-004`). */
  todayAtClub: CalendarDate;
  /** The club's format, resolved before the transaction (#3565). */
  format: ClubFormat;
  /**
   * `prepareBatchModificationForCallerTransaction({ audience: "admin" })`,
   * resolved before the transaction (`INV-LOCK-004`): the member-guest policy,
   * the subscription-lockout mode and the Xero lock dates.
   */
  preTransaction: BatchModificationPreTransaction;
  ipAddress: string;
  /**
   * #4030 Part B: the guests the officer entered for a request that names no
   * change of its own (a member's free-text note). Written into the request as
   * officer-entered on the member's behalf by the claim itself, then applied
   * exactly as a member's own `addGuests` are. Refused on a request that
   * already names a change.
   */
  officerEnteredGuests?: OfficerEnteredGuest[];
  /**
   * #4533: a promo code the officer entered on the member's behalf, for a
   * request that names none. Written into the request by the claim, with the
   * booking's codes it was entered against, and applied with the rest.
   */
  officerPromoChange?: ChangeRequestPromoChange;
  /**
   * #4533: the officer's notify-or-not choice. Absent means notify; `false` is
   * honoured only when the request's one change is a promo code — a guest or
   * date change always emails the member (#4030).
   */
  notifyMember?: boolean;
  db?: ExecutionDb;
} & FinishedStayApprovalMode): Promise<LockedPeriodExecutionResult> {
  const db = params.db ?? prisma;
  const { requestId, expectedVersion, actorMemberId } = params;

  let deferredPostCommit: (() => Promise<void>) | null = null;

  const result: LockedPeriodExecutionResult = await db.$transaction(
    async (tx): Promise<LockedPeriodExecutionResult> => {
      // (1) Only the immutable lock key before the locks.
      const preRead = await tx.bookingChangeRequest.findUnique({
        where: { id: requestId },
        select: { kind: true, booking: { select: { lodgeId: true } } },
      });
      if (!preRead || preRead.kind !== "LOCKED_PERIOD") {
        return { outcome: "notFound" };
      }
      // The canonical global booking/money lock(1): executing the request is a
      // money and booking-status transition composed with a capacity re-check,
      // so it joins the global cohort FIRST — excluding a concurrent cancel,
      // capture or refund of the same booking — and then takes the per-lodge
      // key. Registered in `advisory-lock-guard.test.ts` as
      // `approveAndExecuteLockedPeriodChangeRequest#1`.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await acquireLodgeCapacityLock(
        tx,
        preRead.booking.lodgeId ?? (await getDefaultLodgeId(tx)),
      );

      // (2) Fresh roles. Nothing written yet, so a refusal is clean.
      if (!(await reauthorizeBookingOfficerFromDb(tx, actorMemberId))) {
        return { outcome: "notAuthorized" };
      }

      // (3) The request, fresh, under the locks.
      const request = await tx.bookingChangeRequest.findUnique({
        where: { id: requestId },
        select: {
          id: true,
          kind: true,
          status: true,
          version: true,
          bookingId: true,
          requestedByMemberId: true,
          requestedChanges: true,
          reason: true,
        },
      });
      if (!request || request.kind !== "LOCKED_PERIOD") {
        return { outcome: "notFound" };
      }
      if (request.status !== "REQUESTED" || request.version !== expectedVersion) {
        return { outcome: "claimLost" };
      }
      const stored = storedLockedPeriodRequestSchema.safeParse(
        request.requestedChanges,
      );
      if (!stored.success) {
        return { outcome: "keptPending", message: LOCKED_PERIOD_REQUEST_UNREADABLE_MESSAGE };
      }

      // (4) Drift, against the booking as it stands under the locks.
      const booking = await tx.booking.findUnique({
        where: { id: request.bookingId },
        select: {
          memberId: true,
          checkIn: true,
          checkOut: true,
          status: true,
          guests: {
            select: {
              id: true,
              stayStart: true,
              stayEnd: true,
              nights: { select: { stayDate: true } },
            },
          },
          payment: { select: { amountCents: true, creditAppliedCents: true, source: true } },
          // #4533: the codes the booking carries, for drift and the promo entry.
          promoRedemptions: { select: { promoCode: { select: { code: true, internal: true } } } },
          // #4533 review: who paid (the organiser-return default) and whether
          // the member can be emailed at all (the officer's toast).
          organiserSettled: true,
          parentBookingId: true,
          noEmails: true,
        },
      });
      if (!booking) return { outcome: "notFound" };
      if (bookingDriftedFromRequest(stored.data, booking)) {
        return { outcome: "keptPending", message: LOCKED_PERIOD_REQUEST_DRIFT_MESSAGE };
      }
      // The one finished-stay eligibility answer Edit Booking's offer and the
      // request route read too (`INV-SSOT-001`, #4533 review): the stay has
      // finished, and its status is one the correction edits. The service's
      // edit policy asks both again; this copy refuses before the claim, so a
      // cancelled booking's request is not even claimed.
      const eligibility = finishedStayEligibility(booking, dateOnlyInstantOf(params.todayAtClub));
      if (!eligibility.eligible) {
        return {
          outcome: "keptPending",
          message: eligibility.reason === "status" ? eligibility.message : FINISHED_STAY_NOT_FINISHED_MESSAGE,
        };
      }

      // (5) What the request asks for, in the canonical service's terms.
      const memberInput = lockedPeriodRequestToBatchInput(stored.data, booking);
      // #4030 Part B: the officer's entry, for a request that names nothing.
      const officerGuests = params.officerEnteredGuests ?? null;
      let officerRequestedChanges: Record<string, unknown> | null = null;
      // The request as this approval applies it: the member's, or with the
      // officer's entry written in.
      let appliedRequest = stored.data;
      let requestedInput = memberInput;
      if (officerGuests) {
        if (memberInput) {
          return { outcome: "keptPending", message: OFFICER_ENTRY_ON_STRUCTURED_REQUEST_MESSAGE };
        }
        // Nights inside the stay as it stands under the locks.
        const nightsRefusal = addedGuestNightsRefusal(officerGuests, {
          checkIn: calendarDateOfDateOnlyInstant(booking.checkIn),
          checkOut: calendarDateOfDateOnlyInstant(booking.checkOut),
        });
        if (nightsRefusal) {
          return {
            outcome: "keptPending",
            message: `${nightsRefusal} Nothing has been changed; the request is still pending.`,
          };
        }
        // #4030 review M4 (`INV-GUEST-019`): the one dependant-identity rule,
        // before anything is written. The officer is pointed at the finder.
        if (
          await checkOwnDependantIdentityForParty(tx, {
            bookerMemberId: bookingOwner(booking).memberId,
            party: officerGuests,
            memberPathMemberIds: claimedMemberPathIds(officerGuests),
          })
        ) {
          return { outcome: "keptPending", message: OFFICER_ENTRY_DEPENDANT_TYPED_MESSAGE };
        }
        officerRequestedChanges = withOfficerEnteredGuests(
          request.requestedChanges,
          officerGuests,
          { officerMemberId: actorMemberId, enteredAt: new Date() },
        );
        appliedRequest = storedLockedPeriodRequestSchema.parse(officerRequestedChanges);
        requestedInput = lockedPeriodRequestToBatchInput(appliedRequest, booking);
      }
      // #4533: the officer's promo code, for a request that names none. After
      // any guests, so the summary the guests' entry writes is extended, not
      // replaced; judged against the codes the booking carries under the locks.
      const officerPromo = params.officerPromoChange ?? null;
      if (officerPromo) {
        if (appliedRequest.requested.promoChange) {
          return { outcome: "keptPending", message: OFFICER_PROMO_ON_PROMO_REQUEST_MESSAGE };
        }
        const codesNow = bookingPromoCodeSnapshot(booking.promoRedemptions);
        officerRequestedChanges = withPromoChange(
          officerRequestedChanges ?? request.requestedChanges,
          officerPromo,
          { officerMemberId: actorMemberId, enteredAt: new Date(), enteredOn: "approval" },
          codesNow,
        );
        appliedRequest = storedLockedPeriodRequestSchema.parse(officerRequestedChanges);
        requestedInput = lockedPeriodRequestToBatchInput(appliedRequest, booking);
      }
      if (!requestedInput) {
        return {
          outcome: "keptPending",
          message: LOCKED_PERIOD_REQUEST_NOTHING_TO_APPLY_MESSAGE,
        };
      }
      const appliedPromoChange = appliedRequest.requested.promoChange ?? null;
      // #4533 review: the one promo rule the request route and the queue card's
      // entry read — a change never takes a booker's code off and is never a
      // change to nothing — judged against the codes carried under the locks,
      // whether the officer entered it now or with the request.
      if (appliedPromoChange) {
        const promoRefusal = await promoChangeRefusalFor(
          tx,
          appliedPromoChange,
          carriedPromoCodes(booking.promoRedemptions),
        );
        if (promoRefusal) {
          return {
            outcome: "keptPending",
            message: `${promoRefusal} Nothing has been changed; the request is still pending.`,
          };
        }
      }
      const promoOnly = storedRequestNamesOnlyPromoChange(appliedRequest, booking);
      // #4533: the email is withheld only on a promo-only correction.
      if (params.notifyMember === false && !promoOnly) {
        return { outcome: "keptPending", message: NOTIFY_CHOICE_PROMO_ONLY_MESSAGE };
      }
      const notifyMember = params.notifyMember !== false;

      // (6) The guarded claim. `version` is the optimistic token every mutating
      // write bumps; a lost claim changes nothing. The officer's entry (#4030)
      // rides the same statement, so it exists only alongside this approval,
      // and so does the record of the nights each guest kept (#4157,
      // `INV-REQ-012`) — read from the same live rows the batch input used —
      // which tells the officer's card this approval kept them.
      const recordedChanges = withKeptNightsRecord(
        officerRequestedChanges ?? request.requestedChanges,
        keptNightsByGuest(appliedRequest, booking.guests),
      );
      const claim = await tx.bookingChangeRequest.updateMany({
        where: {
          id: requestId,
          status: "REQUESTED",
          kind: "LOCKED_PERIOD",
          version: expectedVersion,
        },
        data: {
          requestedChanges: recordedChanges as Prisma.InputJsonObject,
          status: "APPROVED",
          version: { increment: 1 },
          adminNotes: params.adminNotes,
          internalNotes: params.internalNotes,
          reviewedByMemberId: actorMemberId,
          reviewedAt: new Date(),
        },
      });
      if (claim.count !== 1) return { outcome: "claimLost" };

      // (7) The canonical service, on THIS transaction. Its refusals throw and
      // roll the claim back with everything else.
      // #4533: a promo correction's reduction defaults to account credit — or,
      // on a joiner's booking the organiser paid, back to the organiser, the
      // one disposition its options offer (review finding 2).
      const settlementMethod =
        params.settlementMethod ??
        defaultCorrectionSettlementMethod(booking.payment, {
          changesPromoCodes: Boolean(appliedPromoChange),
          paidByOrganiser: paidByOrganiser(booking),
        });
      const modified = await modifyBookingBatch({
        bookingId: request.bookingId,
        actor: { id: actorMemberId, role: "ADMIN" },
        input: {
          ...requestedInput,
          ...(params.confirmOverCapacity ? { confirmOverCapacity: true } : {}),
          // P2 on #3955: the officer's choice, else back the way it was paid.
          settlementMethod,
          // Owner D1 (7 Oct 2026): an added member guest faces the rules a
          // member's own edit does — consent, family boundary, bookability, the
          // supervision review — exactly as a policy-exception approval (#2526).
          reviewedMemberProposal: true,
          // The member's own words, for a supervision review this opens.
          ...(request.reason?.trim()
            ? { memberReviewJustification: request.reason.trim() }
            : {}),
          // The member hears about the change from the canonical change email,
          // with the amount due and how to pay it. #4533: only a promo-only
          // correction may withhold it, on the officer's choice (checked above).
          notifyMember,
        },
        ipAddress: params.ipAddress,
        todayAtClub: params.todayAtClub,
        format: params.format,
        tx,
        preTransaction: params.preTransaction,
        finishedStayCorrection: { changeRequestId: requestId },
      });

      // #4533 review: a missed promo can only lower the price. A promo-only
      // correction that raises it (a working-bee discount released beside it,
      // say) is refused, in the quote as in the approval, and rolls back.
      if (promoOnly && modified.priceDiffCents > 0) {
        throw new ApiError(PROMO_CORRECTION_RAISES_PRICE_MESSAGE, 409);
      }

      if (params.dryRun) {
        throw new FinishedStayDryRun({
          priceDiffCents: modified.priceDiffCents,
          changeFeeCents: modified.changeFeeCents,
          additionalAmountCents: modified.additionalAmountCents,
          refundAmountCents: modified.refundAmountCents,
          accountCreditAmountCents: modified.accountCreditAmountCents,
          capacityOverridden: modified.capacityOverridden,
          settlementMethod,
        });
      }

      // #4030 review C4: charge only what the officer was shown. A throw rolls
      // the claim, the entry and the edit back together.
      const expected = params.expectedFigures;
      if (
        expected.additionalAmountCents !== modified.additionalAmountCents ||
        expected.refundAmountCents !== modified.refundAmountCents ||
        expected.accountCreditAmountCents !== modified.accountCreditAmountCents
      ) {
        throw new FinishedStayFiguresChangedError({
          additionalAmountCents: modified.additionalAmountCents,
          refundAmountCents: modified.refundAmountCents,
          accountCreditAmountCents: modified.accountCreditAmountCents,
        });
      }

      // (8) Join the request to what it produced, in the same transaction.
      await tx.bookingChangeRequest.update({
        where: { id: requestId },
        data: { linkedModificationId: modified.bookingModificationId },
      });

      deferredPostCommit = modified.deferredPostCommit ?? null;
      return {
        outcome: "executed",
        requestId,
        bookingId: request.bookingId,
        requestedByMemberId: request.requestedByMemberId,
        modificationId: modified.bookingModificationId,
        addedGuestCount: requestedInput.addGuests?.length ?? 0,
        removedGuestCount: requestedInput.removeGuestIds?.length ?? 0,
        priceDiffCents: modified.priceDiffCents,
        changeFeeCents: modified.changeFeeCents,
        additionalAmountCents: modified.additionalAmountCents,
        refundAmountCents: modified.refundAmountCents,
        accountCreditAmountCents: modified.accountCreditAmountCents,
        capacityOverridden: modified.capacityOverridden,
        settlementMethod,
        officerEnteredGuests: officerGuests,
        promoChange: appliedPromoChange
          ? { codes: promoChangeCodes(appliedPromoChange), enteredBy: appliedPromoChange.enteredBy }
          : null,
        notifyMember,
        memberEmailed: notifyMember && !booking.noEmails,
      };
    },
  ).catch((error: unknown) => {
    if (error instanceof FinishedStayDryRun) {
      return { outcome: "quoted" as const, ...error.figures };
    }
    throw error;
  });

  // (9) After commit. The approval and the change are already durable.
  if (result.outcome === "executed" && deferredPostCommit) {
    try {
      await (deferredPostCommit as () => Promise<void>)();
    } catch (error) {
      logger.error(
        { err: error, requestId },
        "Locked-period change request executed, but post-commit follow-up work failed",
      );
      return { ...result, followUpFailed: true };
    }
  }
  return result;
}
