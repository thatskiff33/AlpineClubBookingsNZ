import type { Prisma } from "@prisma/client";
import {
  MEMBER_PARENT_PARTNER_CONFLICT_MESSAGE,
  notPartnerWithMemberWhere,
} from "@/lib/member-parent-partner-exclusivity";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  isOrganisationMember,
  resolveAccessRoleTokens,
  type AccessRoleInput,
} from "@/lib/access-roles";
import {
  allowedChildDescendantGenerations,
  descendantDepthWithinWhere,
  exceedsFamilyLinkGenerationLimit,
  FAMILY_LINK_GENERATION_LIMIT_ERROR,
  FAMILY_LINK_GENERATION_LIMIT_EXPLANATION,
} from "@/lib/member-family-link-depth";

/**
 * Shared eligibility contract for "Add Dependant -> Link Existing" (#2254).
 *
 * Two surfaces decide who may be linked as a dependant under a parent member:
 *
 * 1. the candidate SEARCH — `dependentLinkEligibleFor` in
 *    `src/lib/admin-members-service.ts`, a Prisma `where`;
 * 2. the WRITE route — `POST /api/admin/members/[id]/dependents/link`, a set of
 *    row-level 422 guards.
 *
 * They had drifted apart in BOTH directions. The search dropped every member
 * whose parent columns were NULL (see `dependentLinkCandidateWhere` below), and
 * it offered archived members that the write route then rejected with a 422.
 * Both surfaces now derive from this module, so a candidate the search offers is
 * a candidate the write route accepts ON IDENTITY GROUNDS. The route can still
 * refuse on grounds that belong to the REQUEST rather than the candidate —
 * family groups the parent is not in, an invalid inherit-email source, and the
 * privileged-target / last-full-admin guards when `disableLogin` is ticked.
 * Those are options the admin chose, not a candidate the dialog should never
 * have offered.
 *
 * GRAPH FACTS ARE AN INPUT, NOT A SELECT (#2255). Two of the rules below are
 * properties of the whole link graph rather than of the candidate row: whether
 * the candidate is an ancestor of the parent, and how deep the merged chain
 * would be. Neither can be read off a single row, and neither can be expressed
 * as a `take: 1` relation probe — depth needs the DEEPEST child chain, and
 * `take: 1` returns an arbitrary one. Both surfaces therefore compute them once
 * with the bounded walks in `src/lib/member-family-link-depth.ts` and hand the
 * results in as {@link DependentLinkGraphFacts}. That object is a REQUIRED
 * argument for the same reason the relation probes used to be required select
 * fields: a caller that forgets it fails to compile rather than silently
 * dropping the cycle and depth guards.
 *
 * Before #2255 neither rule needed this. The old two-generation cap ("a member
 * with dependants cannot be linked under anyone") excluded the whole ancestor
 * set as a side effect, because every ancestor of the parent necessarily has a
 * dependant — the child on the path down to the parent. Relaxing the cap
 * removed that accidental cover, so the ancestor rule is now stated outright.
 */

/**
 * Ordered from most to least specific. `dependentLinkBlockers` returns reasons
 * in this order, so `blockers[0]` is the one to show.
 */
export const DEPENDENT_LINK_INELIGIBILITY_REASONS = [
  "ARCHIVED",
  "SELF",
  "ALREADY_LINKED_TO_PARENT",
  "DIRECT_PARTNER",
  "TWO_PARENTS",
  "ANCESTOR_OF_PARENT",
  "EXCEEDS_GENERATION_LIMIT",
] as const;

export type DependentLinkIneligibilityReason =
  (typeof DEPENDENT_LINK_INELIGIBILITY_REASONS)[number];

/**
 * The write route's 422 bodies. These strings are the public API contract of
 * `POST /api/admin/members/[id]/dependents/link` and are pinned by
 * `src/lib/__tests__/dependent-link-existing.test.ts`; do not reword them
 * without updating that suite.
 */
export const DEPENDENT_LINK_INELIGIBILITY_ERRORS: Record<
  DependentLinkIneligibilityReason,
  string
> = {
  ARCHIVED: "Archived members cannot be linked into family groups",
  SELF: "A member cannot be their own dependant",
  ALREADY_LINKED_TO_PARENT: "This member is already linked to that parent",
  DIRECT_PARTNER: MEMBER_PARENT_PARTNER_CONFLICT_MESSAGE,
  TWO_PARENTS: "This member already has two parents linked",
  ANCESTOR_OF_PARENT: "Cannot link a parent or ancestor as a dependant",
  EXCEEDS_GENERATION_LIMIT: FAMILY_LINK_GENERATION_LIMIT_ERROR,
};

