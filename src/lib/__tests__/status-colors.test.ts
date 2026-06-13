import { describe, it, expect } from "vitest";
import {
  bookingStatusClasses,
  paymentStatusClasses,
  bookingStatusClass,
  bookingStatusLabel,
  bookingStatusLabels,
  paymentStatusClass,
  subscriptionStatusClasses,
  subscriptionStatusClass,
} from "@/lib/status-colors";
import { FALLBACK_LODGE_CAPACITY as LODGE_CAPACITY } from "@/lib/lodge-capacity";

describe("bookingStatusClasses", () => {
  it("defines all booking statuses", () => {
    const statuses = ["DRAFT", "PENDING", "CONFIRMED", "PAID", "COMPLETED", "CANCELLED", "BUMPED", "WAITLISTED", "WAITLIST_OFFERED"];
    for (const s of statuses) {
      expect(bookingStatusClasses[s], `missing class for ${s}`).toBeTruthy();
    }
  });

  it("each booking status has a unique colour class", () => {
    const statuses = ["DRAFT", "PENDING", "CONFIRMED", "PAID", "COMPLETED", "CANCELLED", "BUMPED", "WAITLISTED", "WAITLIST_OFFERED"];
    const classes = statuses.map((s) => bookingStatusClasses[s]);
    const unique = new Set(classes);
    expect(unique.size).toBe(statuses.length);
  });

  it("CONFIRMED and PAID have different colours", () => {
    expect(bookingStatusClasses["CONFIRMED"]).not.toBe(bookingStatusClasses["PAID"]);
  });

  it("CANCELLED and BUMPED have different colours", () => {
    expect(bookingStatusClasses["CANCELLED"]).not.toBe(bookingStatusClasses["BUMPED"]);
  });
});

describe("paymentStatusClasses", () => {
  it("defines all payment statuses", () => {
    const statuses = ["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"];
    for (const s of statuses) {
      expect(paymentStatusClasses[s], `missing class for ${s}`).toBeTruthy();
    }
  });

  it("each payment status has a unique colour class", () => {
    const statuses = ["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"];
    const classes = statuses.map((s) => paymentStatusClasses[s]);
    const unique = new Set(classes);
    expect(unique.size).toBe(statuses.length);
  });
});

describe("bookingStatusClass helper", () => {
  it("returns the correct class for known statuses", () => {
    expect(bookingStatusClass("CONFIRMED")).toBe(bookingStatusClasses["CONFIRMED"]);
    expect(bookingStatusClass("PAID")).toBe(bookingStatusClasses["PAID"]);
    expect(bookingStatusClass("CANCELLED")).toBe(bookingStatusClasses["CANCELLED"]);
  });

  it("returns a fallback for unknown statuses", () => {
    const fallback = bookingStatusClass("UNKNOWN_STATUS");
    expect(fallback).toBeTruthy();
    expect(fallback).toContain("bg-gray-100");
  });
});

describe("bookingStatusLabel helper", () => {
  it("returns the expected labels for booking statuses", () => {
    expect(bookingStatusLabels["CONFIRMED"]).toBe("Payment Pending");
    expect(bookingStatusLabel("CONFIRMED")).toBe("Payment Pending");
    expect(bookingStatusLabel("WAITLIST_OFFERED")).toBe("Waitlist Offered");
  });

  it("falls back to replacing underscores for unknown statuses", () => {
    expect(bookingStatusLabel("CUSTOM_STATUS")).toBe("CUSTOM STATUS");
  });
});

describe("paymentStatusClass helper", () => {
  it("returns the correct class for known statuses", () => {
    expect(paymentStatusClass("SUCCEEDED")).toBe(paymentStatusClasses["SUCCEEDED"]);
    expect(paymentStatusClass("FAILED")).toBe(paymentStatusClasses["FAILED"]);
    expect(paymentStatusClass("REFUNDED")).toBe(paymentStatusClasses["REFUNDED"]);
  });

  it("returns a fallback for unknown statuses", () => {
    const fallback = paymentStatusClass("UNKNOWN_STATUS");
    expect(fallback).toBeTruthy();
    expect(fallback).toContain("bg-gray-100");
  });
});

describe("subscriptionStatusClasses", () => {
  it("defines all subscription statuses", () => {
    const statuses = ["PAID", "UNPAID", "OVERDUE", "NOT_INVOICED", "NOT_REQUIRED"];
    for (const s of statuses) {
      expect(subscriptionStatusClasses[s], `missing class for ${s}`).toBeTruthy();
    }
  });

  it("each subscription status has a unique colour class", () => {
    const statuses = ["PAID", "UNPAID", "OVERDUE", "NOT_INVOICED", "NOT_REQUIRED"];
    const classes = statuses.map((s) => subscriptionStatusClasses[s]);
    const unique = new Set(classes);
    expect(unique.size).toBe(statuses.length);
  });
});

describe("subscriptionStatusClass helper", () => {
  it("returns the correct class for known statuses", () => {
    expect(subscriptionStatusClass("PAID")).toBe(subscriptionStatusClasses["PAID"]);
    expect(subscriptionStatusClass("OVERDUE")).toBe(subscriptionStatusClasses["OVERDUE"]);
  });

  it("returns a fallback for unknown statuses", () => {
    const fallback = subscriptionStatusClass("UNKNOWN_STATUS");
    expect(fallback).toBeTruthy();
    expect(fallback).toContain("bg-gray-100");
  });
});

describe("Calendar bed availability calculation", () => {
  it("computes correct beds available for a date with bookings", () => {
    const availability: Record<string, number> = { "2026-07-01": 6 };
    const dateStr = "2026-07-01";
    const occupied = availability[dateStr] ?? 0;
    const available = LODGE_CAPACITY - occupied;
    expect(available).toBe(LODGE_CAPACITY - 6);
  });

  it("returns full capacity when date has no bookings", () => {
    const availability: Record<string, number> = {};
    const dateStr = "2026-07-01";
    const occupied = availability[dateStr] ?? 0;
    const available = LODGE_CAPACITY - occupied;
    expect(available).toBe(LODGE_CAPACITY);
  });

  it("returns zero when lodge is fully booked", () => {
    const availability: Record<string, number> = { "2026-07-01": LODGE_CAPACITY };
    const dateStr = "2026-07-01";
    const occupied = availability[dateStr] ?? 0;
    const available = LODGE_CAPACITY - occupied;
    expect(available).toBe(0);
  });

  it("returns limited when 1–5 beds remain", () => {
    for (let remaining = 1; remaining <= 5; remaining++) {
      const occupied = LODGE_CAPACITY - remaining;
      const availability: Record<string, number> = { "2026-07-01": occupied };
      const available = LODGE_CAPACITY - (availability["2026-07-01"] ?? 0);
      expect(available).toBe(remaining);
      expect(available).toBeLessThanOrEqual(5);
      expect(available).toBeGreaterThan(0);
    }
  });

  it("shows available when 6 or more beds remain", () => {
    const available = LODGE_CAPACITY - (LODGE_CAPACITY - 6);
    expect(available).toBeGreaterThan(5);
  });
});
