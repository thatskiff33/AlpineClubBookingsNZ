/**
 * What the member actions send an AI app connection (ALP-720, `INV-MCP-006`).
 *
 * The member list and the member detail are the most personal answers in the
 * Membership area. A connection gets what identifies a member and their
 * membership standing; the detail adds the phone number and the membership,
 * subscription and family-link facts an officer acts on. Never sent: date of
 * birth, street and postal addresses, dietary or medical data, Xero and other
 * provider ids, audit entries, officer notes, access roles and sign-in or
 * security internals.
 */
import { connectionShapeFor, type ConnectionShape } from "@/lib/connection-projection";
import { MEMBER_ACCOUNT_ACTIVITY_CONNECTION_SHAPE } from "@/lib/connection-shapes";
import { MEMBERSHIP_TYPE_SHAPE } from "@/lib/connection-shapes/membership-config";
import type { serializeLodgeAccessRows } from "@/lib/lodge-access";
import type { PartnerLinkState } from "@/lib/member-partner-link";
import type { serializeSeasonalMembershipAssignment } from "@/lib/seasonal-membership-assignments";

/** A member as the list and the detail both name them. */
interface MemberStanding {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  active: boolean;
  cancelledAt: Date | null;
  archivedAt: Date | null;
  joinedDate: Date | null;
  lifeMemberDate: Date | null;
  familyGroups: Array<{ id: string; name: string }>;
}

const MEMBER_STANDING_SHAPE = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  ageTier: true,
  active: true,
  cancelledAt: true,
  archivedAt: true,
  joinedDate: true,
  lifeMemberDate: true,
  familyGroups: { id: true, name: true },
} as const;

