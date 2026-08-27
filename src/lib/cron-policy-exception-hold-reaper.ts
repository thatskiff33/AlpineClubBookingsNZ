/**
 * Abandoned policy-exception capacity-hold reaper (#2553, follow-up to #2525).
 *
 * A HOLD-mode policy-exception request reserves real beds the moment it is
 * raised (`PolicyExceptionReservationNight`, #2525) so that an eventual approval
 * is guaranteed to fit. Every DECIDED outcome gives those beds back atomically —
 * the officer's reject, the member's cancel, a supersede, or the approval that
 * turns them into the executed booking's own beds. What had no owner was the
 * request nobody ever decides: it stayed REQUESTED and held its beds forever,
 * blocking other members' admissions until an officer noticed and rejected it by
 * hand.
 *
 * This cron is that missing owner. It mirrors the `nonMemberHoldUntil`
 * auto-cancel pattern (`cron-confirm-pending.ts`) and the stale group-settlement
 * reaper (`cron-group-settlement-reaper.ts`): scan for holds past their
 * deadline, then resolve each one through the SAME guarded transition the
 * decided outcomes use.
 *
 * Three properties do the work:
 *
 *  - **It only ever touches a hold that is demonstrably stranding beds.** The
 *    scan is REQUESTED + POLICY_EXCEPTION + HOLD aggregate + at least one live
 *    `PolicyExceptionReservationNight` row. A HOLD request that reserved nothing
 *    (a pure shrink) costs the club no capacity, so this cron never closes it.
 *  - **The release path is not forked.** Each expiry calls
 *    `resolvePolicyExceptionRequestTerminal` with `to: "EXPIRED"` — the identical
 *    global `lock(1)` -> per-lodge lock -> guarded `version` CAS ->
 *    request-scoped `deleteMany` that REJECTED / CANCELLED / SUPERSEDED run. No
 *    second release implementation exists to drift.
 *  - **It is idempotent.** The deadline is an immutable column, the claim is
 *    guarded on `status = REQUESTED` AND the exact `version` read during the
 *    scan, and a lost claim releases nothing and reports nothing. A rerun over
 *    an already-expired request matches no row and does nothing; two runners
 *    racing the same request produce exactly one expiry. A lost claim is the only
 *    silent outcome: a row the helper REFUSES before the claim (see
 *    `ResolveTerminalRefusal`) can never self-heal, so it is counted as
 *    `unresolvable` and logged at warn instead.
 *
 * **The member is told, and the expiry is audited — both strictly after the
 * release commits.** Owner decision, 2 Aug 2026 (#2553): closing a member's
 * request and taking back the beds they reserved is not something to do silently,
 * and it matches the two comparable sweeps in this tree (the `nonMemberHoldUntil`
 * auto-cancel emails the bumped guest; the member-guest consent expiry notifies
 * the member). So each expiry now leaves three records:
 *
 *  - the request's own `EXPIRED` status, which the member already sees on their
 *    booking's Change Requests card and an officer sees in the queue's ALL view;
 *  - a `booking-policy-exception-request.expired` AuditLog row, so an officer
 *    asked "why did this close?" has an answer without reading server logs;
 *  - a `policy-exception-request-expired` courtesy email to the member who raised
 *    it, so their next act is not a duplicate request raised in ignorance.
 *
 * **Both side effects sit OUTSIDE the release transaction, by construction.**
 * `resolvePolicyExceptionRequestTerminal` owns that transaction and stays a
 * single, unforked path; the audit write and the send happen after it returns. A
 * failed send must never roll back a capacity release (the beds are already back
 * in the pool and the request is no longer `REQUESTED`, so nothing could be
 * replayed), must never re-run one, and must never stop the reaper working
 * through its other candidates — hence one try/catch per side effect per
 * candidate, logged and swallowed. That is also the repo rule on keeping provider
 * calls out of long transactions (`docs/CONCURRENCY_AND_LOCKING.md`).
 */
import { prisma } from "@/lib/prisma";
import { createAuditLog } from "@/lib/audit";
import { resolvePolicyExceptionRequestTerminal } from "@/lib/booking-exception-execution";
import { computePolicyExceptionHoldExpiry } from "@/lib/booking-exception-requests";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { formatDateOnly } from "@/lib/date-only";
import { sendPolicyExceptionRequestExpiredEmail } from "@/lib/email/booking";
import logger from "@/lib/logger";
import { resolveEffectiveEmail } from "@/lib/member-email";

