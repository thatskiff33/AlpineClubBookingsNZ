export interface BookingFamilyMember {
  relationship: "self" | "partner" | "dependent";
}

export function shouldShowInviteFamilyGroupMembersLink(
  familyMembers: BookingFamilyMember[]
): boolean {
  return !familyMembers.some((member) => member.relationship !== "self");
}
