import type { DataMigrationVerification } from "./types";

/**
 * #3252 — the locale-proof re-derivation of every waiting exception request's
 * stored identity, executed against a real PostgreSQL.
 *
 * ## What only this fixture can prove
 *
 * The migration reproduces `computeProposalHash` in SQL, because a hash cannot
 * be re-derived without reproducing its exact bytes. That makes it a SECOND
 * statement of the canonicalisation, and the only honest way to hold two
 * implementations to each other is to run one and compare it against a literal
 * the other produced. Every `proposalHash` asserted below was computed by the
 * real TypeScript `computeProposalHash` and pasted here; if the SQL and the
 * application ever disagree — about guest order, about key order, about how a
 * quote or a macron is escaped — CI fails on a known value instead of an officer
 * being told months later that a member tampered with their own request.
 *
 * `Migration drift check` cannot reach any of this: it applies migrations to an
 * EMPTY database, so every `UPDATE` here matches nothing and the file is proven
 * to parse and proven to do nothing (#2418).
 *
 * ## The cases, one property each
 *
 *  - a waiting NEW_BOOKING request whose two surnames order OPPOSITELY under the
 *    two comparators (`de la Cruz` vs `Delacruz`, measured on the live server) —
 *    the hash moves, and `openStateKey` moves WITH it, because leaving the key
 *    behind silently disarms the duplicate-open-request cap;
 *  - the same divergence on a MODIFICATION row in the other table, which also
 *    carries the `uncovered` array that approval re-sorts and fingerprints;
 *  - a non-ASCII, quote-and-backslash party, which is where a JSON escaping
 *    difference between PostgreSQL and JavaScript would first bite;
 *  - a party that TIES on the first four sort keys, proving the SQL implements
 *    the sixth-key total order rather than falling back on stored array order;
 *  - rows the statement must not touch: an APPROVED request (whose stale hash
 *    stays stale, because an approved row never reaches the hash gate) and a
 *    LOCKED_PERIOD row whose `proposalHash` is NULL and stays NULL.
 *
 * ## Why there is no "remove COLLATE C" mutant, stated rather than left odd
 *
 * That would be the most on-the-nose mutation available, and it is not
 * declarable here: the runner requires every mutant to be CAUGHT, and whether
 * dropping `COLLATE "C"` changes any order at all depends on the collation the
 * TEST database happens to have been initialised with. A fixture whose teeth
 * depend on the environment's locale is the exact defect #3252 is about. The
 * ordering mutant below reverses the sort instead, which is locale-independent
 * and lands the fixture on the pre-#3252 order for the divergent pair.
 */

const LODGE_ID = "lodge-3252";
const MEMBER_ID = "mem-3252";
const BOOKING_ID = "bk-3252";

/** A hash no canonicalisation produces, so "unchanged" is unambiguous. */
const STALE_HASH = "f".repeat(64);

/**
 * The lodge, the member and the booking every case needs. `Lodge` already holds
 * a default row from the migration chain, but these snapshots name their own
 * lodge id and that id is inside the hashed bytes, so it has to be real.
 */
const PARENTS = `
  INSERT INTO "Lodge" ("id", "name", "slug", "updatedAt")
  VALUES ('${LODGE_ID}', 'Census Lodge', 'census-lodge-3252',
          TIMESTAMP '2026-01-01 00:00:00');

  INSERT INTO "Member" ("id", "email", "passwordHash", "firstName", "lastName", "updatedAt")
  VALUES ('${MEMBER_ID}', 'requester-3252@example.test', 'x', 'Ana', 'Requester',
          TIMESTAMP '2026-01-01 00:00:00');

  INSERT INTO "Booking"
    ("id", "memberId", "lodgeId", "checkIn", "checkOut", "status",
     "totalPriceCents", "finalPriceCents", "updatedAt")
  VALUES ('${BOOKING_ID}', '${MEMBER_ID}', '${LODGE_ID}', DATE '2026-07-04',
          DATE '2026-07-06', 'CONFIRMED', 10000, 10000,
          TIMESTAMP '2026-01-01 00:00:00');
`;

/**
 * A guest, as a canonical `ProposalGuest` object literal.
 *
 * Written as JSON text and dollar-quoted on the way into PostgreSQL, so a
 * surname carrying an apostrophe, a quote or a backslash reaches the database as
 * the bytes this file states rather than through hand-escaped SQL quoting.
 */
