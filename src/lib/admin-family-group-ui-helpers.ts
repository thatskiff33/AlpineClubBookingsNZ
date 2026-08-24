import { CHIP_TONE_CLASSES } from "@/lib/chip-tones";
import {
  calendarDateOfDateOnlyInstant,
  formatClubDate,
  parseCalendarDate,
  parseInstant,
  type BoundClubTime,
} from "@/lib/club-time";

export interface MemberOption {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

/**
 * The calculated age label for identity-sensitive Family Group workflows
 * (#2568): the finished string the server produced with
 * `formatMemberIdentityAge` ("47 years", "3 years 8 months", or
 * "Age unavailable"). Optional on every type that carries it, because the
 * routine payloads deliberately omit it — a surface that does not send it
 * renders no age at all. Never a date of birth: age is calculated server-side
 * so the browser is not handed the birth date to work it out from.
 */
export interface WithMemberAgeLabel {
  ageLabel?: string | null;
}

/** A member option shown while confirming a specific member's identity (#2568). */
export interface MemberIdentityOption extends MemberOption, WithMemberAgeLabel {}

export interface FamilyGroupMemberRow extends MemberOption, WithMemberAgeLabel {
  ageTier: string;
  active: boolean;
  canLogin?: boolean;
  // #2520: no `role`. The admin family-group payloads used to carry the
  // FamilyGroupMember.role value; nothing rendered it, and the column itself is
  // now dropped (20260803030000).
  inheritEmailFromId?: string | null;
  inheritEmailFrom?: { email: string } | null;
  hasPassword?: boolean;
  effectiveEmail?: string;
}

export interface FamilyGroupSummary {
  id: string;
  name: string | null;
  createdAt: string;
  members: FamilyGroupMemberRow[];
  memberCount: number;
  inactiveCount: number;
  pendingRequests: number;
}

export interface FamilyGroupDetail {
  id: string;
  name: string | null;
  createdAt: string;
  members: FamilyGroupMemberRow[];
}

export interface ParentLinkSummary extends MemberOption {
  parentLinkType: "PRIMARY" | "SECONDARY";
}

// #2568: `ageLabel`, NOT `dateOfBirth`. A suggested match is a real member
// record, and the admin only needs to tell one person from another — so the
// server sends the calculated age and keeps the stored birth date server-side.
export interface RequestMemberMatch extends MemberOption, WithMemberAgeLabel {
  ageTier: string;
  active: boolean;
  canLogin?: boolean;
  alreadyInGroup: boolean;
  parentLinks?: ParentLinkSummary[];
}

export interface FamilyGroupRequest {
  id: string;
  type:
    | "JOIN_REQUEST"
    | "CHILD_REQUEST"
    | "ADULT_REQUEST"
    | "REMOVAL_REQUEST"
    | "GROUP_CREATE";
  createdAt: string;
  // #2568: the requester carries an age too — on a join request the requester
  // IS the person being added to the group, and on the others their identity is
  // still part of the decision being approved.
  requester: MemberIdentityOption;
  familyGroup: {
    id: string;
    name: string | null;
    members: Array<{
      id: string;
      firstName: string;
      lastName: string;
      email?: string;
      ageTier?: string;
    }>;
  };
  childFirstName?: string | null;
  childLastName?: string | null;
  childDateOfBirth?: string | null;
  requestedFirstName?: string | null;
  requestedLastName?: string | null;
  requestedDateOfBirth?: string | null;
  requestedEmail?: string | null;
  requestNotes?: string | null;
  requestedAgeTier?: string | null;
  requestedAgeTierLabel?: string | null;
  // #2568: the age implied by the date of birth the REQUESTER supplied for the
  // person being added. Calculated server-side from the request's own declared
  // value, so the create-or-link decision can be checked against a candidate
  // record's age without doing the arithmetic in the admin's head.
  childAgeLabel?: string | null;
  requestedAgeLabel?: string | null;
  canCreateMemberFromRequest?: boolean;
  subjectMemberId?: string | null;
  subjectMember?: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    ageTier: string;
    active: boolean;
    /** #2568 — the member being REMOVED from the group. */
    ageLabel?: string | null;
  } | null;
  // For GROUP_CREATE: the partner to auto-invite on approval (if any).
  invitedMemberId?: string | null;
  invitedMember?: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    ageTier?: string;
    active?: boolean;
    /** #2568 — the member who gets invited if this approval goes through. */
    ageLabel?: string | null;
  } | null;
  matchingMembers: RequestMemberMatch[];
}

