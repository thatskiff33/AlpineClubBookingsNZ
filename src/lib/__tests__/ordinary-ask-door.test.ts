import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  #4036: THE ORDINARY INCREASE'S DOOR SENDS THE REQUEST ITS RECOVERY REPLAYS.

  The door used to send its own customer lookup (`findOrCreateCustomer` with no
  organisation, which throws for a school's booking) and the runner another
  (`resolveAskCustomerId`). Here the real door runs with only the provider
  calls and the database doubled, and the request it sends is compared with
  the plan the runner builds from the recovery row the door would have written.
*/

const mocks = vi.hoisted(() => ({
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  paymentFindUnique: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  enqueueRecovery: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: mocks.createPaymentIntent,
  findOrCreateCustomer: mocks.findOrCreateCustomer,
}));
vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: mocks.upsertPaymentIntentTransaction,
  refundPaymentTransactions: vi.fn(),
  lockPaymentForRefundedTotal: vi.fn(),
  PartialRefundError: class PartialRefundError extends Error {},
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (write: (store: unknown) => Promise<unknown>) => {
      const { prisma } = await import("@/lib/prisma");
      return write(prisma);
    },
    $executeRaw: vi.fn(),
    payment: { findUnique: mocks.paymentFindUnique },
    paymentTransaction: {
      // No other live ask for the supersede to retire.
      findMany: async () => [],
      findUnique: async () => ({ status: "PENDING", withdrawnAt: null }),
    },
  },
}));
vi.mock("@/lib/payment-recovery", () => ({
  enqueuePaymentIntentCancellationRecovery: vi.fn(),
  runPaymentRecoveryOperationNow: vi.fn(),
  enqueueAdditionalPaymentIntentRecovery: mocks.enqueueRecovery,
  enqueueBookingModificationRefundRecovery: vi.fn(),
  processPaymentRecoveryOperations: vi.fn(),
}));
// #3403: the superseded asks' invoice move is its own module's, tested there.
vi.mock("@/lib/superseded-ask-invoice-carry", () => ({
  followSupersededAskInvoicesSafely: async () => null,
}));
// The door folds no waiting re-issue in here; its invoice step answers "live".
vi.mock("@/lib/reissued-ask-invoice", () => ({
  queueFoldedReissuedAskInvoices: async () => true,
  queueReissuedAskSupplementaryInvoice: async () => true,
}));

import { sizeAdditionalAsk } from "@/lib/additional-payment-ask";
import { createModificationAdditionalPaymentIntent } from "@/lib/booking-modification-settlement";
import { ordinaryAskDoorRequest, planOrdinaryAskMint } from "@/lib/ordinary-ask-request";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const BOOKING = "bk_4036";
const EDIT = "mod_4036";

function context(overrides: Record<string, unknown> = {}) {
  return {
    pendingRefundAmountCents: 0,
    organiserChildRefund: null,
    paymentId: "pay_4036",
    additionalAsk: sizeAdditionalAsk({ priceDiffCents: 6_000, changeFeeCents: 0, payment: null }),
    retiredAdditionalAsks: [],
    hasSucceededPayment: true,
    hasIssuedXeroInvoice: false,
    paymentCustomerId: null,
    // The person-shaped projection a school's booking carries (#3369).
    memberEmail: "office@school.example",
    memberName: "Hill School ",
    memberFirstName: "Hill School",
    memberId: null,
    bookingModificationId: EDIT,
    priceLines: null,
    ...overrides,
  };
}

function mint(overrides: Record<string, unknown> = {}) {
  return createModificationAdditionalPaymentIntent({
    format: CLUB_FORMAT_TEST,
    bookingId: BOOKING,
    result: context(overrides) as never,
    door: "guestAdd",
    failureMessage: "door 4036",
  });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.createPaymentIntent.mockResolvedValue({ id: "pi_4036", client_secret: "secret_4036" });
  mocks.findOrCreateCustomer.mockResolvedValue({ id: "cus_school" });
  mocks.enqueueRecovery.mockResolvedValue(undefined);
  mocks.paymentFindUnique.mockResolvedValue({
    additionalAmountCents: 0,
    additionalPaymentStatus: null,
    stripeCustomerId: null,
    booking: { organisationId: "org_hill", member: null, organisation: { name: "Hill School", email: "office@school.example" } },
  });
});

describe("the ordinary increase's door (#4036)", () => {
  it("names a school's customer by its organisation, as the recovery runner does - where it used to throw and mint nothing", async () => {
    const minted = await mint();

    expect(mocks.findOrCreateCustomer).toHaveBeenCalledWith({
      email: "office@school.example",
      name: "Hill School ",
      memberId: null,
      organisationId: "org_hill",
    });
    expect(minted.additionalPaymentIntentId).toBe("pi_4036");
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ customerId: "cus_school" }));
    expect(mocks.enqueueRecovery).not.toHaveBeenCalled();
  });

  it("sends the request the runner's replay of its recovery row sends, byte for byte", async () => {
    await mint({ paymentCustomerId: "cus_stored" });

    // What the door freezes on the recovery row when its mint fails: its key
    // and its figure. The runner's plan is built from exactly those.
    const runnerPlan = planOrdinaryAskMint({
      bookingId: BOOKING,
      bookingModificationId: EDIT,
      stripeKey: ordinaryAskDoorRequest("guestAdd", BOOKING, EDIT).idempotencyKey,
      frozenAmountCents: 6_000,
      amountCents: 6_000,
    });
    expect(mocks.createPaymentIntent).toHaveBeenCalledTimes(1);
    expect(mocks.createPaymentIntent).toHaveBeenCalledWith({
      format: CLUB_FORMAT_TEST,
      amountCents: runnerPlan.amountCents,
      customerId: "cus_stored",
      metadata: { ...runnerPlan.metadata },
      idempotencyKey: runnerPlan.idempotencyKey,
    });
    // The stored customer is the rule's first answer: no owner read, no lookup.
    expect(mocks.paymentFindUnique).toHaveBeenCalledWith({
      where: { id: "pay_4036" },
      select: { additionalAmountCents: true, additionalPaymentStatus: true },
    });
    expect(mocks.findOrCreateCustomer).not.toHaveBeenCalled();
    // The ledger row keeps the door's own reason.
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_4036", reason: "guest_add_price_increase" }),
    );
  });

  it("keeps the debt on a recovery row under the same key and figure when the mint fails", async () => {
    mocks.createPaymentIntent.mockRejectedValue(new Error("socket hang up"));

    const minted = await mint({ paymentCustomerId: "cus_stored" });

    expect(minted.additionalPaymentIntentId).toBeUndefined();
    expect(mocks.enqueueRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 6_000,
        stripeIdempotencyKey: ordinaryAskDoorRequest("guestAdd", BOOKING, EDIT).idempotencyKey,
      }),
    );
  });
});
