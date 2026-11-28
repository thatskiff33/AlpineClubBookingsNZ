import { vi } from "vitest";

/**
 * Test doubles for the hosting participant fence (#2597, hardened in #2619).
 *
 * `acquireHostingCoverageQueueParticipantProof` locks the exact sorted Member
 * rows `FOR KEY SHARE NOWAIT`, then does two reads UNDER that lock:
 *
 *   1. a typed `member.findMany` re-read, requiring every locked id to still
 *      exist, in sorted order;
 *   2. a `booking.findMany` re-read of each source booking's owner and lodge,
 *      requiring the `sourceFingerprint` to match what the caller planned.
 *
 * A double that models neither read makes the fence report contention — or
 * crash outright when the delegate is missing — so before #2619 these suites
 * exercised their seams with the fence effectively switched off. Modelling both
 * reads is what makes the drift check mean anything: it must PASS for unchanged
 * data and FAIL for drifted data, and a double that always returns nothing can
 * do neither.
 *
 * These helpers deliberately answer only the fence's own query shapes and
 * delegate everything else, so adding them to an existing double cannot change
 * what the rest of a suite already asserts.
 */

/**
 * `adultMemberHostingPolicy.findMany` for the mode gate that now stands IN FRONT
 * of the fence (#2623 T5).
 *
 * `reconcileAdultMemberHostingReviewWithSiblings` reads the lodge's resolved
 * hosting mode before acquiring a participant proof, so a club with the rule off
 * pays no row lock on an ordinary booking write. That read is not new to those
 * paths: `evaluateBookingAdultMemberHosting` has always loaded the same policy
 * for the same lodge through the same client, one call deeper. A double reaches
 * it now only because the seams above bail out at
 * `if (!Array.isArray(booking.guests))` before the evaluation ever runs — an
 * artifact of narrow booking fixtures, not of production, where the reconciler's
 * select always hydrates the relation.
 *
 * THE ROW IS DELIBERATELY AN *ACTIVE* MODE. A double that answered `DISABLED`
 * (or `[]`, which resolves to `DISABLED`) would take the new gate's early return
 * and switch the participant fence off in exactly the suites #2619 added it to,
 * re-creating the "exercised their seams with the fence effectively switched
 * off" state described above — silently, and with the fence doubles beside it
 * still looking like coverage. `ENFORCED` keeps the fence on the path, so these
 * suites behave exactly as they did before the gate existed.
 *
 * The scope set is the narrowest one that is still a decided set: `sameBooking`
 * only. `sameBookingOwner` would pull the coverage-owner advisory key and the
 * same-owner settle step into suites that never modelled either.
 *
 * `mode` IS THEREFORE NOT A FREE KNOB (#2675 review). Callers may pick between
 * the two ACTIVE modes — `ENFORCED` (a hosting hazard refuses the write) and
 * `ADMIN_REVIEW_REQUIRED` (it is recorded and the write proceeds) — because that
 * choice changes what a suite's own assertions see. They may not select an
 * inactive one: `hostingModeIsActive` admits only those two, so anything else
 * re-opens the #2623 T5 bypass in the very suites this helper exists to close it
 * in. The census in `adult-member-hosting-call-sites.test.ts` cannot catch that
 * on its own — it can only see that the helper is CALLED — so the refusal is
 * here, at the one place the value is written.
 */

/** The modes `hostingModeIsActive` admits — the only ones a double may state. */
export type ActiveHostingMode = "ENFORCED" | "ADMIN_REVIEW_REQUIRED";
const ACTIVE_HOSTING_MODES: readonly string[] = [
  "ENFORCED",
  "ADMIN_REVIEW_REQUIRED",
];

export function fenceHostingPolicyFindMany(
  overrides: Omit<Record<string, unknown>, "mode"> & {
    mode?: ActiveHostingMode;
  } = {},
) {
  // Runtime guard as well as a type, because a suite can widen its way past the
  // type (`as`, an untyped spread, a `Record<string, unknown>` built elsewhere)
  // and the failure mode is silent: the gate at
  // `adult-member-hosting-review.ts` returns before the participant fence, every
  // fence double beside it stops being reached, and every test stays green.
  // That is #2623 T5 and #2675 exactly.
  if (
    "mode" in overrides &&
    !ACTIVE_HOSTING_MODES.includes(String(overrides.mode))
  ) {
    throw new Error(
      `fenceHostingPolicyFindMany: mode must be an ACTIVE hosting mode ` +
        `(${ACTIVE_HOSTING_MODES.join(" or ")}), got ${JSON.stringify(overrides.mode)}. ` +
        `An inactive mode takes the #2623 T5 early return in ` +
        `reconcileAdultMemberHostingReviewWithSiblings, so the #2619 participant ` +
        `fence is never reached and the doubles beside it assert nothing — the ` +
        `#2675 bypass, silently restored. A suite that genuinely needs the rule ` +
        `switched off must not wire this helper at all, and must be listed in ` +
        `FENCE_DOUBLES_WITHOUT_AN_ACTIVE_POLICY with its reason.`,
    );
  }
  return vi.fn(async () => [
    {
      id: "fence-double-club-policy",
      scopeKey: "club-wide",
      lodgeId: null,
      mode: "ENFORCED",
      capacityMode: "NO_HOLD",
      version: 1,
      hostScopeSameBooking: true,
      hostScopeSameBookingOwner: false,
      ...overrides,
    },
  ]);
}

