import { describe, expect, it } from "vitest";
import {
  clampPollSeconds,
  DISPLAY_DEFAULT_POLL_SECONDS,
  DISPLAY_POLL_MAX_SECONDS,
  DISPLAY_POLL_MIN_SECONDS,
} from "@/lib/lodge-display/poll-interval";

// LTV-039 (issue hoppers99/AlpineClubBookingsNZ#85): the shared poll-cadence clamp used by the state route
// (read), the devices PATCH route (bounds), and the display client (tick).

describe("clampPollSeconds", () => {
  it("falls back to the default for null/undefined/non-finite input", () => {
    expect(clampPollSeconds(null)).toBe(DISPLAY_DEFAULT_POLL_SECONDS);
    expect(clampPollSeconds(undefined)).toBe(DISPLAY_DEFAULT_POLL_SECONDS);
    expect(clampPollSeconds(Number.NaN)).toBe(DISPLAY_DEFAULT_POLL_SECONDS);
  });

  it("passes an in-range value through (rounded to whole seconds)", () => {
    expect(clampPollSeconds(20)).toBe(20);
    expect(clampPollSeconds(45.4)).toBe(45);
  });

  it("clamps below the minimum and above the maximum", () => {
    expect(clampPollSeconds(5)).toBe(DISPLAY_POLL_MIN_SECONDS);
    expect(clampPollSeconds(9999)).toBe(DISPLAY_POLL_MAX_SECONDS);
  });

  it("keeps the documented bounds", () => {
    expect(DISPLAY_POLL_MIN_SECONDS).toBe(15);
    expect(DISPLAY_POLL_MAX_SECONDS).toBe(600);
    expect(DISPLAY_DEFAULT_POLL_SECONDS).toBe(60);
  });
});
