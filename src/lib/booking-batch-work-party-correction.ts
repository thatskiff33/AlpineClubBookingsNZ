/**
 * Fork #119: the batch service's work-party correction argument — its type,
 * the money rule recorded with it, and the guard that keeps it on its one
 * path. Moved out of `booking-batch-modification-service.ts` (#5149: that file
 * is past its hard size ceiling); the service is still the only reader, and
 * `work-party-booking-correction.ts` the only caller that passes it, pinned by
 * `work-party-booking-correction.test.ts`.
 *
 * What the argument names: the work party an officer is adding the booking
 * to, and its internal promo, for a work party the member was entitled to and
 * missed ("Add booking to work party"). A SERVICE argument, like
 * `waiveChangeFee` and for the same reason: `input` is a parsed request body
 * on the member routes.
 *
 * It does three things and nothing else:
 *  - admits that one internal promo code (`applyPromoCodeChanges`);
 *  - charges no change fee — an officer correction, not the member's change;
 *  - returns the reduction IN FULL (`calculateFullReductionSettlementOptions`,
 *    as #4533's), untiered: what ticking the box would have given. How it
 *    settles is `input.settlementMethod`, as any edit's (fork #129).
 */
export type OfficerWorkPartyCorrection = {
  readonly workPartyEventId: string;
  readonly promoCodeId: string;
};

/** The money rule a work-party correction carries, recorded with it. */
const OFFICER_WORK_PARTY_MONEY_RULE = {
  changeFee: "none",
  reduction: "returned in full",
} as const;

/** The only request fields a work-party correction may carry. */
const OFFICER_WORK_PARTY_INPUT_KEYS: ReadonlySet<string> = new Set([
  "promoCodes",
  "settlementMethod",
  "notifyMember",
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
  return { ...correction, ...OFFICER_WORK_PARTY_MONEY_RULE };
}
