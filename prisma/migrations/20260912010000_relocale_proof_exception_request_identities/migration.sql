-- #3252: re-derive the stored identities of every WAITING booking-exception
-- request under the locale-proof comparator that ships in this same release.
--
-- WHAT THIS IS FOR. A pending exception request stores a fingerprint of what was
-- proposed (`proposalHash`), and approval rebuilds that fingerprint from the
-- frozen snapshot and compares. Until this release the party was ordered with
-- bare `localeCompare`, whose collation the runtime resolves from its
-- environment; this release orders it by code unit instead. Any row stored under
-- the old rule whose party orders differently under the new one would be refused
-- at approval as TAMPERED WITH — a member's untouched request, rejected by the
-- fix. This statement moves those stored values onto the new rule so nothing
-- waiting is refused.
--
-- IT REWRITES A COLUMN BOTH SCHEMA COMMENTS CALL "Frozen at submit time; never
-- rewritten", AND THAT IS DELIBERATE. It is a one-off exception, taken because
-- the alternative is telling an officer a proposal was altered when it was not.
-- It is NOT a licence to rewrite frozen rows generally: what makes it legitimate
-- here is that the rewrite changes no FACT about the proposal — the same guests,
-- the same nights, the same dates, in a different array order — and that the
-- value being rewritten is a DERIVATION of the frozen data rather than the
-- frozen data itself. A migration that changed what was proposed would be
-- forging a member's request. See `docs/invariants/booking-policy-exceptions.md`
-- -> INV-EXCEPT-036.
--
-- MEASURED PRODUCTION EFFECT: ZERO ROWS. Read-only, under the authorisation
-- recorded on #3252: both request tables hold exactly one row each and both are
-- APPROVED, there are no rows in REQUESTED state, no row holds a non-null
-- `openStateKey`, and there are no `HostingCoverageIncident` rows. An APPROVED
-- row never reaches the hash gate — the status guard returns first — so it never
-- re-derives anything, ever.
--
-- THAT IS WHAT LETS BOTH HALVES SHIP IN ONE RELEASE. Under blue/green the
-- previous colour keeps serving while migrations run, so rewriting hashes to the
-- new rule while old-comparator instances are still deriving under the old one
-- would cause the very failure this fixes. With no affected row in existence
-- that window is provably empty. The statement still ships, and that is not
-- ceremony: a request submitted between the measurement and the deploy WOULD be
-- affected, and this is what makes that case safe. It is verified to have
-- nothing to do rather than assumed to.
--
-- THREE STORED VALUES MOVE TOGETHER, or the fix breaks something else:
--
--   1. `proposalHash`, on "NewBookingPolicyExceptionRequest" (NOT NULL) and on
--      "BookingChangeRequest" (nullable — NULL on every LOCKED_PERIOD row, and
--      left NULL here).
--   2. `openStateKey` on "NewBookingPolicyExceptionRequest", which is
--      `nbpe:{requestedByMemberId}:{proposalHash}` and carries a UNIQUE index.
--      That index is the durable cap stopping one member holding two open
--      requests for the same proposal. Rewriting the hash and not the key leaves
--      the cap SILENTLY DISARMED: a resubmission computes the new key, which
--      does not collide with the stored old one, and the member ends up with two
--      open requests each holding capacity. "BookingChangeRequest"'s key is
--      `pe:{bookingId}:{requestedByMemberId}` and carries no hash, so it is
--      correctly left alone.
--   3. `frozenEvidence`, whose `uncovered` array is sorted by the SAME rule at
--      `src/lib/policies/adult-member-hosting.ts` and read back at approval to
--      build a violation fingerprint. Leaving it would refuse the identical
--      requests through a different door, with the policy-drift message instead
--      of the tampering one.
--
-- WHY THE CANONICALISATION IS WRITTEN OUT IN SQL, and how that is kept honest.
-- A hash cannot be re-derived without reproducing the exact bytes, so this is
-- necessarily a second statement of the canonicalisation — the same shape as the
-- #2269 annotation-strip migration, which restates a pattern list in SQL and has
-- a test read the SQL back to prove parity. Here the parity proof is the
-- data-migration verification fixture
-- (`prisma/migration-verification/20260912010000_relocale_proof_exception_request_identities.ts`):
-- it seeds a party whose two surnames order OPPOSITELY under the two
-- comparators, runs this real SQL, and asserts the resulting hash equals the
-- literal that `computeProposalHash` produces in TypeScript for the same party.
-- A divergence between the two implementations fails CI on a known value rather
-- than surfacing later as an unexplained mismatch.
--
-- The value space is what makes the SQL tractable: a canonical snapshot contains
-- objects, arrays, strings, booleans and nulls, and NO NUMBERS, so there is no
-- float-formatting difference between PostgreSQL and JavaScript to reconcile.
-- The key set is closed, so the JSON is built EXPLICITLY with keys in
-- `Object.keys().sort()` order rather than by a generic recursive serialiser.
--
-- THE ONE PLACE C COLLATION AND JAVASCRIPT DISAGREE, stated rather than
-- glossed. `COLLATE "C"` is UTF-8 byte order; JavaScript's `<` is UTF-16
-- CODE UNIT order. Those agree for every character in the Basic Multilingual
-- Plane and DISAGREE above it: an astral character (an emoji, say) begins with a
-- UTF-16 surrogate in 0xD800-0xDBFF, which JavaScript orders BELOW a BMP
-- character in 0xE000-0xFFFF while UTF-8 byte order puts it above. Rather than
-- leave that as a silent inaccuracy, the pre-flight block below RAISES if any
-- row this statement would touch contains such a character, so the migration
-- fails loudly instead of writing a hash the application will reject. It has
-- never fired and, on the measured production data, cannot.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers. Created, used, and dropped again at the end of this file: they exist
-- for the length of this migration and are not part of the schema.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION _mig3252_has_astral(value text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1
      FROM regexp_split_to_table(coalesce(value, ''), '') AS ch
     WHERE ascii(ch) > 65535
  )
