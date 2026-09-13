/**
 * CORRECTING A BOOKING REQUEST BEFORE IT IS CONVERTED (#2936, MAD epic #2725).
 *
 * ## What this is for
 *
 * A school or a guest submits a request, then emails the club: the dates were
 * wrong, two more children are coming, a teacher has changed, the school name
 * was typed badly. Until now the only officer answer was **decline it and ask
 * them to submit again** — which loses the request's history, its verification,
 * its place in the queue and any beds held for it, and which the operator guide
 * said in as many words ("There is no guest-edit screen"). This is that screen,
 * as ONE authoritative operation rather than a scatter of column writes.
 *
 * ## The one rule everything else follows from
 *
 * **A correction re-opens the request.** Every price and every quote on a
 * request was computed from the shape being corrected, so all of them are
 * retired in the same write: any DRAFT or SENT quote is SUPERSEDED, the officer
 * price is cleared, and the request drops back to VERIFIED. There is no
 * "small enough not to matter" edit, and deliberately so — a correction that
 * left yesterday's price attached to today's party is exactly the defect this
 * surface would otherwise introduce. The officer re-prices and re-quotes from
 * the corrected data, which is what makes the quote the requester finally sees
 * describe the stay they finally asked for.
 *
 * ## What stage 2 of the school programme changed about this issue
 *
 * This issue was written before #3367, and #3367 changed what two of these
 * fields REACH — worth being blunt about, because nothing on the screen would
 * otherwise say so:
 *
 *   - **the school's name is no longer just a label.** Approval resolves it to
 *     an `Organisation` record, and that record owns the school's durable Xero
 *     customer. So correcting the name is a decision about *which school the
 *     club is about to invoice* — see `school-organisation-preview.ts`, which
 *     shows the officer the answer and makes them confirm it.
 *   - **the teachers are no longer just names on a guest list.** Approval makes
 *     the booking's teachers the school's current contact people, REPLACING
 *     whoever was there (`reconcileOrganisationTeachers`). So correcting the
 *     teacher list before conversion decides who the club's treasurer — and
 *     Xero — will be shown as the people to talk to. The preview names who
 *     would be displaced; the audit row records it.
 *
 * Neither happens HERE, and this module deliberately does not so much as NAME
 * the school link — stage 2's census keeps the set of files that read it small
 * and argued-for, and `school-organisation-preview.ts` is the one file this
 * issue adds to it. The link on the request is still written only at
 * conversion; nothing here creates a record or touches a contact. Correcting a
 * request changes what approval will resolve, not what it has resolved, and
 * that separation is deliberate: the resolve's unique-name claim is the
 * approval transaction's own global lock, and moving it earlier would mint
 * records for requests that are never approved.
 *
 * ## Locking (`INV-LOCK-001`)
 *
 * The claim below takes the canonical global `pg_advisory_xact_lock(1)` and
 * nothing else, and the reason is narrower than "it excludes approval" — which
 * is what an earlier version of this comment said, and is what sent the first
 * reviewer looking at the wrong counterpart.
 *
 * **The key is what makes the school-record re-read inside the claim a fence.**
 * `previewSchoolRecordForName` is asked again under the lock, and the officer's
 * acknowledgement is checked against THAT answer rather than the one the screen
 * rendered. The only writer of those records is
 * `resolveOrCreateSchoolOrganisation`, whose unique-name claim IS the approval
 * transaction's hold of this same key — so excluding approval is exactly what
 * lets the re-read promise that no record appeared in between. Without it the
 * acknowledgement would describe a school that may already have been minted,
 * and a correction could quietly join an invoice to the wrong Xero customer.
 *
 * **It is NOT what fences the conversion's own write.** Both approvals claim on
 * `version: request.version` (#1923), so the version fence below already
 * settles that race in both directions: a correction landing mid-conversion
 * makes the conversion's claim miss, and a conversion landing mid-correction
 * makes this claim miss.
 *
 * **The counterparts a version fence did NOT close** are the FOUR quote writers
 * in `booking-request-quotes.ts`. None of them took a lock, and each fenced only
 * on "not declined, not cancelled" — a set that this writer's VERIFIED is
 * squarely inside, because a correction RE-OPENS a request where decline
 * TERMINATES one. Three are reconciled at the writer, per the concurrency
 * checklist: the quote save claims on the request version, the quote send claims
 * the quote row while it is still DRAFT/SENT, and the accept re-arm takes this
 * key and re-reads the quote's status under it.
 *
 * **The fourth is deliberately left, and saying which one is the point of this
 * paragraph.** `respondToBookingRequestQuote`'s MODIFY/QUERY branch still opens
 * a bare transaction with that same insufficient guard, so a requester pressing
 * "ask for changes" on a quote link that was live a moment ago can still flip a
 * freshly corrected request to MODIFICATION_REQUESTED or QUERY_PENDING. What it
 * writes is a status and the requester's own message — no price, no accepted
 * snapshot, no hold, no conversion — and both states it can reach are
 * correctable and swept exactly as VERIFIED is, so fencing it would buy a
 * cosmetic status at the cost of discarding a message from the person whose
 * booking it is. Its quote write IS narrowed to DRAFT/SENT, so it can no longer
 * overwrite the supersede mark this correction made.
 *
 * It takes no per-lodge key: it creates no booking and claims no bed.
 * Registered in `advisory-lock-guard.test.ts`.
 *
 * ## The capacity hold, and why the release is not inside that transaction
 *
 * A request that already has beds held has them held for the OLD shape. Every
 * corrected field except the catering preference feeds what the hold is made of
 * — its nights, its guest rows, its owner's name and email — so a correction
 * releases the hold and the officer re-holds (or simply re-sends a quote, which
 * holds automatically) against the corrected data.
 *
 * That release CANNOT sit inside the claim transaction: `cancelBooking` takes
 * the global key and runs transactions of its own, so nesting it would
 * self-deadlock. `declineBookingRequest` composes the identical pair and this
 * follows it exactly — claim first, release after, and say so loudly with
 * {@link BookingRequestCorrectionCommittedError} if the release fails. Its
 * worst case is a request still pointing at a hold covering MORE than it needs,
 * visible on the screen with its own Release button; never one that has quietly
 * lost beds it still believes it has.
 */