export interface SharedEmailCluster<T extends FamilyGroupMemberRow = FamilyGroupMemberRow> {
  email: string;
  members: T[];
}

export interface FamilyGroupRequestSearchResult
  extends MemberOption,
    WithMemberAgeLabel {
  ageTier: string;
  active: boolean;
  canLogin?: boolean;
  parentLinks?: ParentLinkSummary[];
}

export const AGE_TIER_COLORS: Record<string, string> = {
  // #2188 P2 (lens MEDIUM-5): age tiers are DEMOGRAPHIC categories, so they use
  // the categorical scales (never severity scales), with ONE assignment shared
  // with the roster page's AGE_TIER_COLORS — same tier, same colour everywhere.
  INFANT: "bg-cat1-3 text-cat1-11 border-cat1-6",
  CHILD: "bg-cat2-3 text-cat2-11 border-cat2-6",
  YOUTH: "bg-cat3-3 text-cat3-11 border-cat3-6",
  ADULT: "bg-cat4-3 text-cat4-11 border-cat4-6",
};

const CHILD_REQUEST_AGE_TIERS = new Set(["INFANT", "CHILD", "YOUTH"]);

export function normalizeFamilyEmail(email: string) {
  return email.trim().toLowerCase();
}

/*
 * ONE HELPER BECAME TWO, and the split is the point (CT-4, #2870).
 *
 * #2256: `formatFamilyGroupDate` used to call bare `toLocaleDateString()` — no
 * locale, no time zone — so every family-group date (request "Requested"
 * stamps, dates of birth, group "Created") rendered in whatever the *viewer's
 * browser* was set to: "4/16/2026" for a US-locale admin, "16.04.2026" for a
 * German one, and a day early for anyone whose machine sat behind New Zealand.
 * That fix pinned `APP_TIME_ZONE` for all of them.
 *
 * NARROW, DECLARED `src/lib` EXCEPTION on this branch, because the surfaces
 * this feeds are two different temporal kinds and the branch moved only one
 * side of each:
 *
 * - `childDateOfBirth` / `requestedDateOfBirth` are `@db.Date` CALENDAR DAYS.
 *   `INV-DATE-019`: a calendar day has no timezone and projecting one through a
 *   zone behind UTC names the day before. The member-detail dependants card and
 *   the member-applications approval screen both decode these correctly now, so
 *   leaving the review card projecting them showed one child's date of birth as
 *   31 Dec on the screen that approves them and 1 Jan on the card that lists
 *   them afterwards. A date of birth on a boundary decides an age tier, and an
 *   age tier decides a price band.
 * - a request's `createdAt` is a real INSTANT and has no civil date until a
 *   zone is chosen. That zone is the club's PERSISTED one (`INV-CONFIG-002`),
 *   which a browser receives as data through `ClubTimeProvider`. The
 *   family-groups page beside this card already reads the group's own
 *   `createdAt` that way, so one screen was showing two "created" stamps under
 *   two different authorities.
 *
 * Both keep the "Not provided" placeholder and the never-throw contract: these
 * values arrive over `fetch` with no runtime schema check and render inside a
 * request card, where a `RangeError` reaches the nearest error boundary and
 * blanks the reviewer's whole queue.
 */

