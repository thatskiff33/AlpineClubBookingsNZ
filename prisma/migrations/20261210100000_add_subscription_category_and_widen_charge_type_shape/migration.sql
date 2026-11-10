BEGIN;

-- Subscription-category decoupling, step 1 of 2 (shape only). Introduces the
-- new SubscriptionCategory billing axis, independent of MembershipType, and
-- widens MembershipSubscriptionCharge's type-axis columns to nullable so a
-- charge can bill on either axis. This half changes SHAPE ONLY and closes
-- nothing: every existing charge keeps membershipTypeId/Key/Name populated,
-- and nothing here stops a NEW writer from inserting a category-only row
-- with those three NULL the moment this migration lands. The CHECK that
-- makes "exactly one axis" true is added by the second half,
-- 20261128020000, once every writer that could violate it is reviewed
-- together with that CHECK in place. They are never applied apart.
--
-- WINDOWED BY PAIRING, like this repo's own precedent for widening a
-- long-required classification column for a second mutually-exclusive axis
-- (Booking.memberId / organisationId, 20260928020000 + 20260928030000,
-- INV-SSOT-005). On its own this half is close to old-code compatible — it
-- only ADD COLUMNs and three DROP NOT NULLs that no existing row trips — but
-- declaring it `yes` would invite applying it without 20261128020000 in the
-- same window, and between the two the currently-deployed app (which still
-- reads membershipTypeId/Key/Name as always-present, e.g. the family-charge
-- dedup key built as a raw template literal before this change) could read a
-- category-only row with those three NULL and silently misbehave rather than
-- fail loudly: a null interpolated into a template literal stringifies to
-- the literal text "null", which is not a crash, it is a *correctness* bug
-- in money-adjacent dedup logic. Required deploy acknowledgements:
-- ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1, a non-empty
-- BLUE_GREEN_MIGRATION_OVERRIDE_REASON naming this window, and
-- BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1 set only once the old app and
-- every worker/scheduler/queue consumer are stopped and verified via
-- pg_stat_activity. Take and verify a fresh backup immediately before
-- running. For this club's own single-instance production deployment there
-- is no separate old/new colour to drain — stop the one `app` container,
-- run both migrations, start it again; see
-- docs/guides/subscription-category-redesign-production-reconciliation.md.
--
-- LOCK IMPACT: CREATE TABLE and its indexes lock only the three new,
-- previously-nonexistent tables. The ALTER TABLE ... ADD COLUMN statements on
-- SeasonalMembershipAssignment, MembershipSubscriptionCharge and
-- MembershipBillingException are catalog-only on PostgreSQL (no default, no
-- table rewrite), each taking a brief ACCESS EXCLUSIVE on its table. The three
-- ALTER COLUMN ... DROP NOT NULL statements on MembershipSubscriptionCharge
-- are likewise catalog-only — dropping a constraint never scans or rewrites.
-- No index is built in this half (the category-axis partial unique index is
-- created in the second half, once the CHECK that makes it meaningful also
-- lands). No advisory-lock key, acquisition order, provider call or status
-- transition changes.
--
-- SubscriptionCategoryFee deliberately has NO membershipTypeId and NO
-- ageTier column (a category fee is one flat number, independent of which
-- MembershipType(s) the covered members hold or their ages), so unlike
-- MembershipAnnualFee/JoiningFee it needs no partial unique index and no
-- GiST no-overlap EXCLUDE constraint — a plain composite unique on
-- (subscriptionCategoryId, effectiveFrom) is sufficient.
--
-- MembershipSubscriptionChargeCoverage is UNCHANGED by this redesign — the
-- original design's per-covered-member membershipTypeId/Name audit columns
-- were write-only (nothing on current main or in this branch ever read them
-- back; the same fact is already available live from the billing preview's
-- computed data) and are dropped from the design rather than added.
--
-- IDEMPOTENCY: not idempotent; Prisma's migration ledger prevents replay.
-- REVERSE: rollback.sql beside this file. NO SESSION-CLOCK value appears in
-- any payload; the seed row's createdAt/updatedAt use an explicit
-- timezone('UTC', statement_timestamp()), never bare now()/CURRENT_TIMESTAMP.

-- ---------------------------------------------------------------------------
-- 1. SubscriptionCategory table
-- ---------------------------------------------------------------------------
CREATE TABLE "SubscriptionCategory" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubscriptionCategory_key_key" ON "SubscriptionCategory"("key");
CREATE INDEX "SubscriptionCategory_isActive_sortOrder_idx" ON "SubscriptionCategory"("isActive", "sortOrder");

-- Built-in "Individual" sentinel row (mirrors MembershipType's isBuiltIn
-- convention): a routing marker the admin UI shows as the explicit
-- "Individual" option, never looked up by id at billing time since
-- SeasonalMembershipAssignment.subscriptionCategoryId is NULL for an
-- Individual member (the common case, unaffected by this feature).
INSERT INTO "SubscriptionCategory" ("id", "key", "name", "isActive", "isBuiltIn", "sortOrder", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'individual', 'Individual', true, true, 0, timezone('UTC', statement_timestamp()), timezone('UTC', statement_timestamp()));

