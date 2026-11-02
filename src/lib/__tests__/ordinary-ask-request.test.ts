import { describe, expect, it } from "vitest";

import {
  ADDITIONAL_ASK_INTENT_TYPE,
  DOOR_INTENT_CLOCK_SKEW_MS,
  ORDINARY_ASK_RECOVERY_REASON,
  couldRecoveryRowOwnIntent,
  isIntentForOrdinaryAskPlan,
  latestAdoptableIntentCreatedAt,
  ordinaryAskDoorRequest,
  ordinaryAskReasonForStripeKey,
  planOrdinaryAskMint,
  type OrdinaryAskDoor,
} from "@/lib/ordinary-ask-request";

/*
  #4036: an ordinary edit's price ask is ONE Stripe request, whichever of its
  door and its recovery replay sends it. Stripe refuses a key replayed with
  other parameters (`idempotency_error`), so these pin that the two plans are
  equal, and that each door's key and reason are the spellings the previous
  release's door sent - a row it wrote replays under them.
*/

const BOOKING = "bk_4036";
const EDIT = "mod_4036";

// The spellings every release before #4036 sent, door by door. A rename here
// would make every row the previous release wrote replay with other parameters.
const DOORS_AS_SHIPPED: Record<OrdinaryAskDoor, { idempotencyKey: string; reason: string }> = {
  guestAdd: { idempotencyKey: `mod_guest_${BOOKING}_${EDIT}`, reason: "guest_add_price_increase" },
  guestRemoval: { idempotencyKey: `mod_guest_remove_${BOOKING}_${EDIT}`, reason: "guest_removal_price_increase" },
  dateChange: { idempotencyKey: `mod_dates_${BOOKING}_${EDIT}`, reason: "date_change_price_increase" },
  batchModify: { idempotencyKey: `mod_batch_${BOOKING}_${EDIT}`, reason: "batch_modify_price_increase" },
  guestConsentRemoval: { idempotencyKey: `mod_guest_consent_${BOOKING}_${EDIT}`, reason: "guest_consent_removal_reissued_ask" },
  guestAcceptanceReprice: {
    idempotencyKey: `guest_accept_${BOOKING}_${EDIT}`,
    reason: "guest_accepted_promo_reprice_reissued_ask",
  },
};

describe("ordinaryAskDoorRequest (#4036)", () => {
  it.each(Object.entries(DOORS_AS_SHIPPED))("%s keeps the key and reason its door has always sent", (door, shipped) => {
    expect(ordinaryAskDoorRequest(door as OrdinaryAskDoor, BOOKING, EDIT)).toEqual(shipped);
  });
});

describe("ordinaryAskReasonForStripeKey (#4036)", () => {
  it.each(Object.entries(DOORS_AS_SHIPPED))("names %s's reason from its key", (_door, shipped) => {
    expect(ordinaryAskReasonForStripeKey(shipped.idempotencyKey, BOOKING, EDIT)).toBe(shipped.reason);
  });

  it("matches the whole key, never a prefix: the guest-removal key is not read as the guest-add door's", () => {
    expect(ordinaryAskReasonForStripeKey(`mod_guest_remove_${BOOKING}_${EDIT}`, BOOKING, EDIT)).toBe(
      "guest_removal_price_increase",
    );
    // Another edit's key under the same prefix names no door for this one.
    expect(ordinaryAskReasonForStripeKey(`mod_guest_${BOOKING}_mod_other`, BOOKING, EDIT)).toBe(
      ORDINARY_ASK_RECOVERY_REASON,
    );
  });

  it("falls back to the runner's historic reason for a key no door builds, or with no edit to rebuild it from", () => {
    expect(ordinaryAskReasonForStripeKey("some_other_key", BOOKING, EDIT)).toBe(ORDINARY_ASK_RECOVERY_REASON);
    expect(ordinaryAskReasonForStripeKey(`mod_guest_${BOOKING}_${EDIT}`, BOOKING, null)).toBe(
      ORDINARY_ASK_RECOVERY_REASON,
    );
    expect(ORDINARY_ASK_RECOVERY_REASON).toBe("modification_additional_recovery");
  });
});