/**
 * Short per-candidate phrases for the search dialog, which lists them after a
 * member's name ("Jane Smith - already has two parents recorded"). Deliberately
 * separate from the 422 sentences above: one is an API error about an attempted
 * write, the other is a label on a row the admin can see but not pick.
 */
export const DEPENDENT_LINK_INELIGIBILITY_EXPLANATIONS: Record<
  DependentLinkIneligibilityReason,
  string
> = {
  ARCHIVED: "is archived",
  SELF: "is the member you are editing",
  ALREADY_LINKED_TO_PARENT: "is already linked to this member",
  DIRECT_PARTNER: "is already this member's partner",
  TWO_PARENTS: "already has two parents recorded",
  ANCESTOR_OF_PARENT: "is already an ancestor of this member",
  EXCEEDS_GENERATION_LIMIT: FAMILY_LINK_GENERATION_LIMIT_EXPLANATION,
};

/**
 * PARENT-SIDE rules (#2282).
 *
 * The rules above are about the CANDIDATE. These are about the member who would
 * become the parent, and they are the whole of what remains there:
 *
 *  - the ORGANISATION/SCHOOL classification — an ACCOUNT rather than a person,
 *    which therefore cannot be anybody's parent (see below);
 *  - `active` — an inactive record is not a current member, and adding a new
 *    dependant to one is a change to a record the club has stood down;
 *  - `archivedAt` — an archived record is history and must not gain new links.
 *
 * The `ageTier === "ADULT"` clause that used to sit alongside them is GONE. A 16
 * or 17 year old can genuinely be a parent, and the club could not record it;
 * the owner decision on #2282 is that parentage is a FACT recorded at any age,
 * while every RESPONSIBILITY function stays adult-gated where it already sits —
 * being the contact of record for a dependant's mail
 * (`validateInheritEmailSource` and `isUsableEmailSource` in
 * `src/lib/member-parent-links.ts`), confirming another member's details, and
 * booking on someone's behalf (`isActiveLoginAdultMember`). None of those three
 * reads the parent link, so recording one grants none of them. Do not
 * "re-tidy" the adult rule back into this file. Every REAL age tier is eligible,
 * INFANT included: the tier boundaries are club-configurable, "any age" was the
 * decision, and a record of who someone's parent is does not become false
 * because the parent is young.
 *
 * AN ORGANISATION IS NOT AN AGE. Organisation and school accounts are not
 * people and cannot be a parent. The old ADULT clause excluded them as a side
 * effect; dropping it let the "Add Parent" search offer a school as a parent and
 * the link route store a child as the school's child. Excluding them again is
 * not a narrowing of the owner's decision — that decision is about age, and this
 * is about accounts that are not people. (The same class of leak needed a
 * `role === "SCHOOL"` special case in `membership-cancellation-requests.ts`,
 * where org accounts in family lists were badged "Dependent".) Orchestrator
 * decision on #2282, recorded on the issue.
 *
 * CLASSIFIED BY ROLE, NEVER BY `ageTier` — two reasons, both load-bearing:
 *
 *  - `NOT_APPLICABLE` is the AGE-EXEMPT tier, not the organisation tier. It is
 *    carried by organisations AND by age-exempt HUMAN accounts (#1440, #2106;
 *    see the comment in `booking-guests.ts`). Filtering on it would bar real
 *    people from being recorded as parents — the very collateral removal this
 *    rule exists to undo — and would show them copy calling them an
 *    organisation. `isOrganisationMember` is the repo's own answer and is used
 *    here unchanged.
 *  - reading `ageTier` here at all would retire a deliberate protection: no
 *    write path on #2282 selects that column any more, so an age gate
 *    re-introduced on either route fails to COMPILE rather than having to be
 *    caught in review. Keep it that way.
 *
 * Both surfaces that could dead-end on these rules use them: the two write
 * routes for their 422 bodies, the "Add Parent" candidate search through
 * {@link dependentParentEligibleWhere}, and the member detail page to disable
 * "Add Dependent" WITH the reason rather than let the admin discover it on save.
 * Hiding the control was the previous behaviour and taught the admin nothing.
 *
 * SPELLING (#2282 review). Every string in this file, and every string #2282
 * added to the member detail page, says "dependent" — the spelling on the
 * controls the admin is already looking at ("Dependents", "Add Dependent",
 * "Create Dependent", "Link Dependent") and the majority spelling in the app's
 * own copy. Docs and CHANGELOG prose keep "dependant" where their neighbours
 * do; a repo-wide rename is a separate job, not this one.
 */
