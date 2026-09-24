/**
 * The store-facing half of the credit sync (#3599): what it reads, what it
 * writes, and what it deliberately does not swallow.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: log }));

import { syncBookingLedgerCredits } from "@/lib/booking-ledger-credit-sync";

function store(over: { booking?: unknown; credits?: unknown[]; posted?: unknown[]; createMany?: ReturnType<typeof vi.fn> } = {}) {
  const createMany = over.createMany ?? vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  const lines = vi.fn(async () => over.posted ?? []);
  const credits = vi.fn(async () =>
    over.credits ?? [{ id: "c1", type: "BOOKING_APPLIED", amountCents: -2_275, restoredFromBookingId: null }],
  );
  const booking = vi.fn(async () => (over.booking === undefined ? { lodgeId: "l1" } : over.booking));
  return {
    s: {
      booking: { findUnique: booking },
      memberCredit: { findMany: credits },
      bookingLedgerLine: { findMany: lines, createMany },
    } as never,
    createMany,
    lines,
    credits,
  };
}

describe("syncBookingLedgerCredits", () => {
  it("posts what the booking's credit rows imply, through the write door, skipping keys already there", async () => {
    const { s, createMany } = store();
    await syncBookingLedgerCredits({ bookingId: "b1", store: s });
    const call = createMany.mock.calls[0]?.[0] as { data: Array<Record<string, unknown>>; skipDuplicates: boolean };
    expect(call.skipDuplicates).toBe(true);
    expect(call.data).toEqual([
      expect.objectContaining({ kind: "CREDIT_APPLIED", amountCents: 2_275, postingKey: "credit:c1", bookingId: "b1", lodgeId: "l1" }),
    ]);
  });

  it("reads exactly the rows that belong to the booking: credit applied TO it, and credit minted FROM it", async () => {
    const { s, credits, lines } = store();
    await syncBookingLedgerCredits({ bookingId: "b1", store: s });
    expect(credits).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { appliedToBookingId: "b1", type: "BOOKING_APPLIED" },
            { sourceBookingId: "b1", type: { in: ["CANCELLATION_REFUND", "BOOKING_MODIFICATION_REFUND"] } },
          ],
        },
      }),
    );
    expect(lines).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bookingId: "b1", kind: { in: ["CREDIT_APPLIED", "CREDIT_ISSUED"] } } }),
    );
  });

  it("writes nothing on a replay — every key is already posted", async () => {
    const { s, createMany } = store({ posted: [{ postingKey: "credit:c1", amountCents: 2_275 }] });
    await syncBookingLedgerCredits({ bookingId: "b1", store: s });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("does nothing for a booking that no longer exists", async () => {
    const { s, createMany, credits } = store({ booking: null });
    await syncBookingLedgerCredits({ bookingId: "gone", store: s });
    expect(credits).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it("swallows a PLANNING failure — pure code, the caller's transaction is untouched — and logs it", async () => {
    log.error.mockClear();
    const { s, createMany } = store({
      credits: [{ id: "a1", type: "ADMIN_ADJUSTMENT", amountCents: 500, restoredFromBookingId: null }],
    });
    await expect(syncBookingLedgerCredits({ bookingId: "b1", store: s })).resolves.toBeUndefined();
    expect(createMany).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("does NOT swallow a WRITE failure: a statement Postgres refused has already aborted the transaction (#3590)", async () => {
    const refused = new Error("refused");
    const { s } = store({ createMany: vi.fn(async () => Promise.reject(refused)) });
    await expect(syncBookingLedgerCredits({ bookingId: "b1", store: s })).rejects.toBe(refused);
  });
});
