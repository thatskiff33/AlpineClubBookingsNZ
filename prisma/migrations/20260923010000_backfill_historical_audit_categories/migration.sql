-- #2581 (third child): give the audit rows written BEFORE the category became
-- mandatory the category their writers carry today, for exactly the actions
-- whose meaning is proven — and leave every other null row null.
--
-- WHAT THE FIRST TWO CHILDREN DID AND DID NOT DO. Child 2 (#2676, #2732) made
-- `AuditLog.category` required at the type and refused at the write boundary,
-- so no NEW row has been born without one since that runtime deployed. It
-- changed no stored row. `category` is written onto the row and never
-- re-derived at read time, so every row written before that release still has
-- `category IS NULL`, and such a row is returned by NO AI Diagnostics
-- correlation entry (`"category" = ANY ($1)` is NULL for it) and is placed by
-- Admin > Audit Log's Category filter only through a legacy action-name guess.
-- Measured read-only on the reference deployment on 13 September 2026: 1,885 of
-- 6,559 rows, across 83 distinct exact action strings, 2026-04-06 .. 2026-08-17.
--
-- HOW EACH ACTION WAS MAPPED, and it is an EXACT map or nothing (#2581 owner
-- decision 4: "no fuzzy prefix/substr/file-name inference"). The single
-- source of truth is `HISTORICAL_NULL_CATEGORY_MAP_2581` in
-- `scripts/audit/audit-writer-census-manifest.ts`, one row per action with the
-- evidence that proves it — the CURRENT WRITER of the same exact action, read
-- by `scanAuditWriterCensus()`, for most; corroborated where the corrected
-- runtime has already written the same action WITH a category on the reference
-- deployment (28 of 83, and all 28 agree); repository history for the three
-- `COMMITTEE_MEMBER_*` actions nothing writes any more; and, for
-- `member.bulk-deactivate`/`-reactivate`, the category the same exact action
-- carried BEFORE #2755 — `account` — by owner decision (see below). The tally
-- by evidence kind is measured and pinned by the contract test, not restated
-- here. `src/lib/__tests__/historical-audit-category-backfill.test.ts` parses
-- the `VALUES` list below and fails if it and that map ever disagree in either
-- direction, or if any pair names a category outside the taxonomy. Nothing here
-- is `admin` or `system` as a fallback: every `admin` pair is `admin` because
-- its current OR successor writer says so — the removed `COMMITTEE_MEMBER_*`
-- writers carried no category at all, and `admin` rests on the
-- `COMMITTEE_ASSIGNMENT_*` writers that replaced them.
--
-- ONE LIST, NEVER A PREFIX. The `mapping` CTE holds every (action, category)
-- pair as a literal, once, and the UPDATE joins on `a."action" = m."action"`.
-- `LIKE 'XERO_%'` would sweep up any Xero action added after this file was
-- written — including one deliberately classified elsewhere — and could not be
-- reviewed against the census. A pair is present here because a person read
-- its writer.
--
-- WHY THIS IS ALLOWED TO REWRITE AN APPEND-ONLY TABLE. `AuditLog` is
-- append-only by convention and there is no undo, so the scope is the
-- narrowest that fixes the defect: ONE column, on rows matched by
-- `"category" IS NULL` and an exact action. `category` is the only column in
-- every SET clause in this file, so `severity`, `retentionClass`, `expiresAt`,
-- `createdAt`, `details`, `metadata`, `summary`, `entityType`, `entityId`,
-- `requestId`, `outcome`, `archivedAt`, `incidentPreserved`, `ipAddress`,
-- `userAgent` and every actor column (`memberId`, `actorMemberId`,
-- `subjectMemberId`, `targetId`) keep the bytes they were written with.
--
-- RETENTION DOES NOT MOVE. Whatever `retentionClass`/`expiresAt` a row was
-- written with, it keeps — and for every uncategorised writer the census
-- sampled that is NONE (the boundary derives retention only when a category,
-- severity or class is supplied), so those rows are kept indefinitely before
-- and after. That is a statement about the writers, not a measurement of the
-- stored rows: the 13 Sep preflight did not read the retention columns, and
-- `docs/UPGRADING.md` gives the operator a postflight query that does. This
-- migration deliberately does NOT derive `critical`/seven years from the new category:
-- `pruneExpiredAuditLogs`, `archiveEligibleAuditLogs` and
-- `anonymizeExpiredAuditRequestData` in `src/lib/audit-retention.ts` select on
-- the STORED `retentionClass`/`expiresAt`/`severity`/`createdAt`/`archivedAt`
-- and never read `category`, so a category rewrite cannot change when a row is
-- archived or purged — and stamping an expiry onto 1,885 historical rows is a
-- separate retention decision (#2581 body §3: "do not rewrite historical
-- retention fields as a side effect").
--
-- WHO CAN READ THEM AFTERWARDS — this IS a readership change, in two places:
--   * AI Diagnostics: every mapped row moves from readable by NOBODY to
--     readable by the correlation entry its category maps to
--     (`AUDIT_CATEGORY_CORRELATION_DOMAIN`), behind that entry's areas
--     (`AUDIT_CORRELATION_DOMAIN_AREAS` in `src/lib/audit-categories.ts`; the
--     table is in `docs/ai-diagnostics/tool-pack-support.md`). That is the same
--     gate each action's NEW rows already sit behind, applied to the older rows too — with ONE
--     deliberate exception: the 632 bulk deactivate/reactivate rows land on
--     `account` (support + membership), not on the `admin` their post-#2755
--     writer files (support alone), so the older bulk history is read by the
--     membership entry while the newer is read by the system entry — the
--     operator-side date split #2763 accepted. On the reference deployment
--     610 rows land on support alone (`security` 540, `admin` 70) and 1,275
--     behind support plus a domain area.
--   * Admin > Audit Log: unchanged in what anyone can SEE (it is a `support`
--     surface with no category gate), changed in where the Category filter
--     PLACES these rows — the stored category now wins over the legacy guess,
--     so e.g. `member.setup-invite-sent` answers to Security instead of
--     Account, and `XERO_INVOICE_GENERATED` to Xero instead of Payments and
--     Xero.
--   * The member's own activity timeline: see the second block.
--
-- TWO BLOCKS, BECAUSE INV-OPS-012 DRAWS A LINE THROUGH THE MAP — AND THE OWNER
-- HAS DECIDED EVERY CROSSING (#2581, 13 September 2026). A null row is on a
-- member's own timeline today only through the legacy action-name leg of
-- `buildMemberVisibleAuditLogWhere`; once categorised, visibility follows the
-- stored category. For 58 of the 83 actions nothing crosses that line in
-- either direction (block 1, `base`). For 25 it does (block 2,
-- `member_boundary_crossings`, 209 rows): three Xero rows leave the acting
-- officer's own timeline, and 206 booking-rule, fee-configuration,
-- subscription-billing and issue-report rows APPEAR on a timeline — 201 only
-- on the acting officer's own, 5 on another member's
-- (`fee-configuration.set_member_billing_family` x3, the billed member;
-- `issue.reported` x2, the reporter). Separately, and outside those 209, the
-- four corrected rows below also become visible: the two `EMAIL` rows to the
-- acting officer only, `nominator_replaced` to the replacement nominator, and
-- `nomination_workflow_refreshed` to the acting officer only. The owner
-- applied all of them: disclosure to the subject, and no withdrawal from any
-- member other than the acting officer. The bulk deactivate/reactivate pair (632 rows)
-- is NOT in block 2 because the owner rerouted it: its current writer files
-- `admin` (#2755), which would have withdrawn the deactivated member's sight of
-- their own deactivation — the withdrawal already refused for these actions'
-- stored `account`/`security` twins on #2763 (10 Aug 2026) — so these rows
-- take `account`, the category the same exact action carried before #2755,
-- and cross nothing. Block 2 is kept as a documented structure: the contract
-- test derives each action's crossing from the real filters and holds the
-- arms and `HISTORICAL_NULL_CATEGORY_MAP_2581` equal.
--
-- THE FOUR-ROW EXCEPTION TO DECISION 6 (owner decision on #2581, 13 September
-- 2026). Four rows carry a category string OUTSIDE the taxonomy, written before
-- child 1 closed the type: two `EMAIL` on `EMAIL_SUPPRESSION_CLEARED` and two
-- `membership` on `membership_application.nominator_replaced` /
-- `membership_application.nomination_workflow_refreshed`. They are not null,
-- so decision 6 ("existing explicit non-null categories are never rewritten")
-- would leave them — invisible to every reader, because no reader asks for
-- `EMAIL` or `membership`. The owner decided they are corrected here, named by
-- prior string AND exact action, and counted separately; decision 6 otherwise
-- stands, and the fixture proves no OTHER non-null row moves.
--
-- ROWS THIS DOES NOT TOUCH, deliberately: any null row whose action is not in
-- the list (none were measured on the reference deployment, but a fork may
-- hold one) keeps its legacy action-name fallback in Admin > Audit Log and
-- stays outside Diagnostics — which the guide discloses. Any row already
-- carrying a canonical category is untouched even when its action is in the
-- list — including every bulk deactivate/reactivate row the post-#2755 runtime
-- wrote as `admin`, which the fixture seeds and proves.
--
-- IDEMPOTENT. Each predicate is the state its statement destroys: after one
-- run no row matches `"category" IS NULL AND "action" = <mapped>`, and none
-- carries `EMAIL` or `membership`, so a second run updates zero rows — and the
-- record below is gated on rows having moved, so it appends nothing either.
-- `idempotentReRun: true` in the fixture makes the real-PostgreSQL suite prove
-- that.
--
-- BOUNDED. The join is 83 constants against `AuditLog_action_idx`
-- (`@@index([action])`); the planner probes the index per mapped action, or on
-- a small table hashes the 83 values against one scan, and row-locks only the
-- rows it rewrites. The exception UPDATEs are single-action equality lookups
-- on the same index. The measured population is 1,885 rows, so there is no
-- batching and none is wanted: one statement is what makes a partial rewrite
-- impossible. No DDL, so no table-level lock. The one contention this can meet
-- is the nightly retention job on the still-serving old colour holding a row
-- lock this statement wants; that failure is SAFE rather than silent —
-- PostgreSQL aborts one transaction, `prisma migrate deploy` fails, the deploy
-- stops BEFORE cutover with nothing half-applied. Re-run the deploy.
--
-- OPERATOR NOTE — RE-RUN THIS FILE AFTER CUTOVER, and the runbook asks for it:
-- `docs/PRODUCTION_UPGRADE_RUNBOOK.md` §3.2. On a deployment that has NOT yet
-- run the mandatory-category runtime, `prisma migrate deploy` runs before
-- cutover while the old colour is still filing rows with no category; those
-- rows keep NULL until this file runs again. On the reference deployment the
-- runtime cut over on 17 August 2026 and zero null rows have been written since,
-- so the re-run finds nothing — both outcomes are correct. There is no
-- `rollback.sql` (this migration is not `windowed`); a committed data rewrite
-- survives a rollback of the code, and the club's own record of it is the
-- `AUDIT_CATEGORY_BACKFILLED` row below.

WITH mapping ("action", "category") AS (
  -- BLOCK 1 — `base`: the 58 actions that cross no member-visibility line.
  -- Ordered by category, then action, to read against the manifest.
  SELECT * FROM (VALUES
    ('MEMBERSHIP_APPLICATION_APPROVED', 'account'),
    ('MEMBERSHIP_APPLICATION_CREATED', 'account'),
    ('MEMBERSHIP_APPLICATION_NOMINATION_CONFIRMED', 'account'),
    -- `account`, NOT the `admin` the post-#2755 writer files: owner decision
    -- on #2581, 13 Sep 2026, following #2763 (see header).
    ('member.bulk-deactivate', 'account'),
    ('member.bulk-reactivate', 'account'),
    ('ADMIN_NOTIFICATION_PREFERENCES_UPDATED', 'admin'),
    ('COMMITTEE_MEMBER_CREATED', 'admin'),
    ('COMMITTEE_MEMBER_DELETED', 'admin'),
    ('COMMITTEE_MEMBER_UPDATED', 'admin'),
    ('booking.cancel', 'booking'),
    ('booking.created_on_behalf', 'booking'),
    ('booking.modify.batch', 'booking'),
    ('booking.modify.guests.add', 'booking'),
    ('booking.modify.guests.remove', 'booking'),
    ('EMAIL_SUPPRESSION_CLEARED', 'communication'),
    ('FAMILY_GROUP_CHILD_REQUEST', 'family'),
    ('FAMILY_GROUP_CHILD_REQUEST_REJECTED', 'family'),
    ('FAMILY_GROUP_CREATED', 'family'),
    ('FAMILY_GROUP_CREATED_FROM_SUGGESTION', 'family'),
    ('FAMILY_GROUP_DELETED', 'family'),
    ('FAMILY_GROUP_JOIN_APPROVED', 'family'),
    ('FAMILY_GROUP_JOIN_REQUESTED', 'family'),
    ('FAMILY_GROUP_UPDATED', 'family'),
    ('FAMILY_MEMBER_DETAILS_DELEGATED_CONFIRMED', 'family'),
    ('family-group.login-holder-swapped', 'family'),
    ('member.dependent.link', 'family'),
    ('member.dependent.unlink', 'family'),
    ('DISPLAY_DEVICE_TEMPLATE_ASSIGNED', 'lodge'),
    ('DISPLAY_LAYOUT_CREATED', 'lodge'),
    ('DISPLAY_LAYOUT_UPDATED', 'lodge'),
    ('DISPLAY_TEMPLATE_CREATED', 'lodge'),
    ('DISPLAY_TEMPLATE_UPDATED', 'lodge'),
    ('LODGE_ACCOUNT_UPDATED', 'lodge'),
    ('booking.modification.payment.failed', 'payment'),
    ('booking.payment.confirmed', 'payment'),
    ('booking.payment.failed', 'payment'),
    ('refund-request.approve', 'payment'),
    ('refund-request.create', 'payment'),
    ('member.deletion_rejected', 'privacy'),
    ('member.deletion_requested', 'privacy'),
    ('member.password-reset-sent', 'security'),
    ('member.setup-invite-sent', 'security'),
    ('XERO_FORCE_SYNC_CONTACT', 'xero'),
    ('XERO_GROUPING_BULK_RESYNC', 'xero'),
    ('XERO_GROUPING_RULE_CREATED', 'xero'),
    ('XERO_GROUPING_RULE_DELETED', 'xero'),
    ('XERO_GROUPING_RULE_TOGGLED', 'xero'),
    ('XERO_IMPORT_MEMBER_CONTACT', 'xero'),
    ('XERO_INBOUND_EVENT_REPLAY', 'xero'),
    ('XERO_LINK', 'xero'),
    ('XERO_LINK_LEDGER_MAINTENANCE', 'xero'),
    ('XERO_OPERATIONS_RESET_STALE_RUNNING', 'xero'),
    ('XERO_OPERATION_RETRY', 'xero'),
    ('XERO_OPERATION_RETRY_ALL', 'xero'),
    ('XERO_PUSH', 'xero'),
    ('XERO_UNLINK', 'xero'),
    ('xero_account_mappings_updated', 'xero'),
    ('xero_item_code_mappings_updated', 'xero')
  ) AS base ("action", "category")
  UNION ALL
  -- BLOCK 2 — `member_boundary_crossings`: the 25 actions whose categorisation
  -- moves rows across the member self-timeline boundary (INV-OPS-012 reserves
  -- this to the owner). EVERY GROUP HERE IS OWNER-DECIDED AND APPLIED (#2581,
  -- 13 Sep 2026); the arm is kept separate so the crossing population stays
  -- legible, not because anything is pending.
  SELECT * FROM (VALUES
    -- B2: LOSES — the acting officer's own timeline only (3 rows)
    ('XERO_INVOICE_GENERATED', 'xero'),
    ('XERO_TRIGGER_MISSING_INVOICES', 'xero'),
    -- B3: GAINS — the acting officer's own timeline only (147 rows)
    ('AGE_TIER_SETTINGS_UPDATED', 'booking'),
    ('booking-period.update', 'booking'),
    ('cancellation-policy.update', 'booking'),
    ('group-discount.update', 'booking'),
    ('minimum-stay-policy.create', 'booking'),
    ('minimum-stay-policy.update', 'booking'),
    ('promo.archive', 'booking'),
    ('promo.create', 'booking'),
    ('promo.delete', 'booking'),
    ('promo.update', 'booking'),
    ('season.update', 'booking'),
    -- B4: GAINS — the acting officer, plus the billed member for set_member_billing_family (57 rows)
    ('fee-configuration.create_joining_fee', 'payment'),
    ('fee-configuration.create_membership_fee', 'payment'),
    ('fee-configuration.delete_joining_fee', 'payment'),
    ('fee-configuration.delete_membership_fee', 'payment'),
    ('fee-configuration.set_family_billing_member', 'payment'),
    ('fee-configuration.set_member_billing_family', 'payment'),
    ('fee-configuration.update_joining_fee', 'payment'),
    ('fee-configuration.update_membership_fee', 'payment'),
    ('membership-subscription-billing.confirm', 'payment'),
    ('membership-subscription-billing.reconcile', 'payment'),
    ('membership-subscription-billing.settings.update', 'payment'),
    -- B5: GAINS — the reporting member (2 rows)
    ('issue.reported', 'privacy')
  ) AS member_boundary_crossings ("action", "category")
),
before_counts AS (
  -- The BEFORE half of the count the issue's §4 asks for, read in the same
  -- statement as the rewrite. All sub-statements of a `WITH` share one snapshot
  -- and cannot see each other's effects, so this counts the table as it stood
  -- before the UPDATEs even though it is written beside them. Table-wide,
  -- because "how many rows still have no category" is the figure the
  -- postflight compares against.
  SELECT
    count(*) FILTER (WHERE "category" IS NULL)::int AS "nullBefore",
    count(*) FILTER (
      WHERE "category" IS NULL AND "action" IN (SELECT "action" FROM mapping)
    )::int AS "mappedNullBefore",
    count(*) FILTER (WHERE "category" = 'EMAIL')::int AS "emailBefore",
    count(*) FILTER (WHERE "category" = 'membership')::int AS "membershipBefore"
  FROM "AuditLog"
),
rewritten AS (
  -- The rewrite itself. `category` is the only column named; every other field
  -- keeps the bytes it was written with. NULL-only: a row already carrying a
  -- category is never touched, whatever its action.
  UPDATE "AuditLog" a
  SET "category" = m."category"
  FROM mapping m
  WHERE a."category" IS NULL
    AND a."action" = m."action"
  RETURNING a."id", a."action", m."category"
),
corrected_email AS (
  -- Exception to decision 6, rows 1-2: prior string `EMAIL`, exact action.
  UPDATE "AuditLog"
  SET "category" = 'communication'
  WHERE "category" = 'EMAIL'
    AND "action" = 'EMAIL_SUPPRESSION_CLEARED'
  RETURNING "id", "action"
),
corrected_membership AS (
  -- Exception to decision 6, rows 3-4: prior string `membership`, exact actions.
  UPDATE "AuditLog"
  SET "category" = 'account'
  WHERE "category" = 'membership'
    AND "action" IN (
      'membership_application.nominator_replaced',
      'membership_application.nomination_workflow_refreshed'
    )
  RETURNING "id", "action"
)
-- The club's own durable record of the rewrite, and the AFTER half of the
-- count. An audit row rather than a `RAISE NOTICE` because `prisma migrate
-- deploy` does not surface PostgreSQL notices. Readable in Admin > Audit Log
-- for seven years, and `admin` — the support-only category — on purpose, so the
-- operator whose Diagnostics results just changed can see in the system entry
-- why.
INSERT INTO "AuditLog" (
  "id",
  "action",
  "entityType",
  "category",
  "severity",
  "outcome",
  "summary",
  "metadata",
  "retentionClass",
  "expiresAt",
  "createdAt"
)
SELECT
  gen_random_uuid()::text,
  'AUDIT_CATEGORY_BACKFILLED',
  -- The affected population is a SET of audit rows, not one record, so there is
  -- no honest `entityId` to give (the same reason recorded in
  -- `AUDIT_WRITERS_WITHOUT_ENTITY_IDENTIFIER` for the collection writers).
  'AuditLog',
  'admin',
  'important',
  'success',
  'Upgrade gave historical activity records with no category the category their event type records today, from an exact reviewed list, and corrected four records whose category was not a recognised value',
  jsonb_build_object(
    -- MEASURED is what PostgreSQL counted; DERIVED is arithmetic. A re-read of
    -- the table in this statement would return the BEFORE snapshot again, so
    -- the after figures are computed rather than pretended to be readings. The
    -- fixture compares them against an independently measured post-state.
    'measured', jsonb_build_object(
      'nullBefore', before_counts."nullBefore",
      'mappedNullBefore', before_counts."mappedNullBefore",
      'rewritten', (SELECT count(*)::int FROM rewritten),
      'rewrittenByCategory', (
        SELECT coalesce(jsonb_object_agg(c."category", c."n"), '{}'::jsonb)
        FROM (
          SELECT "category", count(*)::int AS "n" FROM rewritten GROUP BY "category"
        ) c
      ),
      'rewrittenByAction', (
        SELECT coalesce(jsonb_object_agg(a."action", a."n"), '{}'::jsonb)
        FROM (
          SELECT "action", count(*)::int AS "n" FROM rewritten GROUP BY "action"
        ) a
      ),
      'correctedNonCanonical', jsonb_build_object(
        'EMAIL', (SELECT count(*)::int FROM corrected_email),
        'membership', (SELECT count(*)::int FROM corrected_membership)
      )
    ),
    'derived', jsonb_build_object(
      'nullAfter', before_counts."nullBefore" - (SELECT count(*)::int FROM rewritten),
      -- Null rows whose action is on no list: what remains uncategorised.
      'unmappedNullRemaining', before_counts."nullBefore" - before_counts."mappedNullBefore",
      'emailAfter', before_counts."emailBefore" - (SELECT count(*)::int FROM corrected_email),
      'membershipAfter', before_counts."membershipBefore" - (SELECT count(*)::int FROM corrected_membership)
    ),
    'source', 'migration:20260923010000_backfill_historical_audit_categories',
    'issue', 2581
  ),
  -- Stated rather than derived, because raw SQL does not go through
  -- `buildAuditLogCreateData`: `classifyAuditRetention` returns `critical` for
  -- this action under `admin`, and `getAuditRetentionExpiresAt` puts `critical`
  -- seven years out.
  'critical',
  timezone('UTC', statement_timestamp()) + interval '7 years',
  timezone('UTC', statement_timestamp())
FROM before_counts
-- Nothing to record when nothing moved, which is what makes the whole migration
-- idempotent: a replay rewrites no row and appends no row.
WHERE (SELECT count(*) FROM rewritten)
    + (SELECT count(*) FROM corrected_email)
    + (SELECT count(*) FROM corrected_membership) > 0;