export const DEPENDENT_PARENT_STATE_REASONS = [
  "ORGANISATION",
  "ARCHIVED",
  "INACTIVE",
] as const;

export type DependentParentStateReason =
  (typeof DEPENDENT_PARENT_STATE_REASONS)[number];

/**
 * Why this member cannot take a dependent right now, or null if they can.
 *
 * ORGANISATION is checked first because it is the permanent one: telling an
 * admin to restore or reactivate an org account implies that doing so would let
 * them add a dependent, and it would not. ARCHIVED then beats INACTIVE because
 * archiving also clears `active`, and "archived" is the more specific fact.
 */
export function dependentParentStateBlocker(parent: {
  /** Legacy compatibility role; `SCHOOL` is an organisation on its own. */
  role: string | null | undefined;
  /**
   * Either raw `MemberAccessRole` rows (a write route's select) or the tokens
   * the detail API already resolved (the admin UI). `resolveAccessRoleTokens`
   * takes both and is idempotent over tokens, so one predicate serves both
   * sides of the wire — the same reason `archivedAt` accepts a string.
   */
  accessRoles: AccessRoleInput["accessRoles"];
  /** Read only by the token resolver: `canLogin: false` clears every token. */
  canLogin: boolean | null | undefined;
  active: boolean;
  // `string` as well as `Date` so the admin UI can pass a member straight out
  // of the JSON detail response, where dates are already serialised. One
  // predicate, both sides of the wire — the same reason #2254 made the search
  // and the write route share `dependentLinkBlockers`.
  archivedAt: Date | string | null;
}): DependentParentStateReason | null {
  const organisation = isOrganisationMember({
    accessRoleTokens: resolveAccessRoleTokens({
      accessRoles: parent.accessRoles,
      canLogin: parent.canLogin,
    }),
    legacyRole: parent.role,
  });
  if (organisation) return "ORGANISATION";
  if (parent.archivedAt) return "ARCHIVED";
  if (!parent.active) return "INACTIVE";
  return null;
}

/**
 * The columns {@link dependentParentStateBlocker} reads off a parent row.
 * Spread this into every select that feeds it, rather than restating the
 * fields — the same contract `DEPENDENT_LINK_CANDIDATE_SELECT` gives the
 * candidate side.
 */
export const DEPENDENT_PARENT_STATE_SELECT = {
  role: true,
  canLogin: true,
  accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
  active: true,
  archivedAt: true,
} satisfies Prisma.MemberSelect;

/**
 * The SQL half of {@link dependentParentStateBlocker}, for the "Add Parent"
 * candidate search (`parentLinkEligibleFor`). Same no-drift rule as
 * {@link dependentLinkCandidateWhere}: the search must offer exactly the
 * members the write route accepts as a parent, so both derive from this module
 * rather than restating the clauses.
 *
 * The organisation clause is the literal negation of `isOrganisationMember`,
 * including its `canLogin` subtlety — a member's ORG token is cleared by
 * `canLogin: false`, which is exactly why that helper falls back to the legacy
 * `SCHOOL` role. Writing it as a plain `accessRoles: { none: … }` would exclude
 * a non-login member the write route is happy to accept, which is the
 * search-hides-what-the-write-allows half of the #2254 drift.
 */
export function dependentParentEligibleWhere(): Prisma.MemberWhereInput[] {
  return [
    {
      NOT: {
        OR: [
          { role: "SCHOOL" },
          { canLogin: true, accessRoles: { some: { role: "ORG" } } },
        ],
      },
    },
    { active: true },
    { archivedAt: null },
  ];
}

/**
 * 422 bodies for `POST /api/admin/members/[id]/dependents/link` — the LINK
 * path. Kept separate from the create path's strings below because they are two
 * endpoints with two contracts; a shared sentence would have to be vague about
 * which action was refused.
 *
 * ARCHIVED says what to do INSTEAD rather than "restore this member first":
 * nothing in the product clears `Member.archivedAt`. The only write is the
 * one-way stamp in `member-lifecycle-actions.ts`, and the archive state machine
 * has no reverse edge, so "restore" named a remedy that does not exist.
 */