function guest(options: {
  firstName: string;
  lastName: string;
  ageTier?: string;
  isMember?: boolean;
  memberId?: string | null;
  nights: string[];
}) {
  return {
    firstName: options.firstName,
    lastName: options.lastName,
    ageTier: options.ageTier ?? "ADULT",
    isMember: options.isMember ?? false,
    memberId: options.memberId ?? null,
    nights: options.nights,
  };
}

/** Wrap JSON in a `$fixture$` literal so no quoting has to be hand-escaped. */
function jsonLiteral(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.includes("$fixture$")) {
    throw new Error("fixture value contains the dollar-quote tag $fixture$");
  }
  return `$fixture$${text}$fixture$::jsonb`;
}

/**
 * The divergent party, stored in the order the OLD comparator produced.
 *
 * `localeCompare` puts `de la Cruz` before `Delacruz` (the space is ignorable at
 * the primary level, then lower case sorts first); the ordinal comparator puts
 * `Delacruz` first, because `D` is below `d` in code-unit order. So this array
 * is exactly what a row submitted before the deploy holds, and the migration has
 * to re-order it.
 */
const DIVERGENT_GUESTS = [
  guest({ firstName: "Ana", lastName: "de la Cruz", nights: ["2026-07-04", "2026-07-05"] }),
  guest({ firstName: "Bo", lastName: "Delacruz", nights: ["2026-07-05"] }),
];

const NEW_BOOKING_SNAPSHOT = {
  kind: "NEW_BOOKING",
  lodgeId: LODGE_ID,
  proposed: {
    checkIn: "2026-07-04",
    checkOut: "2026-07-06",
    guests: DIVERGENT_GUESTS,
  },
};

/** `computeProposalHash(NEW_BOOKING_SNAPSHOT)`, measured in TypeScript. */
const NEW_BOOKING_HASH =
  "4186957fd5a9e5c24c2eb09042346f81933097410f05b8764f679ce193794435";

const MODIFICATION_SNAPSHOT = {
  kind: "MODIFICATION",
  lodgeId: LODGE_ID,
  bookingId: BOOKING_ID,
  base: {
    checkIn: "2026-07-04",
    checkOut: "2026-07-05",
    guests: [
      guest({ firstName: "Ana", lastName: "de la Cruz", nights: ["2026-07-04"] }),
    ],
  },
  proposed: {
    checkIn: "2026-07-04",
    checkOut: "2026-07-06",
    guests: [
      guest({ firstName: "Ana", lastName: "de la Cruz", nights: ["2026-07-04", "2026-07-05"] }),
      // A duplicated night, so the fixture also exercises `canonicalNights`
      // de-duplication inside the SQL rather than only its sort.
      guest({
        firstName: "Bo",
        lastName: "Delacruz",
        ageTier: "CHILD",
        isMember: true,
        memberId: MEMBER_ID,
        nights: ["2026-07-05", "2026-07-05"],
      }),
    ],
  },
};

/** `computeProposalHash(MODIFICATION_SNAPSHOT)`, measured in TypeScript. */
const MODIFICATION_HASH =
  "80279e849b8770056136593116b5fe5bdb9a18ee7e558f08d0c8162c4ea825c3";

/**
 * A party whose escaping is the point: a macron, an em dash, an apostrophe, a
 * double quote and a backslash. PostgreSQL and JavaScript both leave non-ASCII
 * literal and both escape `"` and `\`, and this case is what MEASURES that
 * rather than asserting it.
 */
const ESCAPING_SNAPSHOT = {
  kind: "NEW_BOOKING",
  lodgeId: LODGE_ID,
  proposed: {
    checkIn: "2026-07-04",
    checkOut: "2026-07-05",
    guests: [
      guest({ firstName: "Te Ata", lastName: "O'Brien — Māhuta", nights: ["2026-07-04"] }),
      guest({ firstName: 'Quote"And\\Slash', lastName: "Zeller", nights: ["2026-07-04"] }),
    ],
  },
};

/** `computeProposalHash(ESCAPING_SNAPSHOT)`, measured in TypeScript. */
const ESCAPING_HASH =
  "bbbd2b447299d6f849655b881b1c8978b9904a229223e00ae25c6964f5c062cb";

/**
 * Two guests identical on lastName, firstName, memberId and nights, differing
 * only in age tier. Before #3252 the comparator chain stopped at nights, so
 * these TIED and `Array#sort`'s stability let the stored array order decide the
 * hash. Stored here in the order the tie would have preserved (CHILD first), so
 * the SQL has to apply the fifth key to reach the same value TypeScript does.
 */
