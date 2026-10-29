-- CreateEnum
CREATE TYPE "MemberMoneyAccount" AS ENUM ('MEMBER_RECEIVABLE', 'STRIPE_CLEARING', 'BANK', 'CASH', 'MEMBER_CREDIT', 'REFUND_PAYABLE', 'BOOKING_REVENUE', 'SUBSCRIPTION_REVENUE', 'JOINING_FEE_REVENUE', 'FEE_REVENUE', 'GST_PAYABLE', 'STRIPE_FEES', 'GOODWILL', 'EXTERNAL_CONTROL', 'OPENING_CONTROL');

-- CreateEnum
CREATE TYPE "MemberMoneySide" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "MemberMoneyEventKind" AS ENUM ('CHARGE', 'RECEIPT', 'REFUND_OBLIGATION', 'REFUND', 'CREDIT_GRANT', 'CREDIT_APPLICATION', 'CREDIT_RESTORE', 'FEE', 'TRANSFER', 'ADJUSTMENT', 'OPENING', 'REVERSAL', 'ZERO');

-- CreateEnum
CREATE TYPE "MemberMoneyOrigin" AS ENUM ('APP', 'OFFICER', 'STRIPE', 'XERO', 'LEGACY');

-- CreateEnum
CREATE TYPE "MemberMoneySourceKind" AS ENUM ('BOOKING_LEDGER', 'BOOKING', 'PAYMENT', 'REFUND', 'CREDIT', 'SUBSCRIPTION', 'PROVIDER_FACT', 'OFFICER_FACT', 'OPENING');

-- CreateEnum
CREATE TYPE "MemberMoneyObligationKind" AS ENUM ('CHARGE', 'REFUND');

-- CreateEnum
CREATE TYPE "MemberMoneyDebtorKind" AS ENUM ('MEMBER', 'ORGANISATION');

-- The cluster a header was created on, beside its transaction id: a restore into
-- a new cluster restarts transaction ids, so an id alone could match again.
CREATE FUNCTION member_money_system_identifier() RETURNS bigint
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
SELECT system_identifier FROM pg_catalog.pg_control_system()
$$;