/** `listAdminMembers`'s answer (its body is untyped), the fields a connection may get. */
interface MemberListAnswer {
  members: Array<
    MemberStanding & {
      deletedAccount: boolean;
      subscriptionStatus: string | null;
      currentMembershipType: { id: string; key: string; name: string; isActive: boolean } | null;
    }
  >;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const MEMBER_LIST_CONNECTION_SHAPE = connectionShapeFor<MemberListAnswer>({
  members: {
    ...MEMBER_STANDING_SHAPE,
    deletedAccount: true,
    subscriptionStatus: true,
    currentMembershipType: { id: true, key: true, name: true, isActive: true },
  },
  total: true,
  page: true,
  pageSize: true,
  totalPages: true,
});

type SeasonalAssignment = ReturnType<typeof serializeSeasonalMembershipAssignment>;

interface MemberNameAndEmail {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

/** `getAdminMemberDetail`'s answer (its body is untyped), the fields a connection may get. */
interface MemberDetailAnswer extends MemberStanding {
  phoneCountryCode: string | null;
  phoneAreaCode: string | null;
  phoneNumber: string | null;
  deletedAt: Date | null;
  leavingDate: Date | null;
  requiresInduction: boolean;
  createdAt: Date;
  parentLinks: Array<MemberNameAndEmail & { ageTier?: string; active?: boolean; parentLinkType: string }>;
  dependents: Array<{
    id: string;
    firstName: string;
    lastName: string;
    ageTier: string;
    active: boolean;
    parentLinkType: string;
  }>;
  inheritParentEmail: boolean;
  inheritEmailFromId: string | null;
  inheritEmailFrom: MemberNameAndEmail | null;
  dependentEmailSource: MemberNameAndEmail | null;
  billingFamilyGroupId: string | null;
  currentSeasonYear: number;
  subscriptions: Array<{ id: string; seasonYear: number; status: string; paidAt: Date | null }>;
  seasonalMembershipAssignments: SeasonalAssignment[];
  openCancellationRequest: {
    id: string;
    status: string;
    submittedAt: string;
    participantStatus: string;
    requestedBy: { id: string; name: string } | null;
  } | null;
}

const NAME_AND_EMAIL_SHAPE = { id: true, firstName: true, lastName: true, email: true } as const;

export const MEMBER_DETAIL_CONNECTION_SHAPE = connectionShapeFor<MemberDetailAnswer>({
  ...MEMBER_STANDING_SHAPE,
  phoneCountryCode: true,
  phoneAreaCode: true,
  phoneNumber: true,
  deletedAt: true,
  leavingDate: true,
  requiresInduction: true,
  createdAt: true,
  parentLinks: { ...NAME_AND_EMAIL_SHAPE, ageTier: true, active: true, parentLinkType: true },
  dependents: { id: true, firstName: true, lastName: true, ageTier: true, active: true, parentLinkType: true },
  inheritParentEmail: true,
  inheritEmailFromId: true,
  inheritEmailFrom: NAME_AND_EMAIL_SHAPE,
  dependentEmailSource: NAME_AND_EMAIL_SHAPE,
  billingFamilyGroupId: true,
  currentSeasonYear: true,
  subscriptions: { id: true, seasonYear: true, status: true, paidAt: true },
  seasonalMembershipAssignments: {
    id: true,
    seasonYear: true,
    membershipTypeId: true,
    subscriptionCategoryId: true,
    applyFrom: true,
    membershipType: { id: true, key: true, name: true, isActive: true },
    subscriptionCategory: { id: true, key: true, name: true, isActive: true },
  },
  openCancellationRequest: {
    id: true,
    status: true,
    submittedAt: true,
    participantStatus: true,
    requestedBy: { id: true, name: true },
  },
});

/**
 * A member's audit timeline as the admin screen reads it: the same fields as
 * the member's own timeline (when, what kind, the outcome and what happened),
 * never request details, devices, addresses or metadata. The route reads it
 * with the officer audience, so every category is listed and each summary is
 * the officers' summary (the text recorded with the entry), not the member's.
 */
export const MEMBER_AUDIT_TIMELINE_CONNECTION_SHAPE: ConnectionShape = MEMBER_ACCOUNT_ACTIVITY_CONNECTION_SHAPE;

type LodgeAccessRow = ReturnType<typeof serializeLodgeAccessRows>[number];

const LODGE_ACCESS_ROW_SHAPE = connectionShapeFor<LodgeAccessRow>({
  id: true,
  lodgeId: true,
  kind: true,
  createdAt: true,
});

/** The member's lodge access grants, all and by kind: the whole answer. */
export const MEMBER_LODGE_ACCESS_CONNECTION_SHAPE: ConnectionShape = {
  lodgeAccess: LODGE_ACCESS_ROW_SHAPE,
  bookingRestrictions: LODGE_ACCESS_ROW_SHAPE,
  staffGrants: LODGE_ACCESS_ROW_SHAPE,
};

const PARTNER_LINK_SHAPE = {
  id: true,
  status: true,
  partner: { id: true, firstName: true, lastName: true },
  initiatedByMe: true,
  assignedByAdmin: true,
  confirmedAt: true,
  createdAt: true,
} as const;

/** A member's confirmed partner link and pending requests; the partner's sign-in flag stays out. */
export const MEMBER_PARTNER_LINK_CONNECTION_SHAPE = connectionShapeFor<PartnerLinkState>({
  confirmed: PARTNER_LINK_SHAPE,
  pendingIncoming: PARTNER_LINK_SHAPE,
  pendingOutgoing: PARTNER_LINK_SHAPE,
});

export const PARTNER_LINK_ASSIGNED_CONNECTION_SHAPE = connectionShapeFor<{ message: string; linkId: string | null }>({
  message: true,
  linkId: true,
});

export const PARTNER_LINK_REMOVED_CONNECTION_SHAPE = connectionShapeFor<{ message: string }>({ message: true });

interface DependentFamilyLink {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  parentMemberId: string | null;
  secondaryParentId: string | null;
  inheritEmailFromId: string | null;
}

const DEPENDENT_FAMILY_LINK_SHAPE = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  ageTier: true,
  parentMemberId: true,
  secondaryParentId: true,
  inheritEmailFromId: true,
} as const;

/** The dependant as linked: names and the family links; never the sign-in flag. */
export const DEPENDENT_LINKED_CONNECTION_SHAPE = connectionShapeFor<{ member: DependentFamilyLink }>({
  member: DEPENDENT_FAMILY_LINK_SHAPE,
});

/** The dependant as unlinked, and what the unlink changed. */
export const DEPENDENT_UNLINKED_CONNECTION_SHAPE = connectionShapeFor<{
  member: DependentFamilyLink & { active: boolean; inheritParentEmail: boolean };
  clearedEmailInheritance: boolean;
  promotedSecondaryParent: boolean;
}>({
  member: { ...DEPENDENT_FAMILY_LINK_SHAPE, active: true, inheritParentEmail: true },
  clearedEmailInheritance: true,
  promotedSecondaryParent: true,
});

/**
 * Each type with its booking, subscription and age-tier rules, which the
 * configuration actions change (#5305 comment 7111359405); no fees.
 */
export const MEMBERSHIP_TYPE_LIST_CONNECTION_SHAPE: ConnectionShape = {
  membershipTypes: MEMBERSHIP_TYPE_SHAPE,
  currentSeasonYear: true,
};