import {
  BookingRequestQuoteStatus,
  BookingRequestStatus,
  BookingRequestType,
  Prisma,
} from "@prisma/client";

import { logAudit } from "@/lib/audit";
import {
  BookingRequestError,
  isMemberWholeLodgeRequest,
  parseBookingRequestGuests,
  parseBookingRequestLinkedGuestMembers,
  type BookingRequestGuest,
} from "@/lib/booking-request";
import {
  cleanCorrectionLine,
  guestListKey,
  normaliseCorrectedTeachers,
  teacherListKey,
  type BookingRequestCorrectionInput,
  type BookingRequestCorrectionResult,
  type CorrectedTeacher,
} from "@/lib/booking-request-correction-shape";
import {
  BookingRequestCorrectionCommittedError,
  reconcileCorrectedRequestHold,
  type CorrectionHoldOutcome,
} from "@/lib/booking-request-correction-hold";
import { isHostingCoverageParticipantRetry } from "@/lib/adult-member-hosting-queue-participants";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { getCapacityFullNights } from "@/lib/capacity-full-nights";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { getDefaultLodgeCapacity, getLodgeCapacity } from "@/lib/lodge-capacity";
import { getDefaultLodgeId } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import {
  assertSchoolRecordOutcomeAcknowledged,
  normaliseSchoolNameForStorage,
  previewSchoolRecordForName,
} from "@/lib/school-organisation-preview";
import { generateSchoolGuests } from "@/lib/school-booking-request";

