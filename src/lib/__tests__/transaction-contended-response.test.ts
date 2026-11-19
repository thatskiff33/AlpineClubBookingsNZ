import { beforeEach, describe, expect, it, vi } from "vitest";

import { transactionContendedResponse } from "@/lib/transaction-contended-response";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { warn } }));

describe("transactionContendedResponse", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["P2028", "P2034"])("makes %s retryable without exposing database details", async (code) => {
    const error = Object.assign(new Error("private database details"), { code });

    const response = transactionContendedResponse(error, "Booking claim contended", {
      context: { bookingId: "booking-1" },
    });

    expect(response?.status).toBe(503);
    expect(response?.headers.get("Retry-After")).toBe("2");
    await expect(response?.json()).resolves.toEqual({
      error: "The booking system is busy right now. Nothing was saved, so please try again in a moment.",
      code: "TRANSACTION_CONTENDED",
    });
    expect(warn).toHaveBeenCalledWith(
      { err: error, bookingId: "booking-1" },
      "Booking claim contended",
    );
  });

  it("preserves the caller's recovery wording and public error code", async () => {
    const response = transactionContendedResponse({ code: "P2028" }, "Move contended", {
      message: "Check the current booking status before retrying.",
      code: "BOOKING_MOVE_CONTENDED",
    });

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({
      error: "Check the current booking status before retrying.",
      code: "BOOKING_MOVE_CONTENDED",
    });
  });

  it.each([null, undefined, "P2028", new Error("P2028"), { code: "P2002" }])(
    "leaves unrelated errors to the caller's existing handling: %s",
    (error) => {
      expect(transactionContendedResponse(error, "Claim contended")).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    },
  );
});
