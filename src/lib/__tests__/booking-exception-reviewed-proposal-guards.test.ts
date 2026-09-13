import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminReviewStatus } from "@prisma/client";

import { resolveAdminReviewFields } from "@/lib/booking-create-guests";

/**
 * #2526 review: an officer approving a booking-policy exception reviewed a NAMED
 * set of rules — minimum stay, adult-member hosting — and nothing else. The
 * approval borrows `role: "ADMIN"` purely as the mechanism that applies that
 * override, and `reviewedMemberProposal` is what stops the borrowed role deciding
 * rules the officer was never shown.
 *
 * The rule these tests are about is ADULT SUPERVISION (#1372/#1422): a party with
 * a minor and no adult. It is neither policy-exception reason code, so the drift
 * gate cannot evaluate it, the officer's card never mentions it, and no written
 * reason is required for a minimum-stay-only approval. Auto-approving it in the
 * officer's name would un-park the child-safety check-in block for a hazard
 * nobody looked at.
 */

const CHILD = {
  firstName: "Kid",
  lastName: "Guest",
  ageTier: "CHILD" as never,
  isMember: false,
};

describe("resolveAdminReviewFields — the create path", () => {
  it("still auto-approves an ORDINARY admin on-behalf create", () => {
    const review = resolveAdminReviewFields({
      guests: [CHILD],
      isOnBehalf: true,
      sessionUserId: "officer-1",
      memberReviewJustification: undefined,
    });
    expect(review.adminReviewStatus).toBe(AdminReviewStatus.APPROVED);
    expect(review.adminReviewedById).toBe("officer-1");
    expect(review.blockForReview).toBe(false);
  });

  it("opens the review PENDING and BLOCKED when executing a reviewed member proposal", () => {
    const review = resolveAdminReviewFields({
      guests: [CHILD],
      isOnBehalf: true,
      sessionUserId: "officer-1",
      memberReviewJustification: "Grandparents are in the next room.",
      reviewedMemberProposal: true,
    });
    // Member parity: nobody has decided this, and the #1422 check-in block stays
    // armed until somebody does.
    expect(review.adminReviewStatus).toBe(AdminReviewStatus.PENDING);
    expect(review.adminReviewedById).toBeNull();
    expect(review.adminReviewNotes).toBeNull();
    expect(review.blockForReview).toBe(true);
    // The MEMBER's own words are what goes on the record, not the officer's.
    expect(review.memberReviewJustification).toBe(
      "Grandparents are in the next room.",
    );
  });

  it("changes nothing when the rule does not trip at all", () => {
    const review = resolveAdminReviewFields({
      guests: [{ ...CHILD, ageTier: "ADULT" as never }],
      isOnBehalf: true,
      sessionUserId: "officer-1",
      memberReviewJustification: undefined,
      reviewedMemberProposal: true,
    });
    expect(review.requiresAdminReview).toBe(false);
    expect(review.adminReviewStatus).toBeNull();
    expect(review.blockForReview).toBe(false);
  });

  it("MUTATION GUARD: dropping the flag re-opens the auto-approval", () => {
    // If `reviewedMemberProposal` stops being honoured, this is the assertion that
    // changes — the same input starts coming back APPROVED.
    const withFlag = resolveAdminReviewFields({
      guests: [CHILD],
      isOnBehalf: true,
      sessionUserId: "officer-1",
      memberReviewJustification: "reason",
      reviewedMemberProposal: true,
    });
    const withoutFlag = resolveAdminReviewFields({
      guests: [CHILD],
      isOnBehalf: true,
      sessionUserId: "officer-1",
      memberReviewJustification: "reason",
    });
    expect(withFlag.adminReviewStatus).not.toBe(withoutFlag.adminReviewStatus);
  });
});

/**
 * The other half of the same finding: the guest-authorisation rules. These are
 * resolved inside `prepareGuestPlan`, which needs a whole loaded booking, so the
 * flag's effect is pinned STRUCTURALLY here — every `role === "ADMIN"`
 * guest-authorisation gate in the planner must read the derived flag instead, or
 * one of them silently keeps the elevation.
 */
describe("no guest-authorisation gate keys on the raw role any more", () => {
  it("routes every one of them through the derived flag", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/lib/booking-modify-plan.ts", "utf8");

    // The derived flag exists and is computed from the input.
    expect(source).toMatch(
      /const guestAuthorizationRole: Role =\s*\n?\s*role === "ADMIN" && input\.reviewedMemberProposal === true/,
    );
    expect(source).toContain(
      "const guestAuthorizationIsAdmin = guestAuthorizationRole === \"ADMIN\";",
    );

    // Each of the five gates the finding named reads the flag, not the role.
    expect(source).toContain("skipAuthorization: guestAuthorizationIsAdmin,");
    expect(source).toContain(
      "{ skipAuthorization: guestAuthorizationIsAdmin, bookingId: booking.id },",
    );
    expect(source).toContain("actorRole: guestAuthorizationRole,");
    expect(source).toContain(
      // #3368: the booking's owner is read through the one accessor, which is
      // the identity on this column while it is still required. The gate this
      // rule pins — the DERIVED admin flag, not the raw role — is unchanged.
      "onBehalfOfMemberId: guestAuthorizationIsAdmin ? bookingOwner(booking).memberId : null,",
    );
    expect(source).toContain("if (!guestAuthorizationIsAdmin) {");
    // The adult-supervision review on the MODIFICATION path takes the same
    // answer: `resolveModifyReviewUpdate` is private to the planner, so the
    // wiring is pinned here rather than behaviourally.
    expect(source).toMatch(
      /resolveModifyReviewUpdate\(\{[\s\S]{0,600}?role: guestAuthorizationRole,/,
    );

    // And no `skipAuthorization: role === "ADMIN"` survives anywhere.
    expect(source).not.toMatch(/skipAuthorization:\s*role === "ADMIN"/);
  });

  it("the batch service's consent actor agrees with the plan's decision", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      "src/lib/booking-batch-modification-service.ts",
      "utf8",
    );
    // A consent-free ADMIN add requires BOTH that the actor is an admin and that
    // this is not a reviewed member proposal.
    expect(source).toContain(
      'actor.role === "ADMIN" && input.reviewedMemberProposal !== true',
    );
    // Pricing reads the plan's own answer rather than re-deriving it.
    expect(source).toContain(
      "skipAuthorization: guestPlan.guestAuthorizationIsAdmin,",
    );
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
