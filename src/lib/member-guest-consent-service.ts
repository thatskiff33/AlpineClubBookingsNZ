import type { Prisma } from "@prisma/client";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { enqueueHostingCoverageReevaluationForMember } from "@/lib/adult-member-hosting-review";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { acquireLodgeCapacityLock } from "@/lib/capacity";
import {
  BookingGuestRemovalError,
  removeBookingGuestInTransaction,
} from "@/lib/booking-guest-removal-service";
import {
  familyAdultDelegateResolver,
  resolveDelegateAnswerRecipients,
} from "@/lib/member-guest-delegate";
import type { MemberGuestConsentDelegateResolver } from "@/lib/member-guest-delegate";
import { getDefaultLodgeId } from "@/lib/lodges";
import { reconcileBedAllocationsForBooking } from "@/lib/bed-allocation-lifecycle";
import { ApiError } from "@/lib/api-error";
import { DELETED_BOOKING_MESSAGE } from "@/lib/deleted-booking-refusal";
import { MembershipTypeBookingPolicyError } from "@/lib/membership-type-policy";
import { logAudit } from "@/lib/audit";
import {
  sendMemberGuestConsentAnsweredEmail,
  sendMemberGuestConsentExpiredEmail,
  sendMemberGuestConsentOutcomeEmail,
} from "@/lib/email/member-guest";
import type {
  MemberGuestConsentOutcome as EmailConsentOutcome,
  MemberGuestDelegateAnswer,
  MemberGuestStillOnBookingReason,
} from "@/lib/member-guest-email-notes";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * The member-guest consent state machine ("+ Add Member Guest", epic #2305,
 * MG2 #2307).
 *
 * `PENDING -> CONFIRMED | DECLINED | EXPIRED`, one-way, idempotent, modelled on
 * `MemberPartnerLink`'s `PENDING/CONFIRMED` plus audit-columns shape. `CONFIRMED`
 * is terminal: owner decision **D-13** means no later modification of the booking
 * re-opens it, in either policy mode.
 *
 * THE ONE MECHANISM THAT DELIVERS MOST OF THE CORRECTNESS is the status-guarded
 * `updateMany` in `claimConsentTransition` below. Double-approve,
 * approve-after-expire, decline racing the sweep, and two delegates answering at
 * once all resolve to exactly one winner and exactly one set of side effects,
 * because the loser's `count` is `0` and every side effect — the removal, the
 * bed reconcile, the audit entry, the emails — hangs off a non-zero count. See
 * `docs/CONCURRENCY_AND_LOCKING.md`.
 *
 * DECLINED AND EXPIRED ROWS ARE USUALLY INVISIBLE, and that is intended: the
 * shared removal path DELETES the guest row, so a successful decline leaves no
 * `DECLINED` row behind and the durable record is the audit entry plus the
 * outcome email. The persisted status earns its keep in exactly one case — the
 * claim succeeded but the removal was refused. That row is *blocked*: still
 * holding a bed, needing a human, and surfaced on the admin exception list
 * (owner decision **D-15**).
 *
 * A REFUSED REMOVAL IS TWO WRITES, NOT ONE, and it has to be. The shared removal
 * path deletes the chore assignments and the guest row BEFORE its last two gates
 * run, so a refusal caught inside the transaction and returned as a value would
 * let Prisma commit a half-completed removal — the row gone, the price never
 * recalculated, no credit, no bed reconcile, and no blocked row for D-15's
 * exception list to find. So the refusal is THROWN out of the transaction
 * (`ConsentRemovalRefusal`), which rolls all of that back, and the terminal
 * status is written afterwards by `recordBlockedConsentTransition` over the row
 * the rollback restored.
 */

export type MemberGuestConsentAction = "APPROVE" | "DECLINE";

/**
 * Why a claimed decline or expiry could not be completed.
 *
 * Owner decision **D-15** names exactly four reasons that reach the admin
 * exception list, and they are the four self-removal blockers that survive
 * D-15's credit election: the guest is the booking's last one, the booking was
 * priced by hand, the booking's status forbids guest changes, or check-in has
 * already happened. Everything else — including every ordinary paid booking —
 * resolves without an admin, because the sweep elects account credit.
 */
export type MemberGuestConsentBlockedReason =
  | "LAST_GUEST"
  | "QUOTE_PRICED"
  | "BOOKING_STATUS"
  | "STAY_NOT_FUTURE"
  /** Anything the removal path refused for a reason not in the four above. */
  | "OTHER";

export type MemberGuestConsentOutcome =
  | { outcome: "APPROVED" }
  /**
   * `creditCents` is what the reduction actually settled as account credit, read
   * off the shared removal path's own result rather than recomputed. The outcome
   * email quotes it to the booking owner, so a second calculation here would be a
   * second chance to tell them the wrong number.
   */
  | { outcome: "DECLINED"; removed: true; creditCents: number }
  | { outcome: "EXPIRED"; removed: true; creditCents: number }
  /** Claimed, but the guest is still on the booking and an admin must act. */
  | {
      outcome: "BLOCKED";
      status: "DECLINED" | "EXPIRED";
      reason: MemberGuestConsentBlockedReason;
      message: string;
    }
  /** Somebody (or the sweep) got there first. No side effects, ever. */
  | { outcome: "ALREADY_RESOLVED" };

export class MemberGuestConsentError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * The 403 every unauthorized caller gets, whatever went wrong.
 *
 * One message and one status for "no such booking", "no such guest row", "that
 * row is not a consent request" and "you are not the target or an accepted
 * delegate", so neither id can be used as an existence oracle. Lens (b)'s
 * primary target on this endpoint is IDOR, and this is the answer to it.
 */
function forbidden(): never {
  throw new MemberGuestConsentError("Forbidden", 403);
}

/**
 * The refusal a soft-deleted booking gets (#2700).
 *
 * NOT the uniform 403 above, and that difference is deliberate. This one is
 * only ever thrown BELOW the target/delegate check, so the caller has already
 * proved they are the guest being asked (or an accepted family delegate
 * answering for them). Telling that person the booking was cancelled or removed
 * discloses nothing they were not already entitled to know, and it is the
 * difference between an explanation and a dead end. In practice the person who
 * sees it answered from a page loaded before the deletion — a fresh click on an
 * old consent email dead-ends earlier, on the booking page's own `notFound()`
 * or the delegate page's uniform NOT_FOUND. `deleted-booking-refusal.ts`
 * carries the full reasoning and the wording every surface shares, and
 * `INV-ADDPAY-034` records that widening it to the email journey is an owner
 * decision rather than a tidy-up.
 *
 * Anyone who has NOT proved that still hits `forbidden()` first and cannot tell
 * a deleted booking from a live one, which is the property that makes the
 * disclosure safe.
 */
function refuseDeletedBooking(): never {
  throw new MemberGuestConsentError(DELETED_BOOKING_MESSAGE, 404);
}

/**
 * Classify a removal refusal into one of D-15's four exception reasons.
 *
 * Matched on the removal service's own messages rather than on a re-derivation of
 * its gates, because the message the member is shown and the reason the operator
 * is shown must be the same fact. A refusal that matches none of the four is
 * `OTHER` and still reaches the exception list — an unclassified block is a
 * visible block, never a swallowed one.
 */
export function classifyConsentRemovalRefusal(
  message: string,
): MemberGuestConsentBlockedReason {
  if (message.includes("Cannot remove the last guest")) return "LAST_GUEST";
  if (message.toLowerCase().includes("quote")) return "QUOTE_PRICED";
  if (message.includes("Only future booking guests")) return "STAY_NOT_FUTURE";
  if (
    message.includes("current status") ||
    message.includes("cannot be modified") ||
    message.includes("can be modified")
  ) {
    return "BOOKING_STATUS";
  }
  return "OTHER";
}

/**
 * The message of a refusal the shared removal path raised, or `null` if this is
 * not a refusal at all.
 *
 * THE REMOVAL PATH REFUSES IN THREE TYPED CLASSES, NOT ONE, and matching only
 * `BookingGuestRemovalError` was a real defect rather than a tidy-up. The gate
 * that blocks a hand-priced booking (`assertBookingNotQuotePriced`) raises
 * `ApiError`, and the membership-type policy check on the REMAINING guests raises
 * `MembershipTypeBookingPolicyError` — both from inside
 * `removeBookingGuestInTransaction`, and both after the status-guarded claim has
 * already succeeded in this same transaction. An unmatched refusal propagates,
 * which rolls the claim back, so the row stays `PENDING`, keeps holding its bed,
 * never reaches D-15's exception list, and is retried by the sweep every night
 * for ever. That is precisely the stranded capacity D-4's deadline exists to
 * prevent, and `classifyConsentRemovalRefusal`'s `QUOTE_PRICED` branch was dead
 * code until this matched the error that carries it.
 *
 * These are the same three classes the guest DELETE route has enumerated for this
 * same function since #1032, which is where the list comes from: it is the shared
 * path's actual contract with its callers — typed domain errors carrying a
 * user-facing sentence and an HTTP status — rather than a guess about what might
 * be thrown. Anything else (a `TypeError`, a lost connection) is NOT a refusal and
 * must keep propagating: marking a row terminal on the strength of a bug would put
 * it on an operator's list with a meaningless reason.
 */
function consentRemovalRefusalMessage(err: unknown): string | null {
  if (
    err instanceof BookingGuestRemovalError ||
    err instanceof ApiError ||
    err instanceof MembershipTypeBookingPolicyError
  ) {
    return err.message;
  }
  return null;
}

type ConsentGuestRow = {
  id: string;
  memberId: string | null;
  consentStatus: string | null;
  consentExpiresAt: Date | null;
  bookingId: string;
};

/**
 * The status-guarded claim. This is the whole idempotency story.
 *
 * Mutation-verify: replace this `updateMany` with a bare `update` by id and a
 * concurrency test must fail — a bare update would let both racers "win" and
 * send two emails for one act.
 */
async function claimConsentTransition(
  tx: Prisma.TransactionClient,
  guestId: string,
  next: "CONFIRMED" | "DECLINED" | "EXPIRED",
  respondedByMemberId: string | null,
  now: Date,
): Promise<boolean> {
  const claimed = await tx.bookingGuest.updateMany({
    where: { id: guestId, consentStatus: "PENDING" },
    data:
      next === "EXPIRED"
        ? // An expiry is nobody's decision, so it records no responder: that is
          // what distinguishes the EXPIRED shape from DECLINED in the model's
          // sub-state table.
          { consentStatus: next }
        : {
            consentStatus: next,
            consentRespondedAt: now,
            consentRespondedByMemberId: respondedByMemberId,
          },
  });
  return claimed.count > 0;
}

/**
 * A refusal from the shared removal path, carried OUT of the transaction on
 * purpose so that Postgres rolls the whole attempt back.
 *
 * THIS CLASS IS THE FIX FOR A HALF-COMPLETED REMOVAL. The removal path's gates
 * are not all at the front: it deletes the guest's chore assignments and then the
 * guest row itself, and only afterwards checks the membership-type policy on the
 * REMAINING guests and asks whether a settled booking needs a refund-or-credit
 * election. Catching those refusals inside the `$transaction` callback and
 * returning a value made the callback RESOLVE, and Prisma commits a callback that
 * resolves — so the guest row and its chore assignments stayed deleted while the
 * price was never recalculated, no `BookingModification` was written, no credit
 * was issued and no bed was reconciled. Worse, the row that D-15 requires to
 * survive as a *blocked* row had vanished, so it never reached the admin
 * exception list, while the member was told "ask the booking owner or an admin to
 * remove this guest" about a guest who was already gone.
 *
 * Throwing instead means the refusal unwinds the transaction, exactly as the
 * sibling guest-DELETE route (`/api/bookings/[id]/guests/[guestId]`) has always
 * let it. The BLOCKED status is then written by a SEPARATE, tiny transaction —
 * see `recordBlockedConsentTransition` — over the row the rollback restored.
 */
class ConsentRemovalRefusal extends Error {
  constructor(
    readonly blockedReason: MemberGuestConsentBlockedReason,
    readonly refusalMessage: string,
  ) {
    super(refusalMessage);
    this.name = "ConsentRemovalRefusal";
  }
}

/**
 * Remove a just-claimed guest through the shared removal path, or throw the
 * classified refusal so the caller's transaction rolls back.
 *
 * ONE removal semantics, never a bespoke second delete: capacity release, night
 * deletion, repricing, promo revalidation, chore cleanup, bed reconcile and
 * lifecycle transitions are all inherited from the path a member's own
 * self-removal uses, so a decline and a self-removal cannot diverge.
 */
async function removeClaimedConsentGuest(
  tx: Prisma.TransactionClient,
  params: {
    bookingId: string;
    guestId: string;
    targetMemberId: string;
    actorMemberId: string;
    kind: "CONSENT_DECLINE" | "CONSENT_EXPIRY";
    /** D-15's credit election. Only the sweep passes it. */
    settlementMethod?: "credit";
    /**
     * The club's today (#3123), resolved by the caller before it opened this
     * transaction — see `removeBookingGuestInTransaction`'s own parameter, and
     * `INV-LOCK-004`. This transaction holds `pg_advisory_xact_lock(1)` and the
     * per-lodge capacity key.
     */
    today: Date;
  },
): Promise<{ removed: true; creditCents: number }> {
  try {
    const result = await removeBookingGuestInTransaction({
      tx,
      bookingId: params.bookingId,
      guestId: params.guestId,
      actorMemberId: params.actorMemberId,
      actorRole: "MEMBER",
      today: params.today,
      ...(params.settlementMethod ? { settlementMethod: params.settlementMethod } : {}),
      consentAuthority: {
        kind: params.kind,
        guestId: params.guestId,
        targetMemberId: params.targetMemberId,
      },
    });
    return { removed: true, creditCents: result.accountCreditAmountCents ?? 0 };
  } catch (err) {
    const refusal = consentRemovalRefusalMessage(err);
    if (refusal !== null) {
      throw new ConsentRemovalRefusal(classifyConsentRemovalRefusal(refusal), refusal);
    }
    throw err;
  }
}

/**
 * Write the BLOCKED outcome after the refusal has rolled the removal back.
 *
 * A separate, minimal transaction that touches ONE column set on ONE row, so
 * there is nothing here for a later gate to refuse. It re-uses the same
 * status-guarded claim, which matters: the rollback put the row back to
 * `PENDING`, and between the rollback and this write the nightly sweep (or the
 * other delegate) may legitimately have claimed it. A lost claim is reported as
 * `ALREADY_RESOLVED` and takes no side effects, which is the same answer every
 * other loser of that race gets.
 *
 * The row is deliberately left ON the booking, still holding its bed, carrying
 * its terminal status — that is what makes it visible to
 * `ATTENTION_GUEST_WHERE` on the admin exception list (owner decision D-15), and
 * it is the state the member-facing copy already promises when it says to ask
 * the booking owner or an admin.
 */
async function recordBlockedConsentTransition(params: {
  db: typeof prisma;
  guestId: string;
  status: "DECLINED" | "EXPIRED";
  respondedByMemberId: string | null;
  now: Date;
  refusal: ConsentRemovalRefusal;
}): Promise<MemberGuestConsentOutcome> {
  const { db, guestId, status, respondedByMemberId, now, refusal } = params;

  const claimed = await db.$transaction((tx) =>
    claimConsentTransition(tx, guestId, status, respondedByMemberId, now),
  );
  if (!claimed) return { outcome: "ALREADY_RESOLVED" };

  return {
    outcome: "BLOCKED",
    status,
    reason: refusal.blockedReason,
    message: refusal.refusalMessage,
  };
}

/**
 * Approve or decline one consent request.
 *
 * Order of operations follows `cron-group-settlement-reaper.ts`: authorize
 * OUTSIDE the transaction, then take the global money/status lock before the
 * per-lodge capacity lock, re-read under the locks, claim, and only then act.
 * External calls (the emails) and the bed reconcile happen AFTER the commit,
 * each independently try/caught, so a mail failure can never roll back a
 * consent decision and no provider call ever sits inside a booking transaction.
 */
export async function respondToMemberGuestConsent(params: {
  bookingId: string;
  guestId: string;
  actorMemberId: string;
  action: MemberGuestConsentAction;
  now?: Date;
  delegateResolver?: MemberGuestConsentDelegateResolver;
  db?: typeof prisma;
}): Promise<MemberGuestConsentOutcome> {
  const {
    bookingId,
    guestId,
    actorMemberId,
    action,
    now = new Date(),
    delegateResolver = familyAdultDelegateResolver,
    db = prisma,
  } = params;

  // Authorization runs on an unlocked read. It is re-asserted implicitly under
  // the lock by the status-guarded claim (a row that changed hands cannot be
  // claimed), and the guest's memberId is immutable, so nothing an attacker can
  // race changes the answer.
  const guest = (await db.bookingGuest.findUnique({
    where: { id: guestId },
    select: {
      id: true,
      memberId: true,
      consentStatus: true,
      consentExpiresAt: true,
      bookingId: true,
    },
  })) as ConsentGuestRow | null;

  if (!guest || guest.bookingId !== bookingId || guest.memberId === null) forbidden();
  if (guest.consentStatus !== "PENDING") {
    // Deliberately the SAME 403 as "not yours". An already-resolved request and
    // a request belonging to somebody else must be indistinguishable, or the
    // endpoint becomes an oracle for who is on which booking.
    forbidden();
  }

  const targetMemberId = guest.memberId;
  const isTarget = targetMemberId === actorMemberId;
  const isDelegate =
    !isTarget &&
    (await delegateResolver.canRespondForTarget({
      actorMemberId,
      targetMemberId,
      db,
    }));

  if (!isTarget && !isDelegate) forbidden();

  // #2700 — a SOFT-DELETED booking takes no consent answer, from anybody.
  //
  // The rule is `INV-ADDPAY-035`; `INV-ADDPAY-032`, which tracked this as an
  // open decision, is now a superseded stub pointing there.
  //
  // BOTH ARMS reached a write before this. `INV-ADDPAY-032` recorded the shape:
  // the booking was loaded below purely to pick a lodge lock (`{ id, lodgeId }`),
  // so neither `status` nor `deletedAt` was ever read, and an APPROVE went on to
  // write the guest row, reconcile beds, drain the hosting queue and EMAIL THE
  // BOOKING'S OWNER about a record the club has deleted; a DECLINE additionally
  // recorded a BLOCKED response outside the transaction it rolls back. The owner
  // decided (10 Aug 2026) that none of that should happen: a guest cannot
  // meaningfully consent to a stay the club has deleted, and the owner should
  // not receive an email about one.
  //
  // AFTER the authorisation check, deliberately, and that is why the refusal is
  // allowed to be informative — see `refuseDeletedBooking` above. Note the ROUTE
  // could not host this guard: its pre-read only proves the guest row belongs to
  // the booking, not that the caller is the target or a delegate, so a check
  // there would answer 404-vs-403 to somebody holding a guessed pair of ids.
  const bookingBeforeLock = await db.booking.findUnique({
    where: { id: bookingId },
    select: { deletedAt: true },
  });
  if (bookingBeforeLock?.deletedAt) refuseDeletedBooking();

  // #3123 / INV-LOCK-004 — the club's day, resolved before the transaction
  // opens. Inside it this path holds `pg_advisory_xact_lock(1)` and the
  // per-lodge capacity key, where resolving the club's persisted timezone would
  // be a `clubTimeSettings.findUnique` taking a second pooled connection. The
  // RUNTIME reader, not the server binding: this module is reached from
  // `instrumentation.node.ts` through `cron-member-guest-consent-expiry`, where
  // `server-only` is a bare throw at import.
  const clubTodayDateOnly = dateOnlyInstantOf(
    clubToday(await readClubTimeZoneOutsideRequest()),
  );

  try {
    return await db.$transaction(async (tx) => {
      // Global money/status lock first, then the per-lodge capacity lock: this
      // transaction can reprice a booking AND release a bed, so it belongs in
      // both cohorts and must take them in the repo's declared order.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        select: { id: true, lodgeId: true, deletedAt: true },
      });
      if (!booking) forbidden();
      // Re-asserted under the lock, not merely checked above. The unlocked read
      // is what produces the right answer cheaply; THIS one is what makes it
      // true. `softDeleteCancelledBooking` takes the same
      // `pg_advisory_xact_lock(1)`, so a deletion committing between the two
      // reads is serialised behind this transaction and seen here.
      if (booking.deletedAt) refuseDeletedBooking();
      await acquireLodgeCapacityLock(
        tx,
        booking.lodgeId ?? (await getDefaultLodgeId(tx)),
      );

      if (action === "APPROVE") {
        const claimed = await claimConsentTransition(
          tx,
          guestId,
          "CONFIRMED",
          actorMemberId,
          now,
        );
        if (!claimed) return { outcome: "ALREADY_RESOLVED" } as const;
        await enqueueHostingCoverageReevaluationForMember(
          targetMemberId,
          tx,
          clubTodayDateOnly,
          {
            cause: "SYSTEM_CHANGE",
            actorMemberId,
          },
        );
        return { outcome: "APPROVED" } as const;
      }

      const claimed = await claimConsentTransition(
        tx,
        guestId,
        "DECLINED",
        actorMemberId,
        now,
      );
      if (!claimed) return { outcome: "ALREADY_RESOLVED" } as const;

      // D-14 as ticked: NO exemption from the ordinary self-removal blockers. A
      // member who never consented can still be refused, and the honest answer
      // is to tell them who can act rather than to invent a bypass. A refusal
      // THROWS from here, unwinding this transaction — the claim, the chore
      // deletions and the guest-row delete all go back — and the blocked status
      // is written afresh below.
      const removal = await removeClaimedConsentGuest(tx, {
        bookingId,
        guestId,
        targetMemberId,
        actorMemberId,
        kind: "CONSENT_DECLINE",
        today: clubTodayDateOnly,
      });

      return {
        outcome: "DECLINED",
        removed: true,
        creditCents: removal.creditCents,
      } as const;
    });
  } catch (err) {
    if (!(err instanceof ConsentRemovalRefusal)) throw err;
    return recordBlockedConsentTransition({
      db,
      guestId,
      status: "DECLINED",
      respondedByMemberId: actorMemberId,
      now,
      refusal: err,
    });
  }
}

