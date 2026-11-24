/**
 * #5433 review A: a later phase of the cross-lodge confirm treats a window
 * restart (and only a window restart) since its first phase as the same offer.
 * Against PostgreSQL, the confirm racing a real restart:
 * `waitlist-owed-notices.realdb.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import { offerSnapshotAcrossWindowRestart } from "@/lib/waitlist-offer-epoch";

const row = {
  id: "entry-1",
  status: "WAITLIST_OFFERED",
  updatedAt: new Date("2026-08-06T00:00:00.000Z"),
  waitlistOfferedAt: new Date("2026-08-05T00:00:00.000Z"),
  waitlistOfferExpiresAt: new Date("2026-08-07T00:00:00.000Z"),
  waitlistOfferedLodgeId: "lodge-b",
  waitlistOfferedPriceCents: 34_000,
  notes: null as string | null,
};
// A relation the first phase included: never compared.
const entry = { ...row, guests: [{ id: "g1" }] };

const read = (current: Record<string, unknown> | null) => ({ booking: { findUnique: vi.fn().mockResolvedValue(current) } });

describe("offerSnapshotAcrossWindowRestart", () => {
  it("takes the restarted deadline and updatedAt when nothing else changed", async () => {
    const restarted = { ...row, updatedAt: new Date("2026-08-06T05:00:00.000Z"), waitlistOfferExpiresAt: new Date("2026-08-08T05:00:00.000Z") };
    const tx = read(restarted);
    const snapshot = await offerSnapshotAcrossWindowRestart(tx as never, entry);
    expect(tx.booking.findUnique).toHaveBeenCalledWith({ where: { id: "entry-1" } });
    expect(snapshot).toEqual({ ...entry, updatedAt: restarted.updatedAt, waitlistOfferExpiresAt: restarted.waitlistOfferExpiresAt });
  });

  it("returns the first phase's row unchanged when nothing changed", async () => {
    await expect(offerSnapshotAcrossWindowRestart(read({ ...row }) as never, entry)).resolves.toEqual(entry);
  });

  it.each([
    ["the offer's identity", { waitlistOfferedAt: new Date("2026-08-06T00:00:00.000Z") }],
    ["the offered price", { waitlistOfferedPriceCents: 35_000 }],
    ["the status", { status: "WAITLISTED" }],
    ["a column the offer guard does not name", { notes: "an officer's note" }],
  ])("keeps the first phase's row when %s changed too, so the claim still fails", async (_case, change) => {
    const current = { ...row, updatedAt: new Date("2026-08-06T05:00:00.000Z"), waitlistOfferExpiresAt: new Date("2026-08-08T05:00:00.000Z"), ...change };
    await expect(offerSnapshotAcrossWindowRestart(read(current) as never, entry)).resolves.toBe(entry);
  });

  it("keeps the first phase's row when the booking is gone", async () => {
    await expect(offerSnapshotAcrossWindowRestart(read(null) as never, entry)).resolves.toBe(entry);
  });
});
