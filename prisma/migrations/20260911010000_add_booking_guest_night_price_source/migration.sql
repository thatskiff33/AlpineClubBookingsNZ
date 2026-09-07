BEGIN;

-- #3275 (stage 1 of programme #3272): record where each stored night price
-- came from. This migration changes no priceCents value.
--
-- UNKNOWN is deliberately the column default. During a blue/green deploy the
-- draining colour does not know this column and omits it from inserts; the
-- default therefore records the only fact the new colour can honestly know
-- about such a row. It must never re-derive provenance from the amount.
CREATE TYPE "BookingGuestNightPriceSource" AS ENUM (
  'SOLD',
  'OFFICER_PRICED',
  'EVEN_SPLIT',
  'UNKNOWN'
);

ALTER TABLE "BookingGuestNight"
ADD COLUMN "priceSource" "BookingGuestNightPriceSource" NOT NULL DEFAULT 'UNKNOWN';

-- Both officer-repair paths write their AuditLog row in the same transaction
-- as the repaired BookingGuestNight rows. Keep that evidence useful while the
-- draining colour still runs code compiled before priceSource existed: its
-- data write receives UNKNOWN from the column default, then this trigger marks
-- only the exact guest/date/amount pairs named by the successful repair audit.
-- The createdAt boundary prevents an old audit row from relabelling a later
-- delete-and-recreate of the same guest night.
CREATE FUNCTION "applyBookingGuestNightOfficerPriceSourceFromAudit"(
  p_guest_id TEXT,
  p_night_prices JSONB,
  p_audit_created_at TIMESTAMP(3)
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  item JSONB;
  item_date DATE;
  item_price_cents INTEGER;
BEGIN
  IF jsonb_typeof(p_night_prices) IS DISTINCT FROM 'array' THEN
    RETURN;
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_night_prices)
  LOOP
    IF jsonb_typeof(item->'priceCents') IS DISTINCT FROM 'number' THEN
      CONTINUE;
    END IF;
    IF (item->>'date' ~ '^\d{4}-\d{2}-\d{2}$') IS DISTINCT FROM TRUE THEN
      CONTINUE;
    END IF;
    IF (item->>'priceCents' ~ '^(0|[1-9][0-9]*)$') IS DISTINCT FROM TRUE THEN
      CONTINUE;
    END IF;

    -- These casts sit behind shape checks, but still need a bounded exception:
    -- a syntactically valid date can be impossible and an integer can overflow.
    -- Keeping the casts in their own block means malformed audit metadata skips
    -- that item instead of rolling back the officer's otherwise valid repair.
    BEGIN
      item_date := (item->>'date')::date;
      item_price_cents := (item->>'priceCents')::integer;
    EXCEPTION
      WHEN invalid_text_representation
        OR datetime_field_overflow
        OR numeric_value_out_of_range
      THEN CONTINUE;
    END;

    UPDATE "BookingGuestNight" AS bgn
    SET "priceSource" = 'OFFICER_PRICED'
    WHERE bgn."bookingGuestId" = p_guest_id
      AND bgn."createdAt" <= p_audit_created_at
      AND bgn."stayDate" = item_date
      AND bgn."priceCents" = item_price_cents;
  END LOOP;
END;
$$;

CREATE FUNCTION "setBookingGuestNightOfficerPriceSourceFromAudit"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."action" IN (
      'booking-payment.stored-night-price.record',
      'booking-payment.stored-night-price.reconcile'
    )
    AND NEW."entityType" = 'BookingGuest'
    AND NEW."outcome" = 'success'
  THEN
    PERFORM "applyBookingGuestNightOfficerPriceSourceFromAudit"(
      NEW."entityId",
      NEW."metadata"->'nightPrices',
      NEW."createdAt"
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "AuditLog_set_booking_guest_night_officer_price_source"
AFTER INSERT ON "AuditLog"
FOR EACH ROW
EXECUTE FUNCTION "setBookingGuestNightOfficerPriceSourceFromAudit"();

COMMIT;