/**
 * Expire one lapsed request, for the nightly sweep.
 *
 * Owner decision **D-15**: the sweep elects **account credit to the booking
 * owner** through the shared path's existing `settlementMethod` parameter, so an
 * ordinary paid booking releases its bed on time and no card refund is ever
 * issued that nobody asked for. That election is not a weakening of D-14 — D-14
 * governs what a *guest* may do; this governs a system timer the club configured.
 *
 * MARK BEFORE SEND, on purpose. The destructive database transition IS the
 * idempotency token here, so a failed email is logged for an operator and never
 * replayed into a second removal. (The opposite ordering in
 * `cron-quote-expiry-reminders.ts` is right for a pure reminder and wrong for
 * this.)
 */
export async function expireMemberGuestConsent(params: {
  guestId: string;
  now?: Date;
  db?: typeof prisma;
}): Promise<MemberGuestConsentOutcome> {
  const { guestId, now = new Date(), db = prisma } = params;

  // #3123 / INV-LOCK-004 — the club's day, resolved before the transaction
  // opens. Inside it this path holds `pg_advisory_xact_lock(1)` and the
  // per-lodge capacity key, where resolving the club's persisted timezone would
  // be a `clubTimeSettings.findUnique` taking a second pooled connection. The
  // RUNTIME reader, not the server binding: this module is reached from
  // `instrumentation.node.ts` through `cron-member-guest-consent-expiry`, where
  // `server-only` is a bare throw at import.
  const clubTodayDateOnly = dateOnlyInstantOf(
    clubToday(await readClubTimeZoneOutsideRequest()),
  );

  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const guest = await tx.bookingGuest.findUnique({
        where: { id: guestId },
        select: {
          id: true,
          memberId: true,
          consentStatus: true,
          consentExpiresAt: true,
          bookingId: true,
          booking: { select: { id: true, lodgeId: true, memberId: true } },
        },
      });

      if (!guest || guest.memberId === null || guest.consentStatus !== "PENDING") {
        return { outcome: "ALREADY_RESOLVED" } as const;
      }

      await acquireLodgeCapacityLock(
        tx,
        guest.booking.lodgeId ?? (await getDefaultLodgeId(tx)),
      );

      // Re-assert the clock on the FRESH row under the lock. The settlement
      // reaper's hard-won lesson: an expiry window can be extended between the
      // candidate scan and the transaction, and expiring a row whose deadline
      // has moved is not idempotent, it is wrong.
      if (!guest.consentExpiresAt || guest.consentExpiresAt > now) {
        return { outcome: "ALREADY_RESOLVED" } as const;
      }

      const claimed = await claimConsentTransition(tx, guestId, "EXPIRED", null, now);
      if (!claimed) return { outcome: "ALREADY_RESOLVED" } as const;

      // As on the decline path, a refusal THROWS out of this transaction so the
      // half-done removal is rolled back, and the EXPIRED-but-blocked status is
      // written separately over the restored row.
      const removal = await removeClaimedConsentGuest(tx, {
        bookingId: guest.bookingId,
        guestId,
        targetMemberId: guest.memberId,
        // No person acted, so no person is named as the actor. The booking OWNER
        // is passed because they are the party whose booking is repriced and who
        // receives the credit; the true actor is recorded separately in the audit
        // log as `cron:member-guest-consent-expiry`. The target's id is NOT used —
        // writing it here would attribute to them an act they did not take.
        actorMemberId: guest.booking.memberId,
        kind: "CONSENT_EXPIRY",
        settlementMethod: "credit",
        today: clubTodayDateOnly,
      });

      return {
        outcome: "EXPIRED",
        removed: true,
        creditCents: removal.creditCents,
      } as const;
    });
  } catch (err) {
    if (!(err instanceof ConsentRemovalRefusal)) throw err;
    return recordBlockedConsentTransition({
      db,
      guestId,
      // An expiry is nobody's decision, so it records no responder — the same
      // distinction `claimConsentTransition` draws on the happy path.
      status: "EXPIRED",
      respondedByMemberId: null,
      now,
      refusal: err,
    });
  }
}

