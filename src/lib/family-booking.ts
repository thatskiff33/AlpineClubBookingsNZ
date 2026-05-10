export interface BookingFamilyMember {
  relationship: "self" | "partner" | "dependent";
  firstName?: string | null;
  lastName?: string | null;
  canLogin?: boolean | null;
  canBeBooked?: boolean | null;
  missingFields?: string[];
  needsOwnLoginConfirmation?: boolean | null;
  canCurrentUserConfirmDetails?: boolean | null;
  pendingRequestStatus?: string | null;
  pendingRequests?: Array<{
    id: string;
    type: string;
    status: string;
    familyGroupId: string;
  }>;
  pendingRequestFamilyGroupIds?: string[];
  bookableFamilyGroupIds?: string[];
  action?: string | null;
}

export function shouldShowInviteFamilyGroupMembersLink(
  familyMembers: BookingFamilyMember[]
): boolean {
  return !familyMembers.some((member) => member.relationship !== "self");
}

function getMemberName(member: BookingFamilyMember) {
  return [member.firstName, member.lastName].filter(Boolean).join(" ").trim() || "This member";
}

export function getFamilyMemberBookingBlockMessage(
  member: BookingFamilyMember
): string | null {
  if (member.canBeBooked !== false) {
    return null;
  }

  const name = getMemberName(member);

  if (member.pendingRequestStatus) {
    return "This family change is awaiting admin approval. You can add them as a non-member guest until approved.";
  }

  if (member.canLogin) {
    return `${name} has their own login and needs to sign in and confirm their details before they can be booked as a member.`;
  }

  if (member.canCurrentUserConfirmDetails) {
    return `Complete ${name}'s details before booking them as a member. Because ${name} does not have their own login, any adult in this family group can do this.`;
  }

  return `${name}'s member details need to be completed or confirmed before they can be booked as a member.`;
}

export function getFamilyMemberBookingActionLabel(
  member: BookingFamilyMember
): string | null {
  if (member.canBeBooked !== false) {
    return null;
  }

  if (member.pendingRequestStatus || member.action === "pending_admin_approval") {
    return "Pending admin approval";
  }

  if (member.action === "complete_details") {
    return "Complete details";
  }

  if (member.action === "own_login_required") {
    return "Ask them to sign in and confirm";
  }

  if (member.action === "contact_admin") {
    return "Contact admin";
  }

  return null;
}
