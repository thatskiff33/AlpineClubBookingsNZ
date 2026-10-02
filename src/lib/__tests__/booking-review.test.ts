import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AdminReviewStatus, BookingStatus } from "@prisma/client";
import {
  ADULT_SUPERVISION_REVIEW_REASON,
  checkinNotBlockedByPendingReviewFilter,
  isCheckinBlockedByPendingReview,
  minorsReviewAlertShouldFire,
  requiresAdultSupervisionReview,
} from "@/lib/booking-review";
import { resolveAdminReviewFields } from "@/lib/booking-create-guests";
import type { BookingGuestInput } from "@/lib/booking-create-types";

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

describe("pending-review check-in block (#1372 / #1422)", () => {
  const blocked = {
    requiresAdminReview: true,
    adminReviewStatus: AdminReviewStatus.PENDING,
    adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
  };

  describe("isCheckinBlockedByPendingReview", () => {
    it("blocks a booking with a pending admin review", () => {
      expect(isCheckinBlockedByPendingReview(blocked)).toBe(true);
    });

    it("does not block once the review is APPROVED", () => {
      expect(
        isCheckinBlockedByPendingReview({
          ...blocked,
          adminReviewStatus: AdminReviewStatus.APPROVED,
        }),
      ).toBe(false);
    });

    it("does not block when no review is flagged", () => {
      expect(
        isCheckinBlockedByPendingReview({
          requiresAdminReview: false,
          adminReviewStatus: null,
          adminReviewReason: null,
        }),
      ).toBe(false);
    });

    it("#1422: blocks ANY pending review reason, not just adult-supervision", () => {
      expect(
        isCheckinBlockedByPendingReview({
          ...blocked,
          adminReviewReason: "Some other pending review reason",
        }),
      ).toBe(true);
    });
  });

  describe("checkinNotBlockedByPendingReviewFilter", () => {
    it("admits only bookings that need no review or have explicit approval", () => {
      expect(checkinNotBlockedByPendingReviewFilter()).toEqual({
        OR: [
          { requiresAdminReview: false },
          { adminReviewStatus: AdminReviewStatus.APPROVED },
        ],
      });
    });
  });

  describe("minorsReviewAlertShouldFire", () => {
    const notPreviouslyFlagged = {
      requiresAdminReview: false,
      adminReviewStatus: null,
    };

    it("fires when an edit newly blocks a PAID booking", () => {
      expect(
        minorsReviewAlertShouldFire({
          previous: notPreviouslyFlagged,
          updated: { ...blocked, status: BookingStatus.PAID },
        }),
      ).toBe(true);
    });

    it("fires for a CONFIRMED (capacity-holding) booking", () => {
      expect(
        minorsReviewAlertShouldFire({
          previous: notPreviouslyFlagged,
          updated: { ...blocked, status: BookingStatus.CONFIRMED },
        }),
      ).toBe(true);
    });

    it("does not fire when the booking still has an adult (not blocked)", () => {
      expect(
        minorsReviewAlertShouldFire({
          previous: notPreviouslyFlagged,
          updated: {
            requiresAdminReview: false,
            adminReviewStatus: null,
            adminReviewReason: null,
            status: BookingStatus.PAID,
          },
        }),
      ).toBe(false);
    });

    it("does not fire when the booking was already pending review", () => {
      expect(
        minorsReviewAlertShouldFire({
          previous: {
            requiresAdminReview: true,
            adminReviewStatus: AdminReviewStatus.PENDING,
          },
          updated: { ...blocked, status: BookingStatus.PAID },
        }),
      ).toBe(false);
    });

    it("does not fire for a pre-payment booking parked to AWAITING_REVIEW", () => {
      expect(
        minorsReviewAlertShouldFire({
          previous: notPreviouslyFlagged,
          updated: { ...blocked, status: BookingStatus.AWAITING_REVIEW },
        }),
      ).toBe(false);
    });
  });
});