/**
 * Plain-English "what actually fixes this" for an admin looking at a blocked row.
 *
 * D-15 is explicit that the copy must name the REAL remedy — cancel the booking,
 * or re-quote the request — and never a dead-end "ask the club".
 */
export function describeConsentBlockedRemedy(
  reason: MemberGuestConsentBlockedReason,
): string {
  switch (reason) {
    case "LAST_GUEST":
      return "This member is the only guest on the booking, so taking them off would leave it empty. Cancel the booking, or add another guest first.";
    case "QUOTE_PRICED":
      return "This booking was priced by hand, so the system will not reprice it. Re-quote the request without this member.";
    case "BOOKING_STATUS":
      return "This booking's status does not allow guest changes. Move it to a status that does, or cancel it.";
    case "STAY_NOT_FUTURE":
      return "This stay has already started, so the place cannot be released. Check who actually arrived and adjust the booking directly.";
    case "OTHER":
      return "The booking could not be repriced automatically. Open the booking and take this member off through the edit flow.";
  }
}

/**
 * The post-commit half of every transition, shared by the API route and the sweep.
 *
 * Each step is independently try/caught and `logger.error`-only, on the
 * `cron-pre-arrival-reminders.ts` discipline: none of these may undo a consent
 * decision that has already committed, and none of them may prevent the next one
 * from running.
 *
 * `BookingEventType` is a Postgres enum, so a new event value would be a
 * migration and MG2 ships migration-free — consent transitions are therefore
 * audited with `logAudit`, and the removal path still writes whatever
 * `BookingEvent` it already wrote.
 */
