import { logAudit } from "@/lib/audit";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { eachDateOnlyInRange } from "@/lib/date-only";
import {
  sendMemberGuestAddedEmail,
  sendMemberGuestConsentRequestEmail,
  sendMemberGuestRequestWithdrawnEmail,
} from "@/lib/email/member-guest";
import logger from "@/lib/logger";
import {
  familyAdultDelegateResolver,
  type MemberGuestConsentDelegateResolver,
} from "@/lib/member-guest-delegate";
import type { MemberGuestAddNotificationRow } from "@/lib/member-guest-add-policy";
import type { MemberGuestAddActor } from "@/lib/member-guest-consent";
import type {
  MemberGuestAddedContext,
  MemberGuestWithdrawnContext,
} from "@/lib/member-guest-email-notes";
import { prisma } from "@/lib/prisma";

/**
 * The ONE post-commit sender for every member-guest ADD ("+ Add Member Guest",
 * epic #2305, MG2 #2307).
 *
 * Four paths create cross-family guest rows — booking create, the guest-add
 * route, the batch modification, and the admin booking-copy — and each of them
 * owes the target either a consent request (D-3's ask-first default) or an
 * added-notice (notify-only, or an admin/copy add under MG4-D-a). They share this
 * dispatcher rather than each calling the senders, for three reasons that are all
 * load-bearing:
 *
 *  1. THE RECIPIENT RULE IS NOT OBVIOUS AND MUST NOT BE GUESSED FOUR TIMES.
 *     Owner decision D-9 makes any active member addable, and a large share of a
 *     club's members — children, and adults on a household login — hold no login
 *     of their own. A target with no login is the NORMAL case, so "email the
 *     member" is the wrong rule and would silently drop a large fraction of all
 *     requests. Resolution goes through `familyAdultDelegateResolver`, the same
 *     resolver the consent endpoint authorises answers with, so who is TOLD and
 *     who may ANSWER can never drift apart.
 *  2. NO PROVIDER CALL MAY SIT INSIDE A BOOKING TRANSACTION. Every caller
 *     collects its rows during the transaction and calls this AFTER the commit.
 *     An SES call inside the transaction would hold the per-lodge capacity lock
 *     for the length of a network round trip and, on failure, roll back a booking
 *     the member has already paid for.
 *  3. EACH SEND IS ISOLATED. One recipient's failure must not stop the next
 *     recipient, the next row, or the booking — so every send is individually
 *     try/caught and logged, and this function never rejects. Same discipline as
 *     `cron-pre-arrival-reminders.ts`.
 *
 * SEND-ONCE HONESTY. MG2 adds NO column recording "a request email was sent", so
 * this is best-effort at-most-once: exactly like today's booking-confirmation
 * mail, a send that fails is logged and never retried, and nothing here will send
 * a second time for the same row. That matters more for the consent request than
 * for an ordinary notice, because a request that never arrives becomes a PENDING
 * row that holds a bed until the sweep expires it (D-4) — the member is not
 * stranded, but they are never asked either. The `member-guest-consent-expired`
 * template's own frequency note ("ONLY where a request email was actually sent")
 * therefore cannot be honoured from a column in this release; whoever adds that
 * column adds the retry with it. Do not read the absence of a retry here as an
 * oversight, and do not "fix" it by looping — a loop with no persisted marker
 * sends duplicates on the next deploy, not fewer.
 */

export interface MemberGuestAddNotificationResult {
  /** Rows where at least one recipient was emailed successfully. */
  sentGuestIds: string[];
  /** Rows where every send failed. */
  failedGuestIds: string[];
  /**
   * Rows with NOBODY to tell — a target with no login and no family adult who
   * could stand in for them (see the note on the empty case below).
   */
  unreachableGuestIds: string[];
}

/**
 * Send the add notifications for one committed booking write.
 *
 * Call this AFTER the transaction commits. Never rejects: a mail failure is
 * logged and reported in the result, so the caller can `void` it (or await it and
 * log the counts) without wrapping it in a second try/catch.
 */
