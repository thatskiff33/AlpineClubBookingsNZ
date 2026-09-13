import { formatDateOnly } from "@/lib/date-only";

/**
 * The nights a capacity refusal names, in ONE place (#2930, `INV-SSOT-001`).
 *
 * Measured against `origin/epic/2725-mad` before this module existed: ELEVEN
 * non-test files under `src/` spelled the comparison `availableBeds < 0`. FOUR
 * were byte-identical definitions of this function —
 * `booking-create-guests.ts`, `booking-request-quotes.ts`,
 * `booking-request-shared.ts`, `group-booking.ts` — reached from EIGHT call
 * sites across five modules, `school-booking-request.ts` importing the third
 * rather than holding a fifth. SIX more were inline, under no name at all: the
 * three admin overbook routes, `group-settlement.ts`, the booking-edit quote's
 * night list and the edit panel's over-capacity list. The eleventh is
 * `overCapacityNights`, a deliberately different rule (see below).
 *
 * Every one of the ten carried the same defect.
 * They filtered `availableBeds < 0` alone, and a whole-lodge-held night's
 * `availableBeds` is PINNED to 0, never negative (`INV-CAP-021`; the pin is what
 * keeps an admin over-capacity override out of a held night, ADR-001 decision
 * 5). So a refusal caused only by a hold produced an EMPTY night list while a
 * refusal caused by genuine fullness produced a populated one.
 *
 * That is a hold-privacy leak in the payload, not a cosmetic gap. The member
 * wizard renders the list it is given, so a hold-only refusal reached the member
 * as "the lodge is at capacity on **0 nights**" while an ordinary full lodge
 * named its nights — two visibly different answers to the one question
 * ADR-001 decision 6 says a member must never be able to tell apart. The 409
 * body itself differed even before a pixel was drawn.
 *
 * ## What a "full night" is
 *
 * A night the proposal cannot occupy. There are exactly two ways for that to be
 * true and the caller must not be able to tell them apart:
 *
 * - the arithmetic does not fit — `availableBeds < 0` once the proposal is
 *   subtracted; or
 * - the night is held for one group exclusively (`INV-CAP-021`), where the
 *   lodge presents as full at `availableBeds === 0` regardless of the real
 *   headcount, and the held set excludes the custodian's bed-nights
 *   (`INV-CAP-038`, #2698) without that changing how many beds there are.
 *
 * Both mean the same thing to whoever is refused: no bed here. Naming the held
 * nights is therefore not a disclosure — it is what makes the two refusals the
 * same refusal.
 *
 * ## This is NOT the admin over-capacity set
 *
 * `overCapacityNights()` in `over-capacity-confirmation.ts` deliberately
 * EXCLUDES held nights, because an admin who confirms an over-capacity override
 * still may not punch into a hold (decision 5) and a held night must never
 * appear in a confirmable list. That exclusion and this inclusion are the same
 * rule read from two ends: a held night is never negotiable, and never
 * distinguishable. Held nights reach the admin override path as
 * `wholeLodgeBlockedNights()` instead.
 *
 * Pure and import-light on purpose (the `booking-night-overlap.ts` precedent),
 * so every caller can reach it without pulling Prisma in.
 */
export function getCapacityFullNights(
  nightDetails: Array<{
    date: Date;
    availableBeds: number;
    /**
     * Optional because three of the historic call sites pass a narrowed row
     * shape. Absent is read as "not held", which is the pre-#2930 behaviour —
     * so a caller that has the flag gains the privacy property and one that
     * does not is no worse off than it was.
     */
    wholeLodgeHeld?: boolean;
  }>,
): string[] {
  return nightDetails
    .filter((night) => night.availableBeds < 0 || night.wholeLodgeHeld === true)
    .map((night) => formatDateOnly(night.date));
}
