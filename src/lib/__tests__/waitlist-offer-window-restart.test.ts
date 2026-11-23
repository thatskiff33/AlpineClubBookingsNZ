/**
 * #5433, owner decision D2: the restart of an offer's window, against a
 * transaction double. Its locks (lock(1), then the booking's own lodge key),
 * its re-read under them, and its claim guarded on the status, the offer's
 * identity and the deadline it read. Against PostgreSQL, racing the expiry:
 * `waitlist-owed-notices.realdb.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  booking: { findUnique: vi.fn(), updateMany: vi.fn() },
}));
const transaction = vi.hoisted(() => vi.fn());
const acquireLodgeCapacityLock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: transaction } }));
vi.mock("@/lib/capacity", () => ({ acquireLodgeCapacityLock }));

import { requireClubTimeZone } from "@/lib/club-time";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";
import { restartWaitlistOfferWindow } from "@/lib/waitlist-offer-window-restart";

const HOUR = 60 * 60 * 1000;
const now = new Date("2026-07-01T00:00:00.000Z");
const offeredAt = new Date(now.getTime() - 3 * HOUR);
const expiresAt = new Date(offeredAt.getTime() + 48 * HOUR);
const zone = requireClubTimeZone("Pacific/Auckland");

function offer(overrides: Record<string, unknown> = {}) {
  return {
    status: "WAITLIST_OFFERED",
    waitlistOfferedAt: offeredAt,
    waitlistOfferExpiresAt: expiresAt,
    checkIn: new Date("2026-09-01T00:00:00.000Z"),
    noEmails: false,
    ...overrides,
  };
}

const restart = () => restartWaitlistOfferWindow({ bookingId: "booking1", offeredAt, zone, now });

beforeEach(() => {
  vi.clearAllMocks();
  transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  tx.booking.findUnique.mockReset();
  tx.booking.findUnique.mockResolvedValueOnce({ lodgeId: "lodge-1" }).mockResolvedValueOnce(offer());
  tx.booking.updateMany.mockResolvedValue({ count: 1 });
});

describe("restartWaitlistOfferWindow (D2)", () => {
  it("takes lock(1), then the booking's own lodge key, on the lock(1) budget, and re-reads the offer after both", async () => {
    await restart();
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), LOCK1_HOLDER_TRANSACTION_BUDGET);
    expect(String(tx.$executeRaw.mock.calls[0]![0])).toContain("pg_advisory_xact_lock(1)");
    expect(acquireLodgeCapacityLock).toHaveBeenCalledWith(tx, "lodge-1");
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(acquireLodgeCapacityLock.mock.invocationCallOrder[0]!);
    // The mutable re-read comes after the lodge key.
    expect(acquireLodgeCapacityLock.mock.invocationCallOrder[0]).toBeLessThan(tx.booking.findUnique.mock.invocationCallOrder[1]!);
  });

  it("moves the deadline to a full window from the send, guarded on the status, the offer and the deadline it read", async () => {
    await expect(restart()).resolves.toEqual({ kind: "in-force", expiresAt: new Date(now.getTime() + 48 * HOUR), restarted: true });
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: "booking1", status: "WAITLIST_OFFERED", waitlistOfferedAt: offeredAt, waitlistOfferExpiresAt: expiresAt },
      data: { waitlistOfferExpiresAt: new Date(now.getTime() + 48 * HOUR) },
    });
  });

  it("caps the restarted deadline at the start of the check-in date, and revives an offer whose deadline passed unread", async () => {
    tx.booking.findUnique.mockReset();
    tx.booking.findUnique
      .mockResolvedValueOnce({ lodgeId: "lodge-1" })
      .mockResolvedValueOnce(offer({ waitlistOfferExpiresAt: new Date("2026-06-30T00:00:00.000Z"), checkIn: new Date("2026-07-02T00:00:00.000Z") }));
    const result = await restart();
    expect(result).toEqual({ kind: "in-force", expiresAt: new Date("2026-07-01T12:00:00.000Z"), restarted: true });
  });

  it.each([
    ["no longer offered", offer({ status: "WAITLISTED", waitlistOfferedAt: null })],
    ["a different offer", offer({ waitlistOfferedAt: new Date(now.getTime() - HOUR) })],
    ["gone", null],
  ])("changes nothing when the offer is %s", async (_case, row) => {
    tx.booking.findUnique.mockReset();
    tx.booking.findUnique.mockResolvedValueOnce({ lodgeId: "lodge-1" }).mockResolvedValueOnce(row);
    await expect(restart()).resolves.toMatchObject({ kind: "moved-on" });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("reports a lost claim as moved on", async () => {
    tx.booking.updateMany.mockResolvedValue({ count: 0 });
    await expect(restart()).resolves.toMatchObject({ kind: "moved-on" });
  });

  it("keeps the deadline of a booking whose emails are switched off: its email will be withheld", async () => {
    tx.booking.findUnique.mockReset();
    tx.booking.findUnique.mockResolvedValueOnce({ lodgeId: "lodge-1" }).mockResolvedValueOnce(offer({ noEmails: true }));
    await expect(restart()).resolves.toEqual({ kind: "in-force", expiresAt, restarted: false });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("writes nothing when the deadline in force already reaches the cap (an offer made close to check-in)", async () => {
    const late = new Date("2026-07-03T00:00:00.000Z");
    tx.booking.findUnique.mockReset();
    tx.booking.findUnique
      .mockResolvedValueOnce({ lodgeId: "lodge-1" })
      .mockResolvedValueOnce(offer({ waitlistOfferExpiresAt: late, checkIn: new Date("2026-07-02T00:00:00.000Z") }));
    await expect(restart()).resolves.toEqual({ kind: "in-force", expiresAt: late, restarted: false });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("gives no window once the cap and the deadline have both passed", async () => {
    tx.booking.findUnique.mockReset();
    tx.booking.findUnique
      .mockResolvedValueOnce({ lodgeId: "lodge-1" })
      .mockResolvedValueOnce(offer({ waitlistOfferExpiresAt: new Date("2026-06-30T00:00:00.000Z"), checkIn: new Date("2026-06-30T00:00:00.000Z") }));
    await expect(restart()).resolves.toEqual({ kind: "no-window" });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });
});
