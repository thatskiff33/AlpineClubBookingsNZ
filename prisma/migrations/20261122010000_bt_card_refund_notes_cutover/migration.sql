-- #4312: a marker, not a schema change. When this migration finished on an
-- install is the cutover for giving a card refund on a bank-transfer payment its
-- own Xero refund credit note (`CARD_REFUND_NOTE_CUTOVER_MIGRATION` in
-- src/lib/card-refund-own-note-share.ts): a refund Stripe created before it keeps
-- the note an older release gave it, or none, and is never given one of its own.
-- Readable by the previous release: it changes nothing it reads.
SELECT 1;
