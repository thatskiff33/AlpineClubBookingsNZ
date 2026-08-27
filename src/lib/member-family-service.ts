import type { AgeTier } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  formatMemberProfileMissingField,
  getMemberProfileCompleteness,
  type MemberProfileCompletenessInput,
  type MemberProfileCompletenessResult,
} from "@/lib/member-profile-completeness";
import {
  buildMemberFacingParentLinks,
  buildParentLinks,
} from "@/lib/member-parent-links";
import type { BookingGuestProfileAction } from "@/lib/booking-guests";
import { clubCalendarDateOf, type ClubTimeZone } from "@/lib/club-time";
import { clubTimeZone } from "@/lib/club-time/server";
import { formatDateOnly } from "@/lib/date-only";

type JsonRouteResult = {
  body: unknown;
  init?: ResponseInit;
};

function jsonResult(body: unknown, init?: ResponseInit): JsonRouteResult {
  return { body, init };
}

const FAMILY_MEMBER_PROFILE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  ageTier: true,
  active: true,
  canLogin: true,
  role: true,
  accessRoles: { select: { role: true } },
  phoneCountryCode: true,
  phoneAreaCode: true,
  phoneNumber: true,
  dateOfBirth: true,
  streetAddressLine1: true,
  streetAddressLine2: true,
  streetCity: true,
  streetRegion: true,
  streetPostalCode: true,
  streetCountry: true,
  postalAddressLine1: true,
  postalAddressLine2: true,
  postalCity: true,
  postalRegion: true,
  postalPostalCode: true,
  postalCountry: true,
  profileCompletedAt: true,
  detailsConfirmedAt: true,
  detailsConfirmedByMemberId: true,
  // #2284 (S3): resolve the delegated-confirmation voucher's name so the
  // member-facing payload can show a read-only "Details last confirmed by X on
  // date" provenance line. A deliberate whitelist addition (the #2424 precedent
  // gates what the viewer is allowed to see): only the confirmer's NAME is
  // returned, never an address, and the confirmer is already an adult in the
  // viewer's family group, so this discloses no new identity.
  detailsConfirmedBy: { select: { id: true, firstName: true, lastName: true } },
  onboardingConfirmedAt: true,
  inheritEmailFromId: true,
  // #2255: the member the family's notifications actually reach. Under a
  // four-generation cap that is often NOT one of the two parents below — the
  // resolution walks up past any generation without a mailbox of its own — and
  // the family whose consent is at stake could otherwise see no indication at
  // all of where their child's club email goes.
  inheritEmailFrom: { select: { id: true, firstName: true, lastName: true } },
  // #2424: the parent's own family groups come back with the parent so the
  // member-facing payload can decide, server-side, whether this VIEWER is
  // allowed the parent's email address. A parent link carries no shared-group
  // requirement, so a parent can be someone the viewer has no family
  // relationship with at all.
  parent: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      ageTier: true,
      active: true,
      canLogin: true,
      inheritEmailFromId: true,
      familyGroupMemberships: { select: { familyGroupId: true } },
    },
  },
  secondaryParent: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      ageTier: true,
      active: true,
      canLogin: true,
      inheritEmailFromId: true,
      familyGroupMemberships: { select: { familyGroupId: true } },
    },
  },
  familyGroupMemberships: {
    select: {
      familyGroupId: true,
      familyGroup: { select: { id: true, name: true } },
    },
  },
} as const;

type FamilyMemberRecord = MemberProfileCompletenessInput & {
  id: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  active: boolean;
  canLogin: boolean;
  role: string;
  accessRoles?: Array<{ role: string | null }>;
  inheritEmailFromId?: string | null;
  inheritEmailFrom?: {
    id: string;
    firstName: string;
    lastName: string;
  } | null;
  // #2284 (S3): the adult who last confirmed this member's details (the
  // delegated-confirmation voucher), for the read-only provenance line.
  // `detailsConfirmedByMemberId` / `detailsConfirmedAt` come from
  // MemberProfileCompletenessInput above; only the resolved name is added here.
  detailsConfirmedBy?: {
    id: string;
    firstName: string;
    lastName: string;
  } | null;
  parent?: Parameters<typeof buildMemberFacingParentLinks>[0]["parent"];
  secondaryParent?: Parameters<
    typeof buildMemberFacingParentLinks
  >[0]["secondaryParent"];
  familyGroupMemberships?: Array<{
    familyGroupId: string;
    familyGroup?: { id: string; name: string | null } | null;
  }>;
};

