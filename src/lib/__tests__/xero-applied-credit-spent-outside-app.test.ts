import { describe, expect, it, vi } from "vitest";

import { CreditNoteSpentOutsideAppError } from "@/lib/xero-credit-note-spent-outside-app";

/**
 * #4219 — the allocation worker's entry into the converge routine. The routine's
 * own behaviour is proved against real PostgreSQL
 * (`credit-note-spent-outside-app.realdb.test.ts`); this pins the two ways the
 * worker must NOT call it.
 */

const mocks = vi.hoisted(() => ({ bookingFindUnique: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findUnique: mocks.bookingFindUnique }, $transaction: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  CREDIT_SPENT_OUTSIDE_APP_RESOLUTION_REASON,
  convergedForNamedFailure,
} from "@/lib/xero-applied-credit-spent-outside-app";
import { resolutionLabel } from "@/lib/xero-operation-resolution";

describe("convergedForNamedFailure", () => {
  it("never acts on an error that is not the confirmed named failure", async () => {
    await expect(convergedForNamedFailure(new Error("boom"), "booking_1")).resolves.toBe(false);
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
  });

  it("stops after three converge attempts for one run", async () => {
    const named = new CreditNoteSpentOutsideAppError("spent", "cn_1", 0, 5250);
    await expect(convergedForNamedFailure(named, "booking_1", 3)).resolves.toBe(false);
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
  });

  it("leaves the failure standing when the booking has no payment or owner", async () => {
    mocks.bookingFindUnique.mockResolvedValue(null);
    const named = new CreditNoteSpentOutsideAppError("spent", "cn_1", 0, 5250);
    await expect(convergedForNamedFailure(named, "booking_1")).resolves.toBe(false);
  });
});

describe("resolutionLabel", () => {
  it("names a close the app made itself, and keeps \"Resolved in Xero\" for an officer's mark", () => {
    expect(resolutionLabel(CREDIT_SPENT_OUTSIDE_APP_RESOLUTION_REASON)).toBe("Closed: credit used outside the app");
    expect(resolutionLabel("Fixed the invoice by hand")).toBe("Resolved in Xero");
    expect(resolutionLabel(null)).toBe("Resolved in Xero");
  });
});
