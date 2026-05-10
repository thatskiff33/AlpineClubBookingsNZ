import { describe, expect, it } from "vitest";
import {
  getFamilyMemberBookingActionLabel,
  getFamilyMemberBookingBlockMessage,
  shouldShowInviteFamilyGroupMembersLink,
} from "../family-booking";

describe("shouldShowInviteFamilyGroupMembersLink", () => {
  it("returns true when only the member is available for quick add", () => {
    expect(
      shouldShowInviteFamilyGroupMembersLink([
        { relationship: "self" },
      ])
    ).toBe(true);
  });

  it("returns false when another family group member is available", () => {
    expect(
      shouldShowInviteFamilyGroupMembersLink([
        { relationship: "self" },
        { relationship: "partner" },
      ])
    ).toBe(false);
  });
});

describe("family member booking block messages", () => {
  it("returns null for bookable family members", () => {
    expect(
      getFamilyMemberBookingBlockMessage({
        relationship: "self",
        firstName: "Sam",
        canBeBooked: true,
      })
    ).toBeNull();
  });

  it("does not block quick-add when a scoped pending request leaves another group bookable", () => {
    const member = {
      relationship: "dependent" as const,
      firstName: "Sam",
      canBeBooked: true,
      pendingRequestStatus: null,
      pendingRequestFamilyGroupIds: ["fg1"],
      bookableFamilyGroupIds: ["fg2"],
    };

    expect(getFamilyMemberBookingBlockMessage(member)).toBeNull();
    expect(getFamilyMemberBookingActionLabel(member)).toBeNull();
  });

  it("explains a non-login member the current user can fix", () => {
    const member = {
      relationship: "dependent" as const,
      firstName: "Sam",
      canLogin: false,
      canBeBooked: false,
      canCurrentUserConfirmDetails: true,
      action: "complete_details",
    };

    expect(getFamilyMemberBookingBlockMessage(member)).toContain(
      "Complete Sam's details before booking them as a member"
    );
    expect(getFamilyMemberBookingActionLabel(member)).toBe("Complete details");
  });

  it("explains a login-capable member who must self-confirm", () => {
    const member = {
      relationship: "partner" as const,
      firstName: "Jane",
      canLogin: true,
      canBeBooked: false,
      needsOwnLoginConfirmation: true,
      action: "own_login_required",
    };

    expect(getFamilyMemberBookingBlockMessage(member)).toContain(
      "Jane has their own login and needs to sign in"
    );
    expect(getFamilyMemberBookingActionLabel(member)).toBe(
      "Ask them to sign in and confirm"
    );
  });

  it("explains pending admin approval", () => {
    const member = {
      relationship: "dependent" as const,
      firstName: "Sam",
      canBeBooked: false,
      pendingRequestStatus: "PENDING",
      action: "pending_admin_approval",
    };

    expect(getFamilyMemberBookingBlockMessage(member)).toContain(
      "awaiting admin approval"
    );
    expect(getFamilyMemberBookingActionLabel(member)).toBe(
      "Pending admin approval"
    );
  });
});