export async function sendMemberGuestAddNotifications(params: {
  bookingId: string;
  rows: readonly MemberGuestAddNotificationRow[];
  /**
   * Who did the adding. Decides the added-notice wording — `composeMemberGuest-
   * AddedContextNote`'s `"ADMIN"` vs `"NOTIFY_ONLY"` — which is exactly the same
   * distinction `buildMemberGuestConsentWrite` used to choose ADMIN_ASSIGNED over
   * NOTIFY_ONLY_AUTO_CONFIRMED, taken from the same value rather than re-derived.
   */
  actor: MemberGuestAddActor;
  db?: typeof prisma;
  delegateResolver?: MemberGuestConsentDelegateResolver;
}): Promise<MemberGuestAddNotificationResult> {
  const {
    bookingId,
    rows,
    actor,
    db = prisma,
    delegateResolver = familyAdultDelegateResolver,
  } = params;

  const result: MemberGuestAddNotificationResult = {
    sentGuestIds: [],
    failedGuestIds: [],
    unreachableGuestIds: [],
  };

  const owed = rows.filter((row) => row.notification !== "NONE");
  if (owed.length === 0) {
    // The overwhelming majority of bookings: no cross-family guest, no reads, no
    // sends. Returning before touching the database keeps this a genuine no-op
    // rather than "a query that finds nothing".
    return result;
  }

  // The club's today, resolved ONCE for the whole dispatch and threaded into
  // every self-removal fact set below (#3123). `evaluateGuestSelfRemoval` used
  // to default it from the container's timezone; reading it here — from the
  // club's PERSISTED zone (INV-CONFIG-002) — also means every notice in one
  // dispatch judges "has the stay started" against the same day. The runtime
  // reader rather than `club-time/server`: this module is reached from
  // `booking-create.ts`, which a CLI seed imports, where `server-only` throws
  // at import.
  const today = dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest()));

  // ONE read for the whole dispatch, and it reads what was actually COMMITTED
  // rather than trusting the caller's plan: the consent expiry that goes in the
  // request email is the value the sweep will act on, not the value the caller
  // intended to write.
  const context = await loadNotificationContext(db, bookingId, owed);
  if (!context) {
    logger.error(
      { bookingId, guestIds: owed.map((row) => row.bookingGuestId) },
      "Member-guest add notifications skipped: booking not found after commit",
    );
    result.failedGuestIds.push(...owed.map((row) => row.bookingGuestId));
    return result;
  }

  for (const row of owed) {
    const guest = context.guestsById.get(row.bookingGuestId);
    if (!guest) {
      // The row committed and then vanished — a concurrent removal, or a caller
      // that passed an id from a different booking. Neither is worth failing a
      // booking over, and neither may be papered over silently.
      logger.error(
        { bookingId, guestId: row.bookingGuestId },
        "Member-guest add notification skipped: guest row not found",
      );
      result.failedGuestIds.push(row.bookingGuestId);
      continue;
    }

    let recipients;
    try {
      recipients = await delegateResolver.resolveNotificationRecipients({
        targetMemberId: row.targetMemberId,
        db,
      });
    } catch (err) {
      logger.error(
        { err, bookingId, guestId: row.bookingGuestId, targetMemberId: row.targetMemberId },
        "Failed to resolve member-guest notification recipients",
      );
      result.failedGuestIds.push(row.bookingGuestId);
      continue;
    }

    if (recipients.length === 0) {
      // NOBODY CAN BE TOLD, AND THAT IS NOT AN ERROR CONDITION — it is a real
      // state of the club's data: a member with no login of their own who is in
      // no family group with an active, login-holding adult (D-10's interim
      // delegate rule). D-9 puts such members in scope deliberately.
      //
      // THE CONSEQUENCE, STATED PLAINLY. For a CONSENT_REQUEST this row is a
      // PENDING guest that holds a bed (D-4) which nobody will ever be asked
      // about: it sits until the nightly sweep expires it, and the booker's only
      // signal is the outcome email saying the request lapsed. For an
      // ADDED_NOTICE the member is simply never told they are on a booking. The
      // booking is NOT failed for either — refusing an otherwise valid booking
      // because the club's own membership data has no contactable adult would
      // punish the booker for something they cannot fix.
      //
      // So it is made VISIBLE in two places instead: an error log for the
      // operator, and an audit row an admin can query by action. It is
      // deliberately not swallowed as a debug line, and deliberately not turned
      // into a member-facing error.
      logger.error(
        {
          bookingId,
          guestId: row.bookingGuestId,
          targetMemberId: row.targetMemberId,
          notification: row.notification,
        },
        "Member-guest add notification has no recipient: the target has no login and no family adult delegate",
      );
      logAudit({
        action: "booking.member_guest.notification_unreachable",
        memberId: context.bookingOwnerMemberId,
        targetId: bookingId,
        subjectMemberId: row.targetMemberId,
        entityType: "BookingGuest",
        entityId: row.bookingGuestId,
        category: "communication",
        severity: "important",
        outcome: "blocked",
        summary: "Member guest could not be notified",
        details:
          "The member has no login of their own and no active adult in a family group who could be told, so no consent request or added notice could be sent.",
        metadata: {
          bookingId,
          bookingGuestId: row.bookingGuestId,
          targetMemberId: row.targetMemberId,
          notification: row.notification,
        },
      });
      result.unreachableGuestIds.push(row.bookingGuestId);
      continue;
    }

    if (row.notification === "CONSENT_REQUEST" && !guest.consentExpiresAt) {
      // A PENDING row with no expiry is the one shape
      // `buildMemberGuestConsentWrite` refuses to write, because the sweep's
      // partial index cannot see it and it would hold a bed forever. Reaching
      // here means something else wrote the row; refuse to send a request with no
      // deadline in it rather than mail a member an open-ended ask.
      logger.error(
        { bookingId, guestId: row.bookingGuestId, targetMemberId: row.targetMemberId },
        "Member-guest consent request not sent: the guest row has no consentExpiresAt",
      );
      result.failedGuestIds.push(row.bookingGuestId);
      continue;
    }

    let anySent = false;
    for (const recipient of recipients) {
      try {
        if (row.notification === "CONSENT_REQUEST") {
          await sendMemberGuestConsentRequestEmail({
            bookingId,
            recipient: { kind: "member", memberId: recipient.memberId },
            lodgeId: context.lodgeId,
            email: recipient.email,
            firstName: recipient.firstName,
            // A delegate must not read "has put YOU down as a guest" when it is
            // their child who was added — see `composeMemberGuestConsentAsk`.
            audience: recipient.isTarget
              ? { kind: "TARGET" as const }
              : {
                  kind: "DELEGATE" as const,
                  guest: { firstName: guest.firstName, lastName: guest.lastName },
                },
            consentExpiresAt: guest.consentExpiresAt!,
            consentUrl: buildMemberGuestConsentUrl({
              bookingId,
              guestId: guest.id,
              isTarget: recipient.isTarget,
            }),
            bookerName: context.bookerName,
            checkIn: context.checkIn,
            checkOut: context.checkOut,
            guestNights: guest.nights,
            party: context.party,
          });
        } else {
          await sendMemberGuestAddedEmail({
            bookingId,
            recipient: { kind: "member", memberId: recipient.memberId },
            lodgeId: context.lodgeId,
            email: recipient.email,
            // The recipient's OWN first name, so the greeting is right for a
            // delegate as well as for the target.
            firstName: recipient.firstName,
            // The same discriminator the consent request passes, and it matters
            // for exactly the same reason: owner decision D-9 makes a target with
            // no login the NORMAL case, so this mail is routinely read by a family
            // adult rather than by the guest. Without it the composed sentence
            // would say "…has added YOU as a guest" to somebody who is not on the
            // booking, and the removal note would point them at a self-removal
            // they cannot perform.
            audience: recipient.isTarget
              ? { kind: "TARGET" as const }
              : {
                  kind: "DELEGATE" as const,
                  guest: { firstName: guest.firstName, lastName: guest.lastName },
                },
            // ONE template, told apart by this value. Taken from the actor, not
            // re-derived from the columns — a `switch` rather than a ternary so
            // a fourth actor kind is a compile error here instead of silently
            // falling through to the notify-only sentence (MG4 #2309).
            context: memberGuestAddedContextFor(actor),
            bookerName: context.bookerName,
            checkIn: context.checkIn,
            checkOut: context.checkOut,
            guestNights: guest.nights,
            party: context.party,
            // `composeMemberGuestRemovalNote` calls the shared self-removal
            // predicate itself, so the email can never offer a control the server
            // would refuse (D-14). It needs the facts, not a verdict.
            selfRemoval: {
              actorMemberId: row.targetMemberId,
              guestMemberId: row.targetMemberId,
              bookingOwnerMemberId: context.bookingOwnerMemberId,
              bookingStatus: context.bookingStatus,
              bookingCheckIn: context.checkIn,
              bookingGuestCount: context.party.length,
              // D-14, and the fact that makes this notice honest on the whole
              // MG4-D-b population (#2309). `evaluateGuestSelfRemoval` defaults
              // `isQuotePriced` to false — "not known to be quote priced" — and
              // every row the booking-request pipeline creates sits on a booking
              // that IS, by construction. Without this read the pipeline's own
              // notice would have offered "you can take yourself off from your
              // account" to the one population that provably cannot, which is
              // exactly the promise the D-14 sweep exists to delete.
              isQuotePriced: context.isQuotePriced,
              today,
            },
          });
        }
        anySent = true;
      } catch (err) {
        // Per RECIPIENT, not per row: a household with two adults where one
        // address hard-bounces still reaches the other, and the row counts as
        // sent.
        logger.error(
          {
            err,
            bookingId,
            guestId: row.bookingGuestId,
            recipientMemberId: recipient.memberId,
            notification: row.notification,
          },
          "Failed to send member-guest add notification",
        );
      }
    }

    if (anySent) {
      result.sentGuestIds.push(row.bookingGuestId);
    } else {
      result.failedGuestIds.push(row.bookingGuestId);
    }
  }

  return result;
}