/**
 * The states a request may be corrected in: every state where it is live, in
 * front of an officer, and not yet agreed with the requester.
 *
 * NEW is excluded because the requester has not confirmed their own email
 * address yet, so there is no one to have asked for the correction; every
 * terminal and converted state is excluded because there is nothing left to
 * correct. That this is the same six states a request can be DECLINED in is a
 * consequence of both rules meaning "live and undecided", not a shared list —
 * so it is written out rather than borrowed.
 */
export const CORRECTABLE_BOOKING_REQUEST_STATUSES = [
  BookingRequestStatus.VERIFIED,
  BookingRequestStatus.PRICED,
  BookingRequestStatus.QUOTED,
  BookingRequestStatus.QUOTE_SENT,
  BookingRequestStatus.QUERY_PENDING,
  BookingRequestStatus.MODIFICATION_REQUESTED,
] as const;

/**
 * Correct an unconverted booking request.
 *
 * Refusals are ordered so the officer is told the most fundamental reason
 * first: what the request IS, then what state it is in, then whether its stored
 * data can be read, then whether the corrected values are usable.
 */
export async function correctBookingRequest(
  input: BookingRequestCorrectionInput,
): Promise<BookingRequestCorrectionResult> {
  const reason = cleanCorrectionLine(input.reason);
  if (!reason) {
    throw new BookingRequestError(
      "Record why you are correcting this request.",
      422,
    );
  }

  const request = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
    include: { quotes: { select: { id: true, status: true } } },
  });
  if (!request) {
    throw new BookingRequestError("Booking request not found", 404);
  }

  // A member's whole-lodge request has one lifecycle — approve it directly or
  // decline it — and no quote stage to correct anything for. Refused at the
  // service layer, like every other operation that lifecycle excludes, so a
  // hidden button is not what is holding the rule.
  if (isMemberWholeLodgeRequest(request)) {
    throw new BookingRequestError(
      "A member's whole-lodge request cannot be corrected here. Approve it with the headcount you mean, or decline it.",
      409,
    );
  }

  if (request.convertedBookingId) {
    throw new BookingRequestError(
      "This request has already been converted into a booking. Edit the booking itself instead.",
      409,
    );
  }
  if (!CORRECTABLE_BOOKING_REQUEST_STATUSES.includes(request.status as never)) {
    throw new BookingRequestError(
      "This request is no longer open, so it cannot be corrected.",
      409,
    );
  }

  // An AGREED price is a different thing from an offered one. The requester has
  // accepted these dates at this price; changing what they accepted underneath
  // them is not a correction, it is a new offer. The officer re-opens the quote
  // deliberately — by declining it or issuing a fresh one — and the refusal says
  // so rather than silently voiding an agreement.
  const acceptedQuote = request.quotes.some(
    (quote) => quote.status === BookingRequestQuoteStatus.ACCEPTED,
  );
  if (acceptedQuote || request.acceptedQuoteId) {
    throw new BookingRequestError(
      "The requester has already accepted a quote for this request. Re-open or re-issue the quote before correcting it.",
      409,
    );
  }

  // #2342's rule, applied here for the reason it applies to pricing and
  // holding: a row whose stored party cannot be read back is repaired or
  // declined, never guessed at. Correcting it would be the worst version of
  // guessing, because the officer's corrected list would silently become the
  // whole truth about a party nobody can now compare it against.
  parseBookingRequestGuests(request.guests);
  const storedLinks = parseBookingRequestLinkedGuestMembers(
    request.linkedGuestMembers,
  );

  if (request.version !== input.expectedVersion) {
    throw new BookingRequestError(
      "This request changed while you were correcting it. Refresh and check it before saving again.",
      409,
    );
  }

  /**
   * WHAT THE REQUEST IS DECIDES THE SHAPE, NOT WHAT THE CALLER SENT.
   *
   * This used to branch on whether a school block arrived, which is a different
   * question with a different answer: a GENERAL request carrying both a guest
   * list and a school block would have had its party silently REGENERATED from
   * teachers and counts, and school fields stamped onto a row that has none.
   * This module's whole claim is that it cannot be routed around by a caller
   * with a looser idea of what a correction is, and branching on the payload is
   * exactly that idea. So the row's own type selects the shape, and a payload
   * that does not match it is refused rather than partly used.
   */
  const isSchool = request.type === BookingRequestType.SCHOOL;
  const school = isSchool ? (input.school ?? null) : null;
  if (isSchool && !school) {
    throw new BookingRequestError(
      "A school request needs its school details to be corrected together.",
      422,
    );
  }
  if (!isSchool && input.school) {
    throw new BookingRequestError(
      "This request is not a school request, so it has no school details to correct.",
      422,
    );
  }
  if (isSchool && input.guests?.length) {
    throw new BookingRequestError(
      "A school request's party is built from its teachers and child counts, so a guest list cannot be sent with it.",
      422,
    );
  }
  if (!isSchool && !input.guests?.length) {
    throw new BookingRequestError("A request needs at least one guest.", 422);
  }

  // ---- the corrected envelope --------------------------------------------
  const checkIn = input.checkIn;
  const checkOut = input.checkOut;
  if (checkOut <= checkIn) {
    throw new BookingRequestError("Check-out must be after check-in", 422);
  }
  // CT-4 (#2870): the CLUB's day, from its persisted zone (`INV-CONFIG-002`),
  // read before any lock is taken. The runtime reader rather than the
  // `server-only` one, so this module stays importable from every caller
  // `booking-request-quotes.ts` already is.
  const clubTodayDateOnly = dateOnlyInstantOf(
    clubToday(await readClubTimeZoneOutsideRequest()),
  );
  if (checkIn < clubTodayDateOnly) {
    throw new BookingRequestError(
      "A corrected stay cannot start in the past.",
      422,
    );
  }

  const teachers = school ? normaliseCorrectedTeachers(school.teachers) : [];
  if (school && teachers.length === 0) {
    throw new BookingRequestError(
      "A school request needs at least one teacher attending.",
      422,
    );
  }

  const guests: BookingRequestGuest[] = school
    ? generateSchoolGuests({ teachers, childCounts: school.childCounts })
    : (input.guests ?? []);
  if (guests.length === 0) {
    throw new BookingRequestError("A request needs at least one guest.", 422);
  }

  const lodgeCapacity = request.lodgeId
    ? await getLodgeCapacity(request.lodgeId)
    : await getDefaultLodgeCapacity();
  if (guests.length > lodgeCapacity) {
    throw new BookingRequestError(
      `That party is larger than the lodge capacity of ${lodgeCapacity} guests.`,
      422,
    );
  }

  const contactFirstName = cleanCorrectionLine(input.contactFirstName);
  const contactLastName = cleanCorrectionLine(input.contactLastName);
  const contactEmail = cleanCorrectionLine(input.contactEmail).toLowerCase();
  const contactPhone = cleanCorrectionLine(input.contactPhone) || null;
  if (!contactFirstName || !contactLastName || !contactEmail) {
    throw new BookingRequestError(
      "A request needs a contact name and email address.",
      422,
    );
  }
  const schoolName = school
    ? normaliseSchoolNameForStorage(school.schoolName)
    : null;

  // ---- what actually changed ----------------------------------------------
  const storedGuests = parseBookingRequestGuests(request.guests);
  const changedFields: string[] = [];
  const mark = (field: string, changed: boolean) => {
    if (changed) changedFields.push(field);
  };
  mark("checkIn", request.checkIn.getTime() !== checkIn.getTime());
  mark("checkOut", request.checkOut.getTime() !== checkOut.getTime());
  mark("guests", guestListKey(storedGuests) !== guestListKey(guests));
  mark("contactFirstName", request.contactFirstName !== contactFirstName);
  mark("contactLastName", request.contactLastName !== contactLastName);
  mark("contactEmail", request.contactEmail.toLowerCase() !== contactEmail);
  mark("contactPhone", (request.contactPhone ?? null) !== contactPhone);
  if (school) {
    mark("schoolName", request.schoolName !== schoolName);
    mark(
      "teachers",
      teacherListKey(normaliseCorrectedTeachers((request.teachers as CorrectedTeacher[]) ?? [])) !==
        teacherListKey(teachers),
    );
    mark(
      "cateringPreference",
      request.cateringPreference !== school.cateringPreference,
    );
  }
  if (changedFields.length === 0) {
    throw new BookingRequestError(
      "Nothing was changed, so there is nothing to correct.",
      422,
    );
  }

  // Everything the hold is BUILT from — its nights, its guest rows, its owner's
  // name and email address. The catering preference is the one corrected field
  // a hold never reads (it selects quote options, not beds), so correcting it
  // alone keeps the beds the club already holds.
  const holdAffecting = changedFields.some(
    (field) => field !== "cateringPreference",
  );

  /**
   * THE MEMBER LINKS ARE KEYED BY POSITION, AND A CORRECTION REWRITES THE LIST.
   *
   * `linkedGuestMembers` says "guest number one IS this member", and every
   * consumer — pricing, the hold's guest rows, the night-conflict check, the
   * member-guest consent plan, conversion — resolves it by INDEX. This write
   * replaces the guest list wholesale, and for a school request it regenerates
   * it from the teachers and the counts, so a teacher dropping out shifts every
   * row after them up by one. Left alone, index one would still be claimed as
   * that member: a child row priced at member rates, checked for night
   * conflicts against a stranger, and emailed to tell them the club has put
   * them on a lodge booking. The mirror case silently drops a link, turning a
   * linked member into a non-member — the exact outcome #2342's strict re-read
   * in `createBookingRequestQuote` exists to prevent.
   *
   * So a correction that moves the party CLEARS the links, in the same claim,
   * and the officer is told to re-link before quoting. Keeping them would be
   * guessing at identity, which is the one thing this surface refuses to do
   * (#2342's rule, and this issue's own "identity stays correct through edit
   * and later conversion"). A correction that leaves the list byte-identical —
   * dates only, catering only, a contact detail — moves no position and keeps
   * every link.
   */
  const partyChanged = changedFields.includes("guests");
  const clearedMemberLinkCount = partyChanged ? storedLinks.length : 0;

  // ---- the claim ----------------------------------------------------------
  const correctedAt = new Date();
  const claim = await prisma.$transaction(async (tx) => {
    // `INV-LOCK-001`/`INV-LOCK-002`: the global tier, and only it. Approval is
    // the counterpart this must exclude — see the module docblock. Taken first,
    // before any read whose answer the claim depends on.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

    // Re-asked UNDER the lock, so what the officer confirmed is what the write
    // is about: with approvals excluded, no record can appear between this read
    // and the claim below.
    const preview = schoolName
      ? await previewSchoolRecordForName(tx, schoolName)
      : null;
    if (preview && school) {
      assertSchoolRecordOutcomeAcknowledged(preview, school.schoolRecord);
    }

    const claimed = await tx.bookingRequest.updateMany({
      where: {
        id: request.id,
        version: request.version,
        status: { in: [...CORRECTABLE_BOOKING_REQUEST_STATUSES] },
        convertedBookingId: null,
        acceptedQuoteId: null,
      },
      data: {
        checkIn,
        checkOut,
        guests: guests as unknown as Prisma.InputJsonValue,
        contactFirstName,
        contactLastName,
        contactEmail,
        contactPhone,
        // Positional links cannot survive a rewritten list — see above. Written
        // inside the claim, so the party and its links move together or not at
        // all; an untouched list keeps its links untouched.
        ...(partyChanged
          ? { linkedGuestMembers: [] as unknown as Prisma.InputJsonValue }
          : {}),
        ...(school
          ? {
              schoolName,
              teachers: teachers as unknown as Prisma.InputJsonValue,
              cateringPreference: school.cateringPreference,
            }
          : {}),
        // The one rule: a correction re-opens the request. Every number below
        // was derived from the shape that has just changed.
        status: BookingRequestStatus.VERIFIED,
        priceCents: null,
        pricedByMemberId: null,
        pricedAt: null,
        reviewedByMemberId: input.adminMemberId,
        reviewedAt: correctedAt,
        version: { increment: 1 },
      },
    });
    if (claimed.count === 0) return { claimed: false as const };

    // SUPERSEDED, not CANCELLED: an officer retired this quote, and CANCELLED
    // is the requester's own semantic. Flipping it off SENT is also what kills
    // the requester's live response link — `loadSentQuoteByToken` requires SENT
    // — so the quote they hold can no longer be accepted against a shape it no
    // longer describes.
    const superseded = await tx.bookingRequestQuote.updateMany({
      where: {
        bookingRequestId: request.id,
        status: {
          in: [BookingRequestQuoteStatus.DRAFT, BookingRequestQuoteStatus.SENT],
        },
      },
      data: {
        status: BookingRequestQuoteStatus.SUPERSEDED,
        supersededAt: correctedAt,
      },
    });

    return {
      claimed: true as const,
      preview,
      supersededQuoteCount: superseded.count,
    };
  });

  if (!claim.claimed) {
    throw new BookingRequestError(
      "This request changed while you were correcting it. Refresh and check it before saving again.",
      409,
    );
  }

  // ---- everything after the claim -----------------------------------------
  /**
   * THE CLAIM HAS COMMITTED, SO NOTHING BELOW MAY BE REPORTED AS A FAILED SAVE.
   *
   * `declineBookingRequest` wraps its whole post-claim block and converts ANY
   * error into its own committed type. This adopted decline's ORDERING and, for
   * a while, not its wrapper — so only the hold reconcile's own committed error
   * got that treatment, and everything else (a hold read that throws instead of
   * returning, the member-guest notification, the advisory availability
   * measure) fell through to a bare failure while the correction WAS saved. The
   * officer then re-types the whole form, resubmits, and hits a version
   * conflict: the exact confusion this surface set out to remove, one layer up.
   *
   * So the block is wrapped. The inner capture around the reconcile stays, and
   * is a different thing: it is what lets the AUDIT ROW be written with what
   * actually happened to the hold before the error is rethrown, because a
   * correction whose beds could not be freed is precisely the one an officer has
   * to be able to find later.
   */
  /**
   * Declared OUTSIDE the wrapper, so the catch below can read what actually
   * happened to the beds. Inside it, the catch could not see this binding at
   * all and fell back to `request.heldBookingId` — the pre-claim pointer, which
   * still says "held" about beds this correction had just released — so a
   * failure anywhere after the release told the officer to go and check a hold
   * that was already gone. Exactly the noise the message beside it exists to
   * avoid.
   */
  let hold:
    | { released: true; outcome: CorrectionHoldOutcome }
    | { released: false; error: unknown }
    | undefined;
  try {

  // The inner capture, whose whole job is to let the audit row be written with
  // what happened to the beds before the error is rethrown.
  try {
    hold = {
      released: true,
      outcome: await reconcileCorrectedRequestHold({
        requestId: request.id,
        heldBookingId: request.heldBookingId,
        holdAffecting,
        adminMemberId: input.adminMemberId,
        ipAddress: input.ipAddress ?? "",
      }),
    };
  } catch (error) {
    hold = { released: false, error };
  }

  logAudit({
    action: "booking_request.corrected",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    severity: "important",
    outcome: "success",
    summary: "Booking request corrected by officer before conversion",
    metadata: {
      reason,
      changedFields,
      // `releaseFailed` is not a `CorrectionHoldOutcome`: no outcome was
      // reached. It is the audit's own word for "the beds are still held for
      // the old shape", which is what an officer reading this row needs to know.
      holdOutcome: hold.released ? hold.outcome : "releaseFailed",
      supersededQuoteCount: claim.supersededQuoteCount,
      // The links this correction cleared, and why: an officer reading this row
      // later needs to know the party was re-identified, not just re-typed.
      clearedMemberLinkCount,
      previousStatus: request.status,
      previousCheckIn: request.checkIn.toISOString(),
      previousCheckOut: request.checkOut.toISOString(),
      previousGuestCount: storedGuests.length,
      previousPriceCents: request.priceCents,
      checkIn: checkIn.toISOString(),
      checkOut: checkOut.toISOString(),
      guestCount: guests.length,
      ...(school
        ? {
            previousSchoolName: request.schoolName,
            schoolName,
            teacherCount: teachers.length,
            // #3367: the school record this name will resolve to at approval,
            // and — when the club already holds one — the contact people this
            // request's teachers would replace on it. Recorded because the
            // replacement itself happens later, in a different transaction, and
            // this is where the decision that causes it was taken.
            schoolRecordKnown: claim.preview?.known ?? false,
            schoolRecordHasXeroCustomer:
              claim.preview?.schoolRecordHasXeroCustomer ?? false,
            schoolContactPeopleToReplace:
              claim.preview?.currentContactNames ?? [],
          }
        : {}),
    },
  });

  if (!hold.released) throw hold.error;

  // Advisory, and measured last: after the hold went, so the officer is told
  // what the lodge can take now rather than what it could take while this
  // request's own beds were still sterilised by a stale hold.
  const lodgeId = request.lodgeId ?? (await getDefaultLodgeId(prisma));
  const capacity = await checkCapacityForGuestRanges(
    lodgeId,
    checkIn,
    checkOut,
    guests.map(() => ({ stayStart: checkIn, stayEnd: checkOut })),
  );

  return {
    changedFields,
    holdOutcome: hold.outcome,
    supersededQuoteCount: claim.supersededQuoteCount,
    clearedMemberLinkCount,
    schoolRecord: claim.preview ?? null,
    availability: {
      available: capacity.available,
      fullNights: capacity.available
        ? []
        : getCapacityFullNights(capacity.nightDetails),
    },
  };
  } catch (error) {
    // Already the committed shape (the reconcile's own refusal, rethrown
    // above): it already says the right thing, so pass it through untouched.
    if (error instanceof BookingRequestCorrectionCommittedError) throw error;
    // The hosting-coverage participant fence is a RETRY signal, and the route
    // turns it into its own response — so it is carried as `cause`, the way
    // decline carries it, rather than flattened away.
    const holdReleasePending = isHostingCoverageParticipantRetry(error);
    // Only a request that HAD a hold can have left one behind. Saying "check
    // the held beds" to an officer correcting a request that never held any is
    // how a clear message becomes noise — and so is saying it about beds this
    // correction released a moment ago, which is why the outcome is read here
    // rather than the pre-claim pointer. `undefined` means the failure beat the
    // reconcile to it, which nothing between them can currently do; the pointer
    // is the conservative answer if something ever does.
    const holdUnresolved =
      holdReleasePending ||
      (hold ? !hold.released : request.heldBookingId !== null);
    throw new BookingRequestCorrectionCommittedError(
      holdUnresolved
        ? "The correction was saved, but this request's held beds could not be confirmed. Open the request and check its hold before quoting again."
        : "The correction was saved, but the result could not be read back. Reload the request queue before continuing.",
      error instanceof BookingRequestError
        ? error.status
        : holdReleasePending
          ? 409
          : 500,
      holdReleasePending,
      { cause: error },
    );
  }
}