$$ LANGUAGE sql IMMUTABLE;

-- `canonicalNights`: sorted, de-duplicated, as a JSON array literal.
CREATE OR REPLACE FUNCTION _mig3252_canon_nights(nights jsonb) RETURNS text AS $$
  SELECT '[' || coalesce(string_agg(to_json(night)::text, ',' ORDER BY night COLLATE "C"), '') || ']'
    FROM (SELECT DISTINCT jsonb_array_elements_text(nights) AS night) AS distinct_nights
$$ LANGUAGE sql IMMUTABLE;

-- The same nights, joined for use as the fourth sort key, exactly as
-- `a.nights.join(",")` does in `canonicalizeProposalParty`.
CREATE OR REPLACE FUNCTION _mig3252_nights_key(nights jsonb) RETURNS text AS $$
  SELECT coalesce(string_agg(night, ',' ORDER BY night COLLATE "C"), '')
    FROM (SELECT DISTINCT jsonb_array_elements_text(nights) AS night) AS distinct_nights
$$ LANGUAGE sql IMMUTABLE;

-- One canonical guest. Keys in `Object.keys().sort()` order: ageTier,
-- firstName, isMember, lastName, memberId, nights.
CREATE OR REPLACE FUNCTION _mig3252_canon_guest(guest jsonb) RETURNS text AS $$
  SELECT '{"ageTier":' || to_json(guest->>'ageTier')::text
      || ',"firstName":' || to_json(guest->>'firstName')::text
      || ',"isMember":' || CASE WHEN (guest->>'isMember')::boolean THEN 'true' ELSE 'false' END
      || ',"lastName":' || to_json(guest->>'lastName')::text
      || ',"memberId":' || CASE
                             WHEN guest->>'memberId' IS NULL THEN 'null'
                             ELSE to_json(guest->>'memberId')::text
                           END
      || ',"nights":' || _mig3252_canon_nights(guest->'nights')
      || '}'
$$ LANGUAGE sql IMMUTABLE;

