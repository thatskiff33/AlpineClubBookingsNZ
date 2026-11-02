import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  #4036: `mintOrdinaryAskIntent` sends the one planned request; a recovery's
  replay that Stripe refuses (`idempotency_error`) adopts the intent the key
  already minted, only when exactly one unrecorded intent matches, and
  otherwise throws the refusal as it came. The door's own first mint never
  looks anything up. Review round: a scan that stopped at its bound, or another
  edit's unfinished recovery that could own the match, also fails closed.
*/

const mocks = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  listRecentPaymentIntentsMatching: vi.fn(),
  stampPaymentIntentMetadata: vi.fn(),
  paymentTransactionFindMany: vi.fn(),
  recoveryFindMany: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: mocks.createPaymentIntent,
  listRecentPaymentIntentsMatching: mocks.listRecentPaymentIntentsMatching,
  stampPaymentIntentMetadata: mocks.stampPaymentIntentMetadata,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentTransaction: { findMany: mocks.paymentTransactionFindMany },
    paymentRecoveryOperation: { findMany: mocks.recoveryFindMany },
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mintOrdinaryAskIntent, refuseAdoptedIntentOnLedger } from "@/lib/ordinary-ask-mint";
import { DOOR_INTENT_CLOCK_SKEW_MS, ordinaryAskDoorRequest, planOrdinaryAskMint } from "@/lib/ordinary-ask-request";
import { PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE } from "@/lib/payment-recovery-constants";
import { MINTED_INTENT_LOOKBACK_MS } from "@/lib/reissued-ask-mint";
import { stripeChargeCurrency } from "@/lib/stripe-charge-currency";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { stripeSdkError } from "./support/stripe-sdk-error";

const BOOKING = "bk_4036";
const door = ordinaryAskDoorRequest("guestAdd", BOOKING, "mod_4036");
const plan = planOrdinaryAskMint({
  bookingId: BOOKING,
  bookingModificationId: "mod_4036",
  stripeKey: door.idempotencyKey,
  frozenAmountCents: 6_000,
  amountCents: 6_000,
});
const RECOVERY = { id: "op_4036", createdAt: new Date("2026-06-30T00:00:00.000Z") };
const CURRENCY = stripeChargeCurrency(CLUB_FORMAT_TEST);

function intent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    amount: 6_000,
    currency: CURRENCY,
    customer: "cus_door",
    status: "requires_payment_method",
    // Created before the recovery row, as the door's own mint always is.
    created: RECOVERY.createdAt.getTime() / 1000 - 30,
    metadata: { bookingId: BOOKING, type: "modification_additional", reason: door.reason },
    ...overrides,
  };
}

/** Stripe's list, as the real helper reads it: every intent `matches` accepts. */
function stripeHolds(...intents: ReturnType<typeof intent>[]) {
  mocks.listRecentPaymentIntentsMatching.mockImplementation(
    async ({ matches }: { matches: (pi: unknown) => boolean }) => ({
      intents: intents.filter((pi) => matches(pi)),
      complete: true,
    }),
  );
}

const refusal = () =>
  stripeSdkError({ type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters" });

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.paymentTransactionFindMany.mockResolvedValue([]);
  mocks.recoveryFindMany.mockResolvedValue([]);
});

/*
  #4693 (`INV-PAY-120`): the runner stamps its own intent with its row's id, by an
  update after the create - never in the create, whose replay must repeat the
  door's request - so a close-time sweep can find it if no hold ever writes it.
*/
describe("mintOrdinaryAskIntent stamps the runner's own intent with its recovery (#4693)", () => {
  it("MUTATION: a recovery's mint is stamped after the create, which still carries the door's metadata alone", async () => {
    mocks.createPaymentIntent.mockResolvedValue({ id: "pi_new" });
    await mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY });
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { bookingId: BOOKING, type: "modification_additional", reason: "guest_add_price_increase" } }),
    );
    expect(mocks.stampPaymentIntentMetadata).toHaveBeenCalledWith("pi_new", { askRecoveryId: "op_4036" });
    expect(mocks.createPaymentIntent.mock.invocationCallOrder[0]).toBeLessThan(mocks.stampPaymentIntentMetadata.mock.invocationCallOrder[0]!);
  });

  it("the door's own mint is never stamped: it has no recovery row yet", async () => {
    mocks.createPaymentIntent.mockResolvedValue({ id: "pi_door" });
    await mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: null });
    expect(mocks.stampPaymentIntentMetadata).not.toHaveBeenCalled();
  });

  it("MUTATION: an ADOPTED intent is never stamped - it is not this row's own", async () => {
    mocks.createPaymentIntent.mockRejectedValue(refusal());
    stripeHolds(intent("pi_door"));
    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).resolves.toMatchObject({ adopted: true });
    expect(mocks.stampPaymentIntentMetadata).not.toHaveBeenCalled();
  });

  it("a failed stamp is logged and the ask goes on with its intent", async () => {
    mocks.createPaymentIntent.mockResolvedValue({ id: "pi_new" });
    mocks.stampPaymentIntentMetadata.mockRejectedValue(new Error("Stripe is down"));
    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).resolves.toEqual({ intent: { id: "pi_new" }, adopted: false });
  });
});