/**
 * A `@db.Date` calendar day — a date of birth — in the house medium shape,
 * with NO ZONE APPLIED.
 *
 * Accepts both spellings such a column reaches the browser in: Prisma's
 * UTC-midnight ISO instant and a bare `yyyy-MM-dd`. The bare form is tried
 * first because it is unambiguous; the instant branch then reads the
 * UTC-midnight encoding in UTC, which is the identity for every club rather
 * than a projection.
 */
export function formatFamilyGroupCalendarDay(value: string | null | undefined) {
  if (!value) return "Not provided";
  const bare = parseCalendarDate(value);
  if (bare !== null) return formatClubDate(bare);
  const instant = parseInstant(value);
  if (instant === null) return "Not provided";
  return formatClubDate(calendarDateOfDateOnlyInstant(instant));
}

/**
 * A real instant — a request's "Requested" stamp — in the house medium shape,
 * read in the club's persisted zone.
 */
export function formatFamilyGroupInstantDate(
  clubTime: BoundClubTime,
  value: string | null | undefined,
) {
  if (!value) return "Not provided";
  const instant = parseInstant(value);
  if (instant === null) return "Not provided";
  return clubTime.instantDate(instant);
}

export function getMemberName(member: Pick<MemberOption, "firstName" | "lastName">) {
  return `${member.firstName} ${member.lastName}`.trim();
}

export function buildSharedEmailClusters<T extends FamilyGroupMemberRow>(
  members: T[]
): Array<SharedEmailCluster<T>> {
  const byEmail = new Map<string, T[]>();

  for (const member of members) {
    const email = normalizeFamilyEmail(member.effectiveEmail || member.email);
    const current = byEmail.get(email) ?? [];
    current.push(member);
    byEmail.set(email, current);
  }

  return Array.from(byEmail.entries())
    .filter(([, clusterMembers]) => clusterMembers.length > 1)
    .map(([email, clusterMembers]) => ({ email, members: clusterMembers }));
}

export function dedupeParentOptions(parents: ParentLinkSummary[]) {
  const seen = new Set<string>();
  return parents.filter((parent) => {
    if (seen.has(parent.id)) return false;
    seen.add(parent.id);
    return true;
  });
}

export function getFamilyGroupRequestTypeLabel(request: FamilyGroupRequest) {
  if (request.type === "CHILD_REQUEST") return "Infant/Child/Youth Request";
  if (request.type === "ADULT_REQUEST") return "Same-email Adult Request";
  if (request.type === "REMOVAL_REQUEST") return "Removal Request";
  if (request.type === "GROUP_CREATE") return "New Family Group";
  return "Join Request";
}

export function getFamilyGroupRequestBadgeClass(request: FamilyGroupRequest) {
  if (request.type === "CHILD_REQUEST") return "bg-info-3 text-info-11 border-info-6";
  if (request.type === "ADULT_REQUEST") return "bg-cat1-3 text-cat1-11 border-cat1-6";
  if (request.type === "REMOVAL_REQUEST") return "bg-danger-3 text-danger-11 border-danger-6";
  // GROUP_CREATE reaches its teal through CHIP_TONE_CLASSES.cat6 (#2218)
  // (#2137) rather than a literal Tailwind `teal-*` pair.
  if (request.type === "GROUP_CREATE") return `${CHIP_TONE_CLASSES.cat6} border-cat6-6`;
  return "bg-success-3 text-success-11 border-success-6";
}

export function getFamilyGroupRequestSubjectName(request: FamilyGroupRequest) {
  if (request.type === "CHILD_REQUEST") {
    return [request.childFirstName, request.childLastName].filter(Boolean).join(" ");
  }
  if (request.type === "ADULT_REQUEST") {
    return [request.requestedFirstName, request.requestedLastName].filter(Boolean).join(" ");
  }
  if (request.type === "REMOVAL_REQUEST" && request.subjectMember) {
    return getMemberName(request.subjectMember);
  }
  return "";
}

