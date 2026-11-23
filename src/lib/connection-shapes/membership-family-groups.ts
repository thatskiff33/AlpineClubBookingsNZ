/**
 * What the family group actions send an AI app connection (ALP-720,
 * `INV-MCP-006`). Family groups carry children, so every member is sent as an
 * id, a name, an age tier and, where the screen reads it, whether they are
 * active. Never a date of birth, a calculated age, a phone number, an address,
 * a sign-in field (`canLogin`, `hasPassword`, the shared-email inheritance
 * pointers) or a provider id.
 *
 * A member's email address is sent only where the screen shows it to tell
 * similar records apart: member search results, the people a pending request
 * is about and its candidate matches, and suggested groups (which are built
 * from a shared address). A group's routine roster carries no email.
 * A partner invitation is sent with the address it went to, never its token.
 */
import { connectionShapeFor, type ConnectionShape } from "@/lib/connection-projection";

import type { searchFamilyGroupCandidateMembers } from "@/lib/admin-family-group-member-search";
import type { suggestFamilyGroups } from "@/lib/family-suggestions";
import type { ParentLinkSummary } from "@/lib/member-parent-links";
import type { listOutstandingPartnerInviteTokens } from "@/lib/partner-invite-token";

/** A family group member as the group routes read them. */
interface FamilyGroupMemberAnswer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  archivedAt: Date | null;
}

/** A member on a group's roster in a create or update answer, which reads no `active`. */
const ROSTER_MEMBER_SHAPE = connectionShapeFor<FamilyGroupMemberAnswer>({
  id: true,
  firstName: true,
  lastName: true,
  ageTier: true,
});

/** A member on a group's roster in the list and detail reads. */
const LISTED_MEMBER_SHAPE = connectionShapeFor<FamilyGroupMemberAnswer>({
  id: true,
  firstName: true,
  lastName: true,
  ageTier: true,
  active: true,
});

interface FamilyGroupAnswer {
  id: string;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
  memberCount: number;
  inactiveCount: number;
  pendingRequests: number;
}

export const FAMILY_GROUP_LIST_CONNECTION_SHAPE: ConnectionShape = {
  familyGroups: {
    ...connectionShapeFor<FamilyGroupAnswer>({
      id: true,
      name: true,
      createdAt: true,
      updatedAt: true,
      memberCount: true,
      inactiveCount: true,
      pendingRequests: true,
    }),
    members: LISTED_MEMBER_SHAPE,
  },
};

export const FAMILY_GROUP_DETAIL_CONNECTION_SHAPE: ConnectionShape = {
  ...connectionShapeFor<FamilyGroupAnswer>({ id: true, name: true, createdAt: true }),
  members: LISTED_MEMBER_SHAPE,
};

export const FAMILY_GROUP_CREATED_CONNECTION_SHAPE: ConnectionShape = {
  ...connectionShapeFor<FamilyGroupAnswer>({ id: true, name: true, createdAt: true, updatedAt: true }),
  members: ROSTER_MEMBER_SHAPE,
};

export const FAMILY_GROUP_UPDATED_CONNECTION_SHAPE: ConnectionShape = {
  ...connectionShapeFor<FamilyGroupAnswer>({ id: true, name: true, createdAt: true }),
  members: ROSTER_MEMBER_SHAPE,
};

export const FAMILY_GROUP_SUCCESS_CONNECTION_SHAPE = connectionShapeFor<{ success: boolean }>({
  success: true,
});

/** A member's recorded parents: the ids a child approval's `inheritEmailFromId` may name. No email or sign-in fields. */
const PARENT_LINK_SHAPE = connectionShapeFor<ParentLinkSummary>({
  id: true,
  firstName: true,
  lastName: true,
  parentLinkType: true,
});

type MemberSearchRow = Awaited<ReturnType<typeof searchFamilyGroupCandidateMembers>>["members"][number];

export const FAMILY_GROUP_MEMBER_SEARCH_CONNECTION_SHAPE: ConnectionShape = {
  members: {
    ...connectionShapeFor<MemberSearchRow>({
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      ageTier: true,
      active: true,
      ineligibleReason: true,
    }),
    parentLinks: PARENT_LINK_SHAPE,
  },
  total: true,
};

type PartnerInviteAnswer = Awaited<ReturnType<typeof listOutstandingPartnerInviteTokens>>[number];

