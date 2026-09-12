import {
  MEMBER_PARENT_PARTNER_EXCLUSION_CONSTRAINT,
  MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE,
  MEMBER_PARENT_PARTNER_EXCLUSION_STATE_CONSTRAINT,
  MEMBER_PARENT_PARTNER_EXCLUSION_STATE_MESSAGE,
} from "../../src/lib/member-parent-partner-exclusivity";
import type {
  DataMigrationCase,
  DataMigrationVerification,
} from "./types";

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

const ABSENT_SCHEMA_ARTIFACTS = `
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
`;

function preExistingOverlapCase(
  name: string,
  suffix: string,
  parentColumn: "parentMemberId" | "secondaryParentId",
  status: "PENDING" | "CONFIRMED",
  childSortsBeforeParent: boolean,
): DataMigrationCase {
  const memberAId = `dmv-overlap-${suffix}-a`;
  const memberBId = `dmv-overlap-${suffix}-b`;
  const childId = childSortsBeforeParent ? memberAId : memberBId;
  const parentId = childSortsBeforeParent ? memberBId : memberAId;
  return {
    name,
    seed: `
      ${MEMBER_VALUES(`
        ('${memberAId}', '${memberAId}@example.invalid', 'x', 'Overlap', 'A', now()),
        ('${memberBId}', '${memberBId}@example.invalid', 'x', 'Overlap', 'B', now())
      `)}

      UPDATE "Member"
      SET "${parentColumn}" = '${parentId}'
      WHERE "id" = '${childId}';

      INSERT INTO "MemberPartnerLink" (
        "id", "memberAId", "memberBId", "status", "updatedAt"
      ) VALUES (
        'dmv-overlap-${suffix}-link',
        '${memberAId}',
        '${memberBId}',
        '${status}',
        now()
      );
    `,
    expectedError: {
      message: MEMBER_PARENT_PARTNER_EXCLUSION_DATABASE_MESSAGE,
      code: "23514",
      constraint: MEMBER_PARENT_PARTNER_EXCLUSION_CONSTRAINT,
      noDetailOrHint: true,
      absentText: [memberAId, memberBId],
    },
    expectations: [
      {
        claim:
          "the failed explicit transaction leaves no pair table, functions, or triggers",
        sql: ABSENT_SCHEMA_ARTIFACTS,
        rows: [{ pairTable: null, applyFunction: null, triggerCount: 0 }],
      },
    ],
  };
}