type FamilyMemberRelationship = "self" | "partner" | "dependent";

type PendingFamilyRequest = {
  id: string;
  type: string;
  status: string;
  familyGroupId: string;
  requesterId: string;
  invitedMemberId: string | null;
  linkedMemberId: string | null;
  subjectMemberId: string | null;
  requestedFirstName: string | null;
  requestedLastName: string | null;
  requestedDateOfBirth: Date | null;
  requestedEmail: string | null;
  requestNotes: string | null;
  childFirstName: string | null;
  childLastName: string | null;
  childDateOfBirth: Date | null;
};

type FamilyMemberPendingRequest = Pick<
  PendingFamilyRequest,
  "id" | "type" | "status" | "familyGroupId"
>;

function getFamilyGroupMemberships(
  member: Partial<Pick<FamilyMemberRecord, "familyGroupMemberships">>
) {
  return Array.isArray(member.familyGroupMemberships)
    ? member.familyGroupMemberships
    : [];
}

function getDisplayName(member: { firstName?: string | null; lastName?: string | null }) {
  return [member.firstName, member.lastName].filter(Boolean).join(" ").trim() || "this member";
}

/**
 * Truncate a **date-only** value to its `yyyy-MM-dd` day for a date input.
 *
 * This is the UTC day, so it is correct only for a receiver that already holds
 * a calendar day pinned to UTC midnight. All three remaining callers are
 * *intended* to be that: `Member.dateOfBirth` and the two join-request dates of
 * birth (`requestedDateOfBirth`, `childDateOfBirth`).
 *
 * The two join-request columns really are — both are written from a validated
 * `yyyy-MM-dd` through `parseDateOnly`. **`Member.dateOfBirth` is held there by
 * writer convention alone**: it is `DateTime?`, not `@db.Date` (typing it is
 * #2872), so nothing in the schema enforces it.
 *
 * The Xero import used to break that convention. Two of the four copies of its
 * `dd/MM/yyyy` parser built a `Date` from `"yyyy-MM-ddT00:00:00"` — no `Z`, so
 * SERVER-LOCAL midnight — and under the container's `TZ=Pacific/Auckland` that
 * stored the previous UTC day, so a Xero-imported date of birth read a day
 * early *here*. **#2859 fixed it at the writer and repaired the stored rows**:
 * all four copies were collapsed into one codec
 * (`src/lib/xero-contact-date-of-birth.ts`, `INV-DATE-024`) which parses
 * through `parseDateOnly`, and a data migration moved the ten affected rows
 * onto the day the member was actually born. So this reader is now correct for
 * every row — do not "fix" it by switching to a zone-aware derivation, which
 * would mis-date every date of birth that is stored correctly, which is now all
 * of them.
 *
 * **Never pass it a real instant.** A `DateTime` stamped with `now` truncates
 * to a UTC day that is still *yesterday* in New Zealand for roughly the first
 * half of every club day — use `toClubCalendarDay` below (#2839,
 * `INV-DATE-019`). The rule is about the VALUE, not the shape: the same trap
 * hid behind `formatDate` in `src/lib/xero-invoice-helpers.ts` for twenty Xero
 * document dates until #2834, because a wrapper makes it invisible to a grep.
 */
function toDateInputValue(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : formatDateOnly(value);
  }
  return value.substring(0, 10);
}

/**
 * The **club's** calendar day for a real instant (#2839, `INV-DATE-019`).
 *
 * `Member.detailsConfirmedAt` is a `DateTime` stamped with `now`, not a
 * date-only column, so reading it with `toDateInputValue` above showed the
 * previous day for roughly the first half of every New Zealand day: a member
 * who confirmed their details at 9am read "Details last confirmed by ... on"
 * yesterday's date.
 *
 * The zone is the club's PERSISTED one, passed in rather than looked up here
 * (#3123, `INV-CONFIG-002`): this used to read `APP_TIME_ZONE` through
 * `formatDateOnlyForTimeZone`, which is the container's claim about where the
 * club is. `getMemberFamily` resolves it once and threads it, so one response
 * cannot render two rows from two different zones. This wrapper only handles
 * the null/invalid cases the payload allows.
 */