/**
 * Which of the added-notice's three sentences this actor owes the target.
 *
 * A total function over `MemberGuestAddActor`, kept beside the send rather than
 * inline, because it is the ONE place the actor model and the copy model meet.
 * `composeMemberGuestAdded` has carried three contexts since MG2; before MG4
 * only two of them were reachable, and the third was selected by a ternary whose
 * else-branch would have quietly mailed a pipeline target the notify-only
 * sentence ("this club does not ask first for member guests") — which is not
 * what happened to them at all.
 */
function memberGuestAddedContextFor(
  actor: MemberGuestAddActor,
): MemberGuestAddedContext {
  switch (actor.kind) {
    case "ADMIN":
      return "ADMIN";
    case "BOOKING_REQUEST":
      return "BOOKING_REQUEST";
    case "MEMBER":
      return "NOTIFY_ONLY";
  }
}

/**
 * The link the request email's "Answer this request" button points at — a
 * DIFFERENT surface per recipient, because the two audiences hold different
 * access (MG2's visible half):
 *
 *  - The TARGET answering for themselves gets the booking page's `#consent`
 *    anchor: owner decision D-11 gives their PENDING guest row full access to
 *    that page, and the consent card lives there, directly above the #2250
 *    self-removal card.
 *  - A DELEGATE gets `/bookings/consent/[guestId]` — their own page. D-11
 *    gives a delegate no booking-page access (the consent endpoint's doc
 *    comment is explicit that answering grants no view of the booking), so
 *    the booking-page link would land them on a redirect. The delegate page
 *    shows names, dates and the question, and never money.
 */
