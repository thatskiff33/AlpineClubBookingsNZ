import { isCapacityHoldingBookingStatus } from "@/lib/booking-status";

/**
 * Fork triyder/AlpineClubBookingsNZ#119: the batch service's work-party correction argument — its type,
 * the money rule recorded with it, and the guard that keeps it on its one
 * path. Moved out of `booking-batch-modification-service.ts` (#5149: that file
 * is past its hard size ceiling); the service is still the only reader, and
 * `work-party-booking-correction.ts` the only caller that passes it, pinned by
 * `work-party-booking-correction.test.ts`.
 *
 * What the argument names: the work party an officer is adding the booking
 * to (or, fork triyder/AlpineClubBookingsNZ#130, removing it from), and its internal promo, for a work party the member was entitled to and
 * missed ("Add booking to work party"). A SERVICE argument, like
 * `waiveChangeFee` and for the same reason: `input` is a parsed request body
 * on the member routes.
 *
 * It does three things and nothing else:
 *  - admits that one internal promo code (`applyPromoCodeChanges`);
 *  - charges no change fee — an officer correction, not the member's change;
 *  - returns the reduction IN FULL (`calculateFullReductionSettlementOptions`,
 *    as #4533's), untiered: what ticking the box would have given. How it
 *    settles is `input.settlementMethod`, as any edit's (triyder/AlpineClubBookingsNZ#129).
 */
export type OfficerWorkPartyCorrection = {
  readonly workPartyEventId: string;
  readonly promoCodeId: string;
  /** Fork triyder/AlpineClubBookingsNZ#130: "remove" drops the code instead, and the difference is owed. */
  readonly direction: "add" | "remove";
};

/** The money rule a work-party correction carries, recorded with it: an Add's, or (fork triyder/AlpineClubBookingsNZ#130) a Remove's. */
const OFFICER_WORK_PARTY_MONEY_RULE = {
  add: { changeFee: "none", reduction: "returned in full" },
  remove: { changeFee: "none", increase: "owed on the booking" },
} as const;

/**
 * The only request fields a work-party correction may carry. `quotedFigures`
 * is the save's figures check (`INV-MOD-062`), built by the correction from
 * the figures its preview showed (#5149, maintainers' comment D).
 */
const OFFICER_WORK_PARTY_INPUT_KEYS: ReadonlySet<string> = new Set([
  "promoCodes",
  "settlementMethod",
  "notifyMember",
  "quotedFigures",
]);

/**
 * The argument zeroes the fee and lifts the tier, so it must never ride a
 * date or guest change, a member's actor, or a self-committing call: those are
 * programming errors, refused before anything is read.
 */
export function assertOfficerWorkPartyCorrectionCall(call: {
  hasCallerTransaction: boolean;
  actorRole: string;
  inputKeys: readonly string[];
}): void {
  if (!call.hasCallerTransaction || call.actorRole !== "ADMIN") {
    throw new Error("A work-party correction needs an officer and a caller transaction");
  }
  const extra = call.inputKeys.filter((key) => !OFFICER_WORK_PARTY_INPUT_KEYS.has(key));
  if (extra.length > 0) {
    throw new Error(`A work-party correction carries only a promo change, not: ${extra.join(", ")}`);
  }
}

/**
 * What the modification's change row and its audit row record for a
 * work-party correction: the work party and its promo, and the money rule that
 * came with it, so the trail says why the reduction came back in full with no
 * fee.
 */
export function workPartyCorrectionRecord(correction: OfficerWorkPartyCorrection) {
  return { ...correction, ...OFFICER_WORK_PARTY_MONEY_RULE[correction.direction] };
}

/**
 * Fork triyder/AlpineClubBookingsNZ#127: the day a correction's codes are judged on. On a started stay it
 * is the check-in day, as a finished stay's are (#3750) — on the real today an
 * expired second code would be released and its discount billed back.
 */
export function workPartyCorrectionCodeDay<T extends string>(
  correction: OfficerWorkPartyCorrection | null | undefined,
  checkInDay: T,
  today: T,
): T {
  return correction && checkInDay < today ? checkInDay : today;
}

/**
 * Fork triyder/AlpineClubBookingsNZ#127/triyder/AlpineClubBookingsNZ#130: whether the pricing pass may skip the bed check. A
 * correction moves no guest or night, so a booking whose status already holds
 * its beds claims none (a started stay's slept nights, or an officer's
 * overbooking, would otherwise fail it). A booking that holds none yet, such
 * as PAYMENT_PENDING, can become PAID through the $0 auto-pay, so it takes the
 * check like any edit.
 */
export function workPartyCorrectionSkipsBedCheck(
  correction: OfficerWorkPartyCorrection | null | undefined,
  status: string,
): boolean {
  return Boolean(correction) && isCapacityHoldingBookingStatus(status);
}
