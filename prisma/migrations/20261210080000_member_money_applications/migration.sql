-- Ledger M4a: expand only. M3 writes no applications and remains compatible.
CREATE TYPE "MemberMoneyRefundReservationReleaseReason" AS ENUM ('ANSWERED', 'REFUSED', 'SUPERSEDED_KEY', 'CLOSED_WITHOUT_REFUND', 'OPERATOR');
CREATE TABLE "MemberMoneyRefundReservation" (
  "id" TEXT NOT NULL,
  "attemptKey" TEXT NOT NULL,
  "obligationId" TEXT NOT NULL,
  "stripePaymentIntentId" TEXT NOT NULL,
  "paymentTransactionId" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "fundingJournalId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemberMoneyRefundReservation_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "MemberMoneyRefundReservationRelease" (
  "id" TEXT NOT NULL,
  "reservationId" TEXT NOT NULL,
  "reason" "MemberMoneyRefundReservationReleaseReason" NOT NULL,
  "stripeRefundId" TEXT,
  "applicationId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemberMoneyRefundReservationRelease_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MemberMoneyRefundReservation_attemptKey_key" ON "MemberMoneyRefundReservation"("attemptKey");
CREATE INDEX "MemberMoneyRefundReservation_obligationId_stripePaymentIntentId_idx" ON "MemberMoneyRefundReservation"("obligationId", "stripePaymentIntentId");
CREATE INDEX "MemberMoneyRefundReservation_fundingJournalId_idx" ON "MemberMoneyRefundReservation"("fundingJournalId");
CREATE UNIQUE INDEX "MemberMoneyRefundReservationRelease_reservationId_key" ON "MemberMoneyRefundReservationRelease"("reservationId");
CREATE INDEX "MemberMoneyRefundReservationRelease_applicationId_idx" ON "MemberMoneyRefundReservationRelease"("applicationId");
ALTER TABLE "MemberMoneyRefundReservation" ADD CONSTRAINT "MemberMoneyRefundReservation_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "MemberMoneyObligation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MemberMoneyRefundReservation" ADD CONSTRAINT "MemberMoneyRefundReservation_fundingJournalId_fkey" FOREIGN KEY ("fundingJournalId") REFERENCES "MemberMoneyJournal"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MemberMoneyRefundReservationRelease" ADD CONSTRAINT "MemberMoneyRefundReservationRelease_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "MemberMoneyRefundReservation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MemberMoneyRefundReservationRelease" ADD CONSTRAINT "MemberMoneyRefundReservationRelease_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "MemberMoneyApplication"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MemberMoneyRefundReservation" ADD CONSTRAINT "member_money_reservation_amount" CHECK ("amountCents" > 0 AND length("attemptKey") > 0 AND length("stripePaymentIntentId") > 0 AND length("paymentTransactionId") > 0);
ALTER TABLE "MemberMoneyRefundReservationRelease" ADD CONSTRAINT "member_money_release_answer" CHECK ((reason = 'ANSWERED') = ("applicationId" IS NOT NULL AND "stripeRefundId" IS NOT NULL));
CREATE TRIGGER member_money_immutable BEFORE UPDATE OR DELETE ON "MemberMoneyRefundReservation"
FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation();
CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON "MemberMoneyRefundReservation"
FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation();
CREATE TRIGGER member_money_immutable BEFORE UPDATE OR DELETE ON "MemberMoneyRefundReservationRelease"
FOR EACH ROW EXECUTE FUNCTION member_money_refuse_mutation();
CREATE TRIGGER member_money_no_truncate BEFORE TRUNCATE ON "MemberMoneyRefundReservationRelease"
FOR EACH STATEMENT EXECUTE FUNCTION member_money_refuse_mutation();

-- Exact source convention: PAYMENT identifies PaymentTransaction.id; REFUND
-- identifies PaymentRefund.stripeRefundId. No amount/time matching is permitted.
-- This projection is also the verifier's population-wide input (NULL booking).
CREATE FUNCTION member_money_application_state(booking_id text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
WITH sources AS (
  SELECT l.id, s."sourceKind", l.account, l.side, l."amountCents", l."debtorKind", l."memberId", l."organisationId",
    j.currency, l."bookingId", l."obligationId",
    CASE WHEN s."sourceKind" = 'PAYMENT' THEN p."stripePaymentIntentId"
      WHEN s."sourceKind" = 'REFUND' THEN r."stripePaymentIntentId" ELSE NULL END AS capture,
    EXISTS (SELECT 1 FROM public."MemberMoneyLine" reversal WHERE reversal."originalLineId" = l.id) AS reversed
  FROM public."MemberMoneyLine" l
  JOIN public."MemberMoneyJournal" j ON j.id = l."journalId"
  JOIN public."MemberMoneySourceLink" s ON s.id = l."sourceLinkId"
  LEFT JOIN public."PaymentTransaction" p ON s."sourceKind" = 'PAYMENT' AND p.id = s."sourceId"
  LEFT JOIN public."PaymentRefund" r ON s."sourceKind" = 'REFUND' AND r."stripeRefundId" = s."sourceId"
  WHERE booking_id IS NULL OR l."bookingId" = booking_id
), obligations AS (
  SELECT o.id, o."obligationKey" AS key, o.kind, o."faceCents", o."debtorKind", o."memberId", o."organisationId", j.currency
  FROM public."MemberMoneyObligation" o JOIN public."MemberMoneyJournal" j ON j.id = o."journalId"
  WHERE booking_id IS NULL OR EXISTS (SELECT 1 FROM public."MemberMoneyLine" l WHERE l."obligationId" = o.id AND l."bookingId" = booking_id)
), applications AS (
  SELECT a.id, a."sourceLineId", a."obligationId", a."amountCents", a."reversesApplicationId"
  FROM public."MemberMoneyApplication" a JOIN sources s ON s.id = a."sourceLineId"
), reservations AS (
  SELECT r.id, r."attemptKey", r."obligationId", r."stripePaymentIntentId" AS capture, r."amountCents"
  FROM public."MemberMoneyRefundReservation" r JOIN obligations o ON o.id = r."obligationId"
  WHERE NOT EXISTS (SELECT 1 FROM public."MemberMoneyRefundReservationRelease" x WHERE x."reservationId" = r.id)
)
SELECT jsonb_build_object(
  'sources', coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM sources s), '[]'::jsonb),
  'obligations', coalesce((SELECT jsonb_agg(to_jsonb(o)) FROM obligations o), '[]'::jsonb),
  'applications', coalesce((SELECT jsonb_agg(to_jsonb(a)) FROM applications a), '[]'::jsonb),
  'reservations', coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM reservations r), '[]'::jsonb))
