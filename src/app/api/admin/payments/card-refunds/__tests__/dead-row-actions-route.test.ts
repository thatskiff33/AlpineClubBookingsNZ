import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4368 (owner decision, 25 Oct 2026): the two routes beside "Paid another
 * way" on a card refund Stripe gave up on -
 * POST /api/admin/payments/card-refunds/[id]/try-card-again and
 * POST /api/admin/payments/card-refunds/[id]/nothing-left-owed. Each route is
 * the door: finance:edit exactly as "Paid another way" asks, a confirmed body,
 * and the library's refusals answered with their own status. The rules are
 * `card-refund-dead-row-actions.test.ts`'s.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  tryDeadCardRefundAgain: vi.fn(),
  closeCardRefundNothingLeftOwed: vi.fn(),
  tryOrganiserChildCardRefundAgain: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/card-refund-dead-row-actions", () => ({
  tryDeadCardRefundAgain: mocks.tryDeadCardRefundAgain,
  closeCardRefundNothingLeftOwed: mocks.closeCardRefundNothingLeftOwed,
  DeadCardRefundActionError: class DeadCardRefundActionError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));
// #4851: both routes read the row's key to send a group organiser's refund its own way.
vi.mock("@/lib/prisma", () => ({
  prisma: { paymentRecoveryOperation: { findUnique: mocks.findUnique } },
}));
vi.mock("@/lib/card-refund-group-try-again", () => ({
  tryOrganiserChildCardRefundAgain: mocks.tryOrganiserChildCardRefundAgain,
}));
vi.mock("@/lib/card-refund-group-paid-another-way", () => ({
  closeGroupCardRefundPaidAnotherWay: vi.fn(),
}));
vi.mock("@/lib/card-refund-paid-another-way", () => ({
  closeCardRefundPaidAnotherWay: vi.fn(),
  CardRefundPaidAnotherWayError: class extends Error {},
}));

import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";
import { DeadCardRefundActionError } from "@/lib/card-refund-dead-row-actions";
import { LEGACY_GROUP_CARD_REFUND_TRY_AGAIN_REFUSAL } from "@/lib/card-refund-group-copy";
import {
  BOOKING_CANCELLATION_REFUND_RECOVERY_PREFIX,
  GROUP_SETTLEMENT_REFUND_RECOVERY_PREFIX,
  ORGANISER_CHILD_REFUND_KEY_PREFIX,
} from "@/lib/payment-recovery-keys";
import { POST as payAnotherWay } from "../[id]/paid-another-way/route";
import { POST as nothingLeftOwed } from "../[id]/nothing-left-owed/route";
import { POST as tryCardAgain } from "../[id]/try-card-again/route";