/** `CronJobRun.jobName` and the log/audit tag for this job. */
const JOB_NAME = "policy-exception-hold-reaper";

/** The AuditLog action recorded for each expiry (sibling of `.create`/`.cancel`). */
export const POLICY_EXCEPTION_EXPIRY_AUDIT_ACTION =
  "booking-policy-exception-request.expired";

export interface PolicyExceptionHoldReapResult {
  /** Open HOLD-mode policy-exception requests examined this run. */
  scanned: number;
  /** Requests this run moved REQUESTED -> EXPIRED. */
  expired: number;
  /** Reservation night rows those expiries released. */
  releasedNights: number;
  /** Requests whose expiry threw; logged and retried on the next run. */
  failed: number;
  /**
   * Past-deadline requests the shared terminal transition REFUSED outright (not a
   * policy-exception row, or an unparsable `proposalSnapshot`). A refusal is
   * permanent, so these beds stay stranded and no retry will free them — they are
   * counted into `CronJobRun.resultSummary` and logged at warn precisely so a
   * stuck hold cannot hide behind a green cron-health row. Non-zero here means a
   * human has to look at the row.
   */
  unresolvable: number;
}

/**
 * Release every abandoned HOLD-mode policy-exception hold whose deadline has
 * passed, marking each request EXPIRED.
 *
 * The candidate scan is deliberately narrow — open, policy-exception, HOLD
 * aggregate, and actually holding reservation nights — which is a handful of rows
 * even on a busy club, so the deadline comparison happens in memory rather than
 * as a second index requirement.
 */