function toClubCalendarDay(value: Date | string | null | undefined, zone: ClubTimeZone) {
  if (!value) return null;
  const instant = value instanceof Date ? value : new Date(value);
  return Number.isNaN(instant.getTime()) ? null : clubCalendarDateOf(instant, zone);
}

function getFamilyMemberAction(params: {
  member: FamilyMemberRecord;
  selfId: string;
  canCurrentUserConfirmDetails: boolean;
  needsOwnLoginConfirmation: boolean;
  confirmationMode: string;
  pendingRequestStatus: string | null;
}): BookingGuestProfileAction | null {
  const {
    member,
    selfId,
    canCurrentUserConfirmDetails,
    needsOwnLoginConfirmation,
    confirmationMode,
    pendingRequestStatus,
  } = params;

  if (pendingRequestStatus) {
    return "pending_admin_approval";
  }

  if (confirmationMode === "not_allowed") {
    return null;
  }

  if (member.canLogin && member.id !== selfId && needsOwnLoginConfirmation) {
    return "own_login_required";
  }

  if (member.id === selfId || canCurrentUserConfirmDetails) {
    return "complete_details";
  }

  if (needsOwnLoginConfirmation) {
    return "own_login_required";
  }

  return "contact_admin";
}

function requestTargetsMember(request: PendingFamilyRequest, memberId: string) {
  return (
    request.invitedMemberId === memberId ||
    request.linkedMemberId === memberId ||
    request.subjectMemberId === memberId
  );
}

function getPendingRequestsForMember(
  memberId: string,
  familyGroupIds: string[],
  pendingRequests: PendingFamilyRequest[]
) {
  const familyGroupIdSet = new Set(familyGroupIds);
  return pendingRequests.filter(
    (request) =>
      familyGroupIdSet.has(request.familyGroupId) &&
      requestTargetsMember(request, memberId)
  );
}

function serializeProfileStatus(status: MemberProfileCompletenessResult) {
  return {
    isProfileComplete: status.isProfileComplete,
    isDetailsConfirmed: status.isDetailsConfirmed,
    canBeBookedAsMember: status.canBeBookedAsMember,
    missingFields: status.missingFields.map(formatMemberProfileMissingField),
    needsOwnLoginConfirmation: status.needsOwnLoginConfirmation,
    confirmationMode: status.confirmationMode,
  };
}

