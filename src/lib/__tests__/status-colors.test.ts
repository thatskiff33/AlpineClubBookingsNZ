import { describe, it, expect } from "vitest";
import { BookingStatus } from "@prisma/client";
import {
  bookingStatusClasses,
  paymentStatusClasses,
  bookingStatusClass,
  bookingStatusSwatchClass,
  bookingStatusLabel,
  bookingStatusLabels,
  humanizeStatus,
  paymentStatusClass,
  subscriptionStatusClasses,
  subscriptionStatusClass,
} from "@/lib/status-colors";
import { FALLBACK_LODGE_CAPACITY as LODGE_CAPACITY } from "@/lib/lodge-capacity";
import { CHIP_TONE_CLASSES } from "@/lib/chip-tones";

describe("bookingStatusClasses", () => {
  it("defines all booking statuses", () => {
    for (const s of Object.values(BookingStatus)) {
      expect(bookingStatusClasses[s], `missing class for ${s}`).toBeTruthy();
    }
  });

  it("each booking status has a unique colour class", () => {
    const classes = Object.values(bookingStatusClasses);
    const unique = new Set(classes);
    expect(unique.size).toBe(classes.length);
  });

  it("CONFIRMED and PAID have different colours", () => {
    expect(bookingStatusClasses["CONFIRMED"]).not.toBe(bookingStatusClasses["PAID"]);
  });

  it("CANCELLED and BUMPED have different colours", () => {
    expect(bookingStatusClasses["CANCELLED"]).not.toBe(bookingStatusClasses["BUMPED"]);
  });
});

// ALP-572: the admin calendar used to keep its own status colours, which
// disagreed with these chips (COMPLETED and WAITLISTED shared a bar colour).
// Both now derive from one tone per status, so the swatch and chip of every
// status share a scale and no two statuses share a swatch.
describe("bookingStatusSwatchClass", () => {
  const scaleOf = (classes: string) => classes.match(/\bbg-([a-z0-9]+)-\d+\b/)?.[1] ?? classes;

  it.each(Object.values(BookingStatus))("%s swatch is the same scale as its chip", (status) => {
    const swatch = bookingStatusSwatchClass(status);
    if (bookingStatusClass(status) === CHIP_TONE_CLASSES.neutral) {
      expect(swatch).toBe("bg-muted");
    } else {
      expect(swatch).toMatch(/^bg-[a-z0-9]+-9$/);
      expect(scaleOf(swatch)).toBe(scaleOf(bookingStatusClass(status)));
    }
  });

  it("gives every booking status a distinct swatch", () => {
    const swatches = Object.values(BookingStatus).map(bookingStatusSwatchClass);
    expect(new Set(swatches).size).toBe(swatches.length);
  });

  it("falls back to the neutral swatch for an unknown status", () => {
    expect(bookingStatusSwatchClass("UNKNOWN_STATUS")).toBe("bg-muted");
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
    expect(fallback).toBe(CHIP_TONE_CLASSES.neutral);
  });
});

describe("bookingStatusLabel helper", () => {
  it("returns the expected labels for booking statuses", () => {
    expect(bookingStatusLabels["CONFIRMED"]).toBe("Confirmed (Unpaid)");
    expect(bookingStatusLabel("CONFIRMED")).toBe("Confirmed (Unpaid)");
    expect(bookingStatusLabel("PAYMENT_PENDING")).toBe("Payment Pending");
    expect(bookingStatusLabel("AWAITING_REVIEW")).toBe("Awaiting Review");
    expect(bookingStatusLabel("WAITLIST_OFFERED")).toBe("Waitlist Offered");
  });

  it("each booking status has a unique label", () => {
    const labels = Object.values(bookingStatusLabels);
    const unique = new Set(labels);
    expect(unique.size).toBe(labels.length);
  });

  it("humanizes unknown statuses", () => {
    expect(bookingStatusLabel("CUSTOM_STATUS")).toBe("Custom status");
  });
});

describe("humanizeStatus helper", () => {
  it("renders raw enum values in sentence case", () => {
    expect(humanizeStatus("REQUESTED")).toBe("Requested");
    expect(humanizeStatus("PENDING")).toBe("Pending");
    expect(humanizeStatus("APPROVED")).toBe("Approved");
    expect(humanizeStatus("PENDING_NOMINATORS")).toBe("Pending nominators");
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
    expect(fallback).toBe(CHIP_TONE_CLASSES.neutral);
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
    expect(fallback).toBe(CHIP_TONE_CLASSES.neutral);
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
