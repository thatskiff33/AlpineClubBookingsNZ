import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

/**
 * #4300 (`INV-PAY-138`): after the settle refused a superseded capture, the
 * reporter hands it off and sends the admins its own alert, worded by the
 * booking's status, giving the cooldown claim back when the send throws.
 */
const mocks = vi.hoisted(() => ({
  queueSuperseded: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/lib/payment-recovery", () => ({ queueSupersededPaymentIntentRefundRecovery: mocks.queueSuperseded }));
vi.mock("@/lib/alert-cooldown-fail-open", () => ({ SETTLEMENT_MONEY_ALERT_REPEAT_MS: 86_400_000, claimAlertCooldownFailOpen: mocks.claim }));
vi.mock("@/lib/alert-cooldown", () => ({ releaseAlertCooldown: mocks.release }));
vi.mock("@/lib/email", () => ({ sendAdminSupersededCaptureRefusedAlert: mocks.send }));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { reportSupersededCaptureRefused } from "@/lib/superseded-capture-refusal";

const booking = (status: string) => ({ id: "booking-1", checkIn: new Date("2026-09-01"), checkOut: new Date("2026-09-03"), status });
const report = (status: string) =>
  reportSupersededCaptureRefused({ booking: booking(status), memberName: "Alice Example", paymentIntentId: "pi_superseded", amountCents: 20000, paymentMethodId: "pm_1", format: CLUB_FORMAT_TEST });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queueSuperseded.mockResolvedValue(true);
  mocks.claim.mockResolvedValue(true);
  mocks.release.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
});

describe("reportSupersededCaptureRefused", () => {
  it("hands the capture off, then alerts for a booking that still owes", async () => {
    await report("PAYMENT_PENDING");
    expect(mocks.queueSuperseded).toHaveBeenCalledWith({ id: "pi_superseded", amount: 20000, payment_method: "pm_1" });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ bookingId: "booking-1", bookingCancelled: false, amountCents: 20000 }), CLUB_FORMAT_TEST);
  });

  it("words a cancelled booking's alert as cancelled - it does not still owe", async () => {
    await report("CANCELLED");
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ bookingCancelled: true }), CLUB_FORMAT_TEST);
  });

  it("gives the cooldown claim back when the send throws, so a repeat tries again", async () => {
    mocks.send.mockRejectedValue(new Error("SES down"));
    await expect(report("PAYMENT_PENDING")).resolves.toBeUndefined();
    expect(mocks.release).toHaveBeenCalledWith({ key: "superseded-capture-refused:booking-1:pi_superseded", claimedAt: expect.any(Date) });
  });

  it("sends nothing inside the cooldown, and never throws when the hand-off fails", async () => {
    mocks.claim.mockResolvedValue(false);
    mocks.queueSuperseded.mockRejectedValue(new Error("db down"));
    await expect(report("PAYMENT_PENDING")).resolves.toBeUndefined();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