-- CreateTable
CREATE TABLE "MemberMoneyEvent" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "kind" "MemberMoneyEventKind" NOT NULL,
    "origin" "MemberMoneyOrigin" NOT NULL,
    "sourceKind" "MemberMoneySourceKind" NOT NULL,
    "sourceIdentity" TEXT NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "actorMemberId" TEXT,
    "reason" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberMoneyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberMoneyJournal" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "codingVersion" TEXT NOT NULL,
    "expectedLineCount" INTEGER NOT NULL,
    "expectedObligationCount" INTEGER NOT NULL,
    "expectedApplicationCount" INTEGER NOT NULL,
    "creatingTransaction" BIGINT NOT NULL DEFAULT txid_current(),
    "creatingSystemIdentifier" BIGINT NOT NULL DEFAULT member_money_system_identifier(),
    "reversesJournalId" TEXT,

    CONSTRAINT "MemberMoneyJournal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberMoneySourceLink" (
    "id" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "sourceKind" "MemberMoneySourceKind" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "bookingLedgerLineId" TEXT,

    CONSTRAINT "MemberMoneySourceLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberMoneyLine" (
    "id" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "sourceLinkId" TEXT NOT NULL,
    "account" "MemberMoneyAccount" NOT NULL,
    "side" "MemberMoneySide" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "debtorKind" "MemberMoneyDebtorKind",
    "memberId" TEXT,
    "organisationId" TEXT,
    "obligationId" TEXT,
    "bookingId" TEXT,
    "lodgeId" TEXT,
    "creditLotId" TEXT,
    "chargeIdentity" TEXT,
    "refundIdentity" TEXT,
    "originalLineId" TEXT,
    "grossCents" INTEGER,
    "netCents" INTEGER,
    "taxCents" INTEGER,
    "taxCode" TEXT,
    "evidence" JSONB NOT NULL,

    CONSTRAINT "MemberMoneyLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberMoneyObligation" (
    "id" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "obligationKey" TEXT NOT NULL,
    "kind" "MemberMoneyObligationKind" NOT NULL,
    "debtorKind" "MemberMoneyDebtorKind" NOT NULL,
    "memberId" TEXT,
    "organisationId" TEXT,
    "faceCents" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL,

    CONSTRAINT "MemberMoneyObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberMoneyApplication" (
    "id" TEXT NOT NULL,
    "applicationKey" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "sourceLineId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reversesApplicationId" TEXT,

    CONSTRAINT "MemberMoneyApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberMoneyEvent_eventKey_key" ON "MemberMoneyEvent"("eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "MemberMoneyJournal_eventId_key" ON "MemberMoneyJournal"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberMoneyJournal_reversesJournalId_key" ON "MemberMoneyJournal"("reversesJournalId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberMoneySourceLink_bookingLedgerLineId_key" ON "MemberMoneySourceLink"("bookingLedgerLineId");

-- CreateIndex
CREATE INDEX "MemberMoneySourceLink_journalId_idx" ON "MemberMoneySourceLink"("journalId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberMoneySourceLink_sourceKind_sourceId_sourceVersion_key" ON "MemberMoneySourceLink"("sourceKind", "sourceId", "sourceVersion");

-- CreateIndex
CREATE UNIQUE INDEX "MemberMoneySourceLink_id_journalId_key" ON "MemberMoneySourceLink"("id", "journalId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberMoneyLine_originalLineId_key" ON "MemberMoneyLine"("originalLineId");

-- CreateIndex
CREATE INDEX "MemberMoneyLine_journalId_idx" ON "MemberMoneyLine"("journalId");

-- CreateIndex
CREATE INDEX "MemberMoneyLine_memberId_account_idx" ON "MemberMoneyLine"("memberId", "account");

-- CreateIndex
CREATE INDEX "MemberMoneyLine_organisationId_account_idx" ON "MemberMoneyLine"("organisationId", "account");

-- CreateIndex
CREATE INDEX "MemberMoneyLine_bookingId_idx" ON "MemberMoneyLine"("bookingId");

-- CreateIndex
CREATE INDEX "MemberMoneyLine_lodgeId_idx" ON "MemberMoneyLine"("lodgeId");

-- CreateIndex
CREATE INDEX "MemberMoneyLine_obligationId_idx" ON "MemberMoneyLine"("obligationId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberMoneyObligation_obligationKey_key" ON "MemberMoneyObligation"("obligationKey");

-- CreateIndex
CREATE INDEX "MemberMoneyObligation_journalId_idx" ON "MemberMoneyObligation"("journalId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberMoneyApplication_applicationKey_key" ON "MemberMoneyApplication"("applicationKey");

-- CreateIndex
CREATE UNIQUE INDEX "MemberMoneyApplication_reversesApplicationId_key" ON "MemberMoneyApplication"("reversesApplicationId");

-- CreateIndex
CREATE INDEX "MemberMoneyApplication_journalId_idx" ON "MemberMoneyApplication"("journalId");

-- CreateIndex
CREATE INDEX "MemberMoneyApplication_sourceLineId_idx" ON "MemberMoneyApplication"("sourceLineId");

-- CreateIndex
CREATE INDEX "MemberMoneyApplication_obligationId_idx" ON "MemberMoneyApplication"("obligationId");

-- AddForeignKey
ALTER TABLE "MemberMoneyJournal" ADD CONSTRAINT "MemberMoneyJournal_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "MemberMoneyEvent"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberMoneyJournal" ADD CONSTRAINT "MemberMoneyJournal_reversesJournalId_fkey" FOREIGN KEY ("reversesJournalId") REFERENCES "MemberMoneyJournal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberMoneySourceLink" ADD CONSTRAINT "MemberMoneySourceLink_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "MemberMoneyJournal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberMoneySourceLink" ADD CONSTRAINT "MemberMoneySourceLink_bookingLedgerLineId_fkey" FOREIGN KEY ("bookingLedgerLineId") REFERENCES "BookingLedgerLine"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberMoneyLine" ADD CONSTRAINT "MemberMoneyLine_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "MemberMoneyJournal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberMoneyLine" ADD CONSTRAINT "MemberMoneyLine_sourceLinkId_journalId_fkey" FOREIGN KEY ("sourceLinkId", "journalId") REFERENCES "MemberMoneySourceLink"("id", "journalId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberMoneyLine" ADD CONSTRAINT "MemberMoneyLine_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "MemberMoneyObligation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberMoneyLine" ADD CONSTRAINT "MemberMoneyLine_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberMoneyLine" ADD CONSTRAINT "MemberMoneyLine_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberMoneyLine" ADD CONSTRAINT "MemberMoneyLine_originalLineId_fkey" FOREIGN KEY ("originalLineId") REFERENCES "MemberMoneyLine"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberMoneyObligation" ADD CONSTRAINT "MemberMoneyObligation_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "MemberMoneyJournal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberMoneyApplication" ADD CONSTRAINT "MemberMoneyApplication_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "MemberMoneyJournal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberMoneyApplication" ADD CONSTRAINT "MemberMoneyApplication_sourceLineId_fkey" FOREIGN KEY ("sourceLineId") REFERENCES "MemberMoneyLine"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberMoneyApplication" ADD CONSTRAINT "MemberMoneyApplication_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "MemberMoneyObligation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberMoneyApplication" ADD CONSTRAINT "MemberMoneyApplication_reversesApplicationId_fkey" FOREIGN KEY ("reversesApplicationId") REFERENCES "MemberMoneyApplication"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Exact bridge coverage can be attached later without rewriting any journal leg.
CREATE UNIQUE INDEX "MemberMoneyLine_id_journalId_key" ON "MemberMoneyLine"(id, "journalId");
CREATE TABLE "MemberMoneySourcePosting" (
  id TEXT NOT NULL PRIMARY KEY,
  "sourceLinkId" TEXT NOT NULL,
  "lineId" TEXT NOT NULL,
  "journalId" TEXT NOT NULL
);
CREATE UNIQUE INDEX "MemberMoneySourcePosting_sourceLinkId_lineId_key" ON "MemberMoneySourcePosting"("sourceLinkId", "lineId");
CREATE INDEX "MemberMoneySourcePosting_lineId_journalId_idx" ON "MemberMoneySourcePosting"("lineId", "journalId");
ALTER TABLE "MemberMoneySourcePosting" ADD CONSTRAINT "MemberMoneySourcePosting_sourceLinkId_journalId_fkey"
  FOREIGN KEY ("sourceLinkId", "journalId") REFERENCES "MemberMoneySourceLink"(id, "journalId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MemberMoneySourcePosting" ADD CONSTRAINT "MemberMoneySourcePosting_lineId_journalId_fkey"
  FOREIGN KEY ("lineId", "journalId") REFERENCES "MemberMoneyLine"(id, "journalId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Expand only: no legacy writer is made mandatory in M1. No existing rows change.
-- No SECURITY DEFINER, advisory lock, provider call or mutable journal balance.
ALTER TABLE "MemberMoneyEvent" ADD CONSTRAINT "member_money_event_evidence" CHECK (
  length(btrim("eventKey")) > 0 AND length(btrim("sourceIdentity")) > 0
  AND length(btrim("sourceVersion")) > 0 AND length(btrim(reason)) > 0
  AND "payloadHash" ~ '^[0-9a-f]{64}$'
);
ALTER TABLE "MemberMoneyJournal" ADD CONSTRAINT "member_money_header_shape" CHECK (
  currency ~ '^[A-Z]{3}$' AND "expectedLineCount" >= 0
  AND "expectedObligationCount" >= 0 AND "expectedApplicationCount" >= 0
  AND length(btrim("policyVersion")) > 0 AND length(btrim("codingVersion")) > 0
  AND id IS DISTINCT FROM "reversesJournalId"
);
ALTER TABLE "MemberMoneyLine" ADD CONSTRAINT "member_money_line_shape" CHECK (
  "amountCents" > 0
  AND (account NOT IN ('MEMBER_RECEIVABLE', 'MEMBER_CREDIT', 'REFUND_PAYABLE') OR "debtorKind" IS NOT NULL)
  AND (account <> 'MEMBER_CREDIT' OR "creditLotId" IS NOT NULL)
  AND (account <> 'MEMBER_CREDIT' OR "debtorKind" = 'MEMBER')
  AND (account <> 'REFUND_PAYABLE' OR "obligationId" IS NOT NULL)
  AND ("bookingId" IS NULL OR "lodgeId" IS NOT NULL)
  AND id IS DISTINCT FROM "originalLineId"
);
-- A debtor is a member or an organisation (Booking_owner_exactly_one), never both.
-- Both ids are retained identity strings, not foreign keys: a member merge leaves
-- posted rows untouched and moves balances by an explicit transfer.
ALTER TABLE "MemberMoneyLine" ADD CONSTRAINT "member_money_line_debtor" CHECK (
  CASE "debtorKind"
    WHEN 'MEMBER' THEN "memberId" IS NOT NULL AND length(btrim("memberId")) > 0 AND "organisationId" IS NULL
    WHEN 'ORGANISATION' THEN "organisationId" IS NOT NULL AND length(btrim("organisationId")) > 0 AND "memberId" IS NULL
    ELSE "memberId" IS NULL AND "organisationId" IS NULL
  END
);
ALTER TABLE "MemberMoneyLine" ADD CONSTRAINT "member_money_tax_split" CHECK (
  ("grossCents" IS NULL AND "netCents" IS NULL AND "taxCents" IS NULL AND "taxCode" IS NULL)
  OR ("grossCents" IS NOT NULL AND "netCents" IS NOT NULL AND "taxCents" IS NOT NULL
      AND "taxCode" IS NOT NULL AND length(btrim("taxCode")) > 0
      AND "grossCents" >= 0 AND "netCents" >= 0 AND "taxCents" >= 0
      AND "grossCents"::bigint = "netCents"::bigint + "taxCents"::bigint)
);
ALTER TABLE "MemberMoneyObligation" ADD CONSTRAINT "member_money_obligation_shape" CHECK (
  "faceCents" > 0 AND length(btrim("obligationKey")) > 0
);
ALTER TABLE "MemberMoneyObligation" ADD CONSTRAINT "member_money_obligation_debtor" CHECK (
  CASE "debtorKind"
    WHEN 'MEMBER' THEN "memberId" IS NOT NULL AND length(btrim("memberId")) > 0 AND "organisationId" IS NULL
    WHEN 'ORGANISATION' THEN "organisationId" IS NOT NULL AND length(btrim("organisationId")) > 0 AND "memberId" IS NULL
    ELSE false
  END
);
ALTER TABLE "MemberMoneyApplication" ADD CONSTRAINT "member_money_application_shape" CHECK (
  "amountCents" > 0 AND length(btrim("applicationKey")) > 0
  AND id IS DISTINCT FROM "reversesApplicationId"
);
ALTER TABLE "MemberMoneySourceLink" ADD CONSTRAINT "member_money_source_shape" CHECK (
  length(btrim("sourceId")) > 0 AND length(btrim("sourceVersion")) > 0
  AND (("sourceKind" = 'BOOKING_LEDGER' AND "bookingLedgerLineId" IS NOT NULL AND "sourceId" = "bookingLedgerLineId")
    OR ("sourceKind" <> 'BOOKING_LEDGER' AND "bookingLedgerLineId" IS NULL))
);

CREATE FUNCTION member_money_refuse_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'member_money_immutable: % on %', TG_OP, TG_TABLE_NAME USING ERRCODE = '23514';
END
$$;

-- INSERT-only alone is insufficient: a later balanced pair must not extend a batch.
CREATE FUNCTION member_money_check_seal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  creating_tx bigint;
  creating_system bigint;
BEGIN
  IF TG_TABLE_NAME = 'MemberMoneyJournal' THEN
    NEW."creatingTransaction" := txid_current();
    NEW."creatingSystemIdentifier" := public.member_money_system_identifier();
  ELSE
    SELECT "creatingTransaction", "creatingSystemIdentifier" INTO creating_tx, creating_system
      FROM public."MemberMoneyJournal" WHERE id = NEW."journalId";
    IF creating_tx IS DISTINCT FROM txid_current()
      OR creating_system IS DISTINCT FROM public.member_money_system_identifier() THEN
      RAISE EXCEPTION 'member_money_sealed: batch belongs to another transaction or cluster' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'MemberMoneyLine' THEN
    IF NEW."bookingId" IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public."Booking" b WHERE b.id = NEW."bookingId" AND b."lodgeId" = NEW."lodgeId") THEN
        RAISE EXCEPTION 'member_money_booking_lodge: incorrect booking dimension' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- The verifier and deferred triggers use this single database validation rule.
-- No function writes or acquires UPDATE locks on immutable rows.
CREATE FUNCTION member_money_batch_errors(batch_id text) RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  h public."MemberMoneyJournal"%ROWTYPE;
  e public."MemberMoneyEvent"%ROWTYPE;
  errors text[] := ARRAY[]::text[];
  line_count bigint;
  signed_total numeric;
BEGIN
  SELECT * INTO h FROM public."MemberMoneyJournal" WHERE id = batch_id;
  IF NOT FOUND THEN RETURN ARRAY['missing_header']; END IF;
  SELECT * INTO e FROM public."MemberMoneyEvent" WHERE id = h."eventId";
  IF NOT FOUND THEN RETURN ARRAY['missing_event']; END IF;
  SELECT count(*), coalesce(sum(CASE WHEN side = 'DEBIT' THEN "amountCents"::bigint ELSE -"amountCents"::bigint END), 0)
    INTO line_count, signed_total FROM public."MemberMoneyLine" WHERE "journalId" = h.id;
  IF line_count <> h."expectedLineCount" THEN errors := array_append(errors, 'incomplete_batch'); END IF;
  IF (SELECT count(*) FROM public."MemberMoneyObligation" WHERE "journalId" = h.id) <> h."expectedObligationCount" THEN
    errors := array_append(errors, 'incomplete_obligations');
  END IF;
  IF (SELECT count(*) FROM public."MemberMoneyApplication" WHERE "journalId" = h.id) <> h."expectedApplicationCount" THEN
    errors := array_append(errors, 'incomplete_applications');
  END IF;
  IF signed_total <> 0 THEN errors := array_append(errors, 'unbalanced_batch'); END IF;
  -- Tax tie: a taxed revenue leg carries its net cents, and on each side the
  -- batch's GST_PAYABLE legs carry exactly the tax its taxed revenue legs record.
  IF EXISTS (SELECT 1 FROM public."MemberMoneyLine" WHERE "journalId" = h.id
      AND account IN ('BOOKING_REVENUE', 'SUBSCRIPTION_REVENUE', 'JOINING_FEE_REVENUE', 'FEE_REVENUE')
      AND "taxCents" IS NOT NULL AND "amountCents" <> "netCents")
    OR EXISTS (SELECT 1 FROM (VALUES ('DEBIT'::public."MemberMoneySide"), ('CREDIT')) AS sides(side)
      WHERE (SELECT coalesce(sum("amountCents"::bigint), 0) FROM public."MemberMoneyLine" l
          WHERE l."journalId" = h.id AND l.side = sides.side AND l.account = 'GST_PAYABLE')
        <> (SELECT coalesce(sum("taxCents"::bigint), 0) FROM public."MemberMoneyLine" l
          WHERE l."journalId" = h.id AND l.side = sides.side
            AND l.account IN ('BOOKING_REVENUE', 'SUBSCRIPTION_REVENUE', 'JOINING_FEE_REVENUE', 'FEE_REVENUE'))) THEN
    errors := array_append(errors, 'tax_tie_mismatch');
  END IF;
  -- The writer derives the club civil date through the club-time kernel. No zone
  -- is more than a day from UTC, so a date outside that bound is never right.
  IF e."effectiveDate" NOT BETWEEN e."effectiveAt"::date - 1 AND e."effectiveAt"::date + 1 THEN
    errors := array_append(errors, 'effective_date_out_of_range');
  END IF;
  IF (e.kind = 'ZERO' AND line_count <> 0)
    OR (e.kind <> 'ZERO' AND line_count < 2 AND NOT (e.kind = 'REVERSAL' AND line_count = 0
      AND EXISTS (SELECT 1 FROM public."MemberMoneyJournal" WHERE id = h."reversesJournalId" AND "expectedLineCount" = 0))) THEN
    errors := array_append(errors, 'invalid_zero_event');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."MemberMoneySourceLink" WHERE "journalId" = h.id
      AND "sourceKind" = e."sourceKind" AND "sourceId" = e."sourceIdentity" AND "sourceVersion" = e."sourceVersion") THEN
    errors := array_append(errors, 'missing_source_link');
  END IF;
  IF EXISTS (SELECT 1 FROM public."MemberMoneySourceLink" source
    WHERE source."journalId" = h.id AND source."sourceKind" = 'BOOKING_LEDGER'
      AND h."expectedLineCount" > 0 AND NOT EXISTS (
        SELECT 1 FROM public."MemberMoneySourcePosting" posting WHERE posting."sourceLinkId" = source.id)) THEN
    errors := array_append(errors, 'missing_bridge_postings');
  END IF;
  IF (e.kind = 'REVERSAL') <> (h."reversesJournalId" IS NOT NULL) THEN
    errors := array_append(errors, 'reversal_kind_mismatch');
  END IF;
  IF h."reversesJournalId" IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public."MemberMoneyJournal" original
      WHERE original.id = h."reversesJournalId" AND original.currency = h.currency
        AND original."policyVersion" = h."policyVersion" AND original."codingVersion" = h."codingVersion"
        AND original."expectedLineCount" = h."expectedLineCount")
      OR EXISTS (SELECT 1 FROM public."MemberMoneyLine" l
        LEFT JOIN public."MemberMoneyLine" original ON original.id = l."originalLineId"
        WHERE l."journalId" = h.id AND (original.id IS NULL OR original."journalId" <> h."reversesJournalId"
          OR original.side = l.side
          OR (to_jsonb(original) - ARRAY['id','journalId','sourceLinkId','side','originalLineId'])
            IS DISTINCT FROM (to_jsonb(l) - ARRAY['id','journalId','sourceLinkId','side','originalLineId']))) THEN
      errors := array_append(errors, 'inexact_reversal');
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public."MemberMoneyLine" WHERE "journalId" = h.id AND "originalLineId" IS NOT NULL) THEN
    errors := array_append(errors, 'unexpected_original_line');
  END IF;
  IF EXISTS (SELECT 1 FROM public."MemberMoneyLine" l
    JOIN public."MemberMoneyObligation" o ON o.id = l."obligationId"
    JOIN public."MemberMoneyJournal" oh ON oh.id = o."journalId"
    WHERE l."journalId" = h.id AND (h.currency <> oh.currency
      OR (l."debtorKind", l."memberId", l."organisationId") IS DISTINCT FROM (o."debtorKind", o."memberId", o."organisationId"))) THEN
    errors := array_append(errors, 'line_obligation_mismatch');
  END IF;
  IF EXISTS (SELECT 1 FROM public."MemberMoneyApplication" a
    JOIN public."MemberMoneyLine" l ON l.id = a."sourceLineId"
    JOIN public."MemberMoneyJournal" lh ON lh.id = l."journalId"
    JOIN public."MemberMoneyObligation" o ON o.id = a."obligationId"
    JOIN public."MemberMoneyJournal" oh ON oh.id = o."journalId"
    LEFT JOIN public."MemberMoneyApplication" original ON original.id = a."reversesApplicationId"
    WHERE a."journalId" = h.id AND (h.currency <> lh.currency OR h.currency <> oh.currency
      OR (l."debtorKind", l."memberId", l."organisationId") IS DISTINCT FROM (o."debtorKind", o."memberId", o."organisationId")
      OR (a."reversesApplicationId" IS NOT NULL AND (original.id IS NULL
        OR original."sourceLineId" <> a."sourceLineId" OR original."obligationId" <> a."obligationId"
        OR original."amountCents" <> a."amountCents")))) THEN
    errors := array_append(errors, 'application_mismatch');
  END IF;
  RETURN errors;
END
$$;

CREATE FUNCTION member_money_require_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  batch_id text;
  errors text[];
BEGIN
  IF TG_TABLE_NAME = 'MemberMoneyEvent' THEN
    SELECT id INTO batch_id FROM public."MemberMoneyJournal" WHERE "eventId" = NEW.id;
    IF batch_id IS NULL THEN
      RAISE EXCEPTION 'member_money_missing_journal' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'MemberMoneyJournal' THEN batch_id := NEW.id;
  ELSE batch_id := NEW."journalId";
  END IF;
  errors := public.member_money_batch_errors(batch_id);
  IF cardinality(errors) > 0 THEN
    RAISE EXCEPTION 'member_money_invalid_batch: %', array_to_string(errors, ', ') USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER member_money_immutable BEFORE UPDATE OR DELETE ON "MemberMoneyEvent"
FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation();
CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON "MemberMoneyEvent"
FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation();
CREATE CONSTRAINT TRIGGER member_money_complete AFTER INSERT ON "MemberMoneyEvent"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_complete();

CREATE TRIGGER member_money_immutable BEFORE UPDATE OR DELETE ON "MemberMoneyJournal"
FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation();
CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON "MemberMoneyJournal"
FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation();
CREATE CONSTRAINT TRIGGER member_money_complete AFTER INSERT ON "MemberMoneyJournal"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_complete();
CREATE TRIGGER member_money_seal BEFORE INSERT ON "MemberMoneyJournal"
FOR EACH ROW EXECUTE FUNCTION member_money_check_seal();

CREATE TRIGGER member_money_immutable BEFORE UPDATE OR DELETE ON "MemberMoneyLine"
FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation();
CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON "MemberMoneyLine"
FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation();
CREATE CONSTRAINT TRIGGER member_money_complete AFTER INSERT ON "MemberMoneyLine"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_complete();
CREATE TRIGGER member_money_seal BEFORE INSERT ON "MemberMoneyLine"
FOR EACH ROW EXECUTE FUNCTION member_money_check_seal();

CREATE TRIGGER member_money_immutable BEFORE UPDATE OR DELETE ON "MemberMoneyObligation"
FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation();
CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON "MemberMoneyObligation"
FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation();
CREATE CONSTRAINT TRIGGER member_money_complete AFTER INSERT ON "MemberMoneyObligation"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_complete();
CREATE TRIGGER member_money_seal BEFORE INSERT ON "MemberMoneyObligation"
FOR EACH ROW EXECUTE FUNCTION member_money_check_seal();

CREATE TRIGGER member_money_immutable BEFORE UPDATE OR DELETE ON "MemberMoneyApplication"
FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation();
CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON "MemberMoneyApplication"
FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation();
CREATE CONSTRAINT TRIGGER member_money_complete AFTER INSERT ON "MemberMoneyApplication"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_complete();
CREATE TRIGGER member_money_seal BEFORE INSERT ON "MemberMoneyApplication"
FOR EACH ROW EXECUTE FUNCTION member_money_check_seal();

CREATE TRIGGER member_money_immutable BEFORE UPDATE OR DELETE ON "MemberMoneySourceLink"
FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation();
CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON "MemberMoneySourceLink"
FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation();
CREATE CONSTRAINT TRIGGER member_money_complete AFTER INSERT ON "MemberMoneySourceLink"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_complete();

CREATE TRIGGER member_money_immutable BEFORE UPDATE OR DELETE ON "MemberMoneySourcePosting"
FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation();
CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON "MemberMoneySourcePosting"
FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation();
CREATE CONSTRAINT TRIGGER member_money_complete AFTER INSERT ON "MemberMoneySourcePosting"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_complete();

-- Least-privilege installs (#4453): the migration role's default privileges give
-- the application UPDATE and DELETE on every new table. Narrow the tables THIS
-- file created to INSERT/SELECT-style rights for every grantee but the owner,
-- naming no role (docs/BLUE_GREEN_MIGRATION_POLICY.md, "Which role a migration
-- runs as"). Nothing depends on those rights: the tables are new. On a
-- single-role install, or an app that connects as the owner, it revokes nothing.
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT DISTINCT c.oid::regclass AS rel,
      CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_catalog.pg_get_userbyid(acl.grantee)) END AS grantee
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) AS acl
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relname IN ('MemberMoneyEvent', 'MemberMoneyJournal', 'MemberMoneyLine', 'MemberMoneyObligation',
        'MemberMoneyApplication', 'MemberMoneySourceLink', 'MemberMoneySourcePosting')
      AND acl.grantee <> c.relowner
      AND acl.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE %s FROM %s', target.rel, target.grantee);
  END LOOP;
END
$$;