export async function getMemberFamily(memberId: string): Promise<JsonRouteResult> {
  // ONE read of the club's persisted timezone for the whole response (#3123).
  // `clubTimeZone()` rather than the CLI-safe reader: nothing outside a React
  // request reaches this module, so the request-scoped memo is free.
  const zone = await clubTimeZone();
  const self = await prisma.member.findUnique({
    where: { id: memberId },
    select: FAMILY_MEMBER_PROFILE_SELECT,
  });

  if (!self) {
    return jsonResult({ error: "Member not found" }, { status: 404 });
  }

  const currentMember = self;
  const groupIds = getFamilyGroupMemberships(currentMember).map(
    (membership) => membership.familyGroupId
  );

  const groupMemberships = groupIds.length > 0
    ? await prisma.familyGroupMember.findMany({
        where: {
          familyGroupId: { in: groupIds },
          memberId: { not: memberId },
          member: { active: true },
        },
        // #2520: `select`, not `include` — an `include` projects every scalar of
        // FamilyGroupMember, which is how the retired `role` column stayed in
        // this SQL long after the last reader went (20260803030000 has since
        // dropped it). Only `member` is read from these rows.
        select: {
          member: {
            select: FAMILY_MEMBER_PROFILE_SELECT,
          },
        },
        orderBy: { member: { firstName: "asc" } },
      })
    : [];

  const rawPendingRequests = groupIds.length > 0
    && typeof prisma.familyGroupJoinRequest?.findMany === "function"
    ? await prisma.familyGroupJoinRequest.findMany({
        where: {
          familyGroupId: { in: groupIds },
          status: "PENDING",
        },
        select: {
          id: true,
          type: true,
          status: true,
          familyGroupId: true,
          requesterId: true,
          invitedMemberId: true,
          linkedMemberId: true,
          subjectMemberId: true,
          requestedFirstName: true,
          requestedLastName: true,
          requestedDateOfBirth: true,
          requestedEmail: true,
          requestNotes: true,
          childFirstName: true,
          childLastName: true,
          childDateOfBirth: true,
        },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const pendingRequests = Array.isArray(rawPendingRequests) ? rawPendingRequests : [];

  // A pending GROUP_CREATE targets a group the requester is NOT yet a member
  // of (the group row is memberless until approval), so the group-scoped
  // pending query above cannot surface it. Fetch it requester-scoped so the
  // profile can render the awaiting-review state (#1681).
  const myPendingCreateRequestRow =
    typeof prisma.familyGroupJoinRequest?.findFirst === "function"
      ? await prisma.familyGroupJoinRequest.findFirst({
          where: {
            requesterId: memberId,
            type: "GROUP_CREATE",
            status: "PENDING",
          },
          select: {
            id: true,
            familyGroupId: true,
            createdAt: true,
            familyGroup: { select: { id: true, name: true } },
            invitedMember: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
          },
        })
      : null;

  const myPendingCreateChildRequests = myPendingCreateRequestRow
    ? await prisma.familyGroupJoinRequest.findMany({
        where: {
          familyGroupId: myPendingCreateRequestRow.familyGroupId,
          requesterId: memberId,
          type: "CHILD_REQUEST",
          status: "PENDING",
        },
        select: { id: true, childFirstName: true, childLastName: true },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const myPendingCreateRequest = myPendingCreateRequestRow
    ? {
        id: myPendingCreateRequestRow.id,
        familyGroupId: myPendingCreateRequestRow.familyGroupId,
        groupName: myPendingCreateRequestRow.familyGroup?.name ?? null,
        createdAt: myPendingCreateRequestRow.createdAt,
        partner: myPendingCreateRequestRow.invitedMember
          ? {
              id: myPendingCreateRequestRow.invitedMember.id,
              firstName: myPendingCreateRequestRow.invitedMember.firstName,
              lastName: myPendingCreateRequestRow.invitedMember.lastName,
              email: myPendingCreateRequestRow.invitedMember.email,
            }
          : null,
        pendingChildRequests: (Array.isArray(myPendingCreateChildRequests)
          ? myPendingCreateChildRequests
          : []
        ).map((request) => ({
          id: request.id,
          firstName: request.childFirstName,
          lastName: request.childLastName,
        })),
      }
    : null;

  const allMembers = [currentMember, ...groupMemberships.map((membership) => membership.member)];
  const memberById = new Map(allMembers.map((member) => [member.id, member]));
  const groupIdsByMemberId = new Map<string, Set<string>>();
  for (const member of allMembers) {
    groupIdsByMemberId.set(
      member.id,
      new Set(
        getFamilyGroupMemberships(member).map((membership) => membership.familyGroupId)
      )
    );
  }

  function sharesFamilyGroup(memberId: string, otherMemberId: string) {
    const groups = groupIdsByMemberId.get(memberId);
    const otherGroups = groupIdsByMemberId.get(otherMemberId);
    if (!groups || !otherGroups) {
      return false;
    }

    for (const groupId of groups) {
      if (otherGroups.has(groupId)) {
        return true;
      }
    }
    return false;
  }

  function isActiveLoginAdult(memberId: string) {
    const member = memberById.get(memberId);
    return (
      member?.active === true &&
      member.canLogin === true &&
      member.ageTier === "ADULT"
    );
  }

  function hasValidDelegatedConfirmation(member: FamilyMemberRecord) {
    return (
      member.canLogin === false &&
      Boolean(member.detailsConfirmedByMemberId) &&
      isActiveLoginAdult(member.detailsConfirmedByMemberId!) &&
      sharesFamilyGroup(member.id, member.detailsConfirmedByMemberId!)
    );
  }

  const seen = new Set<string>();
  const familyMembers: Array<{
    id: string;
    firstName: string;
    lastName: string;
    ageTier: AgeTier;
    role: string;
    relationship: FamilyMemberRelationship;
    canLogin: boolean;
    confirmationMode: string;
    profileStatus: ReturnType<typeof serializeProfileStatus>;
    canBeBooked: boolean;
    missingFields: string[];
    needsOwnLoginConfirmation: boolean;
    canCurrentUserConfirmDetails: boolean;
    pendingRequestStatus: string | null;
    pendingRequestType: string | null;
    pendingRequests: FamilyMemberPendingRequest[];
    pendingRequestFamilyGroupIds: string[];
    bookableFamilyGroupIds: string[];
    action: BookingGuestProfileAction | null;
    dateOfBirth: string | null;
    familyGroupIds: string[];
    parentLinks: ReturnType<typeof buildMemberFacingParentLinks>;
    notificationEmailFromId: string | null;
    /**
     * #2255: who the notification address belongs to, when that is somebody
     * other than a listed parent. Null when the source IS a listed parent (the
     * per-parent marker covers it) or when there is no inheritance at all.
     */
    notificationEmailFromName: string | null;
    /**
     * #2284 (S3): read-only provenance for a DELEGATED details confirmation —
     * who confirmed this member's details on their behalf, and when. Null when
     * the member confirmed their own details (the self-confirmed sentinel
     * `detailsConfirmedByMemberId === id`), or when nothing has been confirmed.
     * This is the missing surface from the issue's Q4: a delegated edit was
     * audited but never shown to the family.
     */
    detailsConfirmedBy: { name: string; at: string | null } | null;
  }> = [];

  /**
   * #2255. The per-parent "(notifications)" marker in the profile family list
   * only fires when the source IS one of the listed parents, which was true
   * while inheritance was one hop. It no longer is: resolution walks past any
   * generation with no mailbox of its own, so a child's club email routinely
   * goes to a grandparent who does not appear in that list at all — and the
   * family saw nothing. Returns the source's name only in that case, so the two
   * displays never say the same thing twice.
   */
  function notificationSourceBeyondParents(
    member: FamilyMemberRecord,
  ): string | null {
    const source = member.inheritEmailFrom;
    if (!source || !member.inheritEmailFromId) return null;
    const isListedParent = buildParentLinks(member).some(
      (parent) =>
        parent.id === source.id || parent.inheritEmailFromId === source.id,
    );
    if (isListedParent) return null;
    return `${source.firstName} ${source.lastName}`.trim() || null;
  }

  /**
   * #2284 (S3): "Details last confirmed by X on date", from the already-stamped
   * `detailsConfirmedByMemberId` / `detailsConfirmedAt`. Only a DELEGATED
   * confirmation is attributed: the self-confirmed sentinel
   * (`detailsConfirmedByMemberId === member.id`) means the member vouched for
   * themselves, so there is no "someone else" to name.
   */
  function delegatedConfirmationProvenance(
    member: FamilyMemberRecord,
  ): { name: string; at: string | null } | null {
    const confirmer = member.detailsConfirmedBy;
    if (
      !confirmer ||
      !member.detailsConfirmedByMemberId ||
      member.detailsConfirmedByMemberId === member.id
    ) {
      return null;
    }
    const name = `${confirmer.firstName} ${confirmer.lastName}`.trim();
    if (!name) return null;
    // #2839: `detailsConfirmedAt` is an instant, so the day shown is the CLUB's
    // calendar day, never the UTC one (`INV-DATE-019`).
    return { name, at: toClubCalendarDay(member.detailsConfirmedAt, zone) };
  }

  function addMember(member: FamilyMemberRecord, relationship: FamilyMemberRelationship) {
    if (seen.has(member.id)) return;
    seen.add(member.id);

    const profileStatus = getMemberProfileCompleteness(member, {
      delegatedConfirmationValid: hasValidDelegatedConfirmation(member),
    });
    const sharedFamilyGroupIds = getFamilyGroupMemberships(member)
      .map((membership) => membership.familyGroupId)
      .filter((groupId) => groupIds.includes(groupId));
    const memberPendingRequests = getPendingRequestsForMember(
      member.id,
      sharedFamilyGroupIds,
      pendingRequests
    );
    const pendingRequestFamilyGroupIds = [
      ...new Set(memberPendingRequests.map((request) => request.familyGroupId)),
    ];
    const pendingRequestFamilyGroupIdSet = new Set(pendingRequestFamilyGroupIds);
    const bookableFamilyGroupIds = sharedFamilyGroupIds.filter(
      (groupId) => !pendingRequestFamilyGroupIdSet.has(groupId)
    );
    const allSharedMembershipsBlocked =
      sharedFamilyGroupIds.length > 0 &&
      bookableFamilyGroupIds.length === 0 &&
      memberPendingRequests.length > 0;
    const effectivePendingRequest = allSharedMembershipsBlocked
      ? memberPendingRequests[0] ?? null
      : null;
    const canCurrentUserConfirmDetails =
      member.canLogin === false &&
      isActiveLoginAdult(currentMember.id) &&
      sharesFamilyGroup(member.id, currentMember.id);
    const action = profileStatus.canBeBookedAsMember
      ? null
      : getFamilyMemberAction({
          member,
          selfId: currentMember.id,
          canCurrentUserConfirmDetails,
          needsOwnLoginConfirmation: profileStatus.needsOwnLoginConfirmation,
          confirmationMode: profileStatus.confirmationMode,
          pendingRequestStatus: effectivePendingRequest?.status ?? null,
        });
    const serializedStatus = serializeProfileStatus(profileStatus);

    familyMembers.push({
      id: member.id,
      firstName: member.firstName,
      lastName: member.lastName,
      ageTier: member.ageTier,
      role: member.role,
      relationship,
      canLogin: member.canLogin,
      confirmationMode: serializedStatus.confirmationMode,
      profileStatus: serializedStatus,
      canBeBooked: serializedStatus.canBeBookedAsMember && !allSharedMembershipsBlocked,
      missingFields: serializedStatus.missingFields,
      needsOwnLoginConfirmation: serializedStatus.needsOwnLoginConfirmation,
      canCurrentUserConfirmDetails,
      pendingRequestStatus: effectivePendingRequest?.status ?? null,
      pendingRequestType: effectivePendingRequest?.type ?? null,
      pendingRequests: memberPendingRequests.map((request) => ({
        id: request.id,
        type: request.type,
        status: request.status,
        familyGroupId: request.familyGroupId,
      })),
      pendingRequestFamilyGroupIds,
      bookableFamilyGroupIds,
      action,
      dateOfBirth: toDateInputValue(member.dateOfBirth),
      familyGroupIds: sharedFamilyGroupIds,
      // #2424: `groupIds` is the VIEWER's own set of family groups, and a
      // parent outside all of them is returned without an email address.
      parentLinks: buildMemberFacingParentLinks(member, groupIds),
      notificationEmailFromId: member.inheritEmailFromId ?? null,
      notificationEmailFromName: notificationSourceBeyondParents(member),
      detailsConfirmedBy: delegatedConfirmationProvenance(member),
    });
  }

  addMember(currentMember, "self");
  for (const membership of groupMemberships) {
    addMember(
      membership.member,
      membership.member.ageTier === "ADULT" ? "partner" : "dependent"
    );
  }

  const firstGroup = getFamilyGroupMemberships(currentMember)[0]?.familyGroup ?? null;

  return jsonResult({
    familyGroupId: firstGroup?.id ?? null,
    familyGroupName: firstGroup?.name ?? null,
    familyGroupIds: groupIds,
    displayName: getDisplayName(currentMember),
    familyMembers,
    myPendingCreateRequest,
    pendingRequests: pendingRequests.map((request) => ({
      id: request.id,
      type: request.type,
      status: request.status,
      familyGroupId: request.familyGroupId,
      requesterId: request.requesterId,
      invitedMemberId: request.invitedMemberId,
      linkedMemberId: request.linkedMemberId,
      subjectMemberId: request.subjectMemberId,
      requestedFirstName: request.requestedFirstName,
      requestedLastName: request.requestedLastName,
      requestedDateOfBirth: toDateInputValue(request.requestedDateOfBirth),
      requestedEmail: request.requestedEmail,
      requestNotes: request.requestNotes,
      childFirstName: request.childFirstName,
      childLastName: request.childLastName,
      childDateOfBirth: toDateInputValue(request.childDateOfBirth),
    })),
  });
}
