-- Phase 2: Migrate dependents into family groups
-- Uses PL/pgSQL to safely create groups and add members atomically

DO $$
DECLARE
  parent_rec RECORD;
  dep_rec RECORD;
  new_group_id TEXT;
  parent_group_id TEXT;
BEGIN
  -- Step 1: For each parent with dependents who is NOT yet in any family group,
  -- create a new family group and add the parent as LEAD
  FOR parent_rec IN
    SELECT DISTINCT p.id, p."lastName"
    FROM "Member" p
    WHERE p.id IN (
      SELECT DISTINCT m."parentMemberId"
      FROM "Member" m
      WHERE m."parentMemberId" IS NOT NULL
    )
    AND p.id NOT IN (
      SELECT fgm."memberId" FROM "FamilyGroupMember" fgm
    )
  LOOP
    new_group_id := gen_random_uuid()::text;

    INSERT INTO "FamilyGroup" ("id", "name", "createdAt", "updatedAt")
    VALUES (new_group_id, parent_rec."lastName" || ' Family', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

    INSERT INTO "FamilyGroupMember" ("id", "familyGroupId", "memberId", "role", "joinedAt")
    VALUES (gen_random_uuid()::text, new_group_id, parent_rec.id, 'LEAD', CURRENT_TIMESTAMP)
    ON CONFLICT ("familyGroupId", "memberId") DO NOTHING;
  END LOOP;

  -- Step 2: Add all dependents to their parent's first family group
  FOR dep_rec IN
    SELECT dep.id as dep_id, dep."parentMemberId"
    FROM "Member" dep
    WHERE dep."parentMemberId" IS NOT NULL
    AND dep.id NOT IN (
      SELECT fgm."memberId" FROM "FamilyGroupMember" fgm
      JOIN "FamilyGroupMember" pfgm ON pfgm."familyGroupId" = fgm."familyGroupId"
        AND pfgm."memberId" = dep."parentMemberId"
    )
  LOOP
    SELECT fgm."familyGroupId" INTO parent_group_id
    FROM "FamilyGroupMember" fgm
    WHERE fgm."memberId" = dep_rec."parentMemberId"
    ORDER BY fgm."joinedAt" ASC
    LIMIT 1;

    IF parent_group_id IS NOT NULL THEN
      INSERT INTO "FamilyGroupMember" ("id", "familyGroupId", "memberId", "role", "joinedAt")
      VALUES (gen_random_uuid()::text, parent_group_id, dep_rec.dep_id, 'MEMBER', CURRENT_TIMESTAMP)
      ON CONFLICT ("familyGroupId", "memberId") DO NOTHING;
    END IF;
  END LOOP;

  -- Step 3: Handle secondary parents — add dependents to secondary parent's group too
  FOR dep_rec IN
    SELECT dep.id as dep_id, dep."secondaryParentId"
    FROM "Member" dep
    WHERE dep."secondaryParentId" IS NOT NULL
  LOOP
    SELECT fgm."familyGroupId" INTO parent_group_id
    FROM "FamilyGroupMember" fgm
    WHERE fgm."memberId" = dep_rec."secondaryParentId"
    ORDER BY fgm."joinedAt" ASC
    LIMIT 1;

    IF parent_group_id IS NOT NULL THEN
      INSERT INTO "FamilyGroupMember" ("id", "familyGroupId", "memberId", "role", "joinedAt")
      VALUES (gen_random_uuid()::text, parent_group_id, dep_rec.dep_id, 'MEMBER', CURRENT_TIMESTAMP)
      ON CONFLICT ("familyGroupId", "memberId") DO NOTHING;
    END IF;
  END LOOP;
END $$;