function request(path: string, body: unknown) {
  return new Request(`http://localhost/api/admin/payments/card-refunds/op-1/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: "op-1" });
// Built from the real prefixes, so the routing reads the keys the writers mint.
const CHARGE_ROW = `${BOOKING_CANCELLATION_REFUND_RECOVERY_PREFIX}b-1`;
const ORGANISER_CHILD_ROW = `${ORGANISER_CHILD_REFUND_KEY_PREFIX}c-1`;
const LEGACY_GROUP_ROW = `${GROUP_SETTLEMENT_REFUND_RECOVERY_PREFIX}s-1`;
const tryValid = { expectedOwedCents: 15_000, confirmed: true };
const nothingValid = { expectedStripeRefundIds: ["re_later_1"], confirmed: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({ ok: true, session: { user: { id: "treasurer-1" } } });
  mocks.findUnique.mockResolvedValue({ idempotencyKey: CHARGE_ROW });
  mocks.tryDeadCardRefundAgain.mockResolvedValue({ operationId: "op-1", bookingId: "b-1", paymentId: "p-1", owedCents: 15_000 });
  mocks.closeCardRefundNothingLeftOwed.mockResolvedValue({ operationId: "op-1", bookingId: "b-1", paymentId: "p-1", coveredBy: [] });
});

describe("who may use them: exactly whoever may close as paid another way", () => {
  it("MUTATION: both ask requireAdmin for the very permission Paid another way asks for", async () => {
    await payAnotherWay(request("paid-another-way", {}), { params });
    const payAnotherWayGate = mocks.requireAdmin.mock.calls[0]?.[0];
    expect(payAnotherWayGate).toEqual({ permission: { area: "finance", level: "edit" } });

    await tryCardAgain(request("try-card-again", tryValid), { params });
    await nothingLeftOwed(request("nothing-left-owed", nothingValid), { params });
    expect(mocks.requireAdmin.mock.calls[1]?.[0]).toEqual(payAnotherWayGate);
    expect(mocks.requireAdmin.mock.calls[2]?.[0]).toEqual(payAnotherWayGate);
  });

  it.each([
    ["try-card-again", tryCardAgain, tryValid],
    ["nothing-left-owed", nothingLeftOwed, nothingValid],
  ] as const)("%s refuses a view-only finance admin before anything is read or written", async (path, post, body) => {
    mocks.requireAdmin.mockResolvedValue({ ok: false, response: Response.json({ error: "Forbidden" }, { status: 403 }) });
    const response = await post(request(path, body), { params });
    expect(response.status).toBe(403);
    expect(mocks.tryDeadCardRefundAgain).not.toHaveBeenCalled();
    expect(mocks.closeCardRefundNothingLeftOwed).not.toHaveBeenCalled();
  });
});

describe("Try the card again: what it needs", () => {
  it.each([
    ["no confirmation", { expectedOwedCents: 15_000 }],
    ["a confirmation that is not literally true", { ...tryValid, confirmed: "yes" }],
    ["no owed figure", { confirmed: true }],
    ["an owed figure that is not whole cents", { ...tryValid, expectedOwedCents: 150.5 }],
    ["a field it does not know", { ...tryValid, amountCents: 100 }],
  ])("refuses %s, and re-arms nothing", async (_label, body) => {
    const response = await tryCardAgain(request("try-card-again", body), { params });
    expect(response.status).toBe(400);
    expect(mocks.tryDeadCardRefundAgain).not.toHaveBeenCalled();
  });

  it("MUTATION: hands the row, the figure the dialog showed and the acting treasurer to the re-arm, and refreshes the page", async () => {
    const response = await tryCardAgain(request("try-card-again", tryValid), { params });
    expect(response.status).toBe(200);
    expect(mocks.tryDeadCardRefundAgain).toHaveBeenCalledWith({ operationId: "op-1", expectedOwedCents: 15_000, actingMemberId: "treasurer-1" });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/system/stuck-states");
  });

  it("answers a refusal with its own status and sentence, and anything else with a plain 500", async () => {
    mocks.tryDeadCardRefundAgain.mockRejectedValueOnce(new DeadCardRefundActionError("This card refund has already been closed.", 409));
    const refused = await tryCardAgain(request("try-card-again", tryValid), { params });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toEqual({ error: "This card refund has already been closed." });

    mocks.tryDeadCardRefundAgain.mockRejectedValueOnce(new Error("connection reset"));
    const failed = await tryCardAgain(request("try-card-again", tryValid), { params });
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({ error: "Could not try the card again." });
  });
});

describe("Try the card again: which re-arm a row goes to (#4851)", () => {
  it("re-arms a joiner's refund out of the organiser's card through the group re-arm", async () => {
    mocks.findUnique.mockResolvedValue({ idempotencyKey: ORGANISER_CHILD_ROW });
    mocks.tryOrganiserChildCardRefundAgain.mockResolvedValue({ operationId: "op-1" });

    const response = await tryCardAgain(request("try-card-again", tryValid), { params });

    expect(response.status).toBe(200);
    expect(mocks.tryOrganiserChildCardRefundAgain).toHaveBeenCalledWith({
      operationId: "op-1",
      expectedOwedCents: 15_000,
      actingMemberId: "treasurer-1",
    });
    expect(mocks.tryDeadCardRefundAgain).not.toHaveBeenCalled();
  });

  it("refuses a pre-#3653 whole-group refund with a 409 and its sentence, re-arming nothing", async () => {
    mocks.findUnique.mockResolvedValue({ idempotencyKey: LEGACY_GROUP_ROW });

    const response = await tryCardAgain(request("try-card-again", tryValid), { params });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: LEGACY_GROUP_CARD_REFUND_TRY_AGAIN_REFUSAL });
    expect(mocks.tryOrganiserChildCardRefundAgain).not.toHaveBeenCalled();
    expect(mocks.tryDeadCardRefundAgain).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("Nothing left owed: what it needs", () => {
  it.each([
    ["no confirmation", { expectedStripeRefundIds: ["re_later_1"] }],
    ["no refund named", { expectedStripeRefundIds: [], confirmed: true }],
    ["refunds that are not a list", { expectedStripeRefundIds: "re_later_1", confirmed: true }],
    ["a field it does not know", { ...nothingValid, amountCents: 0 }],
  ])("refuses %s, and closes nothing", async (_label, body) => {
    const response = await nothingLeftOwed(request("nothing-left-owed", body), { params });
    expect(response.status).toBe(400);
    expect(mocks.closeCardRefundNothingLeftOwed).not.toHaveBeenCalled();
  });

  it("MUTATION: hands the row, the refunds the dialog named and the acting treasurer to the close, and refreshes the page", async () => {
    const response = await nothingLeftOwed(request("nothing-left-owed", nothingValid), { params });
    expect(response.status).toBe(200);
    expect(mocks.closeCardRefundNothingLeftOwed).toHaveBeenCalledWith({
      operationId: "op-1",
      expectedStripeRefundIds: ["re_later_1"],
      actingMemberId: "treasurer-1",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/system/stuck-states");
  });

  it("answers a refusal with its own status and sentence, and anything else with a plain 500", async () => {
    mocks.closeCardRefundNothingLeftOwed.mockRejectedValueOnce(new DeadCardRefundActionError("Something is owed on this card refund again.", 409));
    const refused = await nothingLeftOwed(request("nothing-left-owed", nothingValid), { params });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toEqual({ error: "Something is owed on this card refund again." });

    mocks.closeCardRefundNothingLeftOwed.mockRejectedValueOnce(new Error("connection reset"));
    const failed = await nothingLeftOwed(request("nothing-left-owed", nothingValid), { params });
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({ error: "Could not close the card refund." });
  });
});