const verification: DataMigrationVerification = {
  migration: "20260914010000_add_member_parent_partner_exclusion",
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
    preExistingOverlapCase(
      "primary-parent pending overlap, child sorts after parent",
      "primary-pending-after",
      "parentMemberId",
      "PENDING",
      false,
    ),
    preExistingOverlapCase(
      "primary-parent confirmed overlap, child sorts before parent",
      "primary-confirmed-before",
      "parentMemberId",
      "CONFIRMED",
      true,
    ),
    preExistingOverlapCase(
      "secondary-parent confirmed overlap, child sorts after parent",
      "secondary-confirmed-after",
      "secondaryParentId",
      "CONFIRMED",
      false,
    ),
    preExistingOverlapCase(
      "secondary-parent pending overlap, child sorts before parent",
      "secondary-pending-before",
      "secondaryParentId",
      "PENDING",
      true,
    ),
    {
      name: "primary self-parent state is refused without leaking its member id",
      seed: `
        ${MEMBER_VALUES(`
          ('dmv-primary-self-parent', 'dmv-primary-self-parent@example.invalid', 'x', 'Primary', 'Self', now())
        `)}

        UPDATE "Member"
        SET "parentMemberId" = 'dmv-primary-self-parent'
        WHERE "id" = 'dmv-primary-self-parent';
      `,
      expectedError: {
        message: MEMBER_PARENT_PARTNER_EXCLUSION_STATE_MESSAGE,
        code: "23514",
        constraint: MEMBER_PARENT_PARTNER_EXCLUSION_STATE_CONSTRAINT,
        noDetailOrHint: true,
        absentText: ["dmv-primary-self-parent"],
      },
      expectations: [
        {
          claim:
            "the failed explicit transaction leaves no pair table, functions, or triggers",
          sql: ABSENT_SCHEMA_ARTIFACTS,
          rows: [{ pairTable: null, applyFunction: null, triggerCount: 0 }],
        },
      ],
    },
    {
      name: "secondary self-parent state is refused without leaking its member id",
      seed: `
        ${MEMBER_VALUES(`
          ('dmv-secondary-self-parent', 'dmv-secondary-self-parent@example.invalid', 'x', 'Secondary', 'Self', now())
        `)}

        UPDATE "Member"
        SET "secondaryParentId" = 'dmv-secondary-self-parent'
        WHERE "id" = 'dmv-secondary-self-parent';
      `,
      expectedError: {
        message: MEMBER_PARENT_PARTNER_EXCLUSION_STATE_MESSAGE,
        code: "23514",
        constraint: MEMBER_PARENT_PARTNER_EXCLUSION_STATE_CONSTRAINT,
        noDetailOrHint: true,
        absentText: ["dmv-secondary-self-parent"],
      },
      expectations: [
        {
          claim:
            "the failed explicit transaction leaves no pair table, functions, or triggers",
          sql: ABSENT_SCHEMA_ARTIFACTS,
          rows: [{ pairTable: null, applyFunction: null, triggerCount: 0 }],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "omit primary self-parent preflight branch",
      harm: "A primary self-parent pointer reaches the native canonical-pair CHECK and leaks its member id in PostgreSQL failing-row detail.",
      find: `    WHERE m."id" = m."parentMemberId"
       OR m."id" = m."secondaryParentId"`,
      replace: `    WHERE m."id" = m."secondaryParentId"`,
    },
    {
      name: "omit secondary self-parent preflight branch",
      harm: "A secondary self-parent pointer reaches the native canonical-pair CHECK and leaks its member id in PostgreSQL failing-row detail.",
      find: `    WHERE m."id" = m."parentMemberId"
       OR m."id" = m."secondaryParentId"`,
      replace: `    WHERE m."id" = m."parentMemberId"`,
    },
    {
      name: "omit primary-parent preflight branch",
      harm: "A primary-parent overlap reaches the derived-state CHECK, leaking its native failing-row detail instead of the stable non-PII preflight refusal.",
      find: `      FROM "Member" m
      WHERE m."parentMemberId" IS NOT NULL

      UNION

      SELECT
        CASE WHEN m."id" COLLATE "C" < m."secondaryParentId" COLLATE "C"`,
      replace: `      FROM "Member" m
      WHERE FALSE

      UNION

      SELECT
        CASE WHEN m."id" COLLATE "C" < m."secondaryParentId" COLLATE "C"`,
    },
    {
      name: "omit secondary-parent preflight branch",
      harm: "A secondary-parent overlap bypasses the privacy-safe preflight and fails later with PostgreSQL's row-bearing native CHECK detail.",
      find: `      FROM "Member" m
      WHERE m."secondaryParentId" IS NOT NULL
    ),
    partner_pairs AS (`,
      replace: `      FROM "Member" m
      WHERE FALSE
    ),
    partner_pairs AS (`,
    },
    {
      name: "ignore pending partner links in preflight",
      harm: "A pending partner overlap bypasses the privacy-safe census even though pending and confirmed links carry the same exclusion meaning.",
      find: `      FROM "MemberPartnerLink" p
    )
    SELECT 1
    FROM parent_pairs parent_pair`,
      replace: `      FROM "MemberPartnerLink" p
      WHERE p."status" = 'CONFIRMED'
    )
    SELECT 1
    FROM parent_pairs parent_pair`,
    },
    {
      name: "collapse one preflight canonical orientation",
      harm: "Parent pairs whose child id sorts before its parent no longer join the already-canonical partner pair and therefore miss the stable preflight refusal.",
      find: `        CASE WHEN m."id" COLLATE "C" < m."parentMemberId" COLLATE "C"
          THEN m."id" ELSE m."parentMemberId" END AS member_a_id,
        CASE WHEN m."id" COLLATE "C" < m."parentMemberId" COLLATE "C"
          THEN m."parentMemberId" ELSE m."id" END AS member_b_id
      FROM "Member" m`,
      replace: `        m."parentMemberId" AS member_a_id,
        m."id" AS member_b_id
      FROM "Member" m`,
    },
    {
      name: "omit primary-parent backfill",
      harm: "Existing primary parent edges have no serialization state, so a later partner write can bypass the intended cross-table pair row.",
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
      harm: "Existing secondary parent edges are absent from derived state and can overlap a partner row after deployment.",
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
      harm: "A pending partner request remains invisible to the database backstop even though direct parentage must conflict with both statuses.",
      find: `  FROM "MemberPartnerLink" p
), pair_counts AS (`,
      replace: `  FROM "MemberPartnerLink" p
  WHERE p."status" = 'CONFIRMED'
), pair_counts AS (`,
    },
    {
      name: "omit the pair-state backfill insert",
      harm: "The schema and triggers install over clean existing relationships but their initial counters are empty, so later deletes underflow or overlaps evade serialization.",
      find: `FROM pair_counts
ORDER BY member_a_id COLLATE "C", member_b_id COLLATE "C";`,
      replace: `FROM pair_counts
WHERE FALSE
ORDER BY member_a_id COLLATE "C", member_b_id COLLATE "C";`,
    },
  ],
};

export default verification;