export async function finaliseMemberGuestConsentTransition(params: {
  bookingId: string;
  guestId: string;
  targetMemberId: string;
  outcome: MemberGuestConsentOutcome;
  /** The member who acted, or null for the sweep. */
  actorMemberId: string | null;
  /** `cron:member-guest-consent-expiry` for the sweep; undefined for a person. */
  actorLabel?: string;
  /**
   * The deadline the member was given, read off the row BEFORE the transition
   * deleted it. Only the sweep can supply it and only a lapse needs it; without
   * it the outcome email has to date the lapse "now", which is the moment the
   * mail was composed rather than the day the request actually ran out.
   */
  consentExpiresAt?: Date | null;
}): Promise<void> {
  const {
    bookingId,
    guestId,
    targetMemberId,
    outcome,
    actorMemberId,
    actorLabel,
    consentExpiresAt,
  } = params;

  if (outcome.outcome === "ALREADY_RESOLVED") {
    // The claim was lost. No email, no removal, no bed write, no audit entry —
    // the winner already wrote all of them, and a second set would be a lie.
    return;
  }

  if (outcome.outcome === "APPROVED") {
    // The guest is real now and needs a bed. Decline and expiry get their
    // reconcile free — the removal service already calls it — but an approval
    // changes nothing the removal path touches, so this call site is new.
    try {
      await reconcileBedAllocationsForBooking({ bookingId });
    } catch (err) {
      logger.error(
        { err, bookingId, guestId },
        "Failed to reconcile bed allocations after a member-guest consent approval",
      );
    }
  }

  // #2576 §7/§8. LOSING MEMBER-GUEST CONSENT CAN REMOVE COVER, and the owner's
  // decision names it twice: §6 lists "removal or decline of required member-guest
  // consent" among the changes that must be re-evaluated, and §17 asks for a test
  // that it causes re-evaluation.
  //
  // The re-evaluation itself was already recorded, because a decline and an expiry
  // both go through `removeBookingGuestInTransaction` — the shared removal path — and
  // that reconciles the hosting rule inside the caller's transaction, enqueueing a
  // bounded row when another booking on the owner's account is affected. What was
  // missing was the other half of the pair: nothing DRAINED it here, so §7's
  // "immediate re-evaluation" became "within three hours" and the owner of a booking
  // that had just lost its cover was not emailed until the cron ran.
  //
  // AFTER THE COMMIT AND ONLY FOR THE OUTCOMES THAT REMOVED SOMEBODY. An APPROVED
  // consent adds an operationally-present adult, which can only ADD cover, and it
  // reconciles through the same path; BLOCKED left the guest on the booking and
  // ALREADY_RESOLVED wrote nothing at all. Scoped to this booking's owner so one
  // member's decline never runs another account's backlog, and best-effort for the
  // reason every other drain site is: the transition is committed and the cron sweep
  // is the authority on completion.
  if (
    outcome.outcome === "APPROVED" ||
    outcome.outcome === "DECLINED" ||
    outcome.outcome === "EXPIRED"
  ) {
    await settleHostingCoverageAfterCommit({ bookingId });
  }

  await notifyMemberGuestConsentOutcome({
    bookingId,
    guestId,
    targetMemberId,
    outcome,
    actorMemberId,
    consentExpiresAt,
  });

  try {
    await logAudit({
      action: `member_guest_consent_${outcome.outcome.toLowerCase()}`,
      category: "booking",
      // A blocked row needs a human, so it is logged as important-and-failed
      // rather than as a routine info line an operator would scroll past.
      severity: outcome.outcome === "BLOCKED" ? "important" : "info",
      outcome: outcome.outcome === "BLOCKED" ? "failure" : "success",
      entityType: "BookingGuest",
      entityId: guestId,
      ...(actorMemberId ? { actorMemberId, memberId: actorMemberId } : {}),
      subjectMemberId: targetMemberId,
      targetId: bookingId,
      summary:
        outcome.outcome === "BLOCKED"
          ? `Member-guest consent ${outcome.status.toLowerCase()} but the guest could not be removed (${outcome.reason}).`
          : `Member-guest consent ${outcome.outcome.toLowerCase()}.`,
      metadata: {
        bookingId,
        guestId,
        targetMemberId,
        ...(actorLabel ? { actor: actorLabel } : {}),
        ...(outcome.outcome === "BLOCKED"
          ? { blockedReason: outcome.reason, blockedMessage: outcome.message }
          : {}),
      },
    });
  } catch (err) {
    logger.error(
      { err, bookingId, guestId },
      "Failed to audit a member-guest consent transition",
    );
  }
}