$$;

CREATE OR REPLACE FUNCTION member_money_batch_errors(batch_id text) RETURNS text[]
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
  IF EXISTS (SELECT 1 FROM public."MemberMoneyApplication" a
    JOIN public."MemberMoneyLine" l ON l.id = a."sourceLineId"
    JOIN public."MemberMoneyObligation" o ON o.id = a."obligationId"
    WHERE a."journalId" = h.id AND NOT (
      (l.account = 'MEMBER_RECEIVABLE' AND l.side = 'CREDIT') OR
      (l.account = 'REFUND_PAYABLE' AND l.side = 'DEBIT' AND o.kind = 'REFUND' AND l."obligationId" = o.id))) THEN
    errors := array_append(errors, 'application_shape');
  END IF;
  -- A reversal copies every original application. Extra live collect
  -- applications on the reversed receipt may be copied too.
  IF h."reversesJournalId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM public."MemberMoneyApplication" original
    WHERE original."journalId" = h."reversesJournalId" AND NOT EXISTS (
      SELECT 1 FROM public."MemberMoneyApplication" a WHERE a."journalId" = h.id AND a."reversesApplicationId" = original.id)) THEN
    errors := array_append(errors, 'inexact_application_reversal');
  END IF;
  IF EXISTS (
    WITH RECURSIVE signed AS (
      SELECT a.id, a."sourceLineId", a."amountCents"::bigint AS amount
      FROM public."MemberMoneyApplication" a WHERE a."reversesApplicationId" IS NULL
      UNION ALL
      SELECT a.id, a."sourceLineId", -s.amount FROM public."MemberMoneyApplication" a JOIN signed s ON s.id = a."reversesApplicationId"
    )
    SELECT 1 FROM signed s JOIN public."MemberMoneyLine" l ON l.id = s."sourceLineId"
    WHERE l.id IN (SELECT "sourceLineId" FROM public."MemberMoneyApplication" WHERE "journalId" = h.id)
    GROUP BY l.id, l."amountCents" HAVING sum(s.amount) < 0 OR sum(s.amount) > l."amountCents"
  ) THEN errors := array_append(errors, 'application_source_cap'); END IF;
  -- The reservation trigger does not re-fire when funding is reversed. A release
  -- other than ANSWERED reverses that funding in the same transaction, so an
  -- open reservation must not still name the journal this batch reverses.
  IF h."reversesJournalId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM public."MemberMoneyRefundReservation" r
    WHERE r."fundingJournalId" = h."reversesJournalId"
      AND NOT EXISTS (SELECT 1 FROM public."MemberMoneyRefundReservationRelease" x WHERE x."reservationId" = r.id)
  ) THEN errors := array_append(errors, 'open_reservation_without_funding'); END IF;
  RETURN errors;
