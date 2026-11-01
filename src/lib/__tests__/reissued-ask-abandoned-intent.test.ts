/**
 * #4052: the intent a door minted for a re-issued ask whose recovery a later
 * reduction or increase closed mid-mint is cancelled at Stripe as abandoned -
 * only on proof that nobody owns it, never written locally, safe to repeat.
 * The door-level interleavings are in `booking-modify-reduction-unpaid-ask.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  recovery: null as null | Record<string, unknown>,
  row: null as null | { id: string },
  recoveryFind: vi.fn(),
  rowFind: vi.fn(),
  cancel: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRecoveryOperation: { findUnique: h.recoveryFind },
    paymentTransaction: { findUnique: h.rowFind },
  },
}));
vi.mock("@/lib/stripe", () => ({ cancelPaymentIntentIfCancellableWithResult: h.cancel }));
vi.mock("@/lib/logger", () => ({ default: { info: h.info, warn: h.warn, error: h.error } }));

const { settleLostReissuedAskFence } = await import("@/lib/reissued-ask-abandoned-intent");
const { PENDING_ASK_NETTED_BY_REDUCTION_NOTE } = await import("@/lib/additional-ask-recovery-close");

const CALL = { bookingId: "booking_1", bookingModificationId: "mod_reduction", paymentIntentId: "pi_door" };
const NETTED = {
  id: "op_reissue",
  status: "SUCCEEDED",
  lastError: PENDING_ASK_NETTED_BY_REDUCTION_NOTE,
  paymentIntentId: "mod_reissued_ask_mod_reduction",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.recovery = { ...NETTED };
  h.row = null;
  h.recoveryFind.mockImplementation(async () => h.recovery);
  h.rowFind.mockImplementation(async () => h.row);
  h.cancel.mockImplementation(async (id: string) => ({ paymentIntent: { id, status: "canceled" }, canceled: true }));
});

describe("settleLostReissuedAskFence", () => {
  it("MUTATION: cancels a proven abandoned intent as abandoned and hands back the re-read", async () => {
    await expect(settleLostReissuedAskFence(CALL)).resolves.toEqual(NETTED);
    expect(h.rowFind).toHaveBeenCalledWith({ where: { stripePaymentIntentId: "pi_door" }, select: { id: true } });
    expect(h.cancel).toHaveBeenCalledWith("pi_door", { cancellationReason: "abandoned" });
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ canceled: true, paymentIntentId: "pi_door" }), expect.any(String));
  });

  it("repeated cleanup is safe: an intent already cancelled is left alone, not reported cancelled", async () => {
    await settleLostReissuedAskFence(CALL);
    h.cancel.mockResolvedValueOnce({ paymentIntent: { id: "pi_door", status: "canceled" }, canceled: false });
    await settleLostReissuedAskFence(CALL);
    expect(h.cancel).toHaveBeenCalledTimes(2);
    expect(h.info).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ canceled: false, intentStatus: "canceled" }), expect.any(String));
  });

  it("a recovery re-read that fails proves nothing: null back, nothing cancelled", async () => {
    h.recoveryFind.mockRejectedValueOnce(new Error("connection reset"));
    await expect(settleLostReissuedAskFence(CALL)).resolves.toBeNull();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("a payment-row check that fails proves nothing: nothing cancelled", async () => {
    h.rowFind.mockRejectedValueOnce(new Error("connection reset"));
    await settleLostReissuedAskFence(CALL);
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: a recovery carrying this intent's own id (a runner wrote it) is never cancelled", async () => {
    h.recovery = { ...NETTED, paymentIntentId: "pi_door" };
    await settleLostReissuedAskFence(CALL);
    expect(h.rowFind).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("a recovery that is gone proves nothing", async () => {
    h.recovery = null;
    await expect(settleLostReissuedAskFence(CALL)).resolves.toBeNull();
    expect(h.cancel).not.toHaveBeenCalled();
  });
});
