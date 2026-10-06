import type { AgeTier } from "@prisma/client";
import { z } from "zod";

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import { getDefaultLodgeId } from "@/lib/lodges";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { calendarDateOfDateOnlyInstant, type CalendarDate } from "@/lib/club-time";
import type { ClubFormat } from "@/lib/club-format";
import { activeLifecycleEditRefusal } from "@/lib/booking-edit-policy";
import { reauthorizeBookingOfficerFromDb } from "@/lib/booking-exception-approval";
import {
  modifyBookingBatch,
  type BatchModificationPreTransaction,
} from "@/lib/booking-batch-modification-service";
import type {
  BatchModifyInput,
  BookingModificationSettlementMethod,
} from "@/lib/booking-modify";

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
 *     refused, and the request stays REQUESTED.
 *  6. Guarded claim: REQUESTED -> APPROVED with `version + 1`. A lost claim runs
 *     no side effect.
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

// ---------------------------------------------------------------------------
// The stored request
// ---------------------------------------------------------------------------

const optionalDate = z.string().nullish();

/**
 * What `POST /api/bookings/[id]/change-requests` writes into
 * `requestedChanges`, read back defensively: the column is JSON and older rows
 * predate some fields, so anything this cannot parse is refused as unreadable
 * rather than half-executed.
 */
const storedLockedPeriodRequestSchema = z.object({
  original: z.object({
    checkIn: z.string(),
    checkOut: z.string(),
    guests: z.array(z.object({ id: z.string() })),
  }),
  requested: z.object({
    checkIn: optionalDate,
    checkOut: optionalDate,
    addGuests: z
      .array(
        z.object({
          firstName: z.string(),
          lastName: z.string(),
          ageTier: bookableAgeTierEnum,
          isMember: z.boolean(),
          memberId: z.string().nullish(),
          stayStart: optionalDate,
          stayEnd: optionalDate,
        }),
      )
      .default([]),
    removeGuests: z.array(z.object({ id: z.string() })).default([]),
    guestStayRanges: z
      .array(
        z.object({
          guestId: z.string(),
          stayStart: optionalDate,
          stayEnd: optionalDate,
        }),
      )
      .default([]),
  }),
});

type StoredLockedPeriodRequest = z.infer<typeof storedLockedPeriodRequestSchema>;

/**
 * The canonical batch input a stored request asks for, or `null` when it asks
 * for nothing the booking can be changed by — a request that only named an
 * effective date, or whose dates equal the booking's own.
 *
 * Exported for the executor's unit tests; the executor is its only caller.
 */
export function lockedPeriodRequestToBatchInput(
  stored: StoredLockedPeriodRequest,
  booking: { checkIn: Date; checkOut: Date },
): Pick<
  BatchModifyInput,
  "checkIn" | "checkOut" | "addGuests" | "removeGuestIds" | "guestStayRanges"
> | null {
  const currentCheckIn = calendarDateOfDateOnlyInstant(booking.checkIn);
  const currentCheckOut = calendarDateOfDateOnlyInstant(booking.checkOut);
  const { requested } = stored;
  const checkIn =
    requested.checkIn && requested.checkIn !== currentCheckIn
      ? requested.checkIn
      : undefined;
  const checkOut =
    requested.checkOut && requested.checkOut !== currentCheckOut
      ? requested.checkOut
      : undefined;
  const removeGuestIds = requested.removeGuests.map((guest) => guest.id);
  const removed = new Set(removeGuestIds);
  // A range for a guest the same request removes is moot, and the planner would
  // refuse it as naming a guest no longer on the booking.
  const guestStayRanges = requested.guestStayRanges
    .filter((range) => !removed.has(range.guestId))
    .map((range) => ({
      guestId: range.guestId,
      stayStart: range.stayStart ?? null,
      stayEnd: range.stayEnd ?? null,
    }));
  const addGuests = requested.addGuests.map((guest) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier as AgeTier,
    isMember: guest.isMember,
    ...(guest.memberId ? { memberId: guest.memberId } : {}),
    stayStart: guest.stayStart ?? null,
    stayEnd: guest.stayEnd ?? null,
  }));
  if (
    !checkIn &&
    !checkOut &&
    addGuests.length === 0 &&
    removeGuestIds.length === 0 &&
    guestStayRanges.length === 0
  ) {
    return null;
  }
  return {
    ...(checkIn ? { checkIn } : {}),
    ...(checkOut ? { checkOut } : {}),
    ...(addGuests.length > 0 ? { addGuests } : {}),
    ...(removeGuestIds.length > 0 ? { removeGuestIds } : {}),
    ...(guestStayRanges.length > 0 ? { guestStayRanges } : {}),
  };
}

