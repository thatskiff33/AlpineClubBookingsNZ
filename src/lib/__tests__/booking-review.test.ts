import { describe, expect, it } from "vitest";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";

describe("booking review helper", () => {
  it("flags bookings with only minors", () => {
    expect(
      requiresAdultSupervisionReview([
        { ageTier: "CHILD" },
        { ageTier: "YOUTH" },
      ])
    ).toBe(true);
    expect(ADULT_SUPERVISION_REVIEW_REASON).toContain("adult");
  });

  it("does not flag bookings that include an adult", () => {
    expect(
      requiresAdultSupervisionReview([
        { ageTier: "ADULT" },
        { ageTier: "INFANT" },
      ])
    ).toBe(false);
  });

  it("does not flag empty guest lists", () => {
    expect(requiresAdultSupervisionReview([])).toBe(false);
  });
});
