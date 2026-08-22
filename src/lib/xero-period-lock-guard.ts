/**
 * Xero period lock-date guard (#1695 create, #1697 admin override modify,
 * #1729 ordinary date edits).
 *
 * A booking's PRIMARY Xero invoice is issue-dated at the booking's check-in
 * (getBookingInvoiceIssueDate) — on create, and again when a date edit queues
 * the invoice date/narration update (unpaid bookings) or a zero-dollar
 * recalculate creates the missing invoice. Such a write into a period locked
 * in Xero strands the outbox operation until the period is unlocked, so this
 * module rejects the triggering edit up front with an actionable message.
 *
 * Two guard scopes, deliberately asymmetric (owner decisions on #1718/#1729):
 * - The ADMIN OVERRIDE modify paths keep the CONSERVATIVE guard: every
 *   recalculate override is checked, even when the settlement would only
 *   write today-dated documents (supplementary invoices and modification
 *   credit notes are dated at the day they are raised, not at check-in) —
 *   original decision on #1697, re-affirmed and settled on #1718.
 * - ORDINARY (non-override) date edits get the NARROW guard (#1729): it fires
 *   only when the edit would actually queue the check-in-dated invoice
 *   update — issued Xero invoice, dates changing, payment not settled — via
 *   the same predicate queueXeroBookingEditSettlement classifies with
 *   (wouldQueueCheckInDatedInvoiceUpdate). Most member edits are on paid
 *   bookings; blocking those would be pure false alarm. Identity-only edits
 *   (guest name fixes) are never guarded — the outbox backstop covers that
 *   rare strand rather than blocking a typo fix.
 *
 * Semantics (shared by create and both modify scopes):
 * - Only PAST check-ins are guarded — the retroactive paths are the ones that
 *   can land documents in a closed period.
 * - Skipped when the Xero module is disabled or Xero is not connected.
 * - Fails closed when the lock dates cannot be read: the caller returns a
 *   retryable 503 rather than silently skipping the guard.
 * - Must be called OUTSIDE any DB transaction (it performs a Xero API call).
 * - Error text is actor-appropriate (#1729): admins get Xero unlock
 *   instructions, members get a "contact an administrator" message — same
 *   codes and statuses for both audiences.
 */

import { ApiError } from "@/lib/api-error";
// hasIssuedPrimaryXeroInvoice is the same derivation applyPaymentAdjustments
// feeds queueXeroBookingEditSettlement (#1729): settled-lifecycle status plus
// a payment row carrying the Xero invoice id.
import { hasIssuedPrimaryXeroInvoice } from "@/lib/booking-payment-state";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { wouldQueueCheckInDatedInvoiceUpdate } from "@/lib/xero-booking-edit-conditions";
// The source domain module, not the @/lib/xero facade (#1208 lint rule).
import { isXeroConnected } from "@/lib/xero-token-store";
import { getXeroErrorStatusCode } from "@/lib/xero-error-shape";
import {
  getEffectiveXeroLockDate,
  getXeroLockDates,
} from "@/lib/xero-organisation";

/**
 * Which actor sees the guard's error text (#1729). "admin" (the default)
 * keeps the original unlock-instructions messages; "member" swaps in
 * contact-an-administrator wording a member can act on. Codes and statuses
 * are identical for both audiences.
 */
export type XeroLockGuardAudience = "admin" | "member";

export class XeroPeriodLockedError extends ApiError {
  readonly code = "XERO_PERIOD_LOCKED";
  constructor(
    readonly lockDate: string,
    audience: XeroLockGuardAudience = "admin",
  ) {
    super(
      audience === "member"
        ? "These dates fall in an accounting period that has been locked in Xero. Please contact an administrator to make this change."
        : `The check-in date falls on or before the Xero lock date (${lockDate}). Unlock the period in Xero (Settings → Advanced → Financial settings → Lock dates) or choose a later check-in.`,
      409,
    );
    this.name = "XeroPeriodLockedError";
  }
}

