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
 * ## Locking (`INV-LOCK-001`, `INV-LOCK-002`)
 *
 * The claim below takes the canonical global `pg_advisory_xact_lock(1)` and
 * nothing else. It needs the global tier for one concrete reason: **approval is
 * its counterpart.** Both school and general approval take that key first thing
 * in their own transaction, and without it a correction can interleave with a
 * conversion — the conversion reads the old envelope, this writes the new one,
 * and the request ends up CONVERTED while claiming dates the booking does not
 * have. The status-and-version-guarded claim alone cannot close that, because
 * the conversion's own write is not version-guarded. It takes no per-lodge key:
 * it creates no booking and claims no bed. Registered in
 * `advisory-lock-guard.test.ts`.
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
  SchoolCateringPreference,
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
  reconcileCorrectedRequestHold,
  type CorrectionHoldOutcome,
} from "@/lib/booking-request-correction-hold";
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
  type SchoolRecordAcknowledgement,
  type SchoolRecordPreview,
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

/** The corrected teacher, in the shape the request stores. */
export type CorrectedTeacher = {
  firstName: string;
  lastName: string;
  email: string | null;
};

/** The school half of a correction. Required for a SCHOOL request, absent otherwise. */
export type SchoolCorrection = {
  schoolName: string;
  teachers: CorrectedTeacher[];
  childCounts: { INFANT?: number; CHILD?: number; YOUTH?: number };
  cateringPreference: SchoolCateringPreference;
  /** The officer's confirmation of which school record this name claims. */
  schoolRecord: SchoolRecordAcknowledgement;
};

export type BookingRequestCorrectionInput = {
  requestId: string;
  adminMemberId: string;
  ipAddress?: string;
  /**
   * The version the officer's screen was showing. A correction written over a
   * request something else has moved is refused, not merged.
   */
  expectedVersion: number;
  /** Why the officer is changing it. Officer-facing only; never emailed. */
  reason: string;
  checkIn: Date;
  checkOut: Date;
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string;
  contactPhone: string | null;
  /** SCHOOL requests only. */
  school?: SchoolCorrection | null;
  /** GENERAL requests only: the corrected party, in full. */
  guests?: BookingRequestGuest[] | null;
};

export type BookingRequestCorrectionResult = {
  /** Field names the officer actually changed, for the panel and the audit row. */
  changedFields: string[];
  holdOutcome: CorrectionHoldOutcome;
  /** How many DRAFT/SENT quotes this correction retired. */
  supersededQuoteCount: number;
  /** The school record the corrected name claims. Null for a GENERAL request. */
  schoolRecord: SchoolRecordPreview | null;
  /**
   * Whether the lodge can take the corrected party on every corrected night,
   * measured AFTER the correction committed and the hold was released.
   *
   * Advisory by construction, and labelled so everywhere it is shown: a request
   * holds nothing, so this is what the officer would find if they held it now,
   * not a reservation. A correction is never refused for it — the requester
   * asked for these nights, and recording what they asked for is the officer's
   * job whether or not the lodge can take it.
   */
  availability: { available: boolean; fullNights: string[] };
};

function cleanLine(value: string | null | undefined): string {
  return (value ?? "").replace(/[\r\n]/g, " ").trim();
}

function teacherKey(teachers: CorrectedTeacher[]): string {
  return JSON.stringify(
    teachers.map((t) => [t.firstName, t.lastName, t.email ?? ""]),
  );
}

function guestKey(guests: { firstName: string; lastName: string; ageTier: string }[]): string {
  return JSON.stringify(guests.map((g) => [g.firstName, g.lastName, g.ageTier]));
}

/**
 * Normalise the teacher list the way the public form does, so a teacher typed
 * into the correction screen is stored byte-identically to one typed into the
 * school's own form. Blank rows drop out rather than becoming a guest called
 * nothing.
 */