const TIE_SNAPSHOT = {
  kind: "NEW_BOOKING",
  lodgeId: LODGE_ID,
  proposed: {
    checkIn: "2026-07-04",
    checkOut: "2026-07-05",
    guests: [
      guest({ firstName: "Sam", lastName: "Smith", ageTier: "CHILD", nights: ["2026-07-04"] }),
      guest({ firstName: "Sam", lastName: "Smith", ageTier: "ADULT", nights: ["2026-07-04"] }),
    ],
  },
};

/** `computeProposalHash(TIE_SNAPSHOT)`, measured in TypeScript. */
const TIE_HASH =
  "b4f5c2dd76f0c2253be51bc6b2adebd9a84b6971711ec6b5c3cc49695be2cdd7";

/** Frozen evidence with nothing order-sensitive in it. */
const PLAIN_EVIDENCE = {
  violations: [],
  reasonCodes: [],
  policyRefs: [],
  affectedNights: [],
  capacityMode: "NO_HOLD",
};

/**
 * Frozen evidence holding an `uncovered` array in an order neither comparator
 * produces, so the assertion cannot pass by accident. Correct order under
 * (night, guestRef) is g-c (the 04th), then g-a, then g-b.
 */
const UNSORTED_EVIDENCE = {
  violations: [
    {
      reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
      policyId: "pol-3252",
      policyVersion: 3,
      capacityMode: "NO_HOLD",
      affectedNights: ["2026-07-04", "2026-07-05"],
      requirements: {
        uncoveredNonMemberGuestNights: 3,
        uncovered: [
          { guestRef: "g-b", guestName: "Bo", night: "2026-07-05" },
          { guestRef: "g-a", guestName: "Ana", night: "2026-07-05" },
          { guestRef: "g-c", guestName: "Cy", night: "2026-07-04" },
        ],
      },
    },
  ],
  reasonCodes: ["ADULT_MEMBER_HOSTING_REQUIRED"],
  policyRefs: [
    {
      reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
      policyId: "pol-3252",
      policyVersion: 3,
      capacityMode: "NO_HOLD",
    },
  ],
  affectedNights: ["2026-07-04", "2026-07-05"],
  capacityMode: "NO_HOLD",
};

function newBookingRequest(options: {
  id: string;
  status: string;
  snapshot: unknown;
  storedHash: string;
  openStateKey: string | null;
  evidence?: unknown;
}) {
  return `
    INSERT INTO "NewBookingPolicyExceptionRequest"
      ("id", "lodgeId", "requestedByMemberId", "status", "proposalSnapshot",
       "proposalHash", "frozenEvidence", "aggregateCapacityMode",
       "memberMessage", "openStateKey", "updatedAt")
    VALUES ('${options.id}', '${LODGE_ID}', '${MEMBER_ID}', '${options.status}',
            ${jsonLiteral(options.snapshot)}, '${options.storedHash}',
            ${jsonLiteral(options.evidence ?? PLAIN_EVIDENCE)}, 'NO_HOLD',
            'Please allow this booking.',
            ${options.openStateKey === null ? "NULL" : `'${options.openStateKey}'`},
            TIMESTAMP '2026-01-01 00:00:00');
  `;
}

