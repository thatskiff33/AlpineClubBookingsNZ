-- #3037 (epic #2943) — the optional Group Trip adult-cover scope.
--
-- Purely additive EXPAND, in three statements:
--
--   1. ONE NULLABLE, NO-DEFAULT boolean column on "AdultMemberHostingPolicy"
--      holding the third host-qualification scope. Catalog-only ADD COLUMN, no
--      heap rewrite and NO BACKFILL: every existing row keeps NULL, and the
--      resolver reads NULL as OFF, so no club's adult-cover behaviour moves at
--      migration time.
--   2. A CHECK holding the new column to "never set on a row that did not decide
--      the existing pair".
--   3. The revision trigger learns about the new dimension, so a scope-set
--      change still advances the compare-and-swap token.
--
-- Nothing is dropped, renamed, rewritten or backfilled. No index, no foreign
-- key, no session-clock DML, no provider call.

-- ---------------------------------------------------------------------------
-- 1. The third scope.
-- ---------------------------------------------------------------------------
--
-- A separate boolean beside "hostScopeSameBooking"/"hostScopeSameBookingOwner"
-- rather than an enum or a bitmask, because 20260803020000 settled the shape:
-- the scopes are INDEPENDENT CHECKBOXES combined with OR, any combination is
-- legal, and adding one is therefore another additive column rather than an
-- enum change.
--
-- NULL IS OFF ON A DECIDED ROW. That is the whole default-OFF promise of #3037:
-- an existing club that upgrades keeps NULL here whatever its pair says, so its
-- adult-cover answers are byte-identical to the ones it gave before. A club opts
-- in by ticking the box, which writes an explicit `true`.
--
-- "AdultMemberHostingPolicy" holds one club-wide row plus at most one row per
-- lodge — single-digit rows, read on booking gates and admin page render, never
-- written on a hot path — so the brief ACCESS EXCLUSIVE lock this ADD COLUMN
-- takes is momentary. The table is absent from HOT_TABLE_SQL_REGEX.
ALTER TABLE "AdultMemberHostingPolicy"
    ADD COLUMN "hostScopeSameGroupTrip" BOOLEAN;

-- ---------------------------------------------------------------------------
-- 2. Set only where the row decided — and NOT a three-way all-or-none.
-- ---------------------------------------------------------------------------
--
-- 20260803020000 holds "hostScopeSameBooking" and "hostScopeSameBookingOwner"
-- to all-NULL or all-set, because NULL is the "this row did not decide, inherit"
-- signal and a half-configured set has no defensible reading. The obvious move
-- here would be to widen that constraint to three columns and backfill `false`
-- onto every decided row.
--
-- THAT WOULD BREAK BLUE/GREEN, which is why it is not done. Between `migrate`
-- and cutover the previous colour is still serving, and its policy INSERT names
-- only the columns it knows: an admin creating a lodge override on the draining
-- colour would write a row with the pair set and this column NULL, and a
-- three-way all-or-none CHECK would refuse it with a constraint violation. A
-- backfill cannot help — it fixes the rows that exist, not the ones the old
-- colour is still writing.
--
-- So the pair keeps its own constraint untouched and this column carries a
-- weaker, honest one: it may be NULL on any row, and it may be non-NULL only on
-- a row that decided the pair. That refuses the one genuinely meaningless shape
-- — "this row inherits the club's scope set, except for Group Trip, which it
-- decides itself".
--
-- WHAT IT DOES NOT DO IS LEAVE EVERY OLD-COLOUR WRITE LEGAL, and the honest
-- statement of the residue is this. INSERT is safe: the old colour never names
-- this column, so it writes NULL and passes. ONE OLD-COLOUR UPDATE CAN FAIL —
-- the new colour saves a decided scope set (writing this column non-NULL on
-- every decided row it touches), an old-colour tab then switches that same row
-- to "inherit" by setting only the pair to NULL, and the row is left with a
-- non-NULL Group Trip flag under a NULL pair: constraint violation 23514.
--
-- That is accepted rather than hidden, for two reasons. It FAILS CLOSED — the
-- admin sees a save error on one row during the cutover window and retries,
-- rather than a policy silently half-written — and NO CHECK OF THIS SHAPE CAN
-- AVOID IT: any constraint that ties this column to the pair is violated the
-- moment a writer that cannot see the column nulls the pair beneath it, and the
-- only UPDATE-safe alternative is no constraint at all, which readmits the
-- meaningless shape above. Widening 20260803020000 to three columns would be
-- strictly worse: it breaks old-colour INSERT as well.
--
-- Every existing row has all three NULL, so this validates against the current
-- contents without a single violation.
ALTER TABLE "AdultMemberHostingPolicy"
    ADD CONSTRAINT "AdultMemberHostingPolicy_group_trip_scope_needs_set"
    CHECK (
        "hostScopeSameGroupTrip" IS NULL
        OR "hostScopeSameBooking" IS NOT NULL
    );

-- ---------------------------------------------------------------------------
-- 3. The revision trigger learns about the new dimension.
-- ---------------------------------------------------------------------------
--
-- CREATE OR REPLACE FUNCTION, so the trigger definition itself is untouched, and
-- for exactly the reason 20260803020000 replaced it: a body that does not
-- compare this column would classify a Group-Trip-only edit as a NON-MATERIAL
-- write, silently reset NEW."version" to OLD."version", discard the API's
-- `version + 1`, and leave two admins editing the scope set each believing they
-- had won the compare-and-swap.
--
-- The rest of the contract is unchanged: inserts must start at 1, a material
-- update must present OLD + 1, and a genuinely non-material write keeps the old
-- token so a no-op cannot invalidate somebody else's open editor.
--
-- Old-colour safety: a draining old colour's UPDATE does not name the new
-- column, so NEW and OLD agree on it and its writes are classified exactly as
-- they were before this migration.
--
-- REVERSING THIS MIGRATION IS NOT "DROP THE COLUMN", and getting that wrong
-- breaks EVERY policy update rather than only the new feature. plpgsql resolves
-- NEW."hostScopeSameGroupTrip" at RUNTIME, not at CREATE FUNCTION time, so a
-- bare `ALTER TABLE ... DROP COLUMN "hostScopeSameGroupTrip"` leaves this
-- function in place naming a field that no longer exists and every subsequent
-- UPDATE on "AdultMemberHostingPolicy" raises `record "new" has no field
-- "hostScopeSameGroupTrip"`. A reverse must CREATE OR REPLACE this function back
-- to the 20260803020000 two-column body FIRST, in the same transaction as the
-- DROP CONSTRAINT and DROP COLUMN.
CREATE OR REPLACE FUNCTION "version_adult_member_hosting_policy"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."version" <> 1 THEN
            RAISE EXCEPTION 'AdultMemberHostingPolicy inserts must start at version 1'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF ROW(
        NEW."mode",
        NEW."capacityMode",
        NEW."lodgeId",
        NEW."scopeKey",
        NEW."hostScopeSameBooking",
        NEW."hostScopeSameBookingOwner",
        NEW."hostScopeSameGroupTrip"
    ) IS NOT DISTINCT FROM ROW(
        OLD."mode",
        OLD."capacityMode",
        OLD."lodgeId",
        OLD."scopeKey",
        OLD."hostScopeSameBooking",
        OLD."hostScopeSameBookingOwner",
        OLD."hostScopeSameGroupTrip"
    ) THEN
        NEW."version" := OLD."version";
    ELSIF NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'AdultMemberHostingPolicy version must advance exactly once'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;