export async function reapExpiredPolicyExceptionHolds(
  now: Date = new Date(),
): Promise<PolicyExceptionHoldReapResult> {
  const candidates = await prisma.bookingChangeRequest.findMany({
    where: {
      kind: "POLICY_EXCEPTION",
      status: "REQUESTED",
      // Only a HOLD aggregate ever reserved beds (#2525); a NO_HOLD request
      // strands no capacity, so it is not this cron's business and keeps its
      // place in the officer queue until somebody decides it.
      aggregateCapacityMode: "HOLD",
      // ...and only a request that is DEMONSTRABLY still holding beds right now.
      // A HOLD aggregate can reserve nothing at all (a pure shrink, or a
      // reshuffle that adds no bed on any night — `computeProposalReservation`
      // returns an empty footprint), and reservation rows are written only at
      // creation and deleted only by a terminal transition, so for a REQUESTED
      // row "has reservation nights" is exactly "is stranding capacity". This
      // filter is what keeps the cron's blast radius to the bug in the issue: it
      // can never close a live request that costs the club nothing to leave open.
      reservationNights: { some: {} },
    },
    select: {
      id: true,
      version: true,
      holdExpiresAt: true,
      createdAt: true,
      // For the audit row written after a successful expiry: whose request lapsed
      // and which booking it belonged to.
      bookingId: true,
      requestedByMemberId: true,
      // The EARLIEST night this request is holding. The scan already correlates
      // this exact relation (`reservationNights: { some: {} }` above), so carrying
      // one column of its first row costs no extra index and lets the NULL-column
      // fallback below apply the SAME rule as the stamped deadline, first-night cap
      // included.
      reservationNights: {
        select: { night: true },
        orderBy: { night: "asc" },
        take: 1,
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // #3123 — ONE read of the club's persisted zone for the whole run, taken
  // before the loop. Only the NULL-`holdExpiresAt` fallback below needs it, but
  // resolving it inside the loop would be one uncached `ClubTimeSettings` query
  // per candidate row, and a run straddling club midnight could cap two rows'
  // holds against two different days. This module is instrumentation-reachable
  // (`instrumentation.node.ts` -> `general-cron-runner.ts` -> here), so it takes
  // the runtime reader rather than the `server-only` binding, which would throw
  // at import when the cron loads.
  const clubZone = await readClubTimeZoneOutsideRequest();

  const result: PolicyExceptionHoldReapResult = {
    scanned: candidates.length,
    expired: 0,
    releasedNights: 0,
    failed: 0,
    unresolvable: 0,
  };

  for (const candidate of candidates) {
    // `holdExpiresAt` is stamped at creation and never rewritten, so it is the
    // authoritative deadline. Inside THIS scan, NULL means the row predates the
    // column: a bed-holding request written before the #2553 migration, or one the
    // OLD colour wrote between `migrate` and cutover. Either way it has no stored
    // deadline and would otherwise hold its beds forever, exactly the bug this
    // issue exists to close. (The other NULL population, a HOLD aggregate that
    // reserved nothing, never reaches here: the `reservationNights` filter above
    // excludes it.)
    //
    // The fallback is the IDENTICAL pure rule, applied to `createdAt` and to the
    // request's own earliest held night. Dropping the first-night cap here would
    // NOT be the safe direction: the cap is what returns beds to the pool once the
    // stay has begun, so an uncapped fallback would phantom-block a lodge through
    // the whole stay — the precise harm the TTL exists to prevent — and it would
    // do it to the one population that has no stamped deadline to fall back on.
    // The 24-hour floor still applies inside the shared rule, so a request raised
    // moments before its first night keeps a real review window.
    const firstHeldNight = candidate.reservationNights[0]
      ? formatDateOnly(candidate.reservationNights[0].night)
      : null;
    const deadline =
      candidate.holdExpiresAt ??
      computePolicyExceptionHoldExpiry({
        createdAt: candidate.createdAt,
        firstHeldNight,
        zone: clubZone,
      });
    if (now < deadline) continue;

    try {
      const outcome = await resolvePolicyExceptionRequestTerminal({
        requestId: candidate.id,
        expectedVersion: candidate.version,
        to: "EXPIRED",
      });
      if (!outcome.claimed) {
        if (outcome.refused) {
          // NOT a race. The helper refused this row before the claim — it is not a
          // policy-exception request, or its `proposalSnapshot` does not parse — and
          // a retry will refuse it again, so its beds stay stranded until a human
          // looks. Count it and say so, rather than reporting a clean run forever.
          result.unresolvable += 1;
          logger.warn(
            {
              changeRequestId: candidate.id,
              reason: outcome.refused,
              deadline: deadline.toISOString(),
              job: JOB_NAME,
            },
            "Cannot expire a past-deadline policy-exception hold: the terminal transition refused the row, so its beds stay held",
          );
          continue;
        }
        // Somebody decided it between the scan and the lock (approved,
        // rejected, cancelled, superseded) — their transition wins and already
        // dealt with the beds. Nothing to release, nothing to report; the next
        // run re-reads the row's fresh version if it is somehow still open.
        continue;
      }
      result.expired += 1;
      result.releasedNights += outcome.released;
      logger.info(
        {
          changeRequestId: candidate.id,
          releasedNights: outcome.released,
          job: JOB_NAME,
        },
        "Released an abandoned policy-exception capacity hold and expired its request",
      );
      await recordExpiryAudit({
        changeRequestId: candidate.id,
        bookingId: candidate.bookingId,
        requestedByMemberId: candidate.requestedByMemberId,
        releasedNights: outcome.released,
        deadline,
        deadlineSource: candidate.holdExpiresAt ? "stamped" : "created-at",
      });
      // Post-commit courtesy notice. Exactly once per expiry, because the
      // `version` CAS above means exactly one runner can reach this line for a
      // given request; and never for a candidate that was not expired.
      await notifyMemberOfExpiry({
        changeRequestId: candidate.id,
        bookingId: candidate.bookingId,
        requestedByMemberId: candidate.requestedByMemberId,
        deadline,
      });
    } catch (err) {
      result.failed += 1;
      logger.error(
        {
          err,
          changeRequestId: candidate.id,
          job: JOB_NAME,
        },
        "Failed to expire an abandoned policy-exception capacity hold",
      );
    }
  }

  return result;
}

/**
 * Record the expiry in the audit trail, so the request's timeline reads
 * created -> expired rather than created -> nothing. Sibling of the
 * `booking-policy-exception-request.create` / `.cancel` rows the member routes
 * write, with no actor: a cron has no member behind it, so the lapsed request's
 * own member is the subject and `memberId` stays null.
 *
 * Written AFTER the release commits, exactly like those routes write theirs after
 * their own transactions — the shared terminal helper owns the release transaction
 * and stays a single, unforked path. A failure here is therefore logged and
 * swallowed rather than counted as a failed expiry: the beds are already back in
 * the pool and the request is no longer `REQUESTED`, so no retry could repeat the
 * work, and turning a successful release into a reported failure would be a lie an
 * operator then chases.
 */
async function recordExpiryAudit(input: {
  changeRequestId: string;
  bookingId: string;
  requestedByMemberId: string;
  releasedNights: number;
  deadline: Date;
  deadlineSource: "stamped" | "created-at";
}): Promise<void> {
  try {
    await createAuditLog({
      action: POLICY_EXCEPTION_EXPIRY_AUDIT_ACTION,
      targetId: input.bookingId,
      subjectMemberId: input.requestedByMemberId,
      entityType: "BookingChangeRequest",
      entityId: input.changeRequestId,
      category: "booking",
      outcome: "success",
      summary:
        "Abandoned policy-exception request expired and its capacity hold released",
      metadata: {
        source: "MODIFICATION",
        bookingId: input.bookingId,
        requestId: input.changeRequestId,
        releasedNights: input.releasedNights,
        deadline: input.deadline.toISOString(),
        deadlineSource: input.deadlineSource,
        job: JOB_NAME,
      },
    });
  } catch (err) {
    logger.error(
      {
        err,
        changeRequestId: input.changeRequestId,
        job: JOB_NAME,
      },
      "Expired a policy-exception capacity hold but failed to write its audit row",
    );
  }
}

/**
 * Tell the member their request lapsed and its held beds went back to the pool
 * (owner decision, 2 Aug 2026).
 *
 * POST-COMMIT AND FULLY ISOLATED, for three reasons that are all the same reason:
 * the release has already happened. This function is called after
 * `resolvePolicyExceptionRequestTerminal` returned a claimed outcome, so (a) a
 * send failure must not roll the release back — it cannot, the transaction is
 * closed; (b) it must not cause a retry, because the request is no longer
 * `REQUESTED` and the reservation rows are gone, so a "retry" would be a second
 * release of beds that are already free; and (c) it must not stop the loop, so
 * every other past-deadline hold in this run is still returned. Hence this NEVER
 * throws: every failure is logged and swallowed, exactly like the audit write
 * beside it, and `result.failed` therefore keeps meaning "the release itself
 * failed" rather than "some notice did".
 *
 * A failed send is not lost, either — `sendEmail` writes its own `EmailLog` row
 * and the retryable classes are picked up by the email retry cron, which is the
 * operator surface for mail. That is why a bounced courtesy notice needs no
 * counter of its own on the cron-health row: unlike an `unresolvable` hold, no
 * capacity is stranded by it.
 *
 * The context is read HERE rather than carried on the scan so the reaper does not
 * read a member's address for every candidate it merely considers — only for the
 * ones it actually closed.
 */
async function notifyMemberOfExpiry(input: {
  changeRequestId: string;
  bookingId: string;
  requestedByMemberId: string;
  deadline: Date;
}): Promise<void> {
  try {
    const context = await prisma.bookingChangeRequest.findUnique({
      where: { id: input.changeRequestId },
      select: {
        // The member who RAISED the request, who is not always the booking's
        // owner (a family delegate can raise one) — they are the person whose
        // request just closed, and the authority the optional booking link in
        // the mail is resolved against.
        requestedBy: {
          select: {
            firstName: true,
            email: true,
            // Selected so the effective address is resolved without a second
            // query when this member inherits a household address.
            inheritEmailFromId: true,
            inheritEmailFrom: { select: { email: true } },
          },
        },
        booking: { select: { checkIn: true, checkOut: true, lodgeId: true } },
      },
    });
    if (!context) {
      // The row was hard-deleted between the release and this read. Not silent:
      // somebody's request was closed and nobody was told.
      logger.warn(
        { changeRequestId: input.changeRequestId, job: JOB_NAME },
        "Expired a policy-exception capacity hold but its request row vanished before the member could be told",
      );
      return;
    }

    await sendPolicyExceptionRequestExpiredEmail({
      bookingId: input.bookingId,
      recipientMemberId: input.requestedByMemberId,
      email: resolveEffectiveEmail(context.requestedBy),
      firstName: context.requestedBy.firstName,
      checkIn: context.booking.checkIn,
      checkOut: context.booking.checkOut,
      // The deadline that actually applied to this row — stamped, or derived from
      // `createdAt` for a pre-migration hold — never "now", so the member is told
      // the date they were really working to.
      expiresAt: input.deadline,
      lodgeId: context.booking.lodgeId,
    });
  } catch (err) {
    logger.error(
      {
        err,
        changeRequestId: input.changeRequestId,
        job: JOB_NAME,
      },
      "Expired a policy-exception capacity hold but failed to tell the member",
    );
  }
}