/*
  #3770 — owner decision, 2 Oct 2026 (issue comment 5950866253): "only agreed
  adults count". A member guest from beyond the family who has not agreed yet
  may never come, so they are not the responsible adult, exactly as they are not
  the paid-up adult. Read through the same D-12 predicate.
*/
describe("adult supervision counts only an operationally present adult (#3770)", () => {
  const CHILD = { ageTier: "CHILD" };
  it.each([
    ["a family adult (no consent row)", { ageTier: "ADULT" }, false],
    ["an agreed outsider adult (stored CONFIRMED)", { ageTier: "ADULT", consentStatus: "CONFIRMED" as const }, false],
    ["a notify-only outsider adult (planned CONFIRMED)", { ageTier: "ADULT", memberGuestConsent: { consentStatus: "CONFIRMED" as const } }, false],
    ["a pending outsider adult (stored PENDING)", { ageTier: "ADULT", consentStatus: "PENDING" as const }, true],
    ["a pending outsider adult (planned PENDING)", { ageTier: "ADULT", memberGuestConsent: { consentStatus: "PENDING" as const } }, true],
  ])("children plus %s: review %s", (_label, adult, expected) => {
    expect(requiresAdultSupervisionReview([CHILD, adult])).toBe(expected);
  });

  const guest = (overrides: Record<string, unknown>) =>
    ({ firstName: "A", lastName: "B", isMember: true, ...overrides }) as unknown as BookingGuestInput;

  it("asks a member for a justification when the only adult has not agreed yet", () => {
    expect(() =>
      resolveAdminReviewFields({
        guests: [
          guest({ ageTier: "CHILD", isMember: false }),
          guest({ ageTier: "ADULT", memberId: "x", memberGuestConsent: { consentStatus: "PENDING" } }),
        ],
        isOnBehalf: false,
        sessionUserId: "m1",
        memberReviewJustification: undefined,
      }),
    ).toThrow();
  });

  it("sends it to review with the member's justification, as children alone would", () => {
    const review = resolveAdminReviewFields({
      guests: [
        guest({ ageTier: "CHILD", isMember: false }),
        guest({ ageTier: "ADULT", memberId: "x", memberGuestConsent: { consentStatus: "PENDING" } }),
      ],
      isOnBehalf: false,
      sessionUserId: "m1",
      memberReviewJustification: "Grandad is coming",
    });
    expect(review.requiresAdminReview).toBe(true);
    expect(review.blockForReview).toBe(true);
    expect(review.memberReviewJustification).toBe("Grandad is coming");
  });

  it("does not review a party whose outsider adult was written CONFIRMED (notify-only)", () => {
    const review = resolveAdminReviewFields({
      guests: [
        guest({ ageTier: "CHILD", isMember: false }),
        guest({ ageTier: "ADULT", memberId: "x", memberGuestConsent: { consentStatus: "CONFIRMED" } }),
      ],
      isOnBehalf: false,
      sessionUserId: "m1",
      memberReviewJustification: undefined,
    });
    expect(review.requiresAdminReview).toBe(false);
  });
});

/*
  #3770: every caller of the supervision rule must hand it rows that carry their
  consent, or a pending outsider would count again by omission. A census, so a
  new caller is a decision somebody makes rather than a silent regression.
*/
describe("every adult-supervision caller passes consent-carrying rows (#3770)", () => {
  const CALLERS: Record<string, string | null> = {
    // Persisted rows (stored consentStatus) or the planned party (memberGuestConsent).
    "src/app/api/admin/bookings/[id]/force-confirm/route.ts": "requiresAdultSupervisionReview(booking.guests)",
    "src/app/api/bookings/[id]/guests/route.ts": "...normalizedNewGuests,",
    "src/app/api/bookings/route.ts": "requiresAdultSupervisionReview(guestInputs)",
    "src/lib/booking-create-guests.ts": "requiresAdultSupervisionReview(args.guests)",
    "src/lib/booking-guest-removal-service.ts": "requiresAdultSupervisionReview(remainingGuests)",
    "src/lib/booking-modify-plan.ts": "consentStatus: proposedConsentStatus(guest),",
  };

  function productionFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "__tests__" || entry.name === "node_modules" ? [] : productionFiles(full);
      }
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });
  }

  it("names exactly the declared callers, each passing rows with their consent", () => {
    const callers = productionFiles("src")
      .map((file) => file.split("\\").join("/"))
      .filter((file) => file !== "src/lib/booking-review.ts")
      .filter((file) => readFileSync(file, "utf8").includes("requiresAdultSupervisionReview("))
      .sort();
    expect(callers).toEqual(Object.keys(CALLERS).sort());
    for (const [file, marker] of Object.entries(CALLERS)) {
      if (marker) expect(readFileSync(file, "utf8"), file).toContain(marker);
    }
  });
});