/**
 * `hostingCoverageReevaluation` for a double whose policy is an active mode.
 *
 * Every seam that can change cover queues a re-evaluation at BOTH active modes
 * (`INV-HOST-045`), so a booking write that passes the fence above reaches
 * `enqueueHostingCoverageReevaluation` under `ADMIN_REVIEW_REQUIRED` as well as
 * `ENFORCED`. `create` records the item and answers the id the seam returns;
 * the post-commit drain's reads answer "nothing queued", which is what a
 * best-effort drain needs to finish quietly.
 */
export function fenceHostingCoverageQueue() {
  return {
    create: vi.fn(async () => ({ id: "fence-double-reevaluation" })),
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => null),
    updateMany: vi.fn(async () => ({ count: 0 })),
  };
}

/**
 * The live `Member` row the hosting EVALUATOR reads off a booking guest (#2675).
 *
 * `BOOKING_HOSTING_SELECT` hydrates `guests.member` with exactly these five
 * columns, and `memberIsInGoodStanding` reads three of them. A guest fixture
 * that carries `isMember: true` with no `member` relation is therefore a shape
 * production cannot emit, and it does not fail honestly: `member !== null` is
 * TRUE for `undefined`, so the predicate goes on to read `undefined.active` and
 * the seam throws a `TypeError` instead of treating the guest as a non-member.
 *
 * That never showed while the fence doubles left the lodge's hosting mode at the
 * resolver's `DISABLED` default, because `evaluateBookingAdultMemberHosting`
 * builds no participants at all unless the mode is active. Pairing
 * `fenceHostingPolicyFindMany` with a fixture whose guests carry this row is
 * what makes a suite genuinely hosting-evaluable.
 *
 * ADULT AND IN GOOD STANDING by default, because that is the shape that keeps an
 * existing suite's assertions intact: an adult member participant qualifies as a
 * host, so a fixture whose guests are all members raises no hosting violation
 * and the seam behaves exactly as it did with the rule off — while the fence in
 * front of it is now genuinely exercised. Pass `overrides` to model a lapsed,
 * archived or non-adult member deliberately, and `null` (not a partial row) to
 * model a true non-member guest.
 *
 * THE CALLER MUST PASS THE GUEST ROW'S OWN `ageTier` rather than relying on the
 * ADULT default (#2675 review). `BookingGuest.ageTier` and `Member.ageTier` are
 * separate columns that a real row always agrees on, and
 * `participantQualifiesAsHost` reads the MEMBER's. Deriving this row from
 * `memberId` alone therefore turns any member-linked CHILD or YOUTH guest into
 * an adult host and suppresses a hosting violation production would raise —
 * silently, because nothing in the suite asserts the tier.
 */
export function hostingMemberRow(
  id: string,
  overrides: Partial<{
    ageTier: string;
    active: boolean;
    cancelledAt: Date | null;
    archivedAt: Date | null;
  }> = {},
) {
  return {
    id,
    ageTier: "ADULT",
    active: true,
    cancelledAt: null,
    archivedAt: null,
    ...overrides,
  };
}

/**
 * A source booking as the fence re-reads it.
 *
 * `lodgeId` is `string`, not `string | null`, deliberately: `Booking.lodgeId` is
 * NOT NULL in the schema, so a real row always carries one. Allowing it to be
 * absent here would let a fixture compare `"bk1:m1:undefined"` against itself
 * and pass the drift check vacuously — and would hide a real failure, because
 * if a planner's select ever dropped `lodgeId` production would compare an
 * undefined plan against a re-read that has one and refuse every booking write.
 */
export interface FenceBookingRow {
  id: string;
  memberId: string;
  lodgeId: string;
}

/**
 * `member.findMany` for the fence's existence/order re-read: echo the requested
 * ids back, sorted, so every locked participant is present and in order.
 *
 * Pass `missing` to model a participant that vanished under the lock — the
 * fence must then refuse rather than proceed.
 */
