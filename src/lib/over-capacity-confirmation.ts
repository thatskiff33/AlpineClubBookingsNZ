import { ApiError } from "@/lib/api-error";
import type { NightAvailability } from "@/lib/capacity";
import { formatDateOnly } from "@/lib/date-only";

// Lives in its own module, NOT in @/lib/capacity: a dozen-plus test files
// blanket-mock "@/lib/capacity" with non-spreading factories, and the routes'
// instanceof checks need the real class at runtime.

export type OverCapacityNight = { date: string; availableBeds: number };

/**
 * Admin override over-capacity signal (issue #1668). Raised when target nights
 * exceed lodge capacity and the admin has not (yet) confirmed the overbooking.
 * The per-lodge capacity lock is still taken; only the availability *decision*
 * becomes warn-and-confirm. Routes translate this to a 409 with the code and
 * night list so the UI can prompt for an explicit confirm.
 */
export class OverCapacityConfirmationRequiredError extends ApiError {
  readonly code = "OVER_CAPACITY_CONFIRM_REQUIRED";
  constructor(public nightDetails: OverCapacityNight[]) {
    super(
      "The target nights are over lodge capacity. Confirm the override to proceed.",
      409,
    );
    this.name = "OverCapacityConfirmationRequiredError";
  }
}

/**
 * The over-capacity nights of a checkCapacityForGuestRanges result: the nights
 * whose availableBeds went negative (guests baked into occupancy), as
 * YYYY-MM-DD. Not valid for checkCapacity, whose availableBeds excludes the
 * proposed guests — use checkCapacityForGuestRanges under override.
 *
 * Whole-lodge-held nights (ADR-001, issue #118) are deliberately EXCLUDED: a
 * held night is pinned to availableBeds 0 (never negative) so it can never enter
 * this confirmable set. The over-capacity override must not be able to bypass an
 * exclusive hold (decision 5); held nights are reported separately by
 * wholeLodgeBlockedNights and refused via WholeLodgeHoldBlockedError.
 */
export function overCapacityNights(capacity: {
  nightDetails: NightAvailability[];
}): OverCapacityNight[] {
  return capacity.nightDetails
    .filter((night) => night.availableBeds < 0 && !night.wholeLodgeHeld)
    .map((night) => ({
      date: formatDateOnly(night.date),
      availableBeds: night.availableBeds,
    }));
}

/**
 * The whole-lodge-held nights of a capacity result (ADR-001, issue #118), as
 * YYYY-MM-DD. These are the nights an exclusive hold on another overlapping
 * booking hard-blocks. Distinct from overCapacityNights: held nights are NOT
 * confirmable — an admin who confirms the over-capacity override is still
 * refused admission onto them (decision 5).
 */
export function wholeLodgeBlockedNights(capacity: {
  nightDetails: NightAvailability[];
}): string[] {
  return capacity.nightDetails
    .filter((night) => night.wholeLodgeHeld)
    .map((night) => formatDateOnly(night.date));
}

/**
 * "There are not enough beds for this", on a path with no override to offer
 * (ADR-001 decision 6, issue #118; classed for #3232, `INV-HOST-051`).
 *
 * A SUBCLASS OF `ApiError` WITH THE SAME MESSAGE AND THE SAME 400, so nothing on
 * the wire changes: every route's generic `instanceof ApiError` branch answers it
 * exactly as it answered the bare error this replaces. What the class adds is that
 * the refusal can be RECOGNISED by a caller instead of read.
 *
 * WHY THAT MATTERS, AND IT IS NOT TIDINESS. The linked move (#3232) offers a member
 * whose second booking cannot fit on the new nights a "cannot" arm: it says so
 * plainly and offers the warn-and-continue path, because nothing about a full lodge
 * should stop a member moving their own booking. That arm is selected by asking the
 * dependent's refusal what KIND of refusal it is. The two classed capacity errors
 * below are admin-only — the member path throws before either of them is reached —
 * so keying the arm on them alone left it unreachable for the one actor who can
 * ever get there, and a full lodge refused the member with no door at all: the
 * deadlock the whole issue exists to remove. A message match would have worked
 * until somebody reworded the message; a class cannot drift (`INV-SSOT-001`,
 * prefer unrepresentable over policed).
 *
 * ONLY THE ORDINARY CAPACITY REFUSAL. The partner-shared admission's rejection
 * (#1746) stays a bare `ApiError`: it is admin-initiated by owner decision, so it
 * cannot reach a member's linked move, and its reason text is the check's own
 * rather than "there are no beds".
 */
export class InsufficientCapacityError extends ApiError {
  constructor(message: string) {
    super(message, 400);
    this.name = "InsufficientCapacityError";
  }
}

/**
 * Non-confirmable capacity refusal (ADR-001, issue #118). Raised when an admin
 * over-capacity override (`confirmOverCapacity`) would admit a guest onto a
 * night that is exclusively held for another booking. Unlike
 * OverCapacityConfirmationRequiredError there is no confirm that clears it — to
 * add anyone the admin must remove or adjust the hold (decision 5).
 *
 * This error only ever reaches admin override paths, so its message is
 * admin-facing. Members never see it: to them a held night is indistinguishable
 * from a full lodge (decision 6) and they fall through the ordinary no-space /
 * over-capacity-confirm path. It carries the blocked nights for admin surfacing
 * (issue #119).
 */
export class WholeLodgeHoldBlockedError extends ApiError {
  readonly code = "WHOLE_LODGE_HOLD_BLOCKED";
  constructor(public blockedNights: string[]) {
    super(
      "One or more nights are exclusively held for another booking and cannot be overbooked.",
      409,
    );
    this.name = "WholeLodgeHoldBlockedError";
  }
}