export const DEPENDENT_PARENT_LINK_ERRORS: Record<
  DependentParentStateReason,
  string
> = {
  ORGANISATION:
    "Dependents cannot be linked under an organisation or school account, because it is not a person.",
  ARCHIVED:
    "Dependents cannot be linked under an archived member. Archiving is permanent, so link them under another member of the family instead.",
  INACTIVE:
    "Dependents can only be linked under active members. Reactivate this member first.",
};

/**
 * 422 bodies for `POST /api/admin/members` with a `parentMemberId` — the CREATE
 * path. Same rule, different endpoint and different verb.
 */
export const DEPENDENT_PARENT_CREATE_ERRORS: Record<
  DependentParentStateReason,
  string
> = {
  ORGANISATION:
    "Dependents cannot be created under an organisation or school account, because it is not a person.",
  ARCHIVED:
    "Dependents cannot be created under an archived member. Archiving is permanent, so add them under another member of the family instead.",
  INACTIVE:
    "Dependents can only be created under active members. Reactivate this member first.",
};

/**
 * What the member detail page shows beside the DISABLED "Add Dependent"
 * control. Addressed to the admin looking at the member, not to an attempted
 * write, so it names the member's state and what they can actually do next.
 */
export const DEPENDENT_PARENT_BLOCK_EXPLANATIONS: Record<
  DependentParentStateReason,
  string
> = {
  ORGANISATION:
    "This is an organisation or school account rather than a person, so it cannot be recorded as anyone's parent.",
  ARCHIVED:
    "This member is archived, and archiving cannot be undone — add the dependent under another member of the family instead.",
  INACTIVE:
    "This member is inactive — reactivate them to add dependents.",
};

/**
 * One member the candidate search matched on name/email but had to exclude,
 * carried in the members-list response so the dialog can explain an otherwise
 * inscrutable empty result.
 */
export type DependentLinkIneligibleMatch = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  reason: DependentLinkIneligibilityReason;
  explanation: string;
};

/**
 * The columns `dependentLinkBlockers` reads off the candidate row. Spread this
 * into every select that feeds the predicate — the write route and the search's
 * diagnostic query both do — rather than restating the fields.
 *
 * The `dependents` / `secondaryDependents` relation probes that used to live
 * here are gone (#2255). They existed to arm the old `HAS_DEPENDANTS` rule, and
 * they were selected `take: 1` because only emptiness was read. Depth needs the
 * DEEPEST chain under the candidate, and `take: 1` returns an arbitrary child,
 * so keeping them would have been an answer that looked right and was not. The
 * compile-time protection they gave the invariant now sits on the required
 * {@link DependentLinkGraphFacts} argument instead.
 */
export const DEPENDENT_LINK_CANDIDATE_SELECT = {
  id: true,
  archivedAt: true,
  parentMemberId: true,
  secondaryParentId: true,
  partnerLinksAsMemberA: { select: { memberBId: true } },
  partnerLinksAsMemberB: { select: { memberAId: true } },
} satisfies Prisma.MemberSelect;

export type DependentLinkCandidate = {
  id: string;
  archivedAt: Date | null;
  parentMemberId: string | null;
  secondaryParentId: string | null;
  partnerLinksAsMemberA?: ReadonlyArray<{ memberBId: string }>;
  partnerLinksAsMemberB?: ReadonlyArray<{ memberAId: string }>;
};

/**
 * Whole-graph facts the row cannot supply, computed once per request by the
 * caller with `src/lib/member-family-link-depth.ts` and shared across every
 * candidate in that request.
 */
export type DependentLinkGraphFacts = {
  /**
   * Ids of every ancestor of the parent (the parent excluded). A candidate in
   * this set would close a loop. From `describeParentSideDepth`.
   */
  parentAncestorIds: ReadonlyArray<string>;
  /** Longest chain of parent-links above the parent; 0 when it has none. */
  parentAncestorGenerations: number;
  /**
   * Longest chain of parent-links BELOW this candidate. Per candidate, so a
   * caller explaining several rows walks each one. From `describeChildSideDepth`.
   */
  candidateDescendantGenerations: number;
};

/**
 * Every reason this candidate cannot be linked under `parentMemberId`, in
 * `DEPENDENT_LINK_INELIGIBILITY_REASONS` order. Empty means eligible.
 *
 * Unlike before #2255 this is the WHOLE predicate: no guard is left over in the
 * write route, because the graph walks the route used to own are now inputs.
 */
