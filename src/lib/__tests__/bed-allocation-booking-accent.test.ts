import { describe, expect, it } from "vitest";
import {
  BOOKING_ACCENTS,
  getBookingAccent,
} from "@/app/(admin)/admin/booking-desk/bed-allocation/_components/booking-accent";

describe("bed allocation booking accents", () => {
  it("maps the same booking id to the same accent", () => {
    expect(getBookingAccent("booking-123")).toEqual(
      getBookingAccent("booking-123"),
    );
  });

  it("uses the fixed accent palette", () => {
    const accents = new Set(
      Array.from({ length: 32 }, (_, index) =>
        getBookingAccent(`booking-${index}`).stripClassName,
      ),
    );

    expect(accents.size).toBeGreaterThan(1);
    expect(accents.size).toBeLessThanOrEqual(BOOKING_ACCENTS.length);
    expect(BOOKING_ACCENTS).toContain(getBookingAccent("booking-123"));
  });

  it("draws the strip and ring from the generated categorical scales (M1 9→5)", () => {
    // #2188 P2: the 9-hue raw palette collapsed onto cat1..cat5. Solid strip =
    // scale step 9; ring = step 7 (reads in both modes via the --gen-* substrate,
    // so no dark: companion is needed).
    expect(BOOKING_ACCENTS).toHaveLength(5);
    const scales = new Set<string>();
    for (const accent of BOOKING_ACCENTS) {
      expect(accent.name).toMatch(/^cat[1-5]$/);
      expect(accent.stripClassName).toMatch(/^bg-cat[1-5]-9$/);
      expect(accent.ringClassName).toMatch(/^ring-cat[1-5]-7$/);
      expect(accent.ringClassName).not.toMatch(/\bdark:/);
      expect(accent).not.toHaveProperty("tintClassName");
      scales.add(accent.stripClassName);
    }
    // Five DISTINCT categorical scales.
    expect(scales.size).toBe(5);
  });
});
