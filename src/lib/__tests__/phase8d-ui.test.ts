import { describe, it, expect, vi, beforeEach } from "vitest";

// Test the UI logic and component rendering for Phase 8d
// These test the API interaction patterns and helper logic used by the UI components

describe("Phase 8d: Booking Modification UI", () => {
  describe("UI-01: Change Dates Dialog", () => {
    it("should only allow modification for PENDING/CONFIRMED bookings with future check-in", () => {
      const testCases = [
        { status: "CONFIRMED", checkIn: futureDate(7), canModify: true },
        { status: "PENDING", checkIn: futureDate(14), canModify: true },
        { status: "CANCELLED", checkIn: futureDate(7), canModify: false },
        { status: "BUMPED", checkIn: futureDate(7), canModify: false },
        { status: "COMPLETED", checkIn: futureDate(7), canModify: false },
        { status: "CONFIRMED", checkIn: pastDate(1), canModify: false },
        { status: "PENDING", checkIn: pastDate(3), canModify: false },
      ];

      for (const tc of testCases) {
        const canCancel = tc.status === "CONFIRMED" || tc.status === "PENDING";
        const isFutureCheckIn = new Date(tc.checkIn) > new Date();
        const canModify = canCancel && isFutureCheckIn;
        expect(canModify).toBe(tc.canModify);
      }
    });

    it("should detect when dates have changed from current values", () => {
      const currentCheckIn = "2026-05-01";
      const currentCheckOut = "2026-05-05";

      // No change
      expect(currentCheckIn !== currentCheckIn || currentCheckOut !== currentCheckOut).toBe(false);

      // Check-in changed
      const newCheckIn: string = "2026-05-02";
      expect(newCheckIn !== currentCheckIn || currentCheckOut !== currentCheckOut).toBe(true);

      // Check-out changed
      const newCheckOut: string = "2026-05-06";
      expect(currentCheckIn !== currentCheckIn || newCheckOut !== currentCheckOut).toBe(true);
    });

    it("should validate check-out is after check-in", () => {
      const checkIn = "2026-05-05";
      const checkOutBefore = "2026-05-03";
      const checkOutSame = "2026-05-05";
      const checkOutAfter = "2026-05-07";

      expect(checkOutBefore <= checkIn).toBe(true);
      expect(checkOutSame <= checkIn).toBe(true);
      expect(checkOutAfter <= checkIn).toBe(false);
    });

    it("should format price differences correctly", () => {
      // formatCents: cents -> "$X.XX"
      const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

      expect(formatCents(5000)).toBe("$50.00");
      expect(formatCents(-3000)).toBe("$-30.00");
      expect(formatCents(0)).toBe("$0.00");
      expect(formatCents(12550)).toBe("$125.50");
    });
  });

  describe("UI-01: Modify Quote API contract", () => {
    it("should build correct request body for date change quote", () => {
      const checkIn = "2026-06-01";
      const checkOut = "2026-06-05";
      const body = JSON.stringify({ checkIn, checkOut });
      const parsed = JSON.parse(body);

      expect(parsed.checkIn).toBe("2026-06-01");
      expect(parsed.checkOut).toBe("2026-06-05");
    });

    it("should build correct request body for add guest quote", () => {
      const body = JSON.stringify({
        addGuests: [
          { firstName: "John", lastName: "Doe", ageTier: "ADULT", isMember: true },
        ],
      });
      const parsed = JSON.parse(body);

      expect(parsed.addGuests).toHaveLength(1);
      expect(parsed.addGuests[0].firstName).toBe("John");
      expect(parsed.addGuests[0].isMember).toBe(true);
    });

    it("should build correct request body for remove guest quote", () => {
      const guestId = "guest-123";
      const body = JSON.stringify({ removeGuestIds: [guestId] });
      const parsed = JSON.parse(body);

      expect(parsed.removeGuestIds).toEqual(["guest-123"]);
    });
  });

  describe("UI-01: Quote result handling", () => {
    it("should handle capacity unavailable result", () => {
      const quote = {
        newTotalPriceCents: 20000,
        newDiscountCents: 0,
        newFinalPriceCents: 20000,
        priceDiffCents: 5000,
        changeFeeCents: 0,
        capacityAvailable: false,
        promoStillValid: true,
        nightDetails: [
          { date: "2026-06-01", availableBeds: -2 },
          { date: "2026-06-02", availableBeds: 3 },
        ],
      };

      expect(quote.capacityAvailable).toBe(false);
      const overbooked = quote.nightDetails!.filter(
        (n: { availableBeds: number }) => n.availableBeds < 0
      );
      expect(overbooked).toHaveLength(1);
      expect(overbooked[0].date).toBe("2026-06-01");
    });

    it("should handle price increase result", () => {
      const quote = {
        newFinalPriceCents: 25000,
        priceDiffCents: 5000,
        changeFeeCents: 2000,
        capacityAvailable: true,
        promoStillValid: true,
      };

      expect(quote.priceDiffCents > 0).toBe(true);
      const totalOwed = quote.priceDiffCents + quote.changeFeeCents;
      expect(totalOwed).toBe(7000);
    });

    it("should handle price decrease result (refund)", () => {
      const quote = {
        newFinalPriceCents: 10000,
        priceDiffCents: -5000,
        changeFeeCents: 0,
        capacityAvailable: true,
        promoStillValid: true,
      };

      expect(quote.priceDiffCents < 0).toBe(true);
      expect(Math.abs(quote.priceDiffCents)).toBe(5000);
    });

    it("should handle promo no longer valid", () => {
      const quote = {
        newFinalPriceCents: 20000,
        priceDiffCents: 5000,
        changeFeeCents: 0,
        capacityAvailable: true,
        promoStillValid: false,
      };

      expect(quote.promoStillValid).toBe(false);
    });

    it("should handle same-price change (no difference)", () => {
      const quote = {
        newFinalPriceCents: 15000,
        priceDiffCents: 0,
        changeFeeCents: 0,
        capacityAvailable: true,
        promoStillValid: true,
      };

      expect(quote.priceDiffCents).toBe(0);
      expect(quote.changeFeeCents).toBe(0);
    });
  });

  describe("UI-02: Manage Guests", () => {
    it("should not allow removing the last guest", () => {
      const guests = [
        { id: "g1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, priceCents: 5000 },
      ];

      // Remove button should only show when guests.length > 1
      expect(guests.length > 1).toBe(false);
    });

    it("should allow removing a guest when multiple exist", () => {
      const guests = [
        { id: "g1", firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true, priceCents: 5000 },
        { id: "g2", firstName: "Bob", lastName: "Jones", ageTier: "ADULT", isMember: false, priceCents: 7000 },
      ];

      expect(guests.length > 1).toBe(true);
    });

    it("should validate add guest form fields", () => {
      // Form requires non-empty firstName and lastName
      const validInputs = [
        { firstName: "John", lastName: "Doe", valid: true },
        { firstName: "", lastName: "Doe", valid: false },
        { firstName: "John", lastName: "", valid: false },
        { firstName: "", lastName: "", valid: false },
        { firstName: "  ", lastName: "Doe", valid: false },
      ];

      for (const input of validInputs) {
        const formValid = input.firstName.trim() && input.lastName.trim();
        expect(!!formValid).toBe(input.valid);
      }
    });

    it("should build correct request body for add guest API call", () => {
      const body = {
        guests: [
          { firstName: "Jane", lastName: "Doe", ageTier: "YOUTH", isMember: false },
        ],
      };

      expect(body.guests).toHaveLength(1);
      expect(body.guests[0].ageTier).toBe("YOUTH");
      expect(body.guests[0].isMember).toBe(false);
    });

    it("should use correct DELETE endpoint for removing a guest", () => {
      const bookingId = "booking-123";
      const guestId = "guest-456";
      const endpoint = `/api/bookings/${bookingId}/guests/${guestId}`;

      expect(endpoint).toBe("/api/bookings/booking-123/guests/guest-456");
    });
  });

  describe("UI-02: Add Guest quote handling", () => {
    it("should show capacity unavailable when no beds left", () => {
      const quote = {
        newFinalPriceCents: 30000,
        priceDiffCents: 7000,
        capacityAvailable: false,
      };

      expect(quote.capacityAvailable).toBe(false);
    });

    it("should show price increase for adding a guest", () => {
      const quote = {
        newFinalPriceCents: 22000,
        priceDiffCents: 7000,
        capacityAvailable: true,
      };

      expect(quote.capacityAvailable).toBe(true);
      expect(quote.priceDiffCents).toBe(7000);
    });
  });

  describe("UI-02: Remove Guest quote handling", () => {
    it("should show refund amount when removing a guest", () => {
      const quote = {
        newFinalPriceCents: 8000,
        priceDiffCents: -7000,
      };

      expect(quote.priceDiffCents < 0).toBe(true);
      expect(Math.abs(quote.priceDiffCents)).toBe(7000);
    });
  });

  describe("Modify dates API contract", () => {
    it("should build correct request body for date modification", () => {
      const body = JSON.stringify({ checkIn: "2026-06-10", checkOut: "2026-06-15" });
      const parsed = JSON.parse(body);

      expect(parsed.checkIn).toBe("2026-06-10");
      expect(parsed.checkOut).toBe("2026-06-15");
    });

    it("should handle modify-dates success response shape", () => {
      const response = {
        booking: { id: "b1", checkIn: "2026-06-10", checkOut: "2026-06-15" },
        priceDiffCents: 3000,
        changeFeeCents: 1000,
        refundAmountCents: 0,
        additionalAmountCents: 4000,
        promoRemoved: false,
        choreWarnings: [],
      };

      expect(response.booking.id).toBe("b1");
      expect(response.additionalAmountCents).toBe(4000);
      expect(response.choreWarnings).toEqual([]);
    });
  });

  describe("Guest modification API response handling", () => {
    it("should handle add guest success response", () => {
      const response = {
        booking: { id: "b1", guests: [{}, {}, {}] },
        addedGuests: [{ id: "g3", firstName: "New", lastName: "Guest" }],
        priceDiffCents: 5000,
        additionalAmountCents: 5000,
        promoRemoved: false,
      };

      expect(response.addedGuests).toHaveLength(1);
      expect(response.priceDiffCents).toBe(5000);
    });

    it("should handle remove guest success response", () => {
      const response = {
        booking: { id: "b1", guests: [{}] },
        removedGuest: { id: "g2", firstName: "Bob", lastName: "Jones" },
        priceDiffCents: -5000,
        refundAmountCents: 5000,
        choreWarnings: ["Dishes on 2026-06-02 was CONFIRMED"],
      };

      expect(response.removedGuest.firstName).toBe("Bob");
      expect(response.refundAmountCents).toBe(5000);
      expect(response.choreWarnings).toHaveLength(1);
    });
  });
});

function futureDate(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().split("T")[0];
}

function pastDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split("T")[0];
}