/**
 * Why the lock-date check failed closed (#2105). Surfaced to admins only (in the
 * error body and copy); member-facing wording never discloses it.
 * - "reconnect_required": the Xero connection needs re-authorising (revoked /
 *   missing token or tenant) — an admin must reconnect before retrying.
 * - "rate_limited": Xero's daily API budget is exhausted; retrying now cannot
 *   succeed until the cooldown clears.
 * - "transient": a temporary outage or unclassified failure — retry may work.
 */
export type XeroLockDateCheckFailureReason =
  | "reconnect_required"
  | "rate_limited"
  | "transient";

function buildLockDateCheckFailedMessage(
  audience: XeroLockGuardAudience,
  reason: XeroLockDateCheckFailureReason,
  retryAfterSec?: number,
): string {
  // Members get the same generic wording for every cause — deliberate
  // non-disclosure of the organisation's Xero connection state.
  if (audience === "member") {
    return "We couldn't confirm this change can be saved right now. Please try again, or contact an administrator.";
  }
  switch (reason) {
    case "reconnect_required":
      return "Could not verify the Xero lock dates because the Xero connection needs re-authorising. Reconnect Xero (Admin → Xero → Setup), then try again.";
    case "rate_limited": {
      if (retryAfterSec && retryAfterSec > 0) {
        const hours = Math.max(1, Math.round(retryAfterSec / 3600));
        return `Could not verify the Xero lock dates because Xero's daily API limit has been reached. Please try again in about ${hours} hour${hours === 1 ? "" : "s"}.`;
      }
      return "Could not verify the Xero lock dates because Xero's daily API limit has been reached. Please try again tomorrow.";
    }
    case "transient":
    default:
      return "Could not verify the Xero lock dates. Please try again.";
  }
}

export class XeroLockDateCheckFailedError extends ApiError {
  readonly code = "XERO_LOCK_DATE_CHECK_FAILED";
  readonly audience: XeroLockGuardAudience;
  readonly reason: XeroLockDateCheckFailureReason;
  constructor(
    audience: XeroLockGuardAudience = "admin",
    reason: XeroLockDateCheckFailureReason = "transient",
    retryAfterSec?: number,
  ) {
    super(buildLockDateCheckFailedMessage(audience, reason, retryAfterSec), 503);
    this.name = "XeroLockDateCheckFailedError";
    this.audience = audience;
    this.reason = reason;
  }
}

/**
 * Classify a lock-date fetch failure into the audience-appropriate
 * XeroLockDateCheckFailedError. Name-keyed (not instanceof) so the guard stays
 * decoupled from xero-api-client's module graph and easy to unit-test.
 */
function classifyXeroLockDateCheckFailure(
  error: unknown,
  audience: XeroLockGuardAudience | undefined,
): XeroLockDateCheckFailedError {
  if (error instanceof Error && error.name === "XeroReconnectRequiredError") {
    return new XeroLockDateCheckFailedError(audience, "reconnect_required");
  }
  if (error instanceof Error && error.name === "XeroDailyLimitError") {
    const retryAfterSec = (error as { retryAfterSec?: number }).retryAfterSec;
    return new XeroLockDateCheckFailedError(audience, "rate_limited", retryAfterSec);
  }
  // A live 401/403 from the org read (token revoked in Xero's UI before the
  // pre-expiry refresh window trips) arrives as a raw API error, not a
  // reconnect-classed one — same status fallback as getXeroApiErrorInfo.
  const statusCode = getXeroErrorStatusCode(error);
  if (statusCode === 401 || statusCode === 403) {
    return new XeroLockDateCheckFailedError(audience, "reconnect_required");
  }
  return new XeroLockDateCheckFailedError(audience, "transient");
}

/**
 * Response body + status for the two guard errors, or null for anything else.
 */
