/**
 * The age-tier values the members list's own filter offers, and the ONLY ones
 * `buildMembersWhere` will act on.
 *
 * IT IS A LITERAL, NOT `AGE_TIER_VALUES`, and that is deliberate: the shared
 * validator derives its list from the generated Prisma enum
 * (`src/lib/age-tier-schema.ts` → `import { AgeTier } from "@prisma/client"`), so
 * importing it into this client component would pull the generated client into a
 * browser bundle. `page-context/registry.ts` mirrors two Prisma enums the same way
 * and for the same reason. `members-age-tier-vocabulary.test.ts` asserts this list
 * still equals `AGE_TIER_VALUES`, so it cannot drift.
 *
 * WHY THE MEMBERS PAGE NEEDS THE VOCABULARY AT ALL (#2816). `buildMembersWhere`
 * applies `ageTier` only when it is in `AGE_TIER_VALUES` and otherwise ignores it
 * silently — there is no 400 — so `?ageTier=<anything>` narrows nothing while the
 * toolbar still shows a value. Publishing that to AI Diagnostics as an applied
 * filter would report a narrowing that never happened.
 */
export const MEMBER_AGE_TIER_FILTER_VALUES = [
  "INFANT",
  "CHILD",
  "YOUTH",
  "ADULT",
  "NOT_APPLICABLE",
] as const;

export type MemberAgeTierFilterValue =
  (typeof MEMBER_AGE_TIER_FILTER_VALUES)[number];

/** Toolbar option labels, one per value so a new tier cannot ship unlabelled. */
export const MEMBER_AGE_TIER_FILTER_LABELS: Record<
  MemberAgeTierFilterValue,
  string
> = {
  INFANT: "Infant",
  CHILD: "Child",
  YOUTH: "Youth",
  ADULT: "Adult",
  NOT_APPLICABLE: "N/A",
};

/** True when this value is one the members query will actually apply. */
export function isAppliedMemberAgeTier(
  value: string,
): value is MemberAgeTierFilterValue {
  return (MEMBER_AGE_TIER_FILTER_VALUES as readonly string[]).includes(value);
}