function buildMemberGuestConsentUrl(params: {
  bookingId: string;
  guestId: string;
  isTarget: boolean;
}): string {
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  return params.isTarget
    ? `${baseUrl}/bookings/${params.bookingId}#consent`
    : `${baseUrl}/bookings/consent/${params.guestId}`;
}

type NotificationContext = {
  lodgeId: string | null;
  checkIn: Date;
  checkOut: Date;
  bookingStatus: string;
  bookingOwnerMemberId: string;
  /**
   * Whether this booking carries an officer-negotiated booking-request price —
   * the same question `isQuotePricedBooking` answers, read from the booking's
   * own two request relations so the dispatch needs no second query (MG4 #2309,
   * D-14).
   */
  isQuotePriced: boolean;
  bookerName: string;
  /** Every guest on the booking, names only — MG2-D-a's party listing, no money. */
  party: Array<{ firstName: string; lastName: string }>;
  guestsById: Map<
    string,
    {
      id: string;
      firstName: string;
      lastName: string;
      consentExpiresAt: Date | null;
      /** This guest's own nights (#713), for the email's per-guest night label. */
      nights: Date[];
    }
  >;
};

async function loadNotificationContext(
  db: typeof prisma,
  bookingId: string,
  rows: readonly MemberGuestAddNotificationRow[],
): Promise<NotificationContext | null> {
  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      lodgeId: true,
      checkIn: true,
      checkOut: true,
      status: true,
      memberId: true,
      member: { select: { firstName: true, lastName: true } },
      // D-14, and the fact that makes the added notice honest for the whole
      // MG4-D-b population (#2309). `evaluateGuestSelfRemoval` defaults
      // `isQuotePriced` to false — "not known to be quote priced" — and every
      // row the booking-request pipeline creates sits on a booking that IS, by
      // construction. Without this the pipeline's own notice would offer "you
      // can take yourself off from your account" to the one population that
      // provably cannot.
      //
      // Read as two relations on the booking already being fetched rather than
      // through `isQuotePricedBooking`, which asks the same question from the
      // other side and would cost a second round trip after the commit. Both
      // arms are unique FKs on BookingRequest, so each is at most one row.
      originBookingRequest: { select: { id: true } },
      heldForBookingRequest: { select: { id: true } },
      guests: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          stayStart: true,
          stayEnd: true,
          consentExpiresAt: true,
          nights: { select: { stayDate: true } },
        },
      },
    },
  });

  if (!booking) return null;

  const wanted = new Set(rows.map((row) => row.bookingGuestId));
  return {
    lodgeId: booking.lodgeId,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    bookingStatus: booking.status,
    bookingOwnerMemberId: booking.memberId,
    isQuotePriced: Boolean(
      booking.originBookingRequest ?? booking.heldForBookingRequest,
    ),
    bookerName: `${booking.member.firstName} ${booking.member.lastName}`.trim(),
    party: booking.guests.map((guest) => ({
      firstName: guest.firstName,
      lastName: guest.lastName,
    })),
    guestsById: new Map(
      booking.guests
        .filter((guest) => wanted.has(guest.id))
        .map((guest) => [
          guest.id,
          {
            id: guest.id,
            firstName: guest.firstName,
            lastName: guest.lastName,
            consentExpiresAt: guest.consentExpiresAt,
            // Night rows are the uniform model since #713, but a guest written by
            // an older path may have none, so fall back to the stored envelope
            // rather than mailing a member an empty night list.
            nights:
              guest.nights.length > 0
                ? guest.nights.map((night) => night.stayDate)
                : eachDateOnlyInRange(guest.stayStart, guest.stayEnd),
          },
        ]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Withdrawal — the other direction (MG4 #2309)
// ---------------------------------------------------------------------------

export interface MemberGuestWithdrawnNotificationResult {
  /** Members where at least one recipient was emailed successfully. */
  sentMemberIds: string[];
  /** Members where every send failed. */
  failedMemberIds: string[];
  /** Members with nobody to tell (see the note in the add dispatcher). */
  unreachableMemberIds: string[];
}

/**
 * Tell a member — or their family delegate — that they have come OFF a booking
 * they were told about.
 *
 * WHY IT IS A SEPARATE DISPATCHER RATHER THAN A FLAG ON THE ADD ONE. The add
 * dispatcher's whole shape depends on the guest ROW still existing: it reads the
 * row back after the commit so the email quotes the expiry the sweep will act
 * on, the guest's own nights, and the party they are joining. By the time a
 * withdrawal is dispatched the row is gone — that is what "withdrawn" means — so
 * there is nothing to read back and nothing of that to say. Sharing one function
 * would mean every field on it becoming conditional on a direction, which is how
 * a notice ends up quoting a bed that no longer exists.
 *
 * IT NEEDS THE MEMBER, NOT THE ROW. The recipient set comes from the same
 * delegate resolver the add uses (so who is told about being added and who is
 * told about being removed can never drift), and the guest's own name — needed
 * only for the delegate wording — is read from the `Member` record rather than
 * from the vanished guest row.
 *
 * Never rejects, for the same reason the add dispatcher does not: it runs after
 * a committed booking write, and a mail failure must not surface as one.
 */
export async function sendMemberGuestWithdrawnNotifications(params: {
  bookingId: string;
  /** Member ids that were told they were on this booking and are not any more. */
  targetMemberIds: readonly string[];
  context: MemberGuestWithdrawnContext;
  db?: typeof prisma;
  delegateResolver?: MemberGuestConsentDelegateResolver;
}): Promise<MemberGuestWithdrawnNotificationResult> {
  const {
    bookingId,
    context,
    db = prisma,
    delegateResolver = familyAdultDelegateResolver,
  } = params;
  const targetMemberIds = [...new Set(params.targetMemberIds)];

  const result: MemberGuestWithdrawnNotificationResult = {
    sentMemberIds: [],
    failedMemberIds: [],
    unreachableMemberIds: [],
  };
  if (targetMemberIds.length === 0) return result;

  const booking = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      lodgeId: true,
      checkIn: true,
      checkOut: true,
      member: { select: { firstName: true, lastName: true } },
    },
  });
  if (!booking) {
    logger.error(
      { bookingId, targetMemberIds },
      "Member-guest withdrawal notifications skipped: booking not found after commit",
    );
    result.failedMemberIds.push(...targetMemberIds);
    return result;
  }
  const bookerName =
    `${booking.member.firstName} ${booking.member.lastName}`.trim();

  const targets = await db.member.findMany({
    where: { id: { in: targetMemberIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const targetById = new Map(targets.map((member) => [member.id, member]));

  for (const targetMemberId of targetMemberIds) {
    const target = targetById.get(targetMemberId);
    if (!target) {
      // The member row itself has gone — a hard delete between the commit and
      // this send. Nothing to tell and nobody to tell it to.
      logger.error(
        { bookingId, targetMemberId },
        "Member-guest withdrawal notification skipped: member not found",
      );
      result.failedMemberIds.push(targetMemberId);
      continue;
    }

    let recipients;
    try {
      recipients = await delegateResolver.resolveNotificationRecipients({
        targetMemberId,
        db,
      });
    } catch (err) {
      logger.error(
        { err, bookingId, targetMemberId },
        "Failed to resolve member-guest withdrawal recipients",
      );
      result.failedMemberIds.push(targetMemberId);
      continue;
    }

    if (recipients.length === 0) {
      // Same real state of the club's data as on the add path, and made visible
      // the same way. It matters slightly less here — nobody is left holding a
      // bed nobody asked about — but a member who was told they were coming and
      // is never told they are not is exactly the sort of silence an operator
      // should be able to find later.
      logger.error(
        { bookingId, targetMemberId, context },
        "Member-guest withdrawal notification has no recipient: the target has no login and no family adult delegate",
      );
      logAudit({
        action: "booking.member_guest.notification_unreachable",
        targetId: bookingId,
        subjectMemberId: targetMemberId,
        entityType: "Booking",
        entityId: bookingId,
        category: "communication",
        severity: "important",
        outcome: "blocked",
        summary: "Member guest could not be told they came off a booking",
        details:
          "The member has no login of their own and no active adult in a family group who could be told, so no withdrawal notice could be sent.",
        metadata: { bookingId, targetMemberId, context },
      });
      result.unreachableMemberIds.push(targetMemberId);
      continue;
    }

    let anySent = false;
    for (const recipient of recipients) {
      try {
        await sendMemberGuestRequestWithdrawnEmail({
          bookingId,
          recipient: { kind: "member", memberId: recipient.memberId },
          lodgeId: booking.lodgeId,
          email: recipient.email,
          firstName: recipient.firstName,
          bookerName,
          context,
          audience: recipient.isTarget
            ? { kind: "TARGET" as const }
            : {
                kind: "DELEGATE" as const,
                guest: { firstName: target.firstName, lastName: target.lastName },
              },
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
        });
        anySent = true;
      } catch (err) {
        logger.error(
          {
            err,
            bookingId,
            targetMemberId,
            recipientMemberId: recipient.memberId,
            context,
          },
          "Failed to send member-guest withdrawal notification",
        );
      }
    }

    if (anySent) {
      result.sentMemberIds.push(targetMemberId);
    } else {
      result.failedMemberIds.push(targetMemberId);
    }
  }

  return result;
}