END
$$;
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
      AND c.relname IN ('MemberMoneyRefundReservation', 'MemberMoneyRefundReservationRelease')
      AND acl.grantee <> c.relowner
      AND acl.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON TABLE %s FROM %s', target.rel, target.grantee);
  END LOOP;
END
$$;

-- Cross-row reservation shape is checked at commit, allowing the answer and
-- its release (or the funding reversal and its release) in the same transaction.
CREATE FUNCTION member_money_reservation_errors(reservation_id text) RETURNS text[]
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
DECLARE
  r public."MemberMoneyRefundReservation"%ROWTYPE;
  x public."MemberMoneyRefundReservationRelease"%ROWTYPE;
  errors text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO r FROM public."MemberMoneyRefundReservation" WHERE id = reservation_id;
  IF NOT FOUND THEN RETURN ARRAY['missing_reservation']; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public."MemberMoneyObligation" o
    JOIN public."MemberMoneyLine" l ON l."obligationId" = o.id
    JOIN public."Payment" p ON p."bookingId" = l."bookingId"
    JOIN public."PaymentTransaction" t ON t."paymentId" = p.id
    WHERE o.id = r."obligationId" AND o.kind = 'REFUND'
      AND t.id = r."paymentTransactionId" AND t."stripePaymentIntentId" = r."stripePaymentIntentId"
  ) THEN errors := array_append(errors, 'reservation_capture_mismatch'); END IF;
  IF (SELECT coalesce(sum(a."amountCents"::bigint), 0)
    FROM public."MemberMoneyApplication" a
    JOIN public."MemberMoneyLine" l ON l.id = a."sourceLineId"
    JOIN public."MemberMoneySourceLink" s ON s.id = l."sourceLinkId"
    WHERE a."journalId" = r."fundingJournalId" AND a."obligationId" = r."obligationId"
      AND a."reversesApplicationId" IS NULL AND l.account = 'MEMBER_RECEIVABLE' AND l.side = 'CREDIT'
      AND s."sourceKind" = 'PAYMENT' AND s."sourceId" = r."paymentTransactionId") <> r."amountCents" THEN
    errors := array_append(errors, 'reservation_funding_mismatch');
  END IF;
  SELECT * INTO x FROM public."MemberMoneyRefundReservationRelease" WHERE "reservationId" = r.id;
  IF FOUND THEN
    IF x.reason = 'ANSWERED' THEN
      IF NOT EXISTS (SELECT 1 FROM public."MemberMoneyApplication" a
        JOIN public."MemberMoneyLine" l ON l.id = a."sourceLineId"
        JOIN public."MemberMoneyObligation" o ON o.id = a."obligationId"
        JOIN public."MemberMoneyObligation" root ON root.id = r."obligationId"
        JOIN public."MemberMoneySourceLink" s ON s.id = l."sourceLinkId"
        JOIN public."PaymentRefund" refund ON refund."stripeRefundId" = x."stripeRefundId"
        WHERE a.id = x."applicationId" AND a."amountCents" = r."amountCents" AND a."reversesApplicationId" IS NULL
          AND l.account = 'REFUND_PAYABLE' AND l.side = 'DEBIT' AND l."obligationId" = o.id
          AND split_part(o."obligationKey", '|for|', 1) = split_part(root."obligationKey", '|for|', 1)
          AND s."sourceKind" = 'REFUND' AND s."sourceId" = x."stripeRefundId"
          AND refund."stripePaymentIntentId" = r."stripePaymentIntentId") THEN
        errors := array_append(errors, 'reservation_answer_mismatch');
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM public."MemberMoneyJournal" j WHERE j."reversesJournalId" = r."fundingJournalId") THEN
      errors := array_append(errors, 'reservation_release_without_funding_reversal');
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public."MemberMoneyJournal" j WHERE j."reversesJournalId" = r."fundingJournalId") THEN
    errors := array_append(errors, 'open_reservation_without_funding');
  END IF;
  RETURN errors;
END
$$;
CREATE FUNCTION member_money_require_reservation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  errors text[];
  reservation_id text;
BEGIN
  IF TG_TABLE_NAME = 'MemberMoneyRefundReservation' THEN reservation_id := NEW.id;
  ELSE reservation_id := NEW."reservationId"; END IF;
  errors := public.member_money_reservation_errors(reservation_id);
  IF cardinality(errors) > 0 THEN
    RAISE EXCEPTION 'member_money_invalid_reservation: %', array_to_string(errors, ', ') USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER member_money_reservation_complete AFTER INSERT ON "MemberMoneyRefundReservation"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_reservation();
CREATE CONSTRAINT TRIGGER member_money_reservation_complete AFTER INSERT ON "MemberMoneyRefundReservationRelease"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION member_money_require_reservation();