describe("planOrdinaryAskMint (#4036)", () => {
  const door = ordinaryAskDoorRequest("dateChange", BOOKING, EDIT);

  it("the door's plan and its recovery's replay of the same ask are the same request", () => {
    const atDoor = planOrdinaryAskMint({
      bookingId: BOOKING,
      bookingModificationId: EDIT,
      stripeKey: door.idempotencyKey,
      frozenAmountCents: 6_000,
      amountCents: 6_000,
    });
    // The runner reads the key and the figure back off the recovery row.
    const replay = planOrdinaryAskMint({
      bookingId: BOOKING,
      bookingModificationId: EDIT,
      stripeKey: door.idempotencyKey,
      frozenAmountCents: 6_000,
      amountCents: 6_000,
    });
    expect(replay).toEqual(atDoor);
    expect(atDoor).toEqual({
      bookingId: BOOKING,
      amountCents: 6_000,
      idempotencyKey: door.idempotencyKey,
      metadata: { bookingId: BOOKING, type: ADDITIONAL_ASK_INTENT_TYPE, reason: door.reason },
    });
    // The order the door has always sent its metadata in.
    expect(Object.keys(atDoor.metadata)).toEqual(["bookingId", "type", "reason"]);
  });

  it("a replay whose re-derived amount moved is a different request, under a key naming the amount", () => {
    const moved = planOrdinaryAskMint({
      bookingId: BOOKING,
      bookingModificationId: EDIT,
      stripeKey: door.idempotencyKey,
      frozenAmountCents: 6_000,
      amountCents: 3_000,
    });
    expect(moved.idempotencyKey).toBe(`${door.idempotencyKey}_3000`);
    expect(moved.amountCents).toBe(3_000);
    expect(moved.metadata.reason).toBe(door.reason);
  });
});

describe("isIntentForOrdinaryAskPlan (#4036)", () => {
  const plan = planOrdinaryAskMint({
    bookingId: BOOKING,
    bookingModificationId: EDIT,
    stripeKey: ordinaryAskDoorRequest("guestAdd", BOOKING, EDIT).idempotencyKey,
    frozenAmountCents: 6_000,
    amountCents: 6_000,
  });
  // The recovery row was written when the door's create failed; the door's
  // intent was created no later.
  const ROW_AT = new Date("2026-06-30T00:00:00.000Z");
  const atRow = ROW_AT.getTime() / 1000;
  const ROW = { id: "op_this_row", createdAt: ROW_AT };
  const minted = {
    amount: 6_000,
    currency: "nzd",
    status: "requires_payment_method",
    created: atRow - 1,
    metadata: { bookingId: BOOKING, type: ADDITIONAL_ASK_INTENT_TYPE, reason: "guest_add_price_increase" },
  };

  it("matches the door's intent", () => {
    expect(isIntentForOrdinaryAskPlan(minted, plan, "nzd", ROW)).toBe(true);
  });

  it.each([
    ["another booking", { metadata: { ...minted.metadata, bookingId: "bk_other" } }],
    ["not an additional ask", { metadata: { ...minted.metadata, type: "booking" } }],
    ["another door's reason", { metadata: { ...minted.metadata, reason: "date_change_price_increase" } }],
    ["another amount", { amount: 5_000 }],
    ["another currency", { currency: "aud" }],
    ["cancelled", { status: "canceled" }],
    ["already paid", { status: "succeeded" }],
    ["no metadata", { metadata: null }],
  ])("refuses %s", (_label, change) => {
    expect(isIntentForOrdinaryAskPlan({ ...minted, ...change }, plan, "nzd", ROW)).toBe(false);
  });

  it("MUTATION: a door-reason intent is this ask's only if created by the row (clock skew allowed) - a later one is another door minting now", () => {
    const skew = DOOR_INTENT_CLOCK_SKEW_MS / 1000;
    expect(isIntentForOrdinaryAskPlan({ ...minted, created: atRow + skew }, plan, "nzd", ROW)).toBe(true);
    expect(isIntentForOrdinaryAskPlan({ ...minted, created: atRow + skew + 1 }, plan, "nzd", ROW)).toBe(false);
    expect(isIntentForOrdinaryAskPlan({ ...minted, created: undefined }, plan, "nzd", ROW)).toBe(false);
  });

  // #4693 (review of PR #4698): a runner stamped it for another row - that row's own, and its
  // close-time sweep may cancel it. Unstamped (every pre-#4693 intent) or stamped for this row matches.
  it("MUTATION: an intent stamped for ANOTHER recovery row is never adopted", () => {
    const stamped = (askRecoveryId: string) => ({ ...minted, metadata: { ...minted.metadata, askRecoveryId } });
    expect(isIntentForOrdinaryAskPlan(stamped("op_other_row"), plan, "nzd", ROW)).toBe(false);
    expect(isIntentForOrdinaryAskPlan(stamped("op_this_row"), plan, "nzd", ROW)).toBe(true);
  });

  it("#4079 - an intent under the runner's own reason is never adopted, before the row or after it", () => {
    const runnerReason = { ...minted.metadata, reason: ORDINARY_ASK_RECOVERY_REASON };
    expect(isIntentForOrdinaryAskPlan({ ...minted, metadata: runnerReason }, plan, "nzd", ROW)).toBe(false);
    expect(isIntentForOrdinaryAskPlan({ ...minted, created: atRow + 3_600, metadata: runnerReason }, plan, "nzd", ROW)).toBe(false);
  });

  it("MUTATION: #4079 - nor by a plan whose key names no door, though that plan sends the runner's reason", () => {
    const noDoor = planOrdinaryAskMint({
      bookingId: BOOKING,
      bookingModificationId: EDIT,
      stripeKey: "pi_written_earlier",
      frozenAmountCents: 6_000,
      amountCents: 6_000,
    });
    expect(noDoor.metadata.reason).toBe(ORDINARY_ASK_RECOVERY_REASON);
    const runnerReason = { ...minted.metadata, reason: ORDINARY_ASK_RECOVERY_REASON };
    expect(isIntentForOrdinaryAskPlan({ ...minted, metadata: runnerReason }, noDoor, "nzd", ROW)).toBe(false);
  });

  it("the adoptable bound is the row's creation plus the clock skew", () => {
    expect(latestAdoptableIntentCreatedAt(ROW_AT)).toEqual(new Date(ROW_AT.getTime() + DOOR_INTENT_CLOCK_SKEW_MS));
  });
});

