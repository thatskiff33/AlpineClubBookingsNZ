import type { DataMigrationVerification } from "./types";

const PAIR_STATE = `
  SELECT
    "memberAId",
    "memberBId",
    "parentLinkCount",
    "partnerLinkCount"
  FROM "MemberParentPartnerExclusion"
  ORDER BY "memberAId" COLLATE "C", "memberBId" COLLATE "C"
`;

const MEMBER_VALUES = (rows: string) => `
  INSERT INTO "Member" (
    "id", "email", "passwordHash", "firstName", "lastName", "updatedAt"
  ) VALUES ${rows};
`;

const verification: DataMigrationVerification = {
  migration: "20260912010000_add_member_parent_partner_exclusion",
  intent:
    "Refuse pre-existing direct-parent/partner overlap without leaking pair values, otherwise backfill both parent columns and every partner status into exact canonical pair counts before installing the trigger backstop.",
  executionMode: "isolated_database",
  idempotentReRun: false,
  cases: [
    {
      name: "clean primary, secondary, pending, and confirmed relationships",
      seed: `
        ${MEMBER_VALUES(`
          ('dmv-primary-parent', 'dmv-primary-parent@example.invalid', 'x', 'Primary', 'Parent', now()),
          ('dmv-primary-child', 'dmv-primary-child@example.invalid', 'x', 'Primary', 'Child', now()),
          ('dmv-secondary-parent', 'dmv-secondary-parent@example.invalid', 'x', 'Secondary', 'Parent', now()),
          ('dmv-secondary-child', 'dmv-secondary-child@example.invalid', 'x', 'Secondary', 'Child', now()),
          ('dmv-pending-a', 'dmv-pending-a@example.invalid', 'x', 'Pending', 'A', now()),
          ('dmv-pending-b', 'dmv-pending-b@example.invalid', 'x', 'Pending', 'B', now()),
          ('dmv-confirmed-a', 'dmv-confirmed-a@example.invalid', 'x', 'Confirmed', 'A', now()),
          ('dmv-confirmed-b', 'dmv-confirmed-b@example.invalid', 'x', 'Confirmed', 'B', now())
        `)}

        UPDATE "Member"
        SET "parentMemberId" = 'dmv-primary-parent'
        WHERE "id" = 'dmv-primary-child';

        UPDATE "Member"
        SET "secondaryParentId" = 'dmv-secondary-parent'
        WHERE "id" = 'dmv-secondary-child';

        INSERT INTO "MemberPartnerLink" (
          "id", "memberAId", "memberBId", "status", "updatedAt"
        ) VALUES
          ('dmv-pending-link', 'dmv-pending-a', 'dmv-pending-b', 'PENDING', now()),
          ('dmv-confirmed-link', 'dmv-confirmed-a', 'dmv-confirmed-b', 'CONFIRMED', now());
      `,
      expectations: [
        {
          claim:
            "both parent columns and both partner statuses backfill once into canonical pair rows",
          sql: PAIR_STATE,
          rows: [
            {
              memberAId: "dmv-confirmed-a",
              memberBId: "dmv-confirmed-b",
              parentLinkCount: 0,
              partnerLinkCount: 1,
            },
            {
              memberAId: "dmv-pending-a",
              memberBId: "dmv-pending-b",
              parentLinkCount: 0,
              partnerLinkCount: 1,
            },
            {
              memberAId: "dmv-primary-child",
              memberBId: "dmv-primary-parent",
              parentLinkCount: 1,
              partnerLinkCount: 0,
            },
            {
              memberAId: "dmv-secondary-child",
              memberBId: "dmv-secondary-parent",
              parentLinkCount: 1,
              partnerLinkCount: 0,
            },
          ],
        },
      ],
    },
    {
      name: "duplicate primary and secondary parent columns retain exact count",
      seed: `
        ${MEMBER_VALUES(`
          ('dmv-double-parent', 'dmv-double-parent@example.invalid', 'x', 'Double', 'Parent', now()),
          ('dmv-double-child', 'dmv-double-child@example.invalid', 'x', 'Double', 'Child', now())
        `)}

        UPDATE "Member"
        SET
          "parentMemberId" = 'dmv-double-parent',
          "secondaryParentId" = 'dmv-double-parent'
        WHERE "id" = 'dmv-double-child';
      `,
      expectations: [
        {
          claim:
            "the backfill uses UNION ALL and counts both legacy parent columns independently",
          sql: PAIR_STATE,
          rows: [
            {
              memberAId: "dmv-double-child",
              memberBId: "dmv-double-parent",
              parentLinkCount: 2,
              partnerLinkCount: 0,
            },
          ],
        },
      ],
    },
    {
      name: "pre-existing overlap refuses before any schema artifact survives",
      seed: `
        ${MEMBER_VALUES(`
          ('dmv-overlap-a', 'dmv-overlap-a@example.invalid', 'x', 'Overlap', 'A', now()),
          ('dmv-overlap-b', 'dmv-overlap-b@example.invalid', 'x', 'Overlap', 'B', now())
        `)}

        UPDATE "Member"
        SET "parentMemberId" = 'dmv-overlap-a'
        WHERE "id" = 'dmv-overlap-b';

        INSERT INTO "MemberPartnerLink" (
          "id", "memberAId", "memberBId", "status", "updatedAt"
        ) VALUES (
          'dmv-overlap-link',
          'dmv-overlap-a',
          'dmv-overlap-b',
          'PENDING',
          now()
        );
      `,
      expectedError: {
        message: "member_parent_partner_exclusion_conflict",
        code: "23514",
        constraint: "MemberParentPartnerExclusion_no_overlap",
        noDetailOrHint: true,
        absentText: ["dmv-overlap-a", "dmv-overlap-b"],
      },
      expectations: [
        {
          claim:
            "the failed explicit transaction leaves no pair table, functions, or triggers",
          sql: `
            SELECT
              to_regclass('"MemberParentPartnerExclusion"')::text AS "pairTable",
              to_regprocedure(
                'member_parent_partner_apply_delta(text,text,integer,integer)'
              )::text AS "applyFunction",
              COUNT(t.oid)::integer AS "triggerCount"
            FROM pg_trigger t
            WHERE t.tgname IN (
              'Member_parent_partner_exclusion_insert',
              'Member_parent_partner_exclusion_update',
              'Member_parent_partner_exclusion_delete',
              'MemberPartnerLink_parent_partner_exclusion_insert',
              'MemberPartnerLink_parent_partner_exclusion_update',
              'MemberPartnerLink_parent_partner_exclusion_delete',
              'MemberParentPartnerExclusion_cleanup_zero_pair'
            )
          `,
          rows: [
            { pairTable: null, applyFunction: null, triggerCount: 0 },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "omit primary-parent backfill",
      harm:
        "Existing primary parent edges have no serialization state, so a later partner write can bypass the intended cross-table pair row.",
      find: `  FROM "Member" m
  WHERE m."parentMemberId" IS NOT NULL

  UNION ALL

  SELECT
    CASE WHEN m."id" COLLATE "C" < m."secondaryParentId" COLLATE "C"`,
      replace: `  FROM "Member" m
  WHERE FALSE

  UNION ALL

  SELECT
    CASE WHEN m."id" COLLATE "C" < m."secondaryParentId" COLLATE "C"`,
    },
    {
      name: "omit secondary-parent backfill",
      harm:
        "Existing secondary parent edges are absent from derived state and can overlap a partner row after deployment.",
      find: `  FROM "Member" m
  WHERE m."secondaryParentId" IS NOT NULL

  UNION ALL

  SELECT
    CASE WHEN p."memberAId" COLLATE "C" < p."memberBId" COLLATE "C"`,
      replace: `  FROM "Member" m
  WHERE FALSE

  UNION ALL

  SELECT
    CASE WHEN p."memberAId" COLLATE "C" < p."memberBId" COLLATE "C"`,
    },
    {
      name: "omit pending partner links from backfill",
      harm:
        "A pending partner request remains invisible to the database backstop even though direct parentage must conflict with both statuses.",
      find: `  FROM "MemberPartnerLink" p
), pair_counts AS (`,
      replace: `  FROM "MemberPartnerLink" p
  WHERE p."status" = 'CONFIRMED'
), pair_counts AS (`,
    },
    {
      name: "omit the pair-state backfill insert",
      harm:
        "The schema and triggers install over clean existing relationships but their initial counters are empty, so later deletes underflow or overlaps evade serialization.",
      find: `FROM pair_counts
ORDER BY member_a_id COLLATE "C", member_b_id COLLATE "C";`,
      replace: `FROM pair_counts
WHERE FALSE
ORDER BY member_a_id COLLATE "C", member_b_id COLLATE "C";`,
    },
  ],
};

export default verification;
