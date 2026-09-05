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
BEGIN
  IF jsonb_typeof(p_night_prices) <> 'array' THEN
    RETURN;
  END IF;

  UPDATE "BookingGuestNight" AS bgn
  SET "priceSource" = 'OFFICER_PRICED'
  FROM jsonb_array_elements(p_night_prices) AS item
  WHERE bgn."bookingGuestId" = p_guest_id
    AND bgn."createdAt" <= p_audit_created_at
    AND item->>'date' ~ '^\d{4}-\d{2}-\d{2}$'
    AND item->>'priceCents' ~ '^(0|[1-9][0-9]*)$'
    AND bgn."stayDate" = (item->>'date')::date
    AND bgn."priceCents" = (item->>'priceCents')::integer;
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
