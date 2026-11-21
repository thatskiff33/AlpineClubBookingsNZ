// The request body and refusal shapes of
// `POST /api/admin/bookings/[id]/confirm-pending-guests`, moved out of that route
// to keep it under its size ceiling (#5145). The schema and the overbooked-night
// reader moved verbatim; `lockedClaimRefusalBody` is the 409 body both locked
// branches (the $0 confirm and the charge claim) used to spell out in full.
import { z } from "zod";

import type { NightAvailability } from "@/lib/capacity";
import { overCapacityNights } from "@/lib/over-capacity-confirmation";
import { SAVED_CARD_CLAIM_RELEASE_DEFERRED_NOTICE } from "@/lib/saved-card-charge-claim";

export const confirmPendingGuestsSchema = z.object({
  allowOverbook: z.boolean().optional(),
  // #1769b (#1705 semantics): per-action member-email choice. This route is
  // requireAdmin()-only, so no actor gate is needed. Absent = notify (default);
  // false suppresses the confirmation email (only sent on the zero-amount and
  // charged-card outcomes). A non-boolean value is rejected with 400.
  notifyMember: z.boolean().optional(),
});

/** This 409 carries dates alone; the ONE definition supplies them (#2930). */
export const getOverbookedNightDates = (nightDetails: NightAvailability[]): string[] =>
  overCapacityNights({ nightDetails }).map((night) => night.date);

/**
 * The 409 body for a refusal a locked branch returned: its error, plus the
 * `code`, `overbookDates` and `blockedNights` it carries when it carries them.
 * `error` is optional in the type only: the callers' `"error" in` guard leaves
 * the success member in TypeScript's normalised union with `error?: undefined`,
 * exactly as the inline body this replaced read it.
 */
export function lockedClaimRefusalBody(refusal: {
  error?: string;
  code?: string;
  overbookDates?: string[];
  blockedNights?: string[];
}) {
  return {
    error: refusal.error,
    ...("code" in refusal ? { code: refusal.code } : {}),
    ...("overbookDates" in refusal
      ? { overbookDates: refusal.overbookDates }
      : {}),
    ...("blockedNights" in refusal
      ? { blockedNights: refusal.blockedNights }
      : {}),
  };
}

/**
 * The officer's 502 answer to a charge that threw with nothing captured (#5279):
 * today's wording when the release handed the booking back, and the truth when
 * it lost both attempts and the booking waits, CONFIRMED, for the confirm-pending
 * job's recovery.
 */
const CHARGE_FAILED_RETURNED_TO_PENDING_MESSAGE =
  "The card charge failed; the booking was returned to pending and admins have been alerted.";
const CHARGE_FAILED_RETURN_DEFERRED_MESSAGE = `The card charge failed and admins have been alerted. ${SAVED_CARD_CLAIM_RELEASE_DEFERRED_NOTICE}`;

export const chargeFailedMessage = (claimReleased: boolean): string =>
  claimReleased ? CHARGE_FAILED_RETURNED_TO_PENDING_MESSAGE : CHARGE_FAILED_RETURN_DEFERRED_MESSAGE;
