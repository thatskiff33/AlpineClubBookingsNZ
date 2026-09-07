-- #3271 / #3292: database backstop for direct-parent / partner exclusivity.
--
-- This migration is deliberately WINDOWED, not ordinary blue/green-compatible.
-- The pre-epic runtime neither participates in the pair-row protocol nor maps
-- this migration's stable check failure. Remove traffic and stop every old web,
-- worker, scheduler and database connection before the private repair, then
-- keep them stopped through this migration and epic-runtime cutover. The safety
-- ledger and operator runbooks carry the complete sequence.
--
-- LOCK IMPACT. SHARE ROW EXCLUSIVE blocks INSERT/UPDATE/DELETE and other
-- schema-changing locks on both hot relationship sources while allowing reads.
-- It is held for the zero-conflict census, small derived-state backfill, and
-- trigger installation, until the explicit COMMIT. Run only inside the declared
-- maintenance window and let the deploy lock timeout fail closed.
--
-- No source relationship is repaired here. The preflight raises one stable,
-- non-PII check error if any overlap remains, before any schema artifact is
-- committed. The whole file is one explicit transaction.

BEGIN;

LOCK TABLE "Member", "MemberPartnerLink" IN SHARE ROW EXCLUSIVE MODE;

DO $member_parent_partner_preflight$
BEGIN
  IF EXISTS (
    WITH parent_pairs AS (
      SELECT
        CASE WHEN m."id" COLLATE "C" < m."parentMemberId" COLLATE "C"
          THEN m."id" ELSE m."parentMemberId" END AS member_a_id,
        CASE WHEN m."id" COLLATE "C" < m."parentMemberId" COLLATE "C"
          THEN m."parentMemberId" ELSE m."id" END AS member_b_id
      FROM "Member" m
      WHERE m."parentMemberId" IS NOT NULL

      UNION

      SELECT
        CASE WHEN m."id" COLLATE "C" < m."secondaryParentId" COLLATE "C"
          THEN m."id" ELSE m."secondaryParentId" END,
        CASE WHEN m."id" COLLATE "C" < m."secondaryParentId" COLLATE "C"
          THEN m."secondaryParentId" ELSE m."id" END
      FROM "Member" m
      WHERE m."secondaryParentId" IS NOT NULL
    ),
    partner_pairs AS (
      SELECT
        CASE WHEN p."memberAId" COLLATE "C" < p."memberBId" COLLATE "C"
          THEN p."memberAId" ELSE p."memberBId" END AS member_a_id,
        CASE WHEN p."memberAId" COLLATE "C" < p."memberBId" COLLATE "C"
          THEN p."memberBId" ELSE p."memberAId" END AS member_b_id
      FROM "MemberPartnerLink" p
    )
    SELECT 1
    FROM parent_pairs parent_pair
    INNER JOIN partner_pairs partner_pair
      USING (member_a_id, member_b_id)
    LIMIT 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'member_parent_partner_exclusion_conflict',
      CONSTRAINT = 'MemberParentPartnerExclusion_no_overlap';
  END IF;
END
$member_parent_partner_preflight$;

CREATE TABLE "MemberParentPartnerExclusion" (
  "memberAId" TEXT COLLATE "C" NOT NULL,
  "memberBId" TEXT COLLATE "C" NOT NULL,
  "parentLinkCount" INTEGER NOT NULL DEFAULT 0,
  "partnerLinkCount" INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "MemberParentPartnerExclusion_pkey"
    PRIMARY KEY ("memberAId", "memberBId"),
  CONSTRAINT "MemberParentPartnerExclusion_pair_canonical"
    CHECK ("memberAId" < "memberBId"),
  CONSTRAINT "MemberParentPartnerExclusion_counts_nonnegative"
    CHECK ("parentLinkCount" >= 0 AND "partnerLinkCount" >= 0),
  CONSTRAINT "MemberParentPartnerExclusion_no_overlap"
    CHECK ("parentLinkCount" = 0 OR "partnerLinkCount" = 0)
);

WITH relationship_edges AS (
  SELECT
    CASE WHEN m."id" COLLATE "C" < m."parentMemberId" COLLATE "C"
      THEN m."id" ELSE m."parentMemberId" END AS member_a_id,
    CASE WHEN m."id" COLLATE "C" < m."parentMemberId" COLLATE "C"
      THEN m."parentMemberId" ELSE m."id" END AS member_b_id,
    1::INTEGER AS parent_delta,
    0::INTEGER AS partner_delta
  FROM "Member" m
  WHERE m."parentMemberId" IS NOT NULL

  UNION ALL

  SELECT
    CASE WHEN m."id" COLLATE "C" < m."secondaryParentId" COLLATE "C"
      THEN m."id" ELSE m."secondaryParentId" END,
    CASE WHEN m."id" COLLATE "C" < m."secondaryParentId" COLLATE "C"
      THEN m."secondaryParentId" ELSE m."id" END,
    1::INTEGER,
    0::INTEGER
  FROM "Member" m
  WHERE m."secondaryParentId" IS NOT NULL

  UNION ALL

  SELECT
    CASE WHEN p."memberAId" COLLATE "C" < p."memberBId" COLLATE "C"
      THEN p."memberAId" ELSE p."memberBId" END,
    CASE WHEN p."memberAId" COLLATE "C" < p."memberBId" COLLATE "C"
      THEN p."memberBId" ELSE p."memberAId" END,
    0::INTEGER,
    1::INTEGER
  FROM "MemberPartnerLink" p
), pair_counts AS (
  SELECT
    member_a_id,
    member_b_id,
    SUM(parent_delta)::INTEGER AS parent_link_count,
    SUM(partner_delta)::INTEGER AS partner_link_count
  FROM relationship_edges
  GROUP BY member_a_id, member_b_id
)
INSERT INTO "MemberParentPartnerExclusion" (
  "memberAId",
  "memberBId",
  "parentLinkCount",
  "partnerLinkCount"
)
SELECT
  member_a_id,
  member_b_id,
  parent_link_count,
  partner_link_count
FROM pair_counts
ORDER BY member_a_id COLLATE "C", member_b_id COLLATE "C";

-- One pair-row operation owns cross-table serialization. The no-op conflict
-- update is intentional: ON CONFLICT DO NOTHING would not lock an existing row.
-- Counts are calculated before the UPDATE so negative state gets a distinct,
-- stable non-PII failure. Any native CHECK error is caught and re-raised without
-- PostgreSQL's failing-row DETAIL, which would otherwise contain member ids.
CREATE FUNCTION member_parent_partner_apply_delta(
  pair_member_a_id TEXT,
  pair_member_b_id TEXT,
  parent_delta INTEGER,
  partner_delta INTEGER
) RETURNS VOID
LANGUAGE plpgsql
AS $member_parent_partner_apply_delta$
DECLARE
  current_parent_count INTEGER;
  current_partner_count INTEGER;
  next_parent_count INTEGER;
  next_partner_count INTEGER;
BEGIN
  IF pair_member_a_id IS NULL
    OR pair_member_b_id IS NULL
    OR pair_member_a_id COLLATE "C" >= pair_member_b_id COLLATE "C"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'member_parent_partner_exclusion_state_invalid';
  END IF;

  INSERT INTO "MemberParentPartnerExclusion" (
    "memberAId",
    "memberBId",
    "parentLinkCount",
    "partnerLinkCount"
  ) VALUES (pair_member_a_id, pair_member_b_id, 0, 0)
  ON CONFLICT ("memberAId", "memberBId") DO UPDATE
    SET "parentLinkCount" = "MemberParentPartnerExclusion"."parentLinkCount"
  RETURNING "parentLinkCount", "partnerLinkCount"
    INTO current_parent_count, current_partner_count;

  next_parent_count := current_parent_count + parent_delta;
  next_partner_count := current_partner_count + partner_delta;

  IF next_parent_count < 0 OR next_partner_count < 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'member_parent_partner_exclusion_state_invalid';
  END IF;

  IF next_parent_count > 0 AND next_partner_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'member_parent_partner_exclusion_conflict',
      CONSTRAINT = 'MemberParentPartnerExclusion_no_overlap';
  END IF;

  UPDATE "MemberParentPartnerExclusion"
  SET
    "parentLinkCount" = next_parent_count,
    "partnerLinkCount" = next_partner_count
  WHERE "memberAId" = pair_member_a_id
    AND "memberBId" = pair_member_b_id;
EXCEPTION
  WHEN check_violation THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'member_parent_partner_exclusion_conflict',
      CONSTRAINT = 'MemberParentPartnerExclusion_no_overlap';
END
$member_parent_partner_apply_delta$;

CREATE FUNCTION member_parent_partner_member_edges_changed()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $member_parent_partner_member_edges_changed$
DECLARE
  pair_delta RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR pair_delta IN
      WITH edge_deltas AS (
        SELECT n."id" AS child_id, n."parentMemberId" AS parent_id, 1 AS delta
        FROM new_members n
        WHERE n."parentMemberId" IS NOT NULL
        UNION ALL
        SELECT n."id", n."secondaryParentId", 1
        FROM new_members n
        WHERE n."secondaryParentId" IS NOT NULL
      ), canonical_deltas AS (
        SELECT
          CASE WHEN child_id COLLATE "C" < parent_id COLLATE "C"
            THEN child_id ELSE parent_id END AS member_a_id,
          CASE WHEN child_id COLLATE "C" < parent_id COLLATE "C"
            THEN parent_id ELSE child_id END AS member_b_id,
          delta
        FROM edge_deltas
      )
      SELECT member_a_id, member_b_id, SUM(delta)::INTEGER AS parent_delta
      FROM canonical_deltas
      GROUP BY member_a_id, member_b_id
      ORDER BY member_a_id COLLATE "C", member_b_id COLLATE "C"
    LOOP
      PERFORM member_parent_partner_apply_delta(
        pair_delta.member_a_id,
        pair_delta.member_b_id,
        pair_delta.parent_delta,
        0
      );
    END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    FOR pair_delta IN
      WITH edge_deltas AS (
        SELECT o."id" AS child_id, o."parentMemberId" AS parent_id, -1 AS delta
        FROM old_members o
        WHERE o."parentMemberId" IS NOT NULL
        UNION ALL
        SELECT o."id", o."secondaryParentId", -1
        FROM old_members o
        WHERE o."secondaryParentId" IS NOT NULL
      ), canonical_deltas AS (
        SELECT
          CASE WHEN child_id COLLATE "C" < parent_id COLLATE "C"
            THEN child_id ELSE parent_id END AS member_a_id,
          CASE WHEN child_id COLLATE "C" < parent_id COLLATE "C"
            THEN parent_id ELSE child_id END AS member_b_id,
          delta
        FROM edge_deltas
      )
      SELECT member_a_id, member_b_id, SUM(delta)::INTEGER AS parent_delta
      FROM canonical_deltas
      GROUP BY member_a_id, member_b_id
      ORDER BY member_a_id COLLATE "C", member_b_id COLLATE "C"
    LOOP
      PERFORM member_parent_partner_apply_delta(
        pair_delta.member_a_id,
        pair_delta.member_b_id,
        pair_delta.parent_delta,
        0
      );
    END LOOP;
  ELSE
    FOR pair_delta IN
      WITH edge_deltas AS (
        SELECT o."id" AS child_id, o."parentMemberId" AS parent_id, -1 AS delta
        FROM old_members o
        WHERE o."parentMemberId" IS NOT NULL
        UNION ALL
        SELECT o."id", o."secondaryParentId", -1
        FROM old_members o
        WHERE o."secondaryParentId" IS NOT NULL
        UNION ALL
        SELECT n."id", n."parentMemberId", 1
        FROM new_members n
        WHERE n."parentMemberId" IS NOT NULL
        UNION ALL
        SELECT n."id", n."secondaryParentId", 1
        FROM new_members n
        WHERE n."secondaryParentId" IS NOT NULL
      ), canonical_deltas AS (
        SELECT
          CASE WHEN child_id COLLATE "C" < parent_id COLLATE "C"
            THEN child_id ELSE parent_id END AS member_a_id,
          CASE WHEN child_id COLLATE "C" < parent_id COLLATE "C"
            THEN parent_id ELSE child_id END AS member_b_id,
          delta
        FROM edge_deltas
      )
      SELECT member_a_id, member_b_id, SUM(delta)::INTEGER AS parent_delta
      FROM canonical_deltas
      GROUP BY member_a_id, member_b_id
      HAVING SUM(delta) <> 0
      ORDER BY member_a_id COLLATE "C", member_b_id COLLATE "C"
    LOOP
      PERFORM member_parent_partner_apply_delta(
        pair_delta.member_a_id,
        pair_delta.member_b_id,
        pair_delta.parent_delta,
        0
      );
    END LOOP;
  END IF;

  RETURN NULL;
END
$member_parent_partner_member_edges_changed$;

CREATE FUNCTION member_parent_partner_partner_edges_changed()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $member_parent_partner_partner_edges_changed$
DECLARE
  pair_delta RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR pair_delta IN
      WITH edge_deltas AS (
        SELECT n."memberAId" AS endpoint_a, n."memberBId" AS endpoint_b, 1 AS delta
        FROM new_partner_links n
      ), canonical_deltas AS (
        SELECT
          CASE WHEN endpoint_a COLLATE "C" < endpoint_b COLLATE "C"
            THEN endpoint_a ELSE endpoint_b END AS member_a_id,
          CASE WHEN endpoint_a COLLATE "C" < endpoint_b COLLATE "C"
            THEN endpoint_b ELSE endpoint_a END AS member_b_id,
          delta
        FROM edge_deltas
      )
      SELECT member_a_id, member_b_id, SUM(delta)::INTEGER AS partner_delta
      FROM canonical_deltas
      GROUP BY member_a_id, member_b_id
      ORDER BY member_a_id COLLATE "C", member_b_id COLLATE "C"
    LOOP
      PERFORM member_parent_partner_apply_delta(
        pair_delta.member_a_id,
        pair_delta.member_b_id,
        0,
        pair_delta.partner_delta
      );
    END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    FOR pair_delta IN
      WITH edge_deltas AS (
        SELECT o."memberAId" AS endpoint_a, o."memberBId" AS endpoint_b, -1 AS delta
        FROM old_partner_links o
      ), canonical_deltas AS (
        SELECT
          CASE WHEN endpoint_a COLLATE "C" < endpoint_b COLLATE "C"
            THEN endpoint_a ELSE endpoint_b END AS member_a_id,
          CASE WHEN endpoint_a COLLATE "C" < endpoint_b COLLATE "C"
            THEN endpoint_b ELSE endpoint_a END AS member_b_id,
          delta
        FROM edge_deltas
      )
      SELECT member_a_id, member_b_id, SUM(delta)::INTEGER AS partner_delta
      FROM canonical_deltas
      GROUP BY member_a_id, member_b_id
      ORDER BY member_a_id COLLATE "C", member_b_id COLLATE "C"
    LOOP
      PERFORM member_parent_partner_apply_delta(
        pair_delta.member_a_id,
        pair_delta.member_b_id,
        0,
        pair_delta.partner_delta
      );
    END LOOP;
  ELSE
    FOR pair_delta IN
      WITH edge_deltas AS (
        SELECT o."memberAId" AS endpoint_a, o."memberBId" AS endpoint_b, -1 AS delta
        FROM old_partner_links o
        UNION ALL
        SELECT n."memberAId", n."memberBId", 1
        FROM new_partner_links n
      ), canonical_deltas AS (
        SELECT
          CASE WHEN endpoint_a COLLATE "C" < endpoint_b COLLATE "C"
            THEN endpoint_a ELSE endpoint_b END AS member_a_id,
          CASE WHEN endpoint_a COLLATE "C" < endpoint_b COLLATE "C"
            THEN endpoint_b ELSE endpoint_a END AS member_b_id,
          delta
        FROM edge_deltas
      )
      SELECT member_a_id, member_b_id, SUM(delta)::INTEGER AS partner_delta
      FROM canonical_deltas
      GROUP BY member_a_id, member_b_id
      HAVING SUM(delta) <> 0
      ORDER BY member_a_id COLLATE "C", member_b_id COLLATE "C"
    LOOP
      PERFORM member_parent_partner_apply_delta(
        pair_delta.member_a_id,
        pair_delta.member_b_id,
        0,
        pair_delta.partner_delta
      );
    END LOOP;
  END IF;

  RETURN NULL;
END
$member_parent_partner_partner_edges_changed$;

-- Pair rows created only to serialize an application pre-check stay visible for
-- the whole transaction, then disappear if no relationship was written. Source
-- deletes use the same deferred cleanup, so zero/zero rows never persist.
CREATE FUNCTION member_parent_partner_cleanup_zero_pair()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $member_parent_partner_cleanup_zero_pair$
BEGIN
  DELETE FROM "MemberParentPartnerExclusion"
  WHERE "memberAId" = NEW."memberAId"
    AND "memberBId" = NEW."memberBId"
    AND "parentLinkCount" = 0
    AND "partnerLinkCount" = 0;
  RETURN NULL;
END
$member_parent_partner_cleanup_zero_pair$;

CREATE TRIGGER "Member_parent_partner_exclusion_insert"
AFTER INSERT ON "Member"
REFERENCING NEW TABLE AS new_members
FOR EACH STATEMENT
EXECUTE FUNCTION member_parent_partner_member_edges_changed();

CREATE TRIGGER "Member_parent_partner_exclusion_update"
AFTER UPDATE ON "Member"
REFERENCING OLD TABLE AS old_members NEW TABLE AS new_members
FOR EACH STATEMENT
EXECUTE FUNCTION member_parent_partner_member_edges_changed();

CREATE TRIGGER "Member_parent_partner_exclusion_delete"
AFTER DELETE ON "Member"
REFERENCING OLD TABLE AS old_members
FOR EACH STATEMENT
EXECUTE FUNCTION member_parent_partner_member_edges_changed();

CREATE TRIGGER "MemberPartnerLink_parent_partner_exclusion_insert"
AFTER INSERT ON "MemberPartnerLink"
REFERENCING NEW TABLE AS new_partner_links
FOR EACH STATEMENT
EXECUTE FUNCTION member_parent_partner_partner_edges_changed();

CREATE TRIGGER "MemberPartnerLink_parent_partner_exclusion_update"
AFTER UPDATE ON "MemberPartnerLink"
REFERENCING OLD TABLE AS old_partner_links NEW TABLE AS new_partner_links
FOR EACH STATEMENT
EXECUTE FUNCTION member_parent_partner_partner_edges_changed();

CREATE TRIGGER "MemberPartnerLink_parent_partner_exclusion_delete"
AFTER DELETE ON "MemberPartnerLink"
REFERENCING OLD TABLE AS old_partner_links
FOR EACH STATEMENT
EXECUTE FUNCTION member_parent_partner_partner_edges_changed();

CREATE CONSTRAINT TRIGGER "MemberParentPartnerExclusion_cleanup_zero_pair"
AFTER INSERT OR UPDATE ON "MemberParentPartnerExclusion"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION member_parent_partner_cleanup_zero_pair();

COMMIT;
