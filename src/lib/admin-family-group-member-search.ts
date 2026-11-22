import { exactContains } from "@/lib/prisma-exact-prefix";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { familyGroupMemberSearchQuerySchema } from "@/lib/admin-membership-api/family-groups";
import { formatMemberIdentityAge } from "@/lib/member-age";
import { clubTime } from "@/lib/club-time/server";
import { buildParentLinks, type ParentLinkSummary } from "@/lib/member-parent-links";
import {
  MEMBER_PARTNER_RELATIONSHIP_SELECT,
  MEMBER_PARENT_PARTNER_CONFLICT_MESSAGE,
  memberHasPartnerRelationshipWith,
} from "@/lib/member-parent-partner-exclusivity";

/**
 * Member lookup for the identity-sensitive Family Group admin workflows (#2568).
 *
 * Why this exists instead of reusing `GET /api/admin/members`: that endpoint
 * answers the members ADMIN TABLE, whose own editor needs the stored date of
 * birth, so every search response carries it. The Family Group workflows only
 * ever need to tell one similarly-named person from another, so they get a
 * purpose-built response that carries the CALCULATED AGE and no date of birth at
 * all. Both endpoints sit behind the same membership-view permission; this one
 * simply hands the browser less.
 *
 * The result set is deliberately narrow: active, non-archived members only,
 * capped at ten rows, optionally restricted to a set of age tiers (the
 * infant/child/youth restriction a dependant request needs). `total` is the full
 * match count so a caller can say when a list was cut short.
 *
 * It DOES carry `parentLinks`, exactly as the members endpoint it replaced did.
 * That is not decoration: on a child request the admin picks which parent's
 * mailbox the child inherits from this row's parent list
 * (`inheritEmailFromId`), and a searched row overwrites the same candidate id
 * loaded with the request, so dropping the links silently removed the real
 * parent from that choice and left only the requester.
 */

const MAX_RESULTS = 10;

export type FamilyGroupMemberSearchQuery = z.infer<
  typeof familyGroupMemberSearchQuerySchema
>;

export interface FamilyGroupMemberSearchRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  /** Calculated server-side; see `formatMemberIdentityAge`. Never a birth date. */
  ageLabel: string;
  /**
   * This member's recorded parents, which are the notification-email choices a
   * child-request approval offers. Same shape and same fields the members
   * endpoint returned, and no parent's date of birth (it is not selected).
   */
  parentLinks: ParentLinkSummary[];
  ineligibleReason?: string;
}

// Same name/email predicate the members admin search uses, so an admin who
// types a name here finds the same people they would find there.
function buildTextSearchCondition(query: string): Prisma.MemberWhereInput {
  const terms = query.split(/\s+/).filter(Boolean);

  return {
    OR: [
      { firstName: exactContains(query, "insensitive") },
      { lastName: exactContains(query, "insensitive") },
      { email: exactContains(query, "insensitive") },
      ...(terms.length > 1
        ? [
            {
              AND: terms.map(
                (term): Prisma.MemberWhereInput => ({
                  OR: [
                    { firstName: exactContains(term, "insensitive") },
                    { lastName: exactContains(term, "insensitive") },
                    { email: exactContains(term, "insensitive") },
                  ],
                })
              ),
            },
          ]
        : []),
    ],
  };
}

export async function searchFamilyGroupCandidateMembers(
  query: FamilyGroupMemberSearchQuery
): Promise<{ members: FamilyGroupMemberSearchRow[]; total: number }> {
  const where: Prisma.MemberWhereInput = {
    active: true,
    archivedAt: null,
    ...(query.ageTierIn ? { ageTier: { in: query.ageTierIn } } : {}),
    AND: [buildTextSearchCondition(query.q)],
  };

  const [members, total] = await Promise.all([
    prisma.member.findMany({
      where,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        ageTier: true,
        active: true,
        canLogin: true,
        // Read to calculate the age below, and dropped from the mapped row.
        dateOfBirth: true,
        // The parent rows `buildParentLinks` needs. Deliberately the same field
        // list the members endpoint selected — name, email, status and
        // `inheritEmailFromId` — and deliberately no `dateOfBirth`: a parent
        // option is a name in a dropdown, not an identity check of its own.
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
          },
        },
        ...MEMBER_PARTNER_RELATIONSHIP_SELECT,
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: MAX_RESULTS,
    }),
    prisma.member.count({ where }),
  ]);

  // #3123: the club's own day, resolved ONCE for the whole result set. Every
  // row is aged against the same day, so two similarly-named members in one
  // response can never be judged against different todays across club midnight
  // — which matters because telling those two apart is this endpoint's entire
  // purpose (#2568). Measured: this module is reachable from no CLI entry point
  // and no instrumentation edge, so the request-scoped `server-only` reader is
  // the right one.
  const clubToday = (await clubTime()).today();

  return {
    members: members.map((member) => ({
      id: member.id,
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      ageTier: member.ageTier,
      active: member.active,
      canLogin: member.canLogin,
      ageLabel: formatMemberIdentityAge(member.dateOfBirth, clubToday),
      parentLinks: buildParentLinks(member),
      ineligibleReason:
        query.prospectiveParentMemberId &&
        memberHasPartnerRelationshipWith(
          member,
          query.prospectiveParentMemberId,
        )
          ? MEMBER_PARENT_PARTNER_CONFLICT_MESSAGE
          : undefined,
    })),
    total,
  };
}
