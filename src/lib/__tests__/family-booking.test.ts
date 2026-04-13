import { describe, expect, it } from "vitest";
import { shouldShowInviteFamilyGroupMembersLink } from "../family-booking";

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
