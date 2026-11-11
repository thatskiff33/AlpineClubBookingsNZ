import { describe, expect, it } from "vitest";
import { bookingListLodgeLabel } from "@/lib/lodges";

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