export function dependentLinkBlockers(
  parentMemberId: string,
  candidate: DependentLinkCandidate,
  graph: DependentLinkGraphFacts,
): DependentLinkIneligibilityReason[] {
  const blockers: DependentLinkIneligibilityReason[] = [];

  if (candidate.archivedAt) {
    blockers.push("ARCHIVED");
  }
  if (candidate.id === parentMemberId) {
    blockers.push("SELF");
  }
  if (
    candidate.parentMemberId === parentMemberId ||
    candidate.secondaryParentId === parentMemberId
  ) {
    blockers.push("ALREADY_LINKED_TO_PARENT");
  }
  if (
    candidate.partnerLinksAsMemberA?.some(
      (link) => link.memberBId === parentMemberId,
    ) ||
    candidate.partnerLinksAsMemberB?.some(
      (link) => link.memberAId === parentMemberId,
    )
  ) {
    blockers.push("DIRECT_PARTNER");
  }
  if (candidate.parentMemberId && candidate.secondaryParentId) {
    blockers.push("TWO_PARENTS");
  }
  if (graph.parentAncestorIds.includes(candidate.id)) {
    blockers.push("ANCESTOR_OF_PARENT");
  }
  if (
    exceedsFamilyLinkGenerationLimit({
      parentAncestorGenerations: graph.parentAncestorGenerations,
      childDescendantGenerations: graph.candidateDescendantGenerations,
    })
  ) {
    blockers.push("EXCEEDS_GENERATION_LIMIT");
  }

  return blockers;
}

/**
 * The SQL half of the same predicate: the `AND` conditions that select exactly
 * the members `dependentLinkBlockers` would clear.
 *
 * NULL SEMANTICS (#2254 — the bug this file exists for). `parentMemberId` and
 * `secondaryParentId` are nullable. Prisma compiles `{ not: x }` on a nullable
 * column to a bare `"col" <> $1`, and in SQL `NULL <> 'x'` is UNKNOWN, not TRUE
 * — so the row is dropped. The two "not already linked to this parent" clauses
 * were written that way, which silently hid EVERY member with no parent
 * recorded: the overwhelming majority of valid candidates, and the reason the
 * dialog reported "No eligible members found" for perfectly linkable members.
 * The `OR ... IS NULL` form below is the repo's null-safe idiom (compare
 * `src/lib/booking-policies.ts`, `src/lib/cancellation.ts`,
 * `src/lib/authoritative-fees.ts`) and compiles to
 * `("col" IS NULL OR "col" <> $1)`.
 *
 * ACTIVE / ARCHIVED (#2254). `archivedAt: null` is filtered because the write
 * route rejects an archived target outright. `active` is deliberately NOT
 * filtered: the write route requires the PARENT to be active but accepts an
 * inactive target, and the dialog renders an "Inactive" badge on the chosen
 * candidate — filtering here would hide members the route is happy to link.
 * (The parent-side search, `parentLinkEligibleFor`, does filter `active: true`,
 * because there the searched-for member becomes the parent.)
 *
 * DEPTH (#2255). The generation cap is expressed here as bounded relation
 * nesting — "this candidate has no dependant chain longer than N" — with N
 * derived from how much of the cap the parent's own ancestors already use.
 * `parentAncestorIds` excludes the ancestor set outright: with the old
 * two-generation clause gone, an ancestor of the parent is no longer excluded
 * as a side effect of having dependants, and would otherwise be offered as a
 * candidate the write route then refuses as a cycle.
 */
export function dependentLinkCandidateWhere(
  parentMemberId: string,
  graph: Pick<
    DependentLinkGraphFacts,
    "parentAncestorIds" | "parentAncestorGenerations"
  >,
): Prisma.MemberWhereInput[] {
  return [
    { id: { notIn: [parentMemberId, ...graph.parentAncestorIds] } },
    {
      OR: [
        { parentMemberId: null },
        { parentMemberId: { not: parentMemberId } },
      ],
    },
    ...notPartnerWithMemberWhere(parentMemberId),
    {
      OR: [
        { secondaryParentId: null },
        { secondaryParentId: { not: parentMemberId } },
      ],
    },
    // At most two parents: at least one of the two columns must still be free.
    { OR: [{ parentMemberId: null }, { secondaryParentId: null }] },
    descendantDepthWithinWhere(
      allowedChildDescendantGenerations(graph.parentAncestorGenerations),
    ),
    { archivedAt: null },
  ];
}