/**
 * Map a blocked-consent reason back onto the self-removal blocker vocabulary the
 * email copy speaks.
 *
 * The two vocabularies exist for different audiences — one names why an operator
 * has work to do, the other is what a member reads — and this is the single place
 * they are joined, so the copy cannot describe a different situation from the one
 * the exception list is showing.
 */
function selfRemovalBlockerForConsentReason(
  reason: MemberGuestConsentBlockedReason,
  message: string,
): MemberGuestStillOnBookingReason {
  switch (reason) {
    case "LAST_GUEST":
      return "LAST_GUEST";
    case "QUOTE_PRICED":
      return "QUOTE_PRICED";
    case "STAY_NOT_FUTURE":
      return "STAY_NOT_FUTURE";
    case "BOOKING_STATUS":
      return "BOOKING_STATUS";
    case "OTHER":
      // The one refusal that is genuinely common in this bucket has a concrete,
      // sayable cause: an already-settled booking whose reduction needs a
      // refund-or-credit election that no self-removing guest is allowed to make
      // (see `booking-guest-removal-service.ts`). The shared self-removal
      // predicate keeps it server-only because it cannot be predicted from the
      // facts a card renders, so the refusal MESSAGE is the only place it is
      // named — describing it as "the booking is in a state the system cannot
      // change on its own" told the owner nothing they could act on. Anything
      // else unclassified keeps that general wording, which remains the honest
      // answer when we do not know more.
      return isSettlementChoiceRefusal(message) ? "SETTLEMENT_CHOICE" : "BOOKING_STATUS";
  }
}