-- ---------------------------------------------------------------------------
-- 2. SubscriptionCategoryFee table
-- ---------------------------------------------------------------------------
CREATE TABLE "SubscriptionCategoryFee" (
    "id" TEXT NOT NULL,
    "subscriptionCategoryId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "prorationRule" "MembershipFeeProrationRule" NOT NULL DEFAULT 'NONE',
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionCategoryFee_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SubscriptionCategoryFee_amount_nonnegative" CHECK ("amountCents" >= 0),
    CONSTRAINT "SubscriptionCategoryFee_date_order" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
);

CREATE UNIQUE INDEX "SubscriptionCategoryFee_subscriptionCategoryId_effectiveFro_key"
  ON "SubscriptionCategoryFee"("subscriptionCategoryId", "effectiveFrom");
CREATE INDEX "SubscriptionCategoryFee_effective_lookup_idx"
  ON "SubscriptionCategoryFee"("subscriptionCategoryId", "effectiveFrom", "effectiveTo");

ALTER TABLE "SubscriptionCategoryFee"
  ADD CONSTRAINT "SubscriptionCategoryFee_subscriptionCategoryId_fkey"
  FOREIGN KEY ("subscriptionCategoryId") REFERENCES "SubscriptionCategory"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. SubscriptionCategoryFeeComponent table
-- ---------------------------------------------------------------------------
CREATE TABLE "SubscriptionCategoryFeeComponent" (
    "id" TEXT NOT NULL,
    "subscriptionCategoryFeeId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "prorate" BOOLEAN NOT NULL DEFAULT true,
    "xeroAccountCode" TEXT,
    "xeroItemCode" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionCategoryFeeComponent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SubscriptionCategoryFeeComponent_subscriptionCategoryFeeId__idx"
  ON "SubscriptionCategoryFeeComponent"("subscriptionCategoryFeeId", "sortOrder");

ALTER TABLE "SubscriptionCategoryFeeComponent"
  ADD CONSTRAINT "SubscriptionCategoryFeeComponent_subscriptionCategoryFeeId_fkey"
  FOREIGN KEY ("subscriptionCategoryFeeId") REFERENCES "SubscriptionCategoryFee"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. SeasonalMembershipAssignment.subscriptionCategoryId (nullable, additive)
-- ---------------------------------------------------------------------------
ALTER TABLE "SeasonalMembershipAssignment" ADD COLUMN "subscriptionCategoryId" TEXT;

CREATE INDEX "SeasonalMembershipAssignment_subscriptionCategoryId_idx"
  ON "SeasonalMembershipAssignment"("subscriptionCategoryId");
CREATE INDEX "SeasonalMembershipAssignment_seasonYear_subscriptionCategor_idx"
  ON "SeasonalMembershipAssignment"("seasonYear", "subscriptionCategoryId");

ALTER TABLE "SeasonalMembershipAssignment"
  ADD CONSTRAINT "SeasonalMembershipAssignment_subscriptionCategoryId_fkey"
  FOREIGN KEY ("subscriptionCategoryId") REFERENCES "SubscriptionCategory"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. MembershipSubscriptionCharge: widen the type trio, add the category
--    quartet. NO CHECK yet — see the second half.
-- ---------------------------------------------------------------------------
ALTER TABLE "MembershipSubscriptionCharge" ALTER COLUMN "membershipTypeId" DROP NOT NULL;
ALTER TABLE "MembershipSubscriptionCharge" ALTER COLUMN "membershipTypeKey" DROP NOT NULL;
ALTER TABLE "MembershipSubscriptionCharge" ALTER COLUMN "membershipTypeName" DROP NOT NULL;

ALTER TABLE "MembershipSubscriptionCharge" ADD COLUMN "subscriptionCategoryId" TEXT;
ALTER TABLE "MembershipSubscriptionCharge" ADD COLUMN "subscriptionCategoryKey" TEXT;
ALTER TABLE "MembershipSubscriptionCharge" ADD COLUMN "subscriptionCategoryName" TEXT;
ALTER TABLE "MembershipSubscriptionCharge" ADD COLUMN "subscriptionCategoryFeeId" TEXT;

CREATE INDEX "MembershipSubscriptionCharge_subscriptionCategoryId_seasonY_idx"
  ON "MembershipSubscriptionCharge"("subscriptionCategoryId", "seasonYear");

-- ---------------------------------------------------------------------------
-- 6. MembershipBillingException: category-axis exception context (pure
--    additive nullable column — not part of the windowed surface, safe to
--    land in this half: MembershipBillingException.membershipTypeId was
--    already nullable before this feature, so nothing reads this model's
--    type column as required).
-- ---------------------------------------------------------------------------
ALTER TABLE "MembershipBillingException" ADD COLUMN "subscriptionCategoryId" TEXT;

CREATE INDEX "MembershipBillingException_subscriptionCategoryId_status_idx"
  ON "MembershipBillingException"("subscriptionCategoryId", "status");

COMMIT;