const verification: DataMigrationVerification = {
  migration: "20260912010000_relocale_proof_exception_request_identities",
  intent:
    "Re-derive `proposalHash` on both request tables, the `nbpe:` `openStateKey` that embeds it, and the sorted `uncovered` array inside `frozenEvidence`, for REQUESTED rows only — under the code-unit comparator that ships in the same release — so that no request already waiting is refused at approval as tampered with. Every value must equal, byte for byte, what the application's own `computeProposalHash` produces for the same stored snapshot. No row in any other status is touched, and a NULL `proposalHash` stays NULL.",
  idempotentReRun: true,
  cases: [
    {
      name: "a club with a waiting new-booking request whose party orders one way under locale collation and the other way ordinally",
      seed: `
        ${PARENTS}
        ${newBookingRequest({
          id: "nbpe-divergent",
          status: "REQUESTED",
          snapshot: NEW_BOOKING_SNAPSHOT,
          storedHash: STALE_HASH,
          openStateKey: `nbpe:${MEMBER_ID}:${STALE_HASH}`,
        })}
      `,
      expectations: [
        {
          claim:
            "the stored hash is now exactly what the application's `computeProposalHash` produces for this snapshot — the SQL canonicalisation and the TypeScript one agree byte for byte",
          sql: `SELECT "proposalHash" FROM "NewBookingPolicyExceptionRequest"
                 WHERE "id" = 'nbpe-divergent'`,
          rows: [{ proposalHash: NEW_BOOKING_HASH }],
        },
        {
          claim:
            "`openStateKey` moved WITH the hash. Rewriting one and not the other leaves the unique index unable to refuse a resubmission of the same proposal, so the member could hold two open requests each reserving beds",
          sql: `SELECT "openStateKey" FROM "NewBookingPolicyExceptionRequest"
                 WHERE "id" = 'nbpe-divergent'`,
          rows: [{ openStateKey: `nbpe:${MEMBER_ID}:${NEW_BOOKING_HASH}` }],
        },
        {
          claim:
            "the snapshot itself is untouched: the same two guests, still in the order they were submitted in. The migration re-derives a DERIVATION of the frozen proposal and never the proposal",
          sql: `SELECT jsonb_array_length("proposalSnapshot" -> 'proposed' -> 'guests')
                         AS "guestCount",
                       "proposalSnapshot" -> 'proposed' -> 'guests' -> 0 ->> 'lastName'
                         AS "firstStored",
                       "proposalSnapshot" -> 'proposed' -> 'guests' -> 1 ->> 'lastName'
                         AS "secondStored"
                  FROM "NewBookingPolicyExceptionRequest"
                 WHERE "id" = 'nbpe-divergent'`,
          rows: [
            {
              guestCount: 2,
              firstStored: "de la Cruz",
              secondStored: "Delacruz",
            },
          ],
        },
        {
          claim:
            "no helper function is left behind in the schema — the canonicaliser exists for the length of this migration only",
          sql: `SELECT count(*)::int AS "leftovers"
                  FROM pg_proc WHERE proname LIKE '_mig3252%'`,
          rows: [{ leftovers: 0 }],
        },
      ],
    },
    {
      name: "a waiting MODIFICATION request in the other table, carrying the uncovered array approval fingerprints",
      seed: `
        ${PARENTS}
        INSERT INTO "BookingChangeRequest"
          ("id", "bookingId", "requestedByMemberId", "status", "kind",
           "requestedChanges", "proposalSnapshot", "proposalHash",
           "frozenEvidence", "aggregateCapacityMode", "openStateKey", "updatedAt")
        VALUES ('bcr-divergent', '${BOOKING_ID}', '${MEMBER_ID}', 'REQUESTED',
                'POLICY_EXCEPTION', '{}'::jsonb,
                ${jsonLiteral(MODIFICATION_SNAPSHOT)}, '${STALE_HASH}',
                ${jsonLiteral(UNSORTED_EVIDENCE)}, 'NO_HOLD',
                'pe:${BOOKING_ID}:${MEMBER_ID}',
                TIMESTAMP '2026-01-01 00:00:00');
      `,
      expectations: [
        {
          claim:
            "a modification hash — the larger canonical shape, with a `base` party and a `bookingId`, and a guest whose nights were stored with a duplicate — matches the application byte for byte",
          sql: `SELECT "proposalHash" FROM "BookingChangeRequest"
                 WHERE "id" = 'bcr-divergent'`,
          rows: [{ proposalHash: MODIFICATION_HASH }],
        },
        {
          claim:
            "the `uncovered` array inside `frozenEvidence` is re-sorted by (night, guestRef). Approval string-joins this array into a violation fingerprint and compares it against a freshly evaluated one, so leaving it in the old order refuses the identical request through the policy-drift door instead of the tampering one",
          sql: `SELECT jsonb_agg(row_value ->> 'guestRef' ORDER BY ordinality)::text
                         AS "guestRefsInStoredOrder"
                  FROM "BookingChangeRequest",
                       jsonb_array_elements(
                         "frozenEvidence" -> 'violations' -> 0
                           -> 'requirements' -> 'uncovered'
                       ) WITH ORDINALITY AS uncovered(row_value, ordinality)
                 WHERE "id" = 'bcr-divergent'`,
          rows: [{ guestRefsInStoredOrder: '["g-c", "g-a", "g-b"]' }],
        },
        {
          claim:
            "everything else in the evidence survives the rewrite: the violation's own fields, the reason codes, the policy refs and the affected nights",
          sql: `SELECT "frozenEvidence" -> 'violations' -> 0 ->> 'reasonCode' AS "reasonCode",
                       ("frozenEvidence" -> 'violations' -> 0 ->> 'policyVersion')::int
                         AS "policyVersion",
                       ("frozenEvidence" -> 'violations' -> 0 -> 'requirements'
                         ->> 'uncoveredNonMemberGuestNights')::int AS "uncoveredCount",
                       "frozenEvidence" -> 'reasonCodes' AS "reasonCodes",
                       jsonb_array_length("frozenEvidence" -> 'policyRefs') AS "policyRefCount",
                       "frozenEvidence" -> 'affectedNights' AS "affectedNights"
                  FROM "BookingChangeRequest" WHERE "id" = 'bcr-divergent'`,
          rows: [
            {
              reasonCode: "ADULT_MEMBER_HOSTING_REQUIRED",
              policyVersion: 3,
              uncoveredCount: 3,
              reasonCodes: ["ADULT_MEMBER_HOSTING_REQUIRED"],
              policyRefCount: 1,
              affectedNights: ["2026-07-04", "2026-07-05"],
            },
          ],
        },
        {
          claim:
            "this table's `openStateKey` is `pe:{bookingId}:{memberId}` and carries no hash, so it is correctly left exactly as it was",
          sql: `SELECT "openStateKey" FROM "BookingChangeRequest"
                 WHERE "id" = 'bcr-divergent'`,
          rows: [{ openStateKey: `pe:${BOOKING_ID}:${MEMBER_ID}` }],
        },
      ],
    },
    {
      name: "a party whose names carry a macron, an em dash, an apostrophe, a double quote and a backslash",
      seed: `
        ${PARENTS}
        ${newBookingRequest({
          id: "nbpe-escaping",
          status: "REQUESTED",
          snapshot: ESCAPING_SNAPSHOT,
          storedHash: STALE_HASH,
          openStateKey: null,
        })}
      `,
      expectations: [
        {
          claim:
            "the SQL escapes a member's real name exactly as `JSON.stringify` does. This is the one thing a hand-built serialiser is most likely to get subtly wrong, and it is measured here rather than reasoned about",
          sql: `SELECT "proposalHash" FROM "NewBookingPolicyExceptionRequest"
                 WHERE "id" = 'nbpe-escaping'`,
          rows: [{ proposalHash: ESCAPING_HASH }],
        },
        {
          claim:
            "a row that never held an `openStateKey` still holds none — the CASE guard does not manufacture a key for a row without one",
          sql: `SELECT "openStateKey" FROM "NewBookingPolicyExceptionRequest"
                 WHERE "id" = 'nbpe-escaping'`,
          rows: [{ openStateKey: null }],
        },
      ],
    },
    {
      name: "a party that ties on the first four sort keys",
      seed: `
        ${PARENTS}
        ${newBookingRequest({
          id: "nbpe-tie",
          status: "REQUESTED",
          snapshot: TIE_SNAPSHOT,
          storedHash: STALE_HASH,
          openStateKey: null,
        })}
      `,
      expectations: [
        {
          claim:
            "the SQL reaches the application's value for a party the first four keys cannot separate, which is only possible if it applies the age-tier key too. A four-key SQL sort would have kept the stored CHILD-first order and produced a different hash",
          sql: `SELECT "proposalHash" FROM "NewBookingPolicyExceptionRequest"
                 WHERE "id" = 'nbpe-tie'`,
          rows: [{ proposalHash: TIE_HASH }],
        },
      ],
    },
    {
      name: "the rows the statement must not touch — an approved request, and a locked-period row with no proposal at all",
      seed: `
        ${PARENTS}
        ${newBookingRequest({
          id: "nbpe-approved",
          status: "APPROVED",
          snapshot: NEW_BOOKING_SNAPSHOT,
          storedHash: STALE_HASH,
          openStateKey: null,
        })}
        ${newBookingRequest({
          id: "nbpe-rejected",
          status: "REJECTED",
          snapshot: NEW_BOOKING_SNAPSHOT,
          storedHash: STALE_HASH,
          openStateKey: null,
        })}
        INSERT INTO "BookingChangeRequest"
          ("id", "bookingId", "requestedByMemberId", "status", "kind",
           "requestedChanges", "updatedAt")
        VALUES ('bcr-locked', '${BOOKING_ID}', '${MEMBER_ID}', 'REQUESTED',
                'LOCKED_PERIOD', '{}'::jsonb, TIMESTAMP '2026-01-01 00:00:00');
      `,
      expectations: [
        {
          claim:
            "an APPROVED and a REJECTED request keep the hash they were stored with, stale value and all. A terminal row never reaches the hash gate — the status guard returns first — so rewriting it would change a historical record for no benefit and would widen the frozen-snapshot exception this migration is taking",
          sql: `SELECT "id", "proposalHash" FROM "NewBookingPolicyExceptionRequest"
                 WHERE "id" IN ('nbpe-approved', 'nbpe-rejected') ORDER BY "id"`,
          rows: [
            { id: "nbpe-approved", proposalHash: STALE_HASH },
            { id: "nbpe-rejected", proposalHash: STALE_HASH },
          ],
        },
        {
          claim:
            "a LOCKED_PERIOD row has no proposal, no hash and no evidence, and still has none. A blanket rewrite would write a hash of NULL — which on this nullable column would silently blank it rather than fail",
          sql: `SELECT "proposalHash", "proposalSnapshot", "frozenEvidence"
                  FROM "BookingChangeRequest" WHERE "id" = 'bcr-locked'`,
          rows: [
            { proposalHash: null, proposalSnapshot: null, frozenEvidence: null },
          ],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "reverse the guest sort, landing on the pre-#3252 order for the divergent pair",
      harm:
        "This is the defect itself, reproduced: the two guests canonicalise in the other order, the hash is a different 64 characters, and at approval the officer is told the member's untouched proposal no longer matches its signature. It is declared as a reversal rather than as a dropped `COLLATE \"C\"` because a dropped collation only changes anything if the TEST database was initialised with a locale that disagrees, and a fixture whose teeth depend on the environment's locale is the exact hazard this issue is about.",
      find: `             ORDER BY sorted.last_name COLLATE "C",`,
      replace: `             ORDER BY sorted.last_name COLLATE "C" DESC,`,
    },
    {
      name: "rewrite the hash but leave openStateKey alone",
      harm:
        "Silently disarms the duplicate-open-request cap. The stored key still embeds the OLD hash, so when the member resubmits the same proposal the new key does not collide with it, the unique index raises nothing, and they end up holding two open requests for one proposal — each reserving beds against the lodge's capacity.",
      find: `       "openStateKey" = CASE
                          WHEN "openStateKey" IS NULL THEN NULL
                          ELSE 'nbpe:' || "requestedByMemberId" || ':'
                               || _mig3252_proposal_hash("proposalSnapshot")
                        END,`,
      replace: `       "openStateKey" = "openStateKey",`,
    },
    {
      name: "leave the uncovered array in its stored order",
      harm:
        "Moves the failure rather than removing it. The proposal hash now matches, so the tampering gate passes — and then the policy-drift gate compares a violation fingerprint built from this array against a freshly evaluated one, the two orders disagree, and the same waiting request is refused with the policy-drift message instead. The member is still told to resubmit a request nobody touched.",
      find: `       "frozenEvidence" = CASE
                            WHEN "frozenEvidence" IS NULL THEN NULL
                            ELSE _mig3252_resort_evidence("frozenEvidence")
                          END`,
      replace: `       "frozenEvidence" = "frozenEvidence"`,
    },
    {
      name: "sort the uncovered array by guestRef only, dropping the night",
      harm:
        "Produces a stable-looking order that is not the application's. The array is fingerprinted as `{night} {guestRef}` pairs joined in order, so a guest-night set spanning more than one night lands in a different sequence from the fresh evaluation and every such request is refused as policy drift.",
      find: `                               ORDER BY (night_row.value->>'night') COLLATE "C",
                                        (night_row.value->>'guestRef') COLLATE "C"`,
      replace: `                               ORDER BY (night_row.value->>'guestRef') COLLATE "C"`,
    },
    {
      name: "drop the REQUESTED scope from the new-booking rewrite",
      harm:
        "Rewrites the stored fingerprint of every request in the club's history, including approved ones that record what an officer actually authorised. Those rows never re-derive their hash, so nothing would ever notice — the migration would quietly edit the audit trail of past decisions while appearing to work, and the deliberate one-off frozen-column exception would have become a general one.",
      find: ` WHERE "status" = 'REQUESTED'
   AND (
        "proposalHash" <> _mig3252_proposal_hash("proposalSnapshot")
     OR "frozenEvidence" <> _mig3252_resort_evidence("frozenEvidence")
   );`,
      replace: ` WHERE (
        "proposalHash" <> _mig3252_proposal_hash("proposalSnapshot")
     OR "frozenEvidence" <> _mig3252_resort_evidence("frozenEvidence")
   );`,
    },
  ],
};

export default verification;