/**
 * Does this refusal message name the settled-payment election?
 *
 * Matched on the removal service's own sentence for the same reason
 * `classifyConsentRemovalRefusal` matches on messages rather than re-deriving
 * the gates: the sentence the member is shown and the reason the owner is given
 * must be the same fact, not two independent guesses that can drift.
 */
function isSettlementChoiceRefusal(message: string): boolean {
  return message.includes("settled payment");
}

/**
 * Send the "somebody answered for you" notices, each independently guarded.
 *
 * Split out rather than inlined because it has its own failure surface — a
 * resolver query and one send per recipient — and none of it may prevent the
 * booking owner's outcome email, the audit entry, or the next row of a sweep.
 * A delegate answer with nobody to tell is logged rather than passed over: a
 * member who can be answered for but never told is a fact an operator should be
 * able to find.
 */
async function notifyDelegateAnswer(params: {
  bookingId: string;
  guestId: string;
  targetMemberId: string;
  actorMemberId: string;
  booking: {
    lodgeId: string | null;
    checkIn: Date;
    checkOut: Date;
  };
  target: { firstName: string; lastName: string };
  answer: MemberGuestDelegateAnswer;
}): Promise<void> {
  const { bookingId, guestId, targetMemberId, actorMemberId, booking, target, answer } =
    params;

  const responder = await prisma.member
    .findUnique({
      where: { id: actorMemberId },
      select: { firstName: true, lastName: true },
    })
    .catch(() => null);
  const responderName =
    [responder?.firstName, responder?.lastName].filter(Boolean).join(" ").trim() ||
    "Somebody in your family group";

  const recipients = await resolveDelegateAnswerRecipients({
    resolver: familyAdultDelegateResolver,
    targetMemberId,
    actorMemberId,
    db: prisma,
  }).catch((err: unknown) => {
    logger.error(
      { err, bookingId, guestId },
      "Failed to resolve who to tell that a delegate answered a member-guest request",
    );
    return [];
  });

  if (recipients.length === 0) {
    logger.warn(
      { bookingId, guestId, targetMemberId, actorMemberId },
      "A delegate answered a member-guest request with nobody to notify",
    );
    return;
  }

  for (const recipient of recipients) {
    try {
      await sendMemberGuestConsentAnsweredEmail({
        bookingId,
        recipient: { kind: "member", memberId: recipient.memberId },
        email: recipient.email,
        firstName: recipient.firstName,
        target,
        responderName,
        answer,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        lodgeId: booking.lodgeId,
      });
    } catch (err) {
      logger.error(
        { err, bookingId, guestId, recipient: recipient.memberId },
        "Failed to tell somebody that a delegate answered a member-guest request",
      );
    }
  }
}