describe("mintOrdinaryAskIntent (#4036)", () => {
  it("sends the planned request byte for byte", async () => {
    mocks.createPaymentIntent.mockResolvedValue({ id: "pi_new" });

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).resolves.toEqual({ intent: { id: "pi_new" }, adopted: false });
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST,
      amountCents: 6_000,
      customerId: "cus_door",
      metadata: { bookingId: BOOKING, type: "modification_additional", reason: "guest_add_price_increase" },
      idempotencyKey: door.idempotencyKey,
    });
    expect(mocks.listRecentPaymentIntentsMatching).not.toHaveBeenCalled();
  });

  it("the door's own refusal is thrown without a lookup: nothing can have minted before it", async () => {
    const err = refusal();
    mocks.createPaymentIntent.mockRejectedValue(err);
    stripeHolds(intent("pi_door"));

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: null }),
    ).rejects.toBe(err);
    expect(mocks.listRecentPaymentIntentsMatching).not.toHaveBeenCalled();
  });

  it("#4079: a refused replay whose key names no door is thrown without a lookup - no intent could match it", async () => {
    const noDoor = planOrdinaryAskMint({
      bookingId: BOOKING,
      bookingModificationId: "edit_no_door",
      stripeKey: "pi_written_earlier",
      frozenAmountCents: 6_000,
      amountCents: 6_000,
    });
    const err = refusal();
    mocks.createPaymentIntent.mockRejectedValue(err);
    stripeHolds(intent("pi_runner", { metadata: { bookingId: BOOKING, type: "modification_additional", reason: noDoor.metadata.reason } }));

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan: noDoor, customerId: "cus_door", recovery: RECOVERY }),
    ).rejects.toBe(err);
    expect(mocks.listRecentPaymentIntentsMatching).not.toHaveBeenCalled();
  });

  it("any other failure is thrown as it came, without a lookup", async () => {
    const err = stripeSdkError({ type: "api_error" });
    mocks.createPaymentIntent.mockRejectedValue(err);

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).rejects.toBe(err);
    expect(mocks.listRecentPaymentIntentsMatching).not.toHaveBeenCalled();
  });

  it("a refused replay adopts the one unrecorded intent the key minted, looked for from just before the recovery was written to just after", async () => {
    mocks.createPaymentIntent.mockRejectedValue(refusal());
    stripeHolds(intent("pi_other_booking", { metadata: { ...intent("x").metadata, bookingId: "bk_other" } }), intent("pi_door"));

    const adopted = await mintOrdinaryAskIntent({
      format: CLUB_FORMAT_TEST,
      plan,
      customerId: "cus_moved",
      recovery: RECOVERY,
    });

    expect(adopted).toEqual({ intent: expect.objectContaining({ id: "pi_door" }), adopted: true });
    expect(mocks.listRecentPaymentIntentsMatching).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_moved",
        createdSince: new Date(RECOVERY.createdAt.getTime() - MINTED_INTENT_LOOKBACK_MS),
        // #4079: the scan reads nothing created after the row could have been written.
        createdUntil: new Date(RECOVERY.createdAt.getTime() + DOOR_INTENT_CLOCK_SKEW_MS),
      }),
    );
    expect(mocks.paymentTransactionFindMany).toHaveBeenCalledWith({
      where: { stripePaymentIntentId: { in: ["pi_door"] } },
      select: { stripePaymentIntentId: true },
    });
    // Only the booking's OTHER unfinished additional-ask recoveries are rivals.
    expect(mocks.recoveryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          bookingId: BOOKING,
          type: "CREATE_ADDITIONAL_PAYMENT_INTENT",
          id: { not: RECOVERY.id },
          ...PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE,
        },
      }),
    );
  });

  it("does not adopt a door-reason intent created after the recovery row plus the clock skew - a later door is minting it", async () => {
    const err = refusal();
    mocks.createPaymentIntent.mockRejectedValue(err);
    const late = RECOVERY.createdAt.getTime() / 1000 + DOOR_INTENT_CLOCK_SKEW_MS / 1000 + 1;
    stripeHolds(intent("pi_later_door", { created: late }));

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).rejects.toBe(err);
    expect(mocks.paymentTransactionFindMany).not.toHaveBeenCalled();
  });

  it("#4079: does not adopt an intent under the runner's own reason - only the pre-#4036 runner sent it for a door's key", async () => {
    const err = refusal();
    mocks.createPaymentIntent.mockRejectedValue(err);
    stripeHolds(intent("pi_old_runner", { metadata: { ...intent("x").metadata, reason: "modification_additional_recovery" } }));

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).rejects.toBe(err);
    expect(mocks.paymentTransactionFindMany).not.toHaveBeenCalled();
  });

  it("fails closed when the scan stopped at its bound - a second match may be among the intents it never read", async () => {
    const err = refusal();
    mocks.createPaymentIntent.mockRejectedValue(err);
    mocks.listRecentPaymentIntentsMatching.mockResolvedValue({ intents: [intent("pi_door")], complete: false });

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).rejects.toBe(err);
    expect(mocks.paymentTransactionFindMany).not.toHaveBeenCalled();
  });

  it("fails closed when another edit's in-flight recovery (FAILED, retry scheduled) could own the one match - two edits never record one intent", async () => {
    const err = refusal();
    mocks.createPaymentIntent.mockRejectedValue(err);
    stripeHolds(intent("pi_door"));
    const other = ordinaryAskDoorRequest("guestAdd", BOOKING, "mod_other");
    mocks.recoveryFindMany.mockResolvedValue([
      {
        id: "op_other",
        bookingId: BOOKING,
        idempotencyKey: "payment_recovery_additional_intent_mod_other",
        paymentIntentId: other.idempotencyKey,
        amountCents: 6_000,
        // Between retries: FAILED, with its next attempt scheduled.
        status: "FAILED",
        attempts: 1,
        nextRetryAt: new Date("2026-07-01T00:05:00.000Z"),
      },
    ]);

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).rejects.toBe(err);
  });

  it("adopts when the booking's other unfinished recovery could not have minted the match (another amount)", async () => {
    mocks.createPaymentIntent.mockRejectedValue(refusal());
    stripeHolds(intent("pi_door"));
    mocks.recoveryFindMany.mockResolvedValue([
      {
        id: "op_other",
        bookingId: BOOKING,
        idempotencyKey: "payment_recovery_additional_intent_mod_other",
        paymentIntentId: ordinaryAskDoorRequest("guestAdd", BOOKING, "mod_other").idempotencyKey,
        amountCents: 4_000,
        status: "PENDING",
        attempts: 0,
        nextRetryAt: null,
      },
    ]);

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).resolves.toEqual({ intent: expect.objectContaining({ id: "pi_door" }), adopted: true });
  });

  it("never adopts an intent already on the ledger - it is another ask's", async () => {
    const err = refusal();
    mocks.createPaymentIntent.mockRejectedValue(err);
    stripeHolds(intent("pi_recorded"));
    mocks.paymentTransactionFindMany.mockResolvedValue([{ stripePaymentIntentId: "pi_recorded" }]);

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).rejects.toBe(err);
  });

  it("fails closed when more than one unrecorded intent matches, rather than guess", async () => {
    const err = refusal();
    mocks.createPaymentIntent.mockRejectedValue(err);
    stripeHolds(intent("pi_one"), intent("pi_two"));

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).rejects.toBe(err);
  });

  it("fails closed when nothing matches - a cancelled or differently-sized intent is not this ask", async () => {
    const err = refusal();
    mocks.createPaymentIntent.mockRejectedValue(err);
    stripeHolds(intent("pi_cancelled", { status: "canceled" }), intent("pi_smaller", { amount: 5_000 }));

    await expect(
      mintOrdinaryAskIntent({ format: CLUB_FORMAT_TEST, plan, customerId: "cus_door", recovery: RECOVERY }),
    ).rejects.toBe(err);
    expect(mocks.paymentTransactionFindMany).not.toHaveBeenCalled();
  });
});

