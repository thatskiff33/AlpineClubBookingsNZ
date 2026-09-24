import {
  expireMemberGuestConsent,
  finaliseMemberGuestConsentTransition,
  type MemberGuestConsentBlockedReason,
} from "@/lib/member-guest-consent-service";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { clubFormatValues } from "@/lib/club-format-server";

/**
 * The member-guest pending-hold expiry sweep ("+ Add Member Guest", epic #2305,
 * MG2 #2307). Job name `member-guest-consent-expiry`.
 *
 * WHY THIS EXISTS AND WHY IT SHIPS IN THE SAME RELEASE AS THE WIDENING. Owner
 * decision **D-4** lets a `PENDING` guest hold a bed so a booker is not forced to
 * race a stranger's inbox for capacity. That is only defensible if the hold has a
 * deadline: without this sweep, one unanswered request holds a bed until the stay
 * has been and gone. The widening, the approval surface and this sweep therefore
 * go live together — there is no released state in which an admin can enable the
 * module and strand capacity.
 *
 * WHAT IT DOES NOT DO. It does not decide anything. Every row's transition,
 * locking, settlement and refusal-classification lives in
 * `member-guest-consent-service.ts`, shared with the member-facing decline path,
 * so a lapse and a decline cannot diverge. This file is the scheduler-facing
 * shell: find the candidates, call the service once per row, and count the
 * outcomes honestly.
 *
 * MARK BEFORE SEND. The destructive database transition IS the idempotency
 * token, so a failed notification is logged for an operator and never replayed
 * into a second removal. Running the sweep twice over the same data produces an
 * identical end state and no second email.
 */

export type MemberGuestConsentExpiryCronResult =
  | {
      cronStatus: "SUCCESS";
      /** Rows whose bed was actually released. */
      expiredGuestIds: string[];
      /** Rows another writer had already resolved. No side effects were taken. */
      skippedGuestIds: string[];
      /**
       * Rows marked EXPIRED whose guest could NOT be removed — owner decision
       * D-15's admin exception list. Counted separately and surfaced in the
       * result summary, NEVER retried in a loop.
       */
      blockedGuests: { guestId: string; reason: MemberGuestConsentBlockedReason }[];
      /** Rows that threw. Logged, left PENDING, retried next run. */
      failedGuestIds: string[];
    }
  | { cronStatus: "SKIPPED"; reason: string };

export interface MemberGuestConsentExpiryCronDependencies {
  /**
   * Injected rather than read here, and checked at RUN time rather than at
   * registration time, per the `cron-waitlist.ts` precedent: the job registers
   * unconditionally and reports `SKIPPED` while the module is off, so an admin
   * toggling the module takes effect on the next tick without a restart.
   */
  isModuleEnabled?: () => Promise<boolean>;
  now?: () => Date;
}

export async function runMemberGuestConsentExpiryCron(
  dependencies: MemberGuestConsentExpiryCronDependencies = {},
): Promise<MemberGuestConsentExpiryCronResult> {
  const job = "member-guest-consent-expiry";

  if (dependencies.isModuleEnabled && !(await dependencies.isModuleEnabled())) {
    const reason = "Member guests effective module state is disabled";
    logger.info({ job, reason }, "Member-guest consent expiry sweep skipped");
    return { cronStatus: "SKIPPED", reason };
  }

  const now = dependencies.now?.() ?? new Date();
  // The club's format (#3565), resolved once per sweep, before any row's
  // transaction; every outcome notice below renders with it.
  const format = await clubFormatValues();

  // Unbounded and ordered oldest-first, matching every other sweep in this repo.
  // The query is exactly the shape the partial index
  // `BookingGuest_pendingConsent_expiresAt_idx` was created for.
  //
  // ORDER MATTERS, AND IT IS DELIBERATE. Two pending guests on a two-guest
  // booking cannot both be removed: the first succeeds and the second hits the
  // last-guest refusal. Oldest request first makes that outcome deterministic and
  // fair — the request that has been waiting longest is the one that gets
  // resolved — rather than depending on whatever order the database happened to
  // return. The second row lands on the exception list, which is the honest
  // answer: a booking whose entire party declined by silence needs a human to
  // decide whether it should exist at all.
  const candidates = await prisma.bookingGuest.findMany({
    where: { consentStatus: "PENDING", consentExpiresAt: { lte: now } },
    // `consentExpiresAt` is selected for the EMAIL, not for the query: the
    // outcome notice tells the booking's owner which day the request ran out,
    // and the row is gone by the time that mail is composed. Read here or not at
    // all.
    select: { id: true, memberId: true, bookingId: true, consentExpiresAt: true },
    orderBy: [{ consentExpiresAt: "asc" }, { id: "asc" }],
  });

  const expiredGuestIds: string[] = [];
  const skippedGuestIds: string[] = [];
  const blockedGuests: { guestId: string; reason: MemberGuestConsentBlockedReason }[] =
    [];
  const failedGuestIds: string[] = [];

  for (const candidate of candidates) {
    try {
      const outcome = await expireMemberGuestConsent({ guestId: candidate.id, now, format });

      if (outcome.outcome === "ALREADY_RESOLVED") {
        skippedGuestIds.push(candidate.id);
        continue;
      }

      if (outcome.outcome === "BLOCKED") {
        blockedGuests.push({ guestId: candidate.id, reason: outcome.reason });
      } else {
        expiredGuestIds.push(candidate.id);
      }

      // Post-commit, outside the transaction, each step independently guarded.
      if (candidate.memberId) {
        await finaliseMemberGuestConsentTransition({
          bookingId: candidate.bookingId,
          guestId: candidate.id,
          targetMemberId: candidate.memberId,
          outcome,
          format,
          actorMemberId: null,
          actorLabel: `cron:${job}`,
          consentExpiresAt: candidate.consentExpiresAt,
        });
      }
    } catch (err) {
      // One bad row must not stop the sweep. The row stays PENDING and is picked
      // up again next run — which is safe precisely because the transition is
      // status-guarded.
      failedGuestIds.push(candidate.id);
      logger.error(
        { err, job, guestId: candidate.id, bookingId: candidate.bookingId },
        "Failed to expire a lapsed member-guest consent request",
      );
    }
  }

  if (blockedGuests.length > 0) {
    // Deliberately a warning, not an info line: every one of these is a bed still
    // held by somebody who never answered, waiting on an operator.
    logger.warn(
      { job, blockedGuests },
      "Lapsed member-guest consent requests could not release their beds",
    );
  }

  return {
    cronStatus: "SUCCESS",
    expiredGuestIds,
    skippedGuestIds,
    blockedGuests,
    failedGuestIds,
  };
}

/** Human-readable one-liner for the background-jobs health view. */
export function summariseMemberGuestConsentExpiryRun(
  result: MemberGuestConsentExpiryCronResult,
): string {
  if (result.cronStatus === "SKIPPED") return result.reason;
  return [
    `${result.expiredGuestIds.length} expired`,
    `${result.blockedGuests.length} needing attention`,
    `${result.skippedGuestIds.length} already resolved`,
    `${result.failedGuestIds.length} failed`,
  ].join(", ");
}
