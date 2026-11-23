/**
 * #5433, owner decision D2: the restart of an offer's window, against a
 * transaction double. Its locks (lock(1), then the booking's own lodge key),
 * its re-read under them, its claim guarded on the status, the offer's
 * identity and the offer's ORIGINAL deadline (one restart per offer, review
 * C), its floor (review D) and the cases where no email can go (review L).
 * Against PostgreSQL, racing the expiry and the cross-lodge confirm:
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
import { WAITLIST_NOTICE_SWEEP_AFTER_MS, waitlistOfferExpiresAt } from "@/lib/waitlist-offer-window";
import { restartWaitlistOfferWindow } from "@/lib/waitlist-offer-window-restart";

const HOUR = 60 * 60 * 1000;
const now = new Date("2026-07-01T00:00:00.000Z");
const zone = requireClubTimeZone("Pacific/Auckland");
const at = (ms: number) => new Date(now.getTime() + ms);

/** An offer made at `offeredAt`, on its original deadline unless told otherwise. */
function offer(offeredAt: Date, overrides: Record<string, unknown> = {}) {
  return {
    status: "WAITLIST_OFFERED",
    waitlistOfferedAt: offeredAt,
    waitlistOfferExpiresAt: waitlistOfferExpiresAt(offeredAt),
    checkIn: new Date("2026-09-01T00:00:00.000Z"),
    noEmails: false,
    memberId: "m1",
    member: { email: "ada@example.test" },
    organisation: null,
    ...overrides,
  };
}

function reading(row: ReturnType<typeof offer> | null) {
  tx.booking.findUnique.mockReset();
  tx.booking.findUnique.mockResolvedValueOnce({ lodgeId: "lodge-1" }).mockResolvedValueOnce(row);
}

const restart = (offeredAt: Date) => restartWaitlistOfferWindow({ bookingId: "booking1", offeredAt, zone, now });

const offeredAt = at(-3 * HOUR);

beforeEach(() => {
  vi.clearAllMocks();
  transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  reading(offer(offeredAt));
  tx.booking.updateMany.mockResolvedValue({ count: 1 });
});

describe("restartWaitlistOfferWindow (D2)", () => {
  it("takes lock(1), then the booking's own lodge key, on the lock(1) budget, and re-reads the offer after both", async () => {
    await restart(offeredAt);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), LOCK1_HOLDER_TRANSACTION_BUDGET);
    expect(String(tx.$executeRaw.mock.calls[0]![0])).toContain("pg_advisory_xact_lock(1)");
    expect(acquireLodgeCapacityLock).toHaveBeenCalledWith(tx, "lodge-1");
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(acquireLodgeCapacityLock.mock.invocationCallOrder[0]!);
    expect(acquireLodgeCapacityLock.mock.invocationCallOrder[0]).toBeLessThan(tx.booking.findUnique.mock.invocationCallOrder[1]!);
  });

  it("moves the original deadline to a full window from the sweep's clock, guarded on the status, the offer and that original deadline", async () => {
    await expect(restart(offeredAt)).resolves.toEqual({
      kind: "in-force",
      expiresAt: at(48 * HOUR),
      restarted: true,
      previousExpiresAt: waitlistOfferExpiresAt(offeredAt),
    });
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: "booking1", status: "WAITLIST_OFFERED", waitlistOfferedAt: offeredAt, waitlistOfferExpiresAt: waitlistOfferExpiresAt(offeredAt) },
      data: { waitlistOfferExpiresAt: at(48 * HOUR) },
    });
  });

  it("caps the restarted deadline at the start of the check-in date in the club's time zone", async () => {
    const late = at(-47 * HOUR); // its original deadline is an hour away
    reading(offer(late, { checkIn: new Date("2026-07-02T00:00:00.000Z") }));
    await expect(restart(late)).resolves.toMatchObject({ kind: "in-force", expiresAt: new Date("2026-07-01T12:00:00.000Z"), restarted: true });
  });

  it("revives an offer whose original deadline passed unread", async () => {
    const lapsed = at(-50 * HOUR);
    reading(offer(lapsed));
    await expect(restart(lapsed)).resolves.toMatchObject({ kind: "in-force", expiresAt: at(48 * HOUR), restarted: true });
  });

  it("restarts once per offer: an offer already off its original deadline is sent with the deadline in force, unmoved", async () => {
    const restartedTo = at(40 * HOUR);
    reading(offer(offeredAt, { waitlistOfferExpiresAt: restartedTo }));
    await expect(restart(offeredAt)).resolves.toEqual({ kind: "in-force", expiresAt: restartedTo, restarted: false });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("gives no window, and writes nothing, when less than the waitlist wait would remain", async () => {
    reading(offer(offeredAt, { waitlistOfferExpiresAt: at(WAITLIST_NOTICE_SWEEP_AFTER_MS - 1) }));
    await expect(restart(offeredAt)).resolves.toEqual({ kind: "no-window" });
    // A cap closer than the wait gives no window either.
    const late = at(-47.9 * HOUR);
    reading(offer(late, { checkIn: new Date("2026-07-01T00:00:00.000Z") }));
    await expect(restart(late)).resolves.toEqual({ kind: "no-window" });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["the booking's emails are switched off", { noEmails: true }],
    ["the owner has no address", { member: { email: "" } }],
    ["the owner's address is a placeholder", { member: { email: "walk-in@no-email.invalid" } }],
  ])("keeps the deadline when no email can go: %s", async (_case, overrides) => {
    reading(offer(offeredAt, overrides));
    await expect(restart(offeredAt)).resolves.toEqual({ kind: "in-force", expiresAt: waitlistOfferExpiresAt(offeredAt), restarted: false });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["no longer offered", offer(offeredAt, { status: "WAITLISTED", waitlistOfferedAt: null })],
    ["a different offer", offer(at(-HOUR))],
    ["gone", null],
  ])("changes nothing when the offer is %s", async (_case, row) => {
    reading(row);
    await expect(restart(offeredAt)).resolves.toMatchObject({ kind: "moved-on" });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it("reports a lost claim as moved on", async () => {
    tx.booking.updateMany.mockResolvedValue({ count: 0 });
    await expect(restart(offeredAt)).resolves.toMatchObject({ kind: "moved-on" });
  });
});
