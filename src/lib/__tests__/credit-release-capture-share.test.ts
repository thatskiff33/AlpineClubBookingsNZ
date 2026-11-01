import { beforeEach, describe, expect, it, vi } from "vitest";

import { CREDIT_RELEASE_ASK_REASON } from "@/lib/credit-release-ask-keys";

const mocks = vi.hoisted(() => ({ prisma: {} }));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));

import { creditReleaseSweptCents, readCreditReleaseCaptureShare } from "@/lib/credit-release-capture-share";

/*
  #4253 (`INV-ADDPAY-046`): how much of one capture the credit-release sweep records, so the
  capture's receipt writer records only the rest. Synthetic amounts only.
*/

const store = { paymentTransaction: { findUnique: vi.fn(), findMany: vi.fn() } };
const ask = (over: Record<string, unknown>) => ({
  id: "row",
  source: "STRIPE",
  status: "PENDING",
  reason: CREDIT_RELEASE_ASK_REASON,
  amountCents: 4_000,
  carriedAskCents: 0,
  withdrawnAt: null,
  stripePaymentIntentId: "pi_release",
  ...over,
});

describe("readCreditReleaseCaptureShare", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.paymentTransaction.findUnique.mockResolvedValue({ paymentId: "pay-1" });
    store.paymentTransaction.findMany.mockResolvedValue([]);
  });

  it("is nothing for an intent the ledger does not know", async () => {
    store.paymentTransaction.findUnique.mockResolvedValue(null);
    await expect(readCreditReleaseCaptureShare("pi_x", store as never)).resolves.toEqual({ ownCents: 0, held: false });
    expect(store.paymentTransaction.findMany).not.toHaveBeenCalled();
  });

  it("is the whole capture where a release request was paid itself", async () => {
    store.paymentTransaction.findMany.mockResolvedValue([ask({ id: "r1", status: "SUCCEEDED" })]);
    await expect(readCreditReleaseCaptureShare("pi_release", store as never)).resolves.toEqual({ ownCents: 4_000, held: false });
  });

  it("is only the release's own money where a later edit request absorbed it", async () => {
    store.paymentTransaction.findMany.mockResolvedValue([
      ask({ id: "r1" }),
      ask({ id: "r2", reason: "edit_price_increase", amountCents: 6_500, carriedAskCents: 4_000, status: "SUCCEEDED", stripePaymentIntentId: "pi_edit" }),
    ]);
    await expect(readCreditReleaseCaptureShare("pi_edit", store as never)).resolves.toEqual({ ownCents: 4_000, held: false });
  });

  it("is nothing for a capture that collected no released credit", async () => {
    store.paymentTransaction.findMany.mockResolvedValue([
      ask({ id: "r1", reason: "edit_price_increase", status: "SUCCEEDED", stripePaymentIntentId: "pi_edit" }),
    ]);
    await expect(readCreditReleaseCaptureShare("pi_edit", store as never)).resolves.toEqual({ ownCents: 0, held: false });
  });

  it("is held, and records nothing, for a partly refunded capture", async () => {
    store.paymentTransaction.findMany.mockResolvedValue([ask({ id: "r1", status: "PARTIALLY_REFUNDED" })]);
    await expect(readCreditReleaseCaptureShare("pi_release", store as never)).resolves.toEqual({ ownCents: 0, held: true });
  });

  it("reads the payment's ADDITIONAL rows only", async () => {
    await readCreditReleaseCaptureShare("pi_release", store as never);
    expect(store.paymentTransaction.findMany.mock.calls[0]![0].where).toEqual({ paymentId: "pay-1", kind: "ADDITIONAL" });
  });
});

describe("creditReleaseSweptCents (#4494)", () => {
  it("MUTATION: is all of the net cash for a capture the sweep holds - it has no plan item, so its own share is 0", () => {
    expect(creditReleaseSweptCents({ ownCents: 0, held: true }, 5_000)).toBe(5_000);
  });

  it("is the sweep's own share, never more than the capture holds and never negative", () => {
    expect(creditReleaseSweptCents({ ownCents: 0, held: false }, 5_000)).toBe(0);
    expect(creditReleaseSweptCents({ ownCents: 4_000, held: false }, 10_000)).toBe(4_000);
    expect(creditReleaseSweptCents({ ownCents: 6_000, held: false }, 5_000)).toBe(5_000);
    expect(creditReleaseSweptCents({ ownCents: 4_000, held: false }, -100)).toBe(0);
  });
});

describe("creditReleaseShareFromPlan (#4494 fix round, the one fold)", () => {
  it("sums every item a capture collected and says whether the sweep holds it - the sweep and the share reader read the same", async () => {
    const { creditReleaseShareFromPlan } = await import("@/lib/credit-release-payment-plan");
    const plan = {
      items: [
        { askRowId: "a1", ownCents: 1_000, capturedByRowId: "c1", capturedByIntentId: "pi_1" },
        { askRowId: "a2", ownCents: 2_500, capturedByRowId: "c1", capturedByIntentId: "pi_1" },
        { askRowId: "a3", ownCents: 9_999, capturedByRowId: "c2", capturedByIntentId: "pi_2" },
      ],
      unexplainedRowIds: ["a0"],
      unexplainedCaptureIntentIds: ["pi_1"],
    };
    expect(creditReleaseShareFromPlan(plan, "pi_1")).toEqual({ ownCents: 3_500, held: true });
    expect(creditReleaseShareFromPlan(plan, "pi_2")).toEqual({ ownCents: 9_999, held: false });
    expect(creditReleaseShareFromPlan(plan, "pi_none")).toEqual({ ownCents: 0, held: false });
  });
});