function normaliseTeachers(teachers: CorrectedTeacher[]): CorrectedTeacher[] {
  return teachers
    .map((teacher) => ({
      firstName: cleanLine(teacher.firstName),
      lastName: cleanLine(teacher.lastName),
      email: cleanLine(teacher.email)
        ? cleanLine(teacher.email).toLowerCase()
        : null,
    }))
    .filter((teacher) => teacher.firstName && teacher.lastName);
}

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
  const reason = cleanLine(input.reason);
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
  parseBookingRequestLinkedGuestMembers(request.linkedGuestMembers);

  if (request.version !== input.expectedVersion) {
    throw new BookingRequestError(
      "This request changed while you were correcting it. Refresh and check it before saving again.",
      409,
    );
  }

  const isSchool = request.type === BookingRequestType.SCHOOL;
  if (isSchool && !input.school) {
    throw new BookingRequestError(
      "A school request needs its school details to be corrected together.",
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

  const teachers = input.school ? normaliseTeachers(input.school.teachers) : [];
  if (input.school && teachers.length === 0) {
    throw new BookingRequestError(
      "A school request needs at least one teacher attending.",
      422,
    );
  }

  const guests: BookingRequestGuest[] = input.school
    ? generateSchoolGuests({ teachers, childCounts: input.school.childCounts })
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

  const contactFirstName = cleanLine(input.contactFirstName);
  const contactLastName = cleanLine(input.contactLastName);
  const contactEmail = cleanLine(input.contactEmail).toLowerCase();
  const contactPhone = cleanLine(input.contactPhone) || null;
  if (!contactFirstName || !contactLastName || !contactEmail) {
    throw new BookingRequestError(
      "A request needs a contact name and email address.",
      422,
    );
  }
  const schoolName = input.school
    ? normaliseSchoolNameForStorage(input.school.schoolName)
    : null;

  // ---- what actually changed ----------------------------------------------
  const storedGuests = parseBookingRequestGuests(request.guests);
  const changedFields: string[] = [];
  const mark = (field: string, changed: boolean) => {
    if (changed) changedFields.push(field);
  };
  mark("checkIn", request.checkIn.getTime() !== checkIn.getTime());
  mark("checkOut", request.checkOut.getTime() !== checkOut.getTime());
  mark("guests", guestKey(storedGuests) !== guestKey(guests));
  mark("contactFirstName", request.contactFirstName !== contactFirstName);
  mark("contactLastName", request.contactLastName !== contactLastName);
  mark("contactEmail", request.contactEmail.toLowerCase() !== contactEmail);
  mark("contactPhone", (request.contactPhone ?? null) !== contactPhone);
  if (input.school) {
    mark("schoolName", request.schoolName !== schoolName);
    mark(
      "teachers",
      teacherKey(normaliseTeachers((request.teachers as CorrectedTeacher[]) ?? [])) !==
        teacherKey(teachers),
    );
    mark(
      "cateringPreference",
      request.cateringPreference !== input.school.cateringPreference,
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
    if (preview && input.school) {
      assertSchoolRecordOutcomeAcknowledged(preview, input.school.schoolRecord);
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
        ...(input.school
          ? {
              schoolName,
              teachers: teachers as unknown as Prisma.InputJsonValue,
              cateringPreference: input.school.cateringPreference,
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

  // ---- the hold ------------------------------------------------------------
  const holdOutcome = await reconcileCorrectedRequestHold({
    requestId: request.id,
    heldBookingId: request.heldBookingId,
    holdAffecting,
    adminMemberId: input.adminMemberId,
    ipAddress: input.ipAddress ?? "",
  });

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
      holdOutcome,
      supersededQuoteCount: claim.supersededQuoteCount,
      previousStatus: request.status,
      previousCheckIn: request.checkIn.toISOString(),
      previousCheckOut: request.checkOut.toISOString(),
      previousGuestCount: storedGuests.length,
      previousPriceCents: request.priceCents,
      checkIn: checkIn.toISOString(),
      checkOut: checkOut.toISOString(),
      guestCount: guests.length,
      ...(input.school
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
    holdOutcome,
    supersededQuoteCount: claim.supersededQuoteCount,
    schoolRecord: claim.preview ?? null,
    availability: {
      available: capacity.available,
      fullNights: capacity.available
        ? []
        : getCapacityFullNights(capacity.nightDetails),
    },
  };
}