-- One canonical party. Guests ordered by the SIX-key chain
-- `canonicalizeProposalParty` uses — lastName, firstName, memberId (null as ""),
-- joined nights, ageTier, isMember — which is TOTAL, so no tie can be broken by
-- the order the array happened to be stored in.
CREATE OR REPLACE FUNCTION _mig3252_canon_party(party jsonb) RETURNS text AS $$
  SELECT '{"checkIn":' || to_json(party->>'checkIn')::text
      || ',"checkOut":' || to_json(party->>'checkOut')::text
      || ',"guests":['
      || coalesce(
           string_agg(
             sorted.text_form,
             ','
             ORDER BY sorted.last_name COLLATE "C",
                      sorted.first_name COLLATE "C",
                      sorted.member_id COLLATE "C",
                      sorted.nights_key COLLATE "C",
                      sorted.age_tier COLLATE "C",
                      sorted.is_member
           ),
           ''
         )
      || ']}'
    FROM (
      SELECT _mig3252_canon_guest(entry.value)                AS text_form,
             coalesce(entry.value->>'lastName', '')            AS last_name,
             coalesce(entry.value->>'firstName', '')           AS first_name,
             coalesce(entry.value->>'memberId', '')            AS member_id,
             _mig3252_nights_key(entry.value->'nights')        AS nights_key,
             coalesce(entry.value->>'ageTier', '')             AS age_tier,
             (entry.value->>'isMember')::boolean               AS is_member
        FROM jsonb_array_elements(party->'guests') AS entry(value)
    ) AS sorted
$$ LANGUAGE sql IMMUTABLE;

-- The whole canonical snapshot. Keys sorted: NEW_BOOKING is
-- {kind, lodgeId, proposed}; MODIFICATION is
-- {base, bookingId, kind, lodgeId, proposed}. Anything else returns NULL, which
-- the pre-flight block below turns into a loud failure.
CREATE OR REPLACE FUNCTION _mig3252_canon_snapshot(snapshot jsonb) RETURNS text AS $$
  SELECT CASE snapshot->>'kind'
           WHEN 'NEW_BOOKING' THEN
             '{"kind":' || to_json(snapshot->>'kind')::text
             || ',"lodgeId":' || to_json(snapshot->>'lodgeId')::text
             || ',"proposed":' || _mig3252_canon_party(snapshot->'proposed')
             || '}'
           WHEN 'MODIFICATION' THEN
             '{"base":' || _mig3252_canon_party(snapshot->'base')
             || ',"bookingId":' || to_json(snapshot->>'bookingId')::text
             || ',"kind":' || to_json(snapshot->>'kind')::text
             || ',"lodgeId":' || to_json(snapshot->>'lodgeId')::text
             || ',"proposed":' || _mig3252_canon_party(snapshot->'proposed')
             || '}'
           ELSE NULL
         END
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION _mig3252_proposal_hash(snapshot jsonb) RETURNS text AS $$
  SELECT encode(digest(_mig3252_canon_snapshot(snapshot), 'sha256'), 'hex')
$$ LANGUAGE sql IMMUTABLE;

-- Re-sort every violation's `uncovered` array by (night, guestRef) under C
-- collation, leaving the violations array's own order and every other field of
-- the evidence exactly as stored.
CREATE OR REPLACE FUNCTION _mig3252_resort_evidence(evidence jsonb) RETURNS jsonb AS $$
  SELECT CASE
           WHEN jsonb_typeof(evidence->'violations') <> 'array' THEN evidence
           ELSE jsonb_set(
             evidence,
             '{violations}',
             (
               SELECT coalesce(
                 jsonb_agg(
                   CASE
                     WHEN jsonb_typeof(violation.value->'requirements'->'uncovered') = 'array' THEN
                       jsonb_set(
                         violation.value,
                         '{requirements,uncovered}',
                         (
                           SELECT coalesce(
                             jsonb_agg(
                               night_row.value
                               ORDER BY (night_row.value->>'night') COLLATE "C",
                                        (night_row.value->>'guestRef') COLLATE "C"
                             ),
                             '[]'::jsonb
                           )
                             FROM jsonb_array_elements(
                                    violation.value->'requirements'->'uncovered'
                                  ) AS night_row(value)
                         )
                       )
                     ELSE violation.value
                   END
                   ORDER BY violation.ord
                 ),
                 '[]'::jsonb
               )
                 FROM jsonb_array_elements(evidence->'violations')
                        WITH ORDINALITY AS violation(value, ord)
             )
           )
         END
$$ LANGUAGE sql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- Pre-flight. Both checks fail the whole migration rather than write a value
-- the application would then reject. On the measured production data neither
-- can fire, because there is no REQUESTED row at all.
-- ---------------------------------------------------------------------------