export function fenceMemberFindMany(
  missing: readonly string[] = [],
  /**
   * Handles every OTHER member.findMany a suite makes. Pass a double's
   * existing implementation when the delegate is shared, so dropping this in
   * cannot change what the rest of the suite already asserts.
   */
  existing?: (args: unknown) => unknown,
) {
  return vi.fn(async (args?: {
    where?: { id?: { in?: readonly string[] } };
    select?: Record<string, unknown>;
    orderBy?: unknown;
  }) => {
    // The fence's re-read asks for ids only, keyed on id alone, in id order.
    //
    // The `where` must have EXACTLY the one `id` key. Matching on
    // `where.id.in` plus an ids-only select is not specific enough: other
    // production guards issue the same select with extra predicates — notably
    // `assertLinkedMembersExist` (booking-request-quotes.ts), which asks for
    // `{ id: { in }, active: true, archivedAt: null }`. Answering that here
    // would report every requested member as found, active and unarchived,
    // making its "linked member not found" refusal unfailable in any suite
    // using this helper. Same hazard for the merge participant lock's own
    // re-read and family-suggestions.
    const where = args?.where as Record<string, unknown> | undefined;
    const select = args?.select;
    const isFenceRead =
      Array.isArray(args?.where?.id?.in) &&
      !!where &&
      Object.keys(where).length === 1 &&
      !!select &&
      Object.keys(select).length === 1 &&
      select.id === true;
    if (!isFenceRead) {
      return existing ? await existing(args) : [];
    }
    return [...(args?.where?.id?.in ?? [])]
      .filter((id) => !missing.includes(id))
      .sort()
      .map((id) => ({ id }));
  });
}

/** The fence's booking re-read selects exactly these three columns. */
function isFenceBookingRead(args: unknown): args is {
  where: { id: { in: string[] } };
  select: Record<string, boolean>;
} {
  const a = args as
    | { where?: { id?: { in?: unknown } }; select?: Record<string, unknown> }
    | undefined;
  if (!Array.isArray(a?.where?.id?.in)) return false;
  const select = a?.select;
  if (!select) return false;
  const keys = Object.keys(select).sort();
  return (
    keys.length === 3 &&
    keys[0] === "id" &&
    keys[1] === "lodgeId" &&
    keys[2] === "memberId"
  );
}

/**
 * `booking.findMany` that answers the fence's owner/lodge re-read from the
 * bookings a suite already set up, and hands every other query to the double's
 * existing implementation.
 *
 * `lookup` returns the authoritative row for an id, or undefined if the booking
 * is gone — which the fence must treat as drift.
 */
export function fenceBookingFindMany(
  lookup: (id: string) => FenceBookingRow | undefined,
  existing?: (args: unknown) => unknown,
) {
  return vi.fn(async (args: unknown) => {
    if (isFenceBookingRead(args)) {
      return [...args.where.id.in]
        .sort()
        .map(lookup)
        .filter((row): row is FenceBookingRow => Boolean(row));
    }
    return existing ? await existing(args) : [];
  });
}

/**
 * The generic way to satisfy the fence's drift check without restating a
 * suite's fixtures.
 *
 * The production caller plans its participants from a booking it just read, so
 * the no-drift case is exactly "the fence sees what that read returned". This
 * wraps a suite's own `booking.findUnique` double, remembers the owner/lodge of
 * every booking it serves, and replays those rows for the fence's re-read — so
 * the fingerprints match by construction rather than by a hand-copied fixture
 * that can silently drift away from the real one.
 *
 * Drift is still expressible, and still fails: change what `findUnique`
 * returns between the plan and the re-read, or use `overrides` to state the
 * post-lock truth directly.
 */
export function recordingBookingDouble(
  findUnique: (args: unknown) => unknown,
  options: {
    /**
     * Bookings the caller planned from BEFORE entering this client — typically
     * a read on the outer prisma double, where a transaction-scoped recorder
     * cannot see it. Without these the fence reports drift that never happened.
     */
    seed?: readonly FenceBookingRow[];
    overrides?: Map<string, FenceBookingRow | undefined>;
  } = {},
) {
  const overrides = options.overrides ?? new Map();
  const seen = new Map<string, FenceBookingRow>(
    (options.seed ?? []).map((row) => [row.id, row]),
  );

  const recordingFindUnique = vi.fn(async (args: unknown) => {
    const row = (await findUnique(args)) as
      | (Partial<FenceBookingRow> & { id?: string })
      | null
      | undefined;
    if (
      row &&
      typeof row.id === "string" &&
      typeof row.memberId === "string" &&
      typeof row.lodgeId === "string"
    ) {
      // Record lodgeId EXACTLY as served, and only when it IS served. A row
      // without one is not a row this fence could ever see in production, so
      // it is not recorded — the fence then finds no source booking and
      // refuses, which is the honest outcome and points at the fixture.
      seen.set(row.id, {
        id: row.id,
        memberId: row.memberId,
        lodgeId: row.lodgeId,
      });
    }
    return row;
  });

  const lookup = (id: string) =>
    overrides.has(id) ? overrides.get(id) : seen.get(id);

  return {
    findUnique: recordingFindUnique,
    findMany: fenceBookingFindMany(lookup),
    lookup,
    /** State the post-lock truth for one booking, to model drift. */
    drift(id: string, row: FenceBookingRow | undefined) {
      overrides.set(id, row);
    },
  };
}