export function getXeroLockGuardErrorResponse(error: unknown): {
  body: {
    error: string;
    code: string;
    lockDate?: string;
    reason?: XeroLockDateCheckFailureReason;
  };
  status: number;
} | null {
  if (error instanceof XeroPeriodLockedError) {
    return {
      body: { error: error.message, code: error.code, lockDate: error.lockDate },
      status: error.status,
    };
  }
  if (error instanceof XeroLockDateCheckFailedError) {
    return {
      body: {
        error: error.message,
        code: error.code,
        // The failure cause is disclosed to admins only (#2105): member bodies
        // stay exactly as before so they leak no Xero connection state.
        ...(error.audience === "admin" ? { reason: error.reason } : {}),
      },
      status: error.status,
    };
  }
  return null;
}

/**
 * Throws XeroPeriodLockedError when a past check-in falls on or before the
 * effective Xero lock date, and XeroLockDateCheckFailedError when the lock
 * dates cannot be read. Resolves silently in every skip case (future or
 * invalid check-in, module off, not connected, no lock date set).
 *
 * Pass options.xeroIntegrationEnabled when the caller has already loaded the
 * module flags, to avoid a second settings read. options.audience selects the
 * error wording (#1729); it defaults to the admin unlock-instructions text.
 */
export async function assertCheckInClearsXeroLockDate(
  checkIn: Date,
  options?: {
    xeroIntegrationEnabled?: boolean;
    audience?: XeroLockGuardAudience;
  },
): Promise<void> {
  // An unparseable date is the normal validation path's rejection to make.
  if (Number.isNaN(checkIn.getTime())) return;
  if (checkIn >= dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()))) return;

  const xeroIntegrationEnabled =
    options?.xeroIntegrationEnabled ??
    (await loadEffectiveModuleFlags()).xeroIntegration;
  if (!xeroIntegrationEnabled || !(await isXeroConnected())) return;

  let lockDates;
  try {
    lockDates = await getXeroLockDates();
  } catch (error) {
    throw classifyXeroLockDateCheckFailure(error, options?.audience);
  }
  const effectiveLock = getEffectiveXeroLockDate(lockDates);
  if (effectiveLock && checkIn <= effectiveLock) {
    throw new XeroPeriodLockedError(
      formatDateOnly(effectiveLock),
      options?.audience,
    );
  }
}

/**
 * Modify-path variant (#1697): resolves the check-in the booking would END UP
 * with — the requested new check-in when one was sent, otherwise the booking's
 * current check-in (a check-out-only recalculate still re-dates its Xero
 * documents at the unchanged past check-in). Reads the booking OUTSIDE the
 * modification transaction; a missing booking or unparseable date resolves
 * silently and leaves the rejection to the transaction path.
 */
export async function assertProposedCheckInClearsXeroLockDate(
  db: {
    booking: {
      findUnique(args: {
        where: { id: string };
        select: { checkIn: true };
      }): Promise<{ checkIn: Date } | null>;
    };
  },
  bookingId: string,
  requestedCheckIn: string | undefined,
): Promise<void> {
  let proposedCheckIn: Date;
  if (requestedCheckIn !== undefined) {
    proposedCheckIn = parseDateOnly(requestedCheckIn);
  } else {
    const booking = await db.booking.findUnique({
      where: { id: bookingId },
      select: { checkIn: true },
    });
    if (!booking) return;
    proposedCheckIn = booking.checkIn;
  }
  await assertCheckInClearsXeroLockDate(proposedCheckIn);
}

/** The light booking row the ordinary-edit guard (#1729) evaluates. */
export type XeroLockGuardDateEditBooking = {
  checkIn: Date;
  checkOut: Date;
  status: string;
  payment: { status: string; xeroInvoiceId: string | null } | null;
};