/**
 * The booking must still be the one the request was written about: the same
 * dates and the same guests. Anything else means somebody changed it since, and
 * executing the member's delta against a different party is how a removal
 * lands on the wrong person.
 */
function bookingDriftedFromRequest(
  stored: StoredLockedPeriodRequest,
  booking: { checkIn: Date; checkOut: Date; guests: Array<{ id: string }> },
): boolean {
  if (stored.original.checkIn !== calendarDateOfDateOnlyInstant(booking.checkIn)) {
    return true;
  }
  if (stored.original.checkOut !== calendarDateOfDateOnlyInstant(booking.checkOut)) {
    return true;
  }
  const before = stored.original.guests.map((guest) => guest.id).sort();
  const now = booking.guests.map((guest) => guest.id).sort();
  return before.length !== now.length || before.some((id, i) => id !== now[i]);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const LOCKED_PERIOD_REQUEST_DRIFT_MESSAGE =
  "This booking has changed since the request was made, so nothing has been applied. The request is still pending: reject it with a note, or ask the member to send a new one against the booking as it stands now.";
export const LOCKED_PERIOD_REQUEST_UNREADABLE_MESSAGE =
  "This request's stored change could not be read, so nothing has been applied. The request is still pending: reject it with a note and ask the member to send a new one.";
export const LOCKED_PERIOD_REQUEST_NOTHING_TO_APPLY_MESSAGE =
  "This request names no guest or date change that can be applied, so nothing has been changed. The request is still pending: reject it with a note explaining what happens next.";

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
      followUpFailed?: true;
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
  db?: ExecutionDb;
}): Promise<LockedPeriodExecutionResult> {
  const db = params.db ?? prisma;
  const { requestId, expectedVersion, actorMemberId } = params;

  let deferredPostCommit: (() => Promise<void>) | null = null;

  const result = await db.$transaction(
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
          checkIn: true,
          checkOut: true,
          status: true,
          guests: { select: { id: true } },
        },
      });
      if (!booking) return { outcome: "notFound" };
      if (bookingDriftedFromRequest(stored.data, booking)) {
        return { outcome: "keptPending", message: LOCKED_PERIOD_REQUEST_DRIFT_MESSAGE };
      }
      // The status gate the #1668 date override uses, with the finished stay
      // admitted (`INV-SSOT-001`). The service's edit policy asks it again; this
      // copy refuses before the claim, so a cancelled booking's request is not
      // even claimed.
      const statusRefusal = activeLifecycleEditRefusal(booking.status, "ADMIN", {
        includeFinishedStay: true,
      });
      if (statusRefusal) {
        return { outcome: "keptPending", message: statusRefusal };
      }

      // (5) What the request asks for, in the canonical service's terms.
      const requestedInput = lockedPeriodRequestToBatchInput(stored.data, booking);
      if (!requestedInput) {
        return {
          outcome: "keptPending",
          message: LOCKED_PERIOD_REQUEST_NOTHING_TO_APPLY_MESSAGE,
        };
      }

      // (6) The guarded claim. `version` is the optimistic token every mutating
      // write bumps; a lost claim changes nothing.
      const claim = await tx.bookingChangeRequest.updateMany({
        where: {
          id: requestId,
          status: "REQUESTED",
          kind: "LOCKED_PERIOD",
          version: expectedVersion,
        },
        data: {
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
      const modified = await modifyBookingBatch({
        bookingId: request.bookingId,
        actor: { id: actorMemberId, role: "ADMIN" },
        input: {
          ...requestedInput,
          ...(params.confirmOverCapacity ? { confirmOverCapacity: true } : {}),
          settlementMethod: params.settlementMethod ?? "card",
          // The member hears about the change from the canonical change email,
          // with the amount due and how to pay it — never suppressed here.
          notifyMember: true,
        },
        ipAddress: params.ipAddress,
        todayAtClub: params.todayAtClub,
        format: params.format,
        tx,
        preTransaction: params.preTransaction,
        finishedStayCorrection: { changeRequestId: requestId },
      });

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
      };
    },
  );

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