export const PARTNER_INVITE_LIST_CONNECTION_SHAPE: ConnectionShape = {
  invites: connectionShapeFor<PartnerInviteAnswer>({
    id: true,
    invitedEmail: true,
    expiresAt: true,
    createdAt: true,
    familyGroupId: true,
    familyGroupName: true,
    createdBy: { id: true, name: true },
  }),
};

/** A person a pending request is about, as the review list carries them. */
interface RequestPersonAnswer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  active: boolean;
  // The service also answers an identity `ageLabel`; it is left out of this
  // type so the shape cannot select it (`member-identity-age-surfaces` census).
}

/** A pending request as `listAdminFamilyGroupRequests` answers it (its body is untyped). */
interface FamilyGroupRequestAnswer {
  id: string;
  familyGroupId: string;
  requesterId: string;
  type: string;
  status: string;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  invitedMemberId: string | null;
  linkedMemberId: string | null;
  subjectMemberId: string | null;
  childFirstName: string | null;
  childLastName: string | null;
  childDateOfBirth: Date | null;
  requestedFirstName: string | null;
  requestedLastName: string | null;
  requestedDateOfBirth: Date | null;
  requestedEmail: string | null;
  requestNotes: string | null;
  requestedAgeTier: string | null;
  requestedAgeTierLabel: string | null;
  canCreateMemberFromRequest: boolean;
  childAgeLabel: string | null;
  requestedAgeLabel: string | null;
  requester: Omit<RequestPersonAnswer, "ageTier" | "active">;
  subjectMember: RequestPersonAnswer | null;
  invitedMember: RequestPersonAnswer | null;
  familyGroup: { id: string; name: string | null };
}

interface MatchingMemberAnswer extends RequestPersonAnswer {
  canLogin: boolean;
  alreadyInGroup: boolean;
  ineligibleReason?: string;
}

const REQUEST_PERSON_SHAPE = connectionShapeFor<RequestPersonAnswer>({
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  ageTier: true,
  active: true,
});

export const FAMILY_GROUP_REQUEST_LIST_CONNECTION_SHAPE: ConnectionShape = {
  requests: {
    ...connectionShapeFor<FamilyGroupRequestAnswer>({
      id: true,
      familyGroupId: true,
      requesterId: true,
      type: true,
      status: true,
      createdAt: true,
      invitedMemberId: true,
      linkedMemberId: true,
      subjectMemberId: true,
      childFirstName: true,
      childLastName: true,
      requestedFirstName: true,
      requestedLastName: true,
      requestedEmail: true,
      requestNotes: true,
      requestedAgeTier: true,
      requestedAgeTierLabel: true,
      canCreateMemberFromRequest: true,
      requester: { id: true, firstName: true, lastName: true, email: true },
    }),
    subjectMember: REQUEST_PERSON_SHAPE,
    invitedMember: REQUEST_PERSON_SHAPE,
    familyGroup: { id: true, name: true, members: ROSTER_MEMBER_SHAPE },
    matchingMembers: {
      ...REQUEST_PERSON_SHAPE,
      ...connectionShapeFor<MatchingMemberAnswer>({ alreadyInGroup: true, ineligibleReason: true }),
      parentLinks: PARENT_LINK_SHAPE,
    },
  },
};

export const FAMILY_GROUP_REQUEST_REVIEWED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  action: "approve" | "reject";
}>({ success: true, action: true });

type FamilySuggestionsAnswer = Awaited<ReturnType<typeof suggestFamilyGroups>>;

export const FAMILY_SUGGESTION_LIST_CONNECTION_SHAPE = connectionShapeFor<FamilySuggestionsAnswer>({
  suggestions: {
    signature: true,
    suggestedName: true,
    reason: true,
    score: true,
    members: { id: true, firstName: true, lastName: true, email: true, ageTier: true },
  },
  ungroupedCount: true,
  totalMembers: true,
  hiddenCount: true,
});

export const FAMILY_SUGGESTION_GROUP_CREATED_CONNECTION_SHAPE = connectionShapeFor<{
  message: string;
  groupId: string;
}>({ message: true, groupId: true });

export const FAMILY_SUGGESTION_HIDDEN_CONNECTION_SHAPE = connectionShapeFor<{
  message: string;
  signature: string;
}>({ message: true, signature: true });

export const FAMILY_SUGGESTIONS_RESET_CONNECTION_SHAPE = connectionShapeFor<{
  message: string;
  deletedCount: number;
}>({ message: true, deletedCount: true });
