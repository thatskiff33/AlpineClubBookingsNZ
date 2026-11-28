/**
 * #5433 (the card recovery doors): the one sequence every card door that owes
 * the booking confirmation runs after its settle commits
 * (`queueInvoiceAndDeliverPaidConfirmation`). The doors' own suites prove each
 * door hands it the settle's result; this proves the sequence: the invoice
 * first, then the owed marker, the unkeyed fallback, or nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const confirmation = vi.hoisted(() => ({
  deliver: vi.fn(async () => undefined),
  sendUnrecorded: vi.fn(async () => undefined),
  marker: { id: "booking-confirmed:booking-1:1782864000000", kind: "booking-confirmed", subjectId: "booking-1", eventAt: new Date("2026-07-01T00:00:00.000Z"), variant: null, payload: null },
}));
vi.mock("@/lib/paid-booking-confirmation-notice", () => ({
  deliverPaidBookingConfirmation: confirmation.deliver,
  sendUnrecordedPaidBookingConfirmation: confirmation.sendUnrecorded,
}));

const log = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { error: log.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { queueInvoiceAndDeliverPaidConfirmation } from "@/lib/paid-booking-confirmation-after-commit";

describe("queueInvoiceAndDeliverPaidConfirmation (#5433)", () => {
  const queueInvoice = vi.fn(async () => undefined);
  const run = (result: Parameters<typeof queueInvoiceAndDeliverPaidConfirmation>[0]) =>
    queueInvoiceAndDeliverPaidConfirmation(result, { bookingId: "booking-1", format: CLUB_FORMAT_TEST, job: "door-x", queueInvoice });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queues the invoice, then delivers the owed marker a fresh PAID carries, once", async () => {
    await run({ outcome: "paid", paidConfirmation: confirmation.marker });

    expect(queueInvoice).toHaveBeenCalledTimes(1);
    expect(confirmation.deliver).toHaveBeenCalledTimes(1);
    expect(confirmation.deliver).toHaveBeenCalledWith(confirmation.marker, CLUB_FORMAT_TEST, "door-x");
    expect(confirmation.deliver.mock.invocationCallOrder[0]).toBeGreaterThan(queueInvoice.mock.invocationCallOrder[0]!);
    expect(confirmation.sendUnrecorded).not.toHaveBeenCalled();
  });

  it("sends a fresh PAID that was owed a marker the booking could not key (null) once, unkeyed, after the invoice", async () => {
    await run({ outcome: "paid", paidConfirmation: null });

    expect(confirmation.deliver).not.toHaveBeenCalled();
    expect(confirmation.sendUnrecorded).toHaveBeenCalledWith("booking-1", CLUB_FORMAT_TEST, "door-x");
    expect(confirmation.sendUnrecorded.mock.invocationCallOrder[0]).toBeGreaterThan(queueInvoice.mock.invocationCallOrder[0]!);
  });

  it.each(["already_paid", "duplicate_capture_refunded", "duplicate_capture_refund_failed", "duplicate_capture_kept"] as const)(
    "sends nothing for %s, whose confirmation belongs to the settle that marked the booking paid, and still queues the invoice",
    async (outcome) => {
      await run({ outcome });

      expect(queueInvoice).toHaveBeenCalledTimes(1);
      expect(confirmation.deliver).not.toHaveBeenCalled();
      expect(confirmation.sendUnrecorded).not.toHaveBeenCalled();
    },
  );

  // Fix round 1, item 3: a door that forgot to ask the settle gets no marker and no null; sending unkeyed then
  // would be a confirmation the sweep can never see, so it is an error log and nothing is sent.
  it("sends nothing, and logs an error, for a fresh PAID whose settle was never asked to owe it (no paidConfirmation)", async () => {
    await run({ outcome: "paid" });

    expect(queueInvoice).toHaveBeenCalledTimes(1);
    expect(confirmation.deliver).not.toHaveBeenCalled();
    expect(confirmation.sendUnrecorded).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith({ bookingId: "booking-1", job: "door-x" }, expect.stringContaining("without the settle being asked to owe it"));
  });

  it("sends nothing when the door settled nothing (null), and still queues the invoice", async () => {
    await run(null);

    expect(queueInvoice).toHaveBeenCalledTimes(1);
    expect(confirmation.deliver).not.toHaveBeenCalled();
    expect(confirmation.sendUnrecorded).not.toHaveBeenCalled();
  });
});