/**
 * Ordinary (non-override) date-edit variant (#1729), for callers that already
 * hold the booking with its payment. NARROW, unlike the override guard: it
 * consults the lock dates only when this edit would actually queue the
 * check-in-dated invoice date/narration update — the booking has an issued
 * Xero invoice, a requested date differs from the stored one, and the payment
 * is not settled — via the same wouldQueueCheckInDatedInvoiceUpdate predicate
 * queueXeroBookingEditSettlement classifies with, so guard and settlement can
 * never drift. Requests without date fields (identity-only edits) never reach
 * the lock-date check by construction (no date field ⇒ no date change).
 *
 * The check-in asserted is the one the booking would END UP with
 * (requested ?? stored): a check-out-only edit still re-dates the invoice at
 * the unchanged past check-in. Any unparseable requested date field resolves
 * silently — malformed input is the caller's own date validation's 400 to
 * make, never a lock-date 409.
 */
export async function assertDateEditClearsXeroLockDate(
  booking: XeroLockGuardDateEditBooking,
  requested: { checkIn?: string; checkOut?: string },
  options?: { audience?: XeroLockGuardAudience },
): Promise<void> {
  const requestedCheckIn = requested.checkIn
    ? parseDateOnly(requested.checkIn)
    : null;
  const requestedCheckOut = requested.checkOut
    ? parseDateOnly(requested.checkOut)
    : null;
  if (
    (requestedCheckIn !== null && Number.isNaN(requestedCheckIn.getTime())) ||
    (requestedCheckOut !== null && Number.isNaN(requestedCheckOut.getTime()))
  ) {
    return;
  }
  const datesChanged =
    (requestedCheckIn !== null &&
      requestedCheckIn.getTime() !== booking.checkIn.getTime()) ||
    (requestedCheckOut !== null &&
      requestedCheckOut.getTime() !== booking.checkOut.getTime());
  const wouldQueueCheckInDatedWrite = wouldQueueCheckInDatedInvoiceUpdate({
    hasIssuedXeroInvoice: hasIssuedPrimaryXeroInvoice(booking),
    originalPaymentStatus: booking.payment?.status ?? null,
    datesChanged,
    // Identity-only edits stay unguarded by owner decision (#1729): the
    // outbox backstop covers that rare strand rather than blocking a typo fix.
    guestIdentityChanged: false,
  });
  if (!wouldQueueCheckInDatedWrite) return;

  await assertCheckInClearsXeroLockDate(requestedCheckIn ?? booking.checkIn, {
    audience: options?.audience,
  });
}

/**
 * Ordinary-edit variant of the pre-transaction read (#1729): loads the light
 * booking row OUTSIDE the modification transaction and delegates to
 * assertDateEditClearsXeroLockDate. Returns immediately — without even the
 * read — when the request carries no date fields (identity-only edits are
 * never guarded), and resolves silently for a missing booking (the
 * transaction path 404s). Member-audience requests on a booking the actor
 * does not own also resolve silently (PR #1748 review): the transaction path
 * 403s them, and rejecting here first would disclose the booking's
 * unpaid-invoice state and the organisation's lock date to a non-owner.
 * As with the override variant, the pre-read is only advisory: the outbox
 * still fails safely if the lock dates change mid-flight.
 */
export async function assertProposedDateEditClearsXeroLockDate(
  db: {
    booking: {
      findUnique(args: {
        where: { id: string };
        select: {
          checkIn: true;
          checkOut: true;
          status: true;
          memberId: true;
          payment: { select: { status: true; xeroInvoiceId: true } };
        };
      }): Promise<
        (XeroLockGuardDateEditBooking & { memberId: string }) | null
      >;
    };
  },
  bookingId: string,
  requested: { checkIn?: string; checkOut?: string },
  options?: { audience?: XeroLockGuardAudience; actorMemberId?: string },
): Promise<void> {
  if (!requested.checkIn && !requested.checkOut) return;
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      checkIn: true,
      checkOut: true,
      status: true,
      memberId: true,
      payment: { select: { status: true, xeroInvoiceId: true } },
    },
  });
  if (!booking) return;
  // The absent-audience default is "admin", matching the assertion helpers'
  // own default (the override callers rely on it).
  if (
    (options?.audience ?? "admin") === "member" &&
    booking.memberId !== options?.actorMemberId
  ) {
    return;
  }
  await assertDateEditClearsXeroLockDate(booking, requested, options);
}
