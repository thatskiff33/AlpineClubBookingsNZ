import { describe, expect, it, vi } from "vitest";
import {
  bookingListLodgeLabel,
  countActiveLodgesForBookingList,
} from "@/lib/lodges";

/**
 * INV-CAP-039: whether a member booking LIST row names its lodge. One function
 * decides it for My Bookings and every dashboard row, so these cases are the
 * whole rule.
 */
describe("bookingListLodgeLabel (INV-CAP-039, ADR-002 presentation rule)", () => {
  const active = { name: "Ruapehu Lodge", active: true };
  const archived = { name: "Old Hut", active: false };

  it("hides the name in a single-lodge club, so its lists look as they always have", () => {
    expect(bookingListLodgeLabel(1, active)).toBeNull();
  });

  it("names the booking's own lodge once a second lodge is active", () => {
    expect(bookingListLodgeLabel(2, active)).toBe("Ruapehu Lodge");
  });

  it("names it when the count reads zero, rather than guessing the club has one lodge", () => {
    expect(bookingListLodgeLabel(0, active)).toBe("Ruapehu Lodge");
  });

  it("always names a lodge that is no longer active, even with one active lodge left", () => {
    expect(bookingListLodgeLabel(1, archived)).toBe("Old Hut");
  });
});

/**
 * INV-CAP-039 / #4948: a count that cannot be read must lean towards naming the
 * lodge, and must not take the member's page down with it.
 */
describe("countActiveLodgesForBookingList (INV-CAP-039)", () => {
  const dbReturning = (count: () => Promise<number>) =>
    ({ lodge: { count: vi.fn(count) } }) as unknown as Parameters<
      typeof countActiveLodgesForBookingList
    >[0];

  it("returns the active-lodge count the database reports", async () => {
    await expect(
      countActiveLodgesForBookingList(dbReturning(async () => 2)),
    ).resolves.toBe(2);
  });

  it("asks only for active lodges", async () => {
    const db = dbReturning(async () => 1);
    await countActiveLodgesForBookingList(db);
    expect(db.lodge.count).toHaveBeenCalledWith({ where: { active: true } });
  });

  it("returns 0 when the count cannot be read, so the row names its lodge", async () => {
    const count = await countActiveLodgesForBookingList(
      dbReturning(async () => {
        throw new Error("statement timeout");
      }),
    );
    expect(count).toBe(0);
    expect(bookingListLodgeLabel(count, { name: "Ruapehu Lodge", active: true })).toBe(
      "Ruapehu Lodge",
    );
  });
});
