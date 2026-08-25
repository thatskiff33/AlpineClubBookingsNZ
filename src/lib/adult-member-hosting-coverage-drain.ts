import type { Prisma } from "@prisma/client";

import {
  claimHostingCoverageOwnerNotification,
  completeHostingCoverageOwnerNotification,
  isHostingCoverageOwnerNotificationPending,
  loadHostingCoverageOwnerNotificationDelivery,
  releaseHostingCoverageOwnerNotification,
  resolveHostingCoverageIncidents,
} from "@/lib/adult-member-hosting-coverage-incidents";
import {
  claimHostingCoverageReevaluations,
  completeHostingCoverageReevaluation,
  deferHostingCoverageReevaluation,
  failHostingCoverageReevaluation,
  loadClaimedHostingCoverageReevaluation,
  releaseHostingCoverageReevaluationContention,
  renewHostingCoverageReevaluationClaim,
  type HostingCoverageReevaluationItem,
} from "@/lib/adult-member-hosting-coverage-queue";
import { tryLockAdultMemberHostingPolicySet } from "@/lib/adult-member-hosting-policy-set";
import {
  isHostingCoverageSourceBookingTerminal,
  loadSameOwnerCoverageDependentIds,
  loadAdultMemberHostingPolicy,
  reconcileSameOwnerCoverageIncident,
} from "@/lib/adult-member-hosting-review";
import { sendHostingCoverageLostEmail } from "@/lib/email/booking";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * Drain the bounded same-owner re-evaluation queue (#2576 §8).
 *
 * The post-commit half of the escalation path: an authoritative change recorded
 * what needs looking at inside its own transaction, and this re-reads the facts,
 * settles each dependent booking's incident, and notifies the owner once per
 * transition.
 *
 * Each claimed item is reconciled inside one SHORT transaction. That is required
 * because the evaluator's owner advisory lock is transaction-scoped: without the
 * wrapper it would be released immediately after the lock statement and protect
 * none of the reads or incident writes. The transaction starts only after the
 * authoritative caller commit, so it still re-reads committed facts, and email is
 * sent only after this reconciliation transaction commits.
 *
 * RUN TWICE, ON PURPOSE. Callers run it INLINE immediately after their commit, so
 * §7's "immediate re-evaluation" is real; the general cron sweep runs it again so
 * a crashed process, a failed email or a redeployment mid-drain cannot leave a
 * booking uncovered with nobody told. Inline failures are logged and swallowed —
 * the authoritative change has already committed and must not be undone by a
 * follow-up problem — because the cron is the authority on completion.
 */

export interface HostingCoverageDrainResult {
  claimed: number;
  processed: number;
  incidentsOpened: number;
  incidentsUpdated: number;
  incidentsResolved: number;
  notified: number;
  failed: number;
}

const EMPTY_RESULT: HostingCoverageDrainResult = {
  claimed: 0,
  processed: 0,
  incidentsOpened: 0,
  incidentsUpdated: 0,
  incidentsResolved: 0,
  notified: 0,
  failed: 0,
};

/**
 * Drain the queue immediately after a caller's transaction has committed, and never
 * let a problem in the drain surface as a failure of the change that committed
 * (#2576 §7's "immediate re-evaluation", §8's "re-read current facts after commit").
 *
 * BEST-EFFORT ON PURPOSE, AND THE CRON IS THE AUTHORITY. The authoritative change
 * is already committed and must not be undone by a follow-up problem — an officer's
 * cancellation does not un-cancel because an email bounced — so every failure here
 * is logged and swallowed. The queue row is still unprocessed, so the general cron
 * sweep re-runs it; the cost of the inline attempt failing is a delay, never a lost
 * obligation.
 *
 * MUST BE CALLED AFTER THE COMMIT, never inside the transaction. Inside, it would
 * read the uncommitted rows it exists to re-read, and it would send email from a
 * transaction that can still roll back. Callers place it after their
 * `prisma.$transaction(...)` returns.
 *
 * A no-op when the queue is empty — one indexed read that returns nothing — so a
 * club that is not on this scope pays a single cheap query per mutation, and only
 * on the paths that can escalate.
 *
 * SCOPED TO THE BOOKING THAT WAS JUST WRITTEN, AND THAT IS NOT AN OPTIMISATION.
 * Callers pass `bookingId`; this resolves its owner and lodge and claims only their
 * items, with a small limit. An unfiltered inline claim meant that after an
 * officer's bulk cancellation or a membership sweep left a backlog, the next
 * unrelated member's guest edit would run up to 25 OTHER owners' reconciliations —
 * each fanning out to as many as 25 dependents, each able to send a synchronous
 * loss-of-cover email — inside their request, before it answered. The cron drains
 * everything; a member's request drains only what their own transaction created.
 *
 * A caller that cannot name a booking (it was hard-deleted, or the work is a
 * member-level fan-out across lodges) may pass nothing and gets the unfiltered
 * claim, still capped: the obligation is real and the cron is only three hours away
 * at worst, but immediate is better.
 */
export async function settleHostingCoverageAfterCommit(
  options: {
    /** The booking whose transaction just committed; scopes the claim. */
    bookingId?: string | null;
    memberId?: string | null;
    lodgeId?: string | null;
    limit?: number;
  } = {},
  db: typeof prisma = prisma,
): Promise<HostingCoverageDrainResult> {
  try {
    let { memberId, lodgeId } = options;
    if (options.bookingId && !memberId && !lodgeId) {
      const booking = await db.booking.findUnique({
        where: { id: options.bookingId },
        select: { memberId: true, lodgeId: true },
      });
      memberId = booking?.memberId ?? null;
      lodgeId = booking?.lodgeId ?? null;
    }
    return await drainHostingCoverageReevaluations(
      {
        limit: options.limit ?? INLINE_DRAIN_LIMIT,
        ...(memberId ? { memberId } : {}),
        ...(lodgeId ? { lodgeId } : {}),
      },
      db,
    );
  } catch (err) {
    logger.error(
      { err },
      "Inline same-owner hosting coverage drain failed; leaving it to the cron sweep",
    );
    return { ...EMPTY_RESULT };
  }
}

/**
 * How many items one member's request will settle inline.
 *
 * Small on purpose. A single change can legitimately produce one item; a handful
 * covers the split-booking and group shapes where one commit touches several. Beyond
 * that the work is somebody else's backlog and belongs to the cron.
 */
const INLINE_DRAIN_LIMIT = 5;
const MAX_MEMBER_ID_STABILIZATION_ATTEMPTS = 3;

type HostingCoverageReconciliationOutcome = {
  kind: "processed";
  incidentsOpened: number;
  incidentsUpdated: number;
  incidentsResolved: number;
  notificationObligations: Array<{
    bookingId: string;
    incidentId: string;
    stateKey: string;
  }>;
  notifications: Array<{
    bookingId: string;
    incidentId: string;
    stateKey: string;
    claimToken: string;
  }>;
};

type HostingCoverageReconciliationTransactionResult =
  | HostingCoverageReconciliationOutcome
  | { kind: "deferred" }
  | { kind: "lost" }
  | { kind: "retry"; item: HostingCoverageReevaluationItem };

export async function drainHostingCoverageReevaluations(
  options: {
    limit?: number;
    maxAttempts?: number;
    memberId?: string | null;
    lodgeId?: string | null;
  } = {},
  db: typeof prisma = prisma,
): Promise<HostingCoverageDrainResult> {
  const limit = options.limit ?? 25;
  if (limit <= 0) return { ...EMPTY_RESULT };

  // Claim only when an item is about to run. A serial batch leased up front gives
  // every later item the same expiry even though it may wait behind slow database
  // and provider work. `seenIds` also prevents a failure whose lease was released
  // below from being immediately reclaimed by this same drain and burning all of
  // its attempts in one invocation.
  const seenIds = new Set<string>();
  const result: HostingCoverageDrainResult = { ...EMPTY_RESULT };
  while (result.claimed < limit) {
    const [item] = await claimHostingCoverageReevaluations(
      { ...options, limit: 1, excludeIds: [...seenIds] },
      db,
    );
    if (!item) break;
    seenIds.add(item.id);
    result.claimed += 1;

    try {
      // The evaluator takes transaction-scoped owner advisory locks. Run all
      // database reconciliation for one bounded item in a REAL transaction so
      // those locks remain held through its reads and incident writes. Email is
      // deliberately handled after this transaction commits.
      let reconciliationItem = item;
      let outcome: HostingCoverageReconciliationOutcome | null = null;
      let claimLost = false;
      let policyLockContended = false;
      for (
        let attempt = 0;
        attempt < MAX_MEMBER_ID_STABILIZATION_ATTEMPTS;
        attempt += 1
      ) {
        const reconciliation = await db.$transaction((tx) =>
          processHostingCoverageReevaluation(reconciliationItem, tx),
        );
        if (reconciliation.kind === "deferred") {
          policyLockContended = true;
          break;
        }
        if (reconciliation.kind === "lost") {
          claimLost = true;
          break;
        }
        if (reconciliation.kind === "retry") {
          reconciliationItem = reconciliation.item;
          continue;
        }
        outcome = reconciliation;
        break;
      }
      if (policyLockContended) {
        const released = await releaseHostingCoverageReevaluationContention(
          item,
          db,
        );
        logger.warn(
          { itemId: item.id, memberId: item.memberId, lodgeId: item.lodgeId },
          released
            ? "Hosting coverage re-evaluation deferred behind the policy-set lock"
            : "Hosting coverage re-evaluation policy-lock deferral arrived after its claim was replaced",
        );
        continue;
      }
      if (claimLost) {
        logger.warn(
          { itemId: item.id, memberId: item.memberId, lodgeId: item.lodgeId },
          "Hosting coverage re-evaluation claim disappeared before its authoritative payload read",
        );
        continue;
      }
      if (!outcome) {
        throw new Error(
          "Hosting coverage re-evaluation member identities did not stabilise after merge",
        );
      }
      result.incidentsOpened += outcome.incidentsOpened;
      result.incidentsUpdated += outcome.incidentsUpdated;
      result.incidentsResolved += outcome.incidentsResolved;

      const terminalNotificationStates = new Set<string>();
      let deliveryClaimLost = false;
      for (const notification of outcome.notifications) {
        try {
          // The notification token alone is not authority to continue this queue
          // item. A successor may have replaced the queue lease while the database
          // reconciliation ran. Renew the exact queue token immediately before
          // every provider unit; a stale worker performs no provider call.
          if (!(await renewHostingCoverageReevaluationClaim(item, db))) {
            deliveryClaimLost = true;
            break;
          }
          const delivery = await notifyOwnerOfLostCoverage(notification, db);
          if (delivery === "sent") {
            const completed = await completeHostingCoverageOwnerNotification(
              notification,
              db,
            );
            if (completed) result.notified += 1;
          } else if (delivery === "retry") {
            throw new Error(
              'Hosting coverage notification was withheld because the booking "No emails" flag could not be read',
            );
          } else {
            // Missing recipients and intentional suppression are terminal for this
            // queue item: the officer incident remains visible, but retrying the
            // identical state cannot make an intentionally withheld message send.
            const released = await releaseHostingCoverageOwnerNotification(
              notification,
              db,
            );
            // A null delivery also means the exact notification token may have
            // been replaced. Only the worker that still owns and releases that
            // token may classify missing-recipient/suppression as terminal. A
            // failed release leaves the exact state for the authoritative pending
            // check below, so a crashed successor cannot be stranded by Q.
            if (released) {
              terminalNotificationStates.add(notificationStateKey(notification));
            }
          }
        } catch (err) {
          await releaseHostingCoverageOwnerNotification(notification, db).catch(
            () => undefined,
          );
          throw err;
        }
      }
      if (deliveryClaimLost) {
        // Claims were acquired together in the reconciliation transaction. Release
        // every still-current one when the queue token is gone; completed claims
        // simply match zero. The successor will retry without waiting 15 minutes.
        await Promise.all(
          outcome.notifications.map((notification) =>
            releaseHostingCoverageOwnerNotification(notification, db).catch(
              () => false,
            ),
          ),
        );
        logger.warn(
          { itemId: item.id, memberId: item.memberId, lodgeId: item.lodgeId },
          "Hosting coverage re-evaluation claim was replaced before provider delivery",
        );
        continue;
      }

      // Renew once more immediately before the terminal decision. Completion is
      // allowed only while this exact queue token is current.
      if (!(await renewHostingCoverageReevaluationClaim(item, db))) {
        logger.warn(
          { itemId: item.id, memberId: item.memberId, lodgeId: item.lodgeId },
          "Hosting coverage re-evaluation claim was replaced before completion",
        );
        continue;
      }

      let pendingNotification = false;
      for (const obligation of outcome.notificationObligations) {
        if (terminalNotificationStates.has(notificationStateKey(obligation))) {
          continue;
        }
        if (await isHostingCoverageOwnerNotificationPending(obligation, db)) {
          pendingNotification = true;
          break;
        }
      }
      if (pendingNotification) {
        // Another sender owns (or has just released) an uncompleted notice. Park
        // this renewed queue token until expiry and undo this claim's attempt
        // increment. Completing or failing-and-releasing here can respectively
        // lose the notice or burn every attempt while the sender is still live.
        await deferHostingCoverageReevaluation(item, db);
        logger.warn(
          { itemId: item.id, memberId: item.memberId, lodgeId: item.lodgeId },
          "Hosting coverage re-evaluation remains pending behind an owner notification",
        );
        continue;
      }

      const completed = await completeHostingCoverageReevaluation(item, db);
      if (completed) {
        result.processed += 1;
      } else {
        logger.warn(
          { itemId: item.id, memberId: item.memberId, lodgeId: item.lodgeId },
          "Hosting coverage re-evaluation finished after its claim was replaced",
        );
      }
    } catch (err) {
      logger.error(
        { err, itemId: item.id, memberId: item.memberId, lodgeId: item.lodgeId },
        "Failed to re-evaluate same-owner hosting coverage",
      );
      const failureRecorded = await failHostingCoverageReevaluation(
        item,
        err instanceof Error ? err.message : String(err),
        db,
      ).catch(() => false);
      if (failureRecorded) {
        result.failed += 1;
      } else {
        logger.warn(
          { itemId: item.id, memberId: item.memberId, lodgeId: item.lodgeId },
          "Hosting coverage re-evaluation failure arrived after its claim was replaced",
        );
      }
    }
  }
  return result;
}

/**
 * Settle one queued item: every active booking of that owner, at that lodge, over
 * those nights.
 *
 * Bounded by the item itself (§10) — see `loadSameOwnerCoverageDependentIds`, which
 * turns the owner/lodge/night triple into a booking-id list and cannot be widened
 * into a lodge-wide sweep.
 *
 * §14's EXISTENTIAL RULE IS WHAT THIS LOOP IMPLEMENTS. It does not ask "did the
 * source that used to cover this booking go away"; it asks "is this booking covered
 * NOW, by anything". So a booking with a second eligible same-owner source stays
 * compliant, an incident opened earlier is resolved rather than left standing, and
 * no misleading loss-of-cover message is sent.
 */
async function processHostingCoverageReevaluation(
  item: HostingCoverageReevaluationItem,
  db: Prisma.TransactionClient,
): Promise<HostingCoverageReconciliationTransactionResult> {
  // MEMBER-MERGE HANDSHAKE FOR AN EXISTING QUEUE ROW. A claim is an in-memory
  // snapshot. Take policy first, then the same sorted lifecycle keys merge takes
  // at transaction entry, before it re-points relations. The later sorted row
  // locks protect promotion into incident FKs. If drain wins, merge waits; if a
  // merge already re-pointed this persisted row, the exact typed read sees the
  // survivor. The separate producer/member-merge topology repair in #2597 owns
  // ordinary rows inserted after merge's relation sweep. Never row-lock the queue:
  // merge writes it after Member locks, so queue -> Member would invert the
  // counterpart order.
  if (!(await tryLockAdultMemberHostingPolicySet(db))) {
    // Fail fast before lifecycle locks, reads or incident writes. Member merge can
    // hold the policy key for longer than Prisma's default interactive-transaction
    // timeout; waiting here would turn ordinary contention into a consumed queue
    // attempt. The caller releases this exact claim for the merge's post-commit
    // drain (or the next cron sweep) to retry immediately.
    return { kind: "deferred" };
  }
  const claimedMemberIds = [
    ...new Set(
      [item.memberId, item.actorMemberId].filter(
        (memberId): memberId is string => Boolean(memberId),
      ),
    ),
  ].sort();
  for (const memberId of claimedMemberIds) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`member-lifecycle:${memberId}`}))`;
  }
  for (const memberId of claimedMemberIds) {
    await db.$executeRaw`
      SELECT 1
      FROM "Member"
      WHERE "id" = ${memberId}
      FOR KEY SHARE
    `;
  }
  const refreshedItem = await loadClaimedHostingCoverageReevaluation(item, db);
  if (!refreshedItem) return { kind: "lost" };
  const refreshedMemberIds = [
    ...new Set(
      [refreshedItem.memberId, refreshedItem.actorMemberId].filter(
        (memberId): memberId is string => Boolean(memberId),
      ),
    ),
  ].sort();
  if (
    refreshedMemberIds.length !== claimedMemberIds.length ||
    refreshedMemberIds.some(
      (memberId, index) => memberId !== claimedMemberIds[index],
    )
  ) {
    // End this transaction before acquiring any newly discovered key. Starting a
    // fresh transaction with the refreshed snapshot preserves sorted acquisition
    // and handles chained merges without lifecycle-key inversion.
    return { kind: "retry", item: refreshedItem };
  }

  const counts = {
    kind: "processed" as const,
    incidentsOpened: 0,
    incidentsUpdated: 0,
    incidentsResolved: 0,
    notificationObligations: [] as Array<{
      bookingId: string;
      incidentId: string;
      stateKey: string;
    }>,
    notifications: [] as Array<{
      bookingId: string;
      incidentId: string;
      stateKey: string;
      claimToken: string;
    }>,
  };
  const policy = await loadAdultMemberHostingPolicy(refreshedItem.lodgeId, db);
  const sourceBookingIsTerminal = refreshedItem.sourceBookingId
    ? await isHostingCoverageSourceBookingTerminal(
        refreshedItem.sourceBookingId,
        db,
      )
    : false;
  const dependentIds =
    policy.hostScopes.sameBookingOwner || !refreshedItem.sourceBookingId
      ? await loadSameOwnerCoverageDependentIds(
          {
            memberId: refreshedItem.memberId,
            lodgeId: refreshedItem.lodgeId,
            nights: refreshedItem.nights,
          },
          db,
        )
      : sourceBookingIsTerminal
        ? []
        : [refreshedItem.sourceBookingId];

  for (const bookingId of dependentIds) {
    const outcome = await reconcileSameOwnerCoverageIncident(
      {
        bookingId,
        cause: refreshedItem.cause,
        actorMemberId: refreshedItem.actorMemberId,
        reason: refreshedItem.reason,
      },
      db,
    );
    if (outcome.action === "resolved") {
      counts.incidentsResolved += 1;
      continue;
    }
    if (outcome.action === "none") continue;

    if (outcome.action === "opened") counts.incidentsOpened += 1;
    else if (outcome.action === "updated") counts.incidentsUpdated += 1;

    counts.notificationObligations.push({
      bookingId,
      incidentId: outcome.incidentId,
      stateKey: outcome.stateKey,
    });
    const claimed = await claimHostingCoverageOwnerNotification(
      { incidentId: outcome.incidentId, stateKey: outcome.stateKey },
      db,
    );
    if (!claimed) continue;
    counts.notifications.push({
      bookingId,
      ...claimed,
    });
  }

  // The SOURCE booking itself may have ended before the drain runs, in which case
  // any incident it was carrying is moot: nobody can restore cover for a stay that
  // is not happening. Its absence from `dependentIds` is NOT evidence of that —
  // the same-owner query is capped and may omit a still-active source. Only the
  // direct lifecycle lookup above can justify §7's cancellation resolution.
  if (refreshedItem.sourceBookingId && sourceBookingIsTerminal) {
    counts.incidentsResolved += await resolveHostingCoverageIncidents(
      {
        bookingId: refreshedItem.sourceBookingId,
        resolution: "BOOKING_CANCELLED",
        actorMemberId: refreshedItem.actorMemberId,
      },
      db,
    );
  }

  return counts;
}

function notificationStateKey(params: {
  incidentId: string;
  stateKey: string;
}): string {
  return `${params.incidentId}\u0000${params.stateKey}`;
}

/**
 * Send the owner the loss-of-cover notice, having already claimed it.
 *
 * A missing email address or intentional suppression is terminal: the incident is
 * still open in the officer queue and an officer can contact the member another way.
 * An unreadable booking-level email flag is different: it is a transient fail-closed
 * result and must fail the exact queue claim so this non-retryable EmailLog template
 * is attempted again by the hosting outbox.
 */
async function notifyOwnerOfLostCoverage(
  notification: {
    bookingId: string;
    incidentId: string;
    stateKey: string;
    claimToken: string;
  },
  db: typeof prisma,
): Promise<"sent" | "terminal" | "retry"> {
  const delivery = await loadHostingCoverageOwnerNotificationDelivery(
    notification,
    db,
  );
  if (!delivery?.email) return "terminal";

  const outcome = await sendHostingCoverageLostEmail({
    bookingId: delivery.bookingId,
    recipientMemberId: delivery.recipientMemberId,
    email: delivery.email,
    firstName: delivery.firstName,
    checkIn: delivery.checkIn,
    checkOut: delivery.checkOut,
    uncoveredNights: delivery.uncoveredNights,
    lodgeId: delivery.lodgeId,
  });
  if (outcome.status === "sent") return "sent";
  if (
    outcome.status === "withheld_for_booking" &&
    outcome.reason === "booking_flag_unreadable"
  ) {
    return "retry";
  }
  // #3035: an environment-safety CONFIGURATION fault is the same class of
  // transient fault as an unreadable switch — nothing is wrong with the recipient
  // and the answer changes as soon as somebody fixes the deployment. A CONFIRMED
  // copy is terminal: it will still be a copy on the next pass.
  if (
    outcome.status === "withheld_for_environment" &&
    outcome.reason !== "environment_non_production"
  ) {
    return "retry";
  }
  return "terminal";
}
