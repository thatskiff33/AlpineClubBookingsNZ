import { describe, it, expect } from "vitest";
import {
  welcomeTemplate,
  passwordResetTemplate,
  bookingConfirmedTemplate,
  bookingPendingTemplate,
  bookingBumpedTemplate,
  bookingCancelledTemplate,
  choreRosterTemplate,
} from "../email-templates";

describe("email-templates", () => {
  describe("welcomeTemplate", () => {
    it("includes the member name", () => {
      const html = welcomeTemplate("Alice");
      expect(html).toContain("Alice");
    });

    it("includes login link", () => {
      const html = welcomeTemplate("Bob");
      expect(html).toContain("/login");
    });

    it("includes TAC branding", () => {
      const html = welcomeTemplate("Test");
      expect(html).toContain("Tokoroa Alpine Club");
    });

    it("produces valid HTML structure", () => {
      const html = welcomeTemplate("Test");
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("</html>");
    });
  });

  describe("passwordResetTemplate", () => {
    it("includes the reset URL", () => {
      const html = passwordResetTemplate("https://example.com/reset?token=abc");
      expect(html).toContain("https://example.com/reset?token=abc");
    });

    it("mentions expiry time", () => {
      const html = passwordResetTemplate("https://example.com/reset");
      expect(html).toContain("1 hour");
    });
  });

  describe("bookingConfirmedTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");

    it("includes booking details", () => {
      const html = bookingConfirmedTemplate("Alice", checkIn, checkOut, 3, 45000);
      expect(html).toContain("Alice");
      expect(html).toContain("3");
      expect(html).toContain("$450.00");
    });

    it("shows confirmed status", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 1, 10000);
      expect(html).toContain("Booking Confirmed");
    });

    it("includes view booking link", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 1, 10000);
      expect(html).toContain("/bookings");
    });
  });

  describe("bookingPendingTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");
    const holdUntil = new Date("2026-07-08");

    it("includes pending explanation", () => {
      const html = bookingPendingTemplate("Alice", checkIn, checkOut, 3, holdUntil);
      expect(html).toContain("Booking Pending");
      expect(html).toContain("non-member");
    });

    it("mentions card won't be charged", () => {
      const html = bookingPendingTemplate("Test", checkIn, checkOut, 1, holdUntil);
      expect(html).toContain("only be charged when the booking is confirmed");
    });
  });

  describe("bookingBumpedTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");

    it("includes bumped explanation", () => {
      const html = bookingBumpedTemplate("Alice", checkIn, checkOut, 2);
      expect(html).toContain("bumped");
      expect(html).toContain("member demand");
    });

    it("clarifies no charge", () => {
      const html = bookingBumpedTemplate("Test", checkIn, checkOut, 1);
      expect(html).toContain("not been charged");
    });

    it("includes rebook link", () => {
      const html = bookingBumpedTemplate("Test", checkIn, checkOut, 1);
      expect(html).toContain("/book");
    });
  });

  describe("bookingCancelledTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");

    it("shows refund amount when applicable", () => {
      const html = bookingCancelledTemplate("Alice", checkIn, checkOut, 25000);
      expect(html).toContain("$250.00");
      expect(html).toContain("refund");
    });

    it("shows no refund message when zero", () => {
      const html = bookingCancelledTemplate("Alice", checkIn, checkOut, 0);
      expect(html).toContain("No refund was applicable");
    });
  });

  describe("choreRosterTemplate", () => {
    it("includes chore list", () => {
      const html = choreRosterTemplate("Bob", "2026-07-15", [
        { name: "Dishes", description: "Wash all dishes" },
        { name: "Sweep", description: null },
      ]);
      expect(html).toContain("Dishes");
      expect(html).toContain("Sweep");
      expect(html).toContain("Wash all dishes");
    });

    it("includes heater/fire safety reminder", () => {
      const html = choreRosterTemplate("Test", "2026-07-15", []);
      expect(html).toContain("heaters and fire");
    });
  });
});