DO $preflight$
DECLARE
  unreadable bigint;
  astral bigint;
BEGIN
  SELECT count(*) INTO unreadable
    FROM (
      SELECT "proposalSnapshot" AS snapshot
        FROM "NewBookingPolicyExceptionRequest"
       WHERE "status" = 'REQUESTED'
      UNION ALL
      SELECT "proposalSnapshot"
        FROM "BookingChangeRequest"
       WHERE "status" = 'REQUESTED'
         AND "proposalHash" IS NOT NULL
         AND "proposalSnapshot" IS NOT NULL
    ) AS pending
   WHERE _mig3252_canon_snapshot(snapshot) IS NULL;

  IF unreadable > 0 THEN
    RAISE EXCEPTION
      '#3252: % waiting request(s) hold a proposal snapshot this migration cannot canonicalise. Investigate before deploying; do not relax this check.',
      unreadable;
  END IF;

  SELECT count(*) INTO astral
    FROM (
      SELECT "proposalSnapshot" AS snapshot
        FROM "NewBookingPolicyExceptionRequest"
       WHERE "status" = 'REQUESTED'
      UNION ALL
      SELECT "proposalSnapshot"
        FROM "BookingChangeRequest"
       WHERE "status" = 'REQUESTED'
         AND "proposalHash" IS NOT NULL
         AND "proposalSnapshot" IS NOT NULL
    ) AS pending
   WHERE _mig3252_has_astral(_mig3252_canon_snapshot(snapshot));

  IF astral > 0 THEN
    RAISE EXCEPTION
      '#3252: % waiting request(s) contain a character outside the Basic Multilingual Plane, where UTF-8 byte order and JavaScript UTF-16 code-unit order disagree. This migration cannot reproduce the application hash for such a row; handle it by hand.',
      astral;
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- The rewrite. Only REQUESTED rows: every other status returns from the status
-- guard before the hash gate, so it never re-derives anything.
-- ---------------------------------------------------------------------------

UPDATE "NewBookingPolicyExceptionRequest"
   SET "proposalHash" = _mig3252_proposal_hash("proposalSnapshot"),
       "openStateKey" = CASE
                          WHEN "openStateKey" IS NULL THEN NULL
                          ELSE 'nbpe:' || "requestedByMemberId" || ':'
                               || _mig3252_proposal_hash("proposalSnapshot")
                        END,
       "frozenEvidence" = _mig3252_resort_evidence("frozenEvidence")
 WHERE "status" = 'REQUESTED'
   AND (
        "proposalHash" <> _mig3252_proposal_hash("proposalSnapshot")
     OR "frozenEvidence" <> _mig3252_resort_evidence("frozenEvidence")
   );

UPDATE "BookingChangeRequest"
   SET "proposalHash" = _mig3252_proposal_hash("proposalSnapshot"),
       "frozenEvidence" = CASE
                            WHEN "frozenEvidence" IS NULL THEN NULL
                            ELSE _mig3252_resort_evidence("frozenEvidence")
                          END
 WHERE "status" = 'REQUESTED'
   AND "proposalHash" IS NOT NULL
   AND "proposalSnapshot" IS NOT NULL
   AND (
        "proposalHash" <> _mig3252_proposal_hash("proposalSnapshot")
     OR (
          "frozenEvidence" IS NOT NULL
      AND "frozenEvidence" <> _mig3252_resort_evidence("frozenEvidence")
        )
   );

-- ---------------------------------------------------------------------------
-- Leave no helpers behind.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS _mig3252_resort_evidence(jsonb);
DROP FUNCTION IF EXISTS _mig3252_proposal_hash(jsonb);
DROP FUNCTION IF EXISTS _mig3252_canon_snapshot(jsonb);
DROP FUNCTION IF EXISTS _mig3252_canon_party(jsonb);
DROP FUNCTION IF EXISTS _mig3252_canon_guest(jsonb);
DROP FUNCTION IF EXISTS _mig3252_nights_key(jsonb);
DROP FUNCTION IF EXISTS _mig3252_canon_nights(jsonb);
DROP FUNCTION IF EXISTS _mig3252_has_astral(text);