/**
 * Tell the people who need to know, after the transition has committed.
 *
 * Two audiences, and the split is deliberate. The person who MADE the booking
 * always hears the outcome — it is their booking and, on a decline or a lapse,
 * their money that moved. The member who was ASKED hears only that their request
 * lapsed, and only when there was a request to lapse: a notify-only or
 * admin-assigned row was never asked, so telling that member "your request has
 * lapsed" would describe something that never happened.
 *
 * Every send is independently try/caught and `logger.error`-only. The consent
 * decision is already committed; an email provider being down must not undo it,
 * and must not stop the next row in a sweep. Owner decision **D-16** governs
 * whether these are withheld at all: consent-adjacent mail ignores the per-action
 * notify tick and the member's own notification preferences, and is withheld only
 * by the per-booking No-emails switch — that logic lives in the sender and the
 * suppression gate, not here.
 */
async function notifyMemberGuestConsentOutcome(params: {
  bookingId: string;
  guestId: string;
  targetMemberId: string;
  outcome: MemberGuestConsentOutcome;
  /** Who clicked, or null for the sweep. A delegate is the interesting case. */
  actorMemberId: string | null;
  /** The deadline as recorded on the row; see `finaliseMemberGuestConsentTransition`. */
  consentExpiresAt?: Date | null;
}): Promise<void> {
  const { bookingId, guestId, targetMemberId, outcome, actorMemberId, consentExpiresAt } =
    params;
  if (outcome.outcome === "ALREADY_RESOLVED") return;

  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        lodgeId: true,
        checkIn: true,
        checkOut: true,
        member: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
    });
    if (!booking) return;

    // The guest row is GONE on a successful decline or expiry — the removal path
    // deleted it — so the target's name comes from the Member record, which is
    // the only surviving source once the row is deleted.
    const target = await prisma.member.findUnique({
      where: { id: targetMemberId },
      select: { id: true, email: true, firstName: true, lastName: true },
    });

    const guest = {
      firstName: target?.firstName ?? "A member",
      lastName: target?.lastName ?? "",
    };

    // The lapse date is the deadline the member was actually given, never "now".
    // `new Date()` here is the moment the email happened to be composed — which
    // is after the sweep ran, on whatever day the sweep ran — so it could tell
    // the booking's owner their request lapsed on a date the member was never
    // working to. It falls back to `now` only when the caller could not supply
    // the deadline, and every real caller can.
    const lapsedAt = consentExpiresAt ?? new Date();

    const emailOutcome: EmailConsentOutcome =
      outcome.outcome === "APPROVED"
        ? { kind: "APPROVED" }
        : outcome.outcome === "DECLINED"
          ? { kind: "DECLINED", creditCents: outcome.creditCents }
          : outcome.outcome === "EXPIRED"
            ? {
                kind: "EXPIRED_REMOVED",
                expiredAt: lapsedAt,
                creditCents: outcome.creditCents,
              }
            : // BLOCKED, and WHICH blocked outcome matters. A member who clicked
              // "No thanks" made a decision, promptly; reporting that to the
              // booking's owner as "did not answer in time" — with a lapse date
              // invented on the spot — described the wrong event, blamed the
              // member for silence they are not guilty of, and quoted a date
              // that never happened.
              outcome.status === "DECLINED"
              ? {
                  kind: "DECLINED_STILL_ON_BOOKING",
                  blocker: selfRemovalBlockerForConsentReason(
                    outcome.reason,
                    outcome.message,
                  ),
                }
              : {
                  kind: "EXPIRED_STILL_ON_BOOKING",
                  expiredAt: lapsedAt,
                  blocker: selfRemovalBlockerForConsentReason(
                    outcome.reason,
                    outcome.message,
                  ),
                };

    if (booking.member?.email) {
      try {
        await sendMemberGuestConsentOutcomeEmail({
          bookingId,
          recipient: { kind: "member", memberId: booking.member.id },
          email: booking.member.email,
          firstName: booking.member.firstName ?? "",
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          lodgeId: booking.lodgeId,
          guest,
          outcome: emailOutcome,
        });
      } catch (err) {
        logger.error(
          { err, bookingId, guestId },
          "Failed to send the member-guest consent outcome email to the booking owner",
        );
      }
    }

    // A DELEGATE ANSWERING IS TOLD ABOUT, ALWAYS.
    //
    // The old reasoning here — "a decline needs no notice: they just made the
    // decision themselves" — is true of a member answering for themselves and
    // false of a delegate. Under owner decision D-10 an adult in the household
    // can answer for a member with no login, and a decline releases that
    // member's bed and takes them off a booking somebody put them on. Without
    // this notice the only people who learnt of it were the booking's owner and
    // the adult who clicked.
    const delegateAnswered =
      actorMemberId !== null &&
      actorMemberId !== targetMemberId &&
      (outcome.outcome === "APPROVED" ||
        outcome.outcome === "DECLINED" ||
        (outcome.outcome === "BLOCKED" && outcome.status === "DECLINED"));

    if (delegateAnswered && actorMemberId) {
      await notifyDelegateAnswer({
        bookingId,
        guestId,
        targetMemberId,
        actorMemberId,
        booking,
        target: guest,
        answer:
          outcome.outcome === "APPROVED"
            ? { kind: "APPROVED" }
            : outcome.outcome === "DECLINED"
              ? { kind: "DECLINED_REMOVED" }
              : { kind: "DECLINED_STILL_ON_BOOKING" },
      });
    }

    // Only a LAPSE gets a notice back to the member who was asked, and it reaches
    // them through the SAME recipient rule the request did — themselves if they
    // hold a login, otherwise the family adults who were asked on their behalf —
    // so nobody is told a request lapsed that they never received.
    //
    // A decline needs no notice: they just made the decision themselves. And an
    // EXPIRED row was necessarily PENDING, which by the model's own shape table
    // means a request really was sent, so this cannot fire for a notify-only or
    // admin-assigned row that nobody was ever asked about.
    const lapsed =
      outcome.outcome === "EXPIRED" ||
      (outcome.outcome === "BLOCKED" && outcome.status === "EXPIRED");

    if (lapsed) {
      const bookerName =
        [booking.member?.firstName, booking.member?.lastName]
          .filter(Boolean)
          .join(" ")
          .trim() || "the person who made the booking";

      const recipients = await familyAdultDelegateResolver
        .resolveNotificationRecipients({ targetMemberId, db: prisma })
        .catch((err: unknown) => {
          logger.error(
            { err, bookingId, guestId },
            "Failed to resolve who to tell that a member-guest request lapsed",
          );
          return [];
        });

      if (recipients.length === 0) {
        // Not silent: a target with no login and no family adult cannot be told,
        // and an operator looking at the audit trail needs to know that rather
        // than assume a mail went out.
        logger.warn(
          { bookingId, guestId, targetMemberId },
          "A member-guest request lapsed with nobody to notify",
        );
      }

      for (const recipient of recipients) {
        try {
          await sendMemberGuestConsentExpiredEmail({
            bookingId,
            recipient: { kind: "member", memberId: recipient.memberId },
            email: recipient.email,
            firstName: recipient.firstName,
            bookerName,
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
            lodgeId: booking.lodgeId,
          });
        } catch (err) {
          logger.error(
            { err, bookingId, guestId, recipient: recipient.memberId },
            "Failed to send the member-guest lapse notice",
          );
        }
      }
    }
  } catch (err) {
    logger.error(
      { err, bookingId, guestId },
      "Failed to load booking context for a member-guest consent notification",
    );
  }
}