describe("refuseAdoptedIntentOnLedger (#4036 review)", () => {
  const storeHolding = (row: { id: string } | null) => {
    const findUnique = vi.fn().mockResolvedValue(row);
    return { store: { paymentTransaction: { findUnique } } as never, findUnique };
  };

  it("throws for an adopted intent another ask's ledger row already holds", async () => {
    const { store, findUnique } = storeHolding({ id: "txn_other" });
    await expect(refuseAdoptedIntentOnLedger(store, { intent: { id: "pi_door" } as never, adopted: true })).rejects.toThrow(
      /already on another ask's ledger row/,
    );
    expect(findUnique).toHaveBeenCalledWith({ where: { stripePaymentIntentId: "pi_door" }, select: { id: true } });
  });

  it("lets an adopted intent no row holds through", async () => {
    const { store } = storeHolding(null);
    await expect(refuseAdoptedIntentOnLedger(store, { intent: { id: "pi_door" } as never, adopted: true })).resolves.toBeUndefined();
  });

  it("never checks the key's own intent, which its own earlier attempt may have recorded", async () => {
    const { store, findUnique } = storeHolding({ id: "txn_mine" });
    await expect(refuseAdoptedIntentOnLedger(store, { intent: { id: "pi_door" } as never, adopted: false })).resolves.toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });
});