/*
  #4036 review: an adoption is refused while another unfinished additional-ask
  recovery of the booking could be the request that minted the match, so two
  edits never record one intent.
*/
describe("couldRecoveryRowOwnIntent (#4036 review)", () => {
  const OTHER = "mod_other";
  const otherRow = (overrides: Record<string, unknown> = {}) => ({
    bookingId: BOOKING,
    idempotencyKey: `payment_recovery_additional_intent_${OTHER}`,
    paymentIntentId: ordinaryAskDoorRequest("guestAdd", BOOKING, OTHER).idempotencyKey,
    amountCents: 6_000,
    ...overrides,
  });
  const match = (reason: string, overrides: Record<string, unknown> = {}) => ({
    id: "pi_match",
    amount: 6_000,
    metadata: { bookingId: BOOKING, type: ADDITIONAL_ASK_INTENT_TYPE, reason },
    ...overrides,
  });

  it.each([
    ["the same door's reason and amount", otherRow(), match("guest_add_price_increase")],
    ["a row naming the intent itself", otherRow({ amountCents: 1 }), match("guest_add_price_increase", { id: otherRow().paymentIntentId })],
    ["a row whose key names no door (any reason)", otherRow({ paymentIntentId: "pi_written_earlier" }), match("date_change_price_increase")],
  ])("a rival: %s", (_label, row, intent) => {
    expect(couldRecoveryRowOwnIntent(row, intent)).toBe(true);
  });

  it.each([
    ["another amount", otherRow({ amountCents: 4_000 }), match("guest_add_price_increase")],
    ["another door's reason", otherRow({ paymentIntentId: ordinaryAskDoorRequest("dateChange", BOOKING, OTHER).idempotencyKey }), match("guest_add_price_increase")],
    // #4079: no door's row replays under the pre-#4036 runner's reason any more.
    ["the old runner's reason, against a door's row", otherRow({ paymentIntentId: ordinaryAskDoorRequest("dateChange", BOOKING, OTHER).idempotencyKey }), match(ORDINARY_ASK_RECOVERY_REASON)],
    ["a review charge's row", otherRow({ idempotencyKey: `edit_financial_review_additional_intent_recovery_${OTHER}` }), match(ORDINARY_ASK_RECOVERY_REASON)],
    ["a re-issue's row", otherRow({ paymentIntentId: `mod_reissued_ask_${OTHER}` }), match(ORDINARY_ASK_RECOVERY_REASON)],
  ])("not a rival: %s", (_label, row, intent) => {
    expect(couldRecoveryRowOwnIntent(row, intent)).toBe(false);
  });
});