export function getFamilyGroupRequestSummary(request: FamilyGroupRequest) {
  if (request.type === "CHILD_REQUEST") {
    const childName = [request.childFirstName, request.childLastName].filter(Boolean).join(" ");
    return `${getMemberName(request.requester)} wants to add ${childName || "an infant/child/youth member"} to ${request.familyGroup.name || "this family group"}.`;
  }
  if (request.type === "ADULT_REQUEST") {
    const adultName = [request.requestedFirstName, request.requestedLastName].filter(Boolean).join(" ");
    return `${getMemberName(request.requester)} wants to add ${adultName || "a same-email adult"} to ${request.familyGroup.name || "this family group"}.`;
  }
  if (request.type === "REMOVAL_REQUEST") {
    const subjectName = request.subjectMember ? getMemberName(request.subjectMember) : "a member";
    return `${getMemberName(request.requester)} wants to remove ${subjectName} from ${request.familyGroup.name || "this family group"}.`;
  }
  if (request.type === "GROUP_CREATE") {
    const partnerClause = request.invitedMember
      ? ` and invite ${getMemberName(request.invitedMember)}`
      : "";
    return `${getMemberName(request.requester)} wants to create the new family group ${request.familyGroup.name || "Unnamed Group"}${partnerClause}.`;
  }
  return `${getMemberName(request.requester)} wants to join ${request.familyGroup.name || "this family group"}.`;
}

export function mergeFamilyGroupRequestCandidates(
  request: FamilyGroupRequest,
  searchedMembers: RequestMemberMatch[]
) {
  const merged = new Map<string, RequestMemberMatch>();

  for (const candidate of request.matchingMembers) {
    merged.set(candidate.id, candidate);
  }
  for (const candidate of searchedMembers) {
    merged.set(candidate.id, candidate);
  }

  return Array.from(merged.values());
}

export function mapFamilyGroupRequestSearchResults(
  request: FamilyGroupRequest,
  members: FamilyGroupRequestSearchResult[]
) {
  return members
    .filter(
      (member) =>
        request.type !== "CHILD_REQUEST" || CHILD_REQUEST_AGE_TIERS.has(member.ageTier)
    )
    .map((member) => ({
      id: member.id,
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      ageTier: member.ageTier,
      active: member.active,
      canLogin: member.canLogin,
      // #2568: the server-calculated age, carried through as-is. Nothing here
      // ever sees or derives a date of birth.
      ageLabel: member.ageLabel ?? null,
      parentLinks: member.parentLinks ?? [],
      alreadyInGroup: request.familyGroup.members.some(
        (groupMember) => groupMember.id === member.id
      ),
    }));
}

export function buildInitialRequestSelections(
  requests: FamilyGroupRequest[],
  current: Record<string, string>
) {
  const nextSelections: Record<string, string> = {};

  for (const request of requests) {
    if (current[request.id]) {
      nextSelections[request.id] = current[request.id];
      continue;
    }
    if (request.type === "CHILD_REQUEST" && request.matchingMembers.length === 1) {
      nextSelections[request.id] = request.matchingMembers[0].id;
    }
    if (
      request.type === "CHILD_REQUEST" &&
      request.matchingMembers.length === 0 &&
      request.canCreateMemberFromRequest === true
    ) {
      nextSelections[request.id] = "__create__";
    }
    if (request.type === "ADULT_REQUEST" && request.matchingMembers.length === 0) {
      nextSelections[request.id] = "__create__";
    }
  }

  return nextSelections;
}

export function buildInitialRequestNotificationParents(
  requests: FamilyGroupRequest[],
  current: Record<string, string>
) {
  const nextSelections: Record<string, string> = {};

  for (const request of requests) {
    if (request.type === "CHILD_REQUEST") {
      nextSelections[request.id] = current[request.id] ?? request.requester.id;
    }
  }

  return nextSelections;
}
