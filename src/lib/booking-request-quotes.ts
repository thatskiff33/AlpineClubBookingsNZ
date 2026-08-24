import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import {
  AgeTier,
  BookingRequestPricingMode,
  BookingRequestQuoteStatus,
  BookingRequestStatus,
  BookingRequestType,
  BookingStatus,
  Prisma,
  SchoolCateringOption,
  SchoolCateringPreference,
} from "@prisma/client";
import { z } from "zod";
import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { lockActiveBookingRequestLinkedMembers } from "@/lib/adult-member-hosting-queue-participants";
import { reconcileAdultMemberHostingReviewWithSiblings } from "@/lib/adult-member-hosting-review";
import { logAudit } from "@/lib/audit";
import {
  approveBookingRequest,
  assertMappableOwnerContact,
  BookingRequestError,
  getBookingRequestSettings,
  isMemberWholeLodgeRequest,
  linkedGuestMemberMap,
  parseBookingRequestGuests,
  parseBookingRequestLinkedGuestMembers,
  splitPriceAcrossGuests,
  type BookingRequestLinkedGuestMember,
} from "@/lib/booking-request";
import { reconcileBedAllocationsForBookingWithGlobalLockHeld } from "@/lib/bed-allocation-lifecycle";
import {
  buildApprovalGuestNights,
  collectNotifiedMemberGuestIds,
  notifyMemberGuestsHoldReleased,
  planBookingRequestGuestConsent,
  toPipelineGuestCreateData,
  type HeldBookingGuestInput,
} from "@/lib/booking-request-shared";
import {
  loadMemberGuestAddPolicy,
  matchMemberGuestNotificationRows,
  type MemberGuestAddNotificationRow,
} from "@/lib/member-guest-add-policy";
import type { MemberGuestAddActor } from "@/lib/member-guest-consent";
import {
  assertNoBookingMemberNightConflicts,
  findBookingMemberNightConflicts,
  type BookingMemberNightConflict,
} from "@/lib/booking-member-night-conflicts";
import {
  acquireLodgeCapacityLock,
  checkCapacityForGuestRanges,
} from "@/lib/capacity";
import { sendBookingRequestQuoteEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { countActiveLodges, getDefaultLodgeId } from "@/lib/lodges";
import { resolveGuestRateMembershipTypes } from "@/lib/membership-type-policy";
import { prisma } from "@/lib/prisma";
import { approveSchoolBookingRequest } from "@/lib/school-booking-request";
import { getSeasonYear } from "@/lib/utils";
import { formatDateOnly } from "@/lib/date-only";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The member whole-lodge door (#2263) has exactly one admin lifecycle:
 * direct approve, or decline. The quote lifecycle is refused outright, at the
 * SERVICE layer rather than by hiding buttons, because "the buttons are hidden"
 * is not a guarantee — the admin API routes are reachable directly, and every
 * one of these operations does something the design forbids for a member:
 *
 *   - sending a quote AUTO-HOLDS capacity (#1280), so an officer could
 *     sterilise the whole lodge from a surface the member request never
 *     authorised;
 *   - the quote email carries PRICES to the requester, and a member-visible
 *     pricing surface for a whole-lodge ask is exactly what the design excludes;
 *   - requester-accept mints a duplicate NON-LOGIN member for somebody who
 *     already holds a login account, splitting their booking history.
 *
 * One guard per service function, so no future caller can route around it.
 */
export function assertNotMemberWholeLodgeRequest(
  request: { requestedByMemberId: string | null; exclusivityRequested: boolean },
  operation: string
): void {
  if (!isMemberWholeLodgeRequest(request)) return;
  throw new BookingRequestError(
    `${operation} is not available for a member's whole-lodge request. Approve it directly with a priced headcount, or decline it.`,
    409
  );
}

const quoteableStatuses = [
  BookingRequestStatus.VERIFIED,
  BookingRequestStatus.PRICED,
  BookingRequestStatus.QUOTED,
  BookingRequestStatus.QUOTE_SENT,
  BookingRequestStatus.QUERY_PENDING,
  BookingRequestStatus.MODIFICATION_REQUESTED,
] as const;

const holdableStatuses = [
  BookingRequestStatus.VERIFIED,
  BookingRequestStatus.PRICED,
  BookingRequestStatus.QUOTED,
  BookingRequestStatus.QUOTE_SENT,
  BookingRequestStatus.QUERY_PENDING,
  BookingRequestStatus.MODIFICATION_REQUESTED,
] as const;

export class BookingRequestQuoteError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "BookingRequestQuoteError";
    this.status = status;
  }
}

const bookingRequestGuestNightRateSchema = z.object({
  ageTier: z.enum(AgeTier),
  isMember: z.boolean(),
  rateCents: z.number().int().min(0),
});

const bookingRequestQuoteOptionInputSchema = z.object({
  id: z.string().min(1).max(40).optional(),
  cateringOption: z.enum(SchoolCateringOption).optional().nullable(),
  totalCents: z.number().int().min(0).optional(),
  guestNightRates: z.array(bookingRequestGuestNightRateSchema).optional(),
});

export const bookingRequestQuoteInputSchema = z.object({
  pricingMode: z.enum(BookingRequestPricingMode),
  options: z.array(bookingRequestQuoteOptionInputSchema).min(1).max(2),
  message: z.string().max(2000).optional().nullable(),
  linkedGuestMembers: z
    .array(
      z.object({
        guestIndex: z.number().int().min(0),
        memberId: z.string().min(1),
      })
    )
    .optional(),
});

type BookingRequestQuoteInput = z.infer<
  typeof bookingRequestQuoteInputSchema
>;

interface NormalizedQuoteOption {
  id: string;
  label: string;
  cateringOption: SchoolCateringOption | null;
  totalCents: number;
  pricingMode: BookingRequestPricingMode;
  guestNightRates?: Array<{
    ageTier: AgeTier;
    isMember: boolean;
    rateCents: number;
  }>;
  guestBreakdown: Array<{
    guestIndex: number;
    firstName: string;
    lastName: string;
    ageTier: AgeTier;
    isMember: boolean;
    memberId: string | null;
    nightCount: number;
    rateCents: number | null;
    totalCents: number;
  }>;
}

const quoteOptionsSchema = z.array(
  z.object({
    id: z.string(),
    label: z.string(),
    cateringOption: z.enum(SchoolCateringOption).nullable(),
    totalCents: z.number().int().min(0),
    pricingMode: z.enum(BookingRequestPricingMode),
    guestNightRates: z.array(bookingRequestGuestNightRateSchema).optional(),
    guestBreakdown: z.array(
      z.object({
        guestIndex: z.number().int().min(0),
        firstName: z.string(),
        lastName: z.string(),
        ageTier: z.enum(AgeTier),
        isMember: z.boolean(),
        memberId: z.string().nullable(),
        nightCount: z.number().int().min(0),
        rateCents: z.number().int().min(0).nullable(),
        totalCents: z.number().int().min(0),
      })
    ),
  })
);

function cleanNullableString(value?: string | null) {
  const trimmed = value?.replace(/[\r\n]/g, " ").trim() ?? "";
  return trimmed || null;
}

function getNightCount(checkIn: Date, checkOut: Date) {
  return Math.max(0, Math.ceil((checkOut.getTime() - checkIn.getTime()) / DAY_MS));
}

function rateKey(ageTier: AgeTier, isMember: boolean) {
  return `${ageTier}:${isMember ? "member" : "non-member"}`;
}

function getAllowedSchoolCateringOptions(
  preference: SchoolCateringPreference | null
) {
  if (preference === SchoolCateringPreference.CATERED) {
    return new Set<SchoolCateringOption>([SchoolCateringOption.CATERED]);
  }
  if (preference === SchoolCateringPreference.NON_CATERED) {
    return new Set<SchoolCateringOption>([SchoolCateringOption.NON_CATERED]);
  }
  return new Set<SchoolCateringOption>([
    SchoolCateringOption.CATERED,
    SchoolCateringOption.NON_CATERED,
  ]);
}

function optionLabel(option: SchoolCateringOption | null) {
  if (option === SchoolCateringOption.CATERED) return "Catered";
  if (option === SchoolCateringOption.NON_CATERED) return "Non-catered";
  return "Quote";
}

/**
 * What the actor is told when a stored quote blob cannot be read back and they
 * tried to ACT on it (#2342). Plain English, because the string reaches them
 * verbatim; 409 rather than 500 because an unreadable stored blob is a data
 * condition, not a server fault.
 *
 * Worded for BOTH audiences that can hit it: an admin sending a quote or
 * holding beds against it, and a requester opening their emailed quote link
 * (`GET /api/booking-requests/respond/[token]` surfaces this message as-is).
 * So no admin-only verbs — "decline the request" would be meaningless to a
 * requester, and the remedy that serves both is a fresh quote.
 */
export const UNREADABLE_STORED_QUOTE_MESSAGE =
  "This quote's saved details could not be read, so it can't be sent, accepted, or used to reserve beds. A new quote needs to be created for this request.";

/**
 * STRICT read of a stored quote's options. Throws when the stored JSON does
 * not satisfy `quoteOptionsSchema`.
 *
 * Every path that ACTS on a quote uses this — sending it, holding capacity
 * against it, the requester's accept, and the expiry-reminder cron — because
 * each turns the stored numbers into money or beds. Read-only ADMIN display
 * goes through `readBookingRequestQuoteOptionsForDisplay` instead (#2342).
 */
export function parseBookingRequestQuoteOptions(
  raw: unknown
): NormalizedQuoteOption[] {
  const parsed = quoteOptionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BookingRequestQuoteError(UNREADABLE_STORED_QUOTE_MESSAGE, 409);
  }
  return parsed.data;
}

/**
 * TOLERANT read of a stored quote's options for admin display (#2342).
 *
 * The third stored blob the admin queue parses per row, and — after the guest
 * list and the member links were made tolerant — the last remaining way a
 * single corrupt row could still 500 every filter on the Booking Requests
 * page, by exactly the mechanism this work set out to remove.
 *
 * On failure the row keeps rendering with NO quote options rather than a
 * salvaged half-list: an option id, a total, or a per-guest split we cannot
 * trust is worse than none, and the caller flags the row so the panel can say
 * the quote is not being shown. Actions stay strict — see
 * `parseBookingRequestQuoteOptions`.
 */
export function readBookingRequestQuoteOptionsForDisplay(raw: unknown): {
  options: NormalizedQuoteOption[];
  needsAttention: boolean;
} {
  const parsed = quoteOptionsSchema.safeParse(raw);
  return parsed.success
    ? { options: parsed.data, needsAttention: false }
    : { options: [], needsAttention: true };
}

function normalizeLinkedGuestMembers(
  links: BookingRequestLinkedGuestMember[] | undefined,
  guestCount: number
) {
  const byGuest = new Map<number, string>();
  for (const link of links ?? []) {
    if (link.guestIndex >= guestCount) {
      throw new BookingRequestQuoteError("Linked member guest index is invalid", 422);
    }
    byGuest.set(link.guestIndex, link.memberId);
  }
  return Array.from(byGuest.entries()).map(([guestIndex, memberId]) => ({
    guestIndex,
    memberId,
  }));
}

async function assertLinkedMembersExist(links: BookingRequestLinkedGuestMember[]) {
  const ids = Array.from(new Set(links.map((link) => link.memberId)));
  if (ids.length === 0) return;

  const members = await prisma.member.findMany({
    where: {
      id: { in: ids },
      active: true,
      archivedAt: null,
    },
    select: { id: true },
  });
  const found = new Set(members.map((member) => member.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new BookingRequestQuoteError("One or more linked members were not found", 422);
  }
}

/**
 * Advisory (non-blocking) member-night conflict pre-check for the admin linking
 * step (issue #1226, follow-up from #1158). When an admin links booking-request
 * guests to real members, surface any overlapping member-night conflict *before*
 * they reach the approve/hold action so it can be resolved early.
 *
 * This is display-only. Unlike `assertNoBookingMemberNightConflicts` (which
 * throws a 409 and is the authoritative enforcer at approve/hold time — see
 * INV-CAP-017), this never throws on a conflict: it returns the
 * overlaps so the linking UI can render an advisory. The hard block at
 * approve/hold time is unchanged and remains the only thing that stops a
 * double-book.
 *
 * A genuinely missing request still throws a 404 (an error the caller renders),
 * and out-of-range guest indices from the client are skipped rather than
 * rejected, keeping the advisory path lenient.
 */
export async function findLinkedGuestMemberNightConflicts(input: {
  requestId: string;
  adminMemberId: string;
  links: BookingRequestLinkedGuestMember[];
}): Promise<BookingMemberNightConflict[]> {
  const request = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
    select: {
      checkIn: true,
      checkOut: true,
      guests: true,
      heldBookingId: true,
    },
  });
  if (!request) {
    throw new BookingRequestQuoteError("Booking request not found", 404);
  }

  const guests = parseBookingRequestGuests(request.guests);
  // Build the link map directly (skipping any out-of-range guest index) rather
  // than reusing normalizeLinkedGuestMembers, which throws on a bad index — the
  // advisory must stay lenient and never block linking.
  const linkedByGuest = new Map<number, string>();
  for (const link of input.links) {
    if (link.guestIndex < 0 || link.guestIndex >= guests.length) continue;
    linkedByGuest.set(link.guestIndex, link.memberId);
  }
  if (linkedByGuest.size === 0) return [];

  const linkedGuests = Array.from(linkedByGuest.entries()).map(
    ([, memberId]) => ({
      stayStart: request.checkIn,
      stayEnd: request.checkOut,
      memberId,
    })
  );

  return findBookingMemberNightConflicts(prisma, {
    actorMemberId: input.adminMemberId,
    actorRole: "ADMIN",
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    guests: linkedGuests,
    // A request that already has a held booking (#1254) carries these same
    // linked members on that AWAITING_REVIEW hold, which is itself a
    // conflict-eligible status. Exclude it so the advisory never flags the
    // request against its own hold.
    excludeBookingId: request.heldBookingId ?? undefined,
  });
}

function normalizeQuoteOptions(input: {
  request: {
    type: BookingRequestType;
    cateringPreference: SchoolCateringPreference | null;
    checkIn: Date;
    checkOut: Date;
    guests: Prisma.JsonValue;
  };
  pricingMode: BookingRequestPricingMode;
  options: BookingRequestQuoteInput["options"];
  linkedGuestMembers: BookingRequestLinkedGuestMember[];
}): NormalizedQuoteOption[] {
  const guests = parseBookingRequestGuests(input.request.guests);
  const nightCount = getNightCount(input.request.checkIn, input.request.checkOut);
  const linkedMembers = new Map(
    input.linkedGuestMembers.map((link) => [link.guestIndex, link.memberId])
  );
  const isSchool = input.request.type === BookingRequestType.SCHOOL;
  const allowedSchoolOptions = getAllowedSchoolCateringOptions(
    input.request.cateringPreference
  );

  const seenOptionIds = new Set<string>();

  return input.options.map((option, optionIndex) => {
    const cateringOption = isSchool ? option.cateringOption ?? null : null;
    if (isSchool) {
      if (!cateringOption) {
        throw new BookingRequestQuoteError(
          "School quotes must identify catered or non-catered options",
          422
        );
      }
      if (!allowedSchoolOptions.has(cateringOption)) {
        throw new BookingRequestQuoteError(
          "Quote option does not match the school's catering preference",
          422
        );
      }
    } else if (option.cateringOption) {
      throw new BookingRequestQuoteError(
        "Catering options only apply to school booking requests",
        422
      );
    }

    const id = isSchool
      ? cateringOption!
      : option.id?.trim() || (optionIndex === 0 ? "STANDARD" : `OPTION_${optionIndex + 1}`);
    if (seenOptionIds.has(id)) {
      throw new BookingRequestQuoteError("Quote option ids must be unique", 422);
    }
    seenOptionIds.add(id);

    if (input.pricingMode === BookingRequestPricingMode.OVERALL_TOTAL) {
      if (option.totalCents == null) {
        throw new BookingRequestQuoteError("Overall quote options require a total", 422);
      }
      const split = splitPriceAcrossGuests(option.totalCents, guests.length);
      return {
        id,
        label: optionLabel(cateringOption),
        cateringOption,
        totalCents: option.totalCents,
        pricingMode: input.pricingMode,
        guestBreakdown: guests.map((guest, guestIndex) => {
          const memberId = linkedMembers.get(guestIndex) ?? null;
          return {
            guestIndex,
            firstName: guest.firstName,
            lastName: guest.lastName,
            ageTier: guest.ageTier,
            isMember: Boolean(memberId),
            memberId,
            nightCount,
            rateCents: null,
            totalCents: split[guestIndex] ?? 0,
          };
        }),
      };
    }

    const rates = option.guestNightRates ?? [];
    if (rates.length === 0) {
      throw new BookingRequestQuoteError(
        "Per guest-night quotes require age-tier/member rates",
        422
      );
    }
    const rateByKey = new Map(
      rates.map((rate) => [rateKey(rate.ageTier, rate.isMember), rate.rateCents])
    );
    const guestBreakdown = guests.map((guest, guestIndex) => {
      const memberId = linkedMembers.get(guestIndex) ?? null;
      const isMember = Boolean(memberId);
      const rateCents = rateByKey.get(rateKey(guest.ageTier, isMember));
      if (rateCents == null) {
        throw new BookingRequestQuoteError(
          `Missing ${guest.ageTier} ${isMember ? "member" : "non-member"} rate`,
          422
        );
      }
      return {
        guestIndex,
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageTier: guest.ageTier,
        isMember,
        memberId,
        nightCount,
        rateCents,
        totalCents: rateCents * nightCount,
      };
    });

    return {
      id,
      label: optionLabel(cateringOption),
      cateringOption,
      totalCents: guestBreakdown.reduce((sum, guest) => sum + guest.totalCents, 0),
      pricingMode: input.pricingMode,
      guestNightRates: rates,
      guestBreakdown,
    };
  });
}

function firstQuoteOption(options: NormalizedQuoteOption[], optionId?: string | null) {
  if (!optionId) return options[0];
  return options.find((option) => option.id === optionId) ?? null;
}

export async function createBookingRequestQuote(input: {
  requestId: string;
  adminMemberId: string;
  quote: BookingRequestQuoteInput;
}) {
  const request = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!request) {
    throw new BookingRequestError("Booking request not found", 404);
  }
  assertNotMemberWholeLodgeRequest(request, "Quoting");
  if (!quoteableStatuses.includes(request.status as never)) {
    throw new BookingRequestError("This booking request cannot be quoted", 409);
  }

  const guests = parseBookingRequestGuests(request.guests);
  // #2342: the transaction below OVERWRITES request.linkedGuestMembers with
  // whatever the client posted, and the admin panel posts its DISPLAY list —
  // which is empty for a row whose stored link blob failed to parse, because
  // the tolerant reader falls back to no links. Without this strict re-read one
  // "Save quote" would permanently replace a recoverable member link with
  // nothing, and the guest would later convert and invoice as a NON-MEMBER.
  // Refuse instead: a row whose stored links cannot be read cannot be quoted.
  // (Approval and hold already re-read the column strictly through
  // linkedGuestMemberMap; this closes the one path that WRITES it.)
  parseBookingRequestLinkedGuestMembers(request.linkedGuestMembers);
  const linkedGuestMembers = normalizeLinkedGuestMembers(
    input.quote.linkedGuestMembers,
    guests.length
  );
  await assertLinkedMembersExist(linkedGuestMembers);

  const options = normalizeQuoteOptions({
    request,
    pricingMode: input.quote.pricingMode,
    options: input.quote.options,
    linkedGuestMembers,
  });

  const message = cleanNullableString(input.quote.message);
  const quotedAt = new Date();

  const quote = await prisma.$transaction(async (tx) => {
    // #1423 lock-ordering invariant: lock the BookingRequest row BEFORE any
    // BookingRequestQuote row (matching decline's claim-first order) so a
    // concurrent decline + quote-create on the same request cannot deadlock.
    // Pure statement reorder — same writes, same transaction.
    await tx.bookingRequest.update({
      where: { id: request.id },
      data: {
        status: BookingRequestStatus.QUOTED,
        priceCents: options.length === 1 ? options[0].totalCents : null,
        pricedByMemberId: input.adminMemberId,
        pricedAt: quotedAt,
        linkedGuestMembers: linkedGuestMembers as unknown as Prisma.InputJsonValue,
        responseMessage: null,
        responseMessageAt: null,
        version: { increment: 1 },
      },
    });

    const latest = await tx.bookingRequestQuote.findFirst({
      where: { bookingRequestId: request.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    await tx.bookingRequestQuote.updateMany({
      where: {
        bookingRequestId: request.id,
        status: {
          in: [
            BookingRequestQuoteStatus.DRAFT,
            BookingRequestQuoteStatus.SENT,
          ],
        },
      },
      data: {
        status: BookingRequestQuoteStatus.SUPERSEDED,
        supersededAt: quotedAt,
      },
    });

    const created = await tx.bookingRequestQuote.create({
      data: {
        bookingRequestId: request.id,
        version: (latest?.version ?? 0) + 1,
        status: BookingRequestQuoteStatus.DRAFT,
        pricingMode: input.quote.pricingMode,
        options: options as unknown as Prisma.InputJsonValue,
        message,
        createdByMemberId: input.adminMemberId,
      },
    });

    return created;
  });

  logAudit({
    action: "booking_request.quote_created",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    outcome: "success",
    summary: "Booking request quote created",
    metadata: {
      quoteId: quote.id,
      version: quote.version,
      pricingMode: input.quote.pricingMode,
      optionCount: options.length,
      totals: options.map((option) => ({
        id: option.id,
        totalCents: option.totalCents,
      })),
    },
  });

  return {
    ...quote,
    options,
  };
}

export async function sendBookingRequestQuote(input: {
  requestId: string;
  adminMemberId: string;
  /**
   * Optional existing non-login contact to own the auto-placed hold (issue
   * #1255). Sending a quote reserves the beds by holding capacity (#1254), which
   * materialises the owner — so the admin's map-or-create decision must be
   * threaded here, not just at approval. Ignored once a hold already exists.
   */
  ownerContactMemberId?: string | null;
}) {
  const quote = await prisma.bookingRequestQuote.findFirst({
    where: {
      bookingRequestId: input.requestId,
      status: {
        in: [BookingRequestQuoteStatus.DRAFT, BookingRequestQuoteStatus.SENT],
      },
    },
    orderBy: { version: "desc" },
    include: { bookingRequest: true },
  });

  if (!quote) {
    throw new BookingRequestQuoteError("Create a quote before sending it", 409);
  }
  // Unreachable in practice (createBookingRequestQuote refuses to mint a quote
  // for one of these rows), and kept anyway: a row that acquired a quote through
  // some future path must still never be sent one. The auto-hold inside the send
  // is guarded separately in holdBookingRequestSlots.
  assertNotMemberWholeLodgeRequest(quote.bookingRequest, "Sending a quote");

  // A sent quote must reserve the beds/guest-nights so they cannot disappear
  // before the requester accepts (issue #1254, owner decision (a)). Place the
  // hold BEFORE marking the quote SENT / emailing, so that if the lodge is full
  // the send fails loudly instead of promising dates that are not reserved.
  // The hold is idempotent (reused on re-send) and option-agnostic — the bed
  // count is the guest count regardless of which price option is chosen.
  const hold = await holdBookingRequestSlots({
    requestId: input.requestId,
    adminMemberId: input.adminMemberId,
    optionId: null,
    ownerContactMemberId: input.ownerContactMemberId,
  });
  if (hold.type === "capacityExceeded") {
    const nights = hold.fullNights.join(", ");
    throw new BookingRequestQuoteError(
      nights
        ? `The lodge is at capacity for one or more requested nights (${nights}), so the beds cannot be reserved. Sending this quote was blocked — adjust the dates or wait for capacity before sending.`
        : "The lodge is at capacity for the requested nights, so the beds cannot be reserved. Sending this quote was blocked.",
      409
    );
  }

  const options = parseBookingRequestQuoteOptions(quote.options);
  const settings = await getBookingRequestSettings();
  const ttlMs = settings.quoteResponseTtlDays * DAY_MS;
  const { token, tokenHash } = issueActionToken();
  const sentAt = new Date();
  const expiresAt = new Date(sentAt.getTime() + ttlMs);

  const updated = await prisma.$transaction(async (tx) => {
    // #1423 lock-ordering invariant: lock the BookingRequest row BEFORE the
    // BookingRequestQuote row (matching decline's claim-first order) so a
    // concurrent decline + re-send on the same request cannot deadlock. Pure
    // statement reorder — same writes, same transaction.
    //
    // #1504 resurrection guard: this request-status flip is a status-guarded
    // updateMany (claim-first), NOT a plain update. A concurrent admin decline
    // can finalise the request to DECLINED (releasing its hold) in the narrow
    // window between holdBookingRequestSlots' own status check and this
    // transaction; a plain overwrite to QUOTE_SENT would resurrect that
    // just-DECLINED request. The guard claims the request only while it is still
    // in a quoteable state (the same live set holdBookingRequestSlots requires),
    // so a decline wins the race: count 0 throws 409 BEFORE the quote is marked
    // SENT (the throw rolls the whole tx back, leaving the quote untouched) and
    // BEFORE the email is sent below, so a lost re-send delivers nothing.
    const claimed = await tx.bookingRequest.updateMany({
      where: {
        id: quote.bookingRequestId,
        status: { in: [...quoteableStatuses] },
      },
      data: {
        status: BookingRequestStatus.QUOTE_SENT,
        reviewedByMemberId: input.adminMemberId,
        reviewedAt: sentAt,
        version: { increment: 1 },
      },
    });
    if (claimed.count === 0) {
      throw new BookingRequestQuoteError(
        "This quote can no longer be sent — the booking request has been declined or cancelled.",
        409
      );
    }

    const saved = await tx.bookingRequestQuote.update({
      where: { id: quote.id },
      data: {
        status: BookingRequestQuoteStatus.SENT,
        responseTokenHash: tokenHash,
        responseTokenExpiresAt: expiresAt,
        sentAt,
        reminderSentAt: null,
        createdByMemberId: quote.createdByMemberId ?? input.adminMemberId,
      },
    });

    return saved;
  });

  let emailDelivered = true;
  let emailOutcome = "sent";
  try {
    const outcome = await sendBookingRequestQuoteEmail({
      // A quote is sent before any booking exists (#2258).
      bookingContext: "none",
      email: quote.bookingRequest.contactEmail,
      firstName: quote.bookingRequest.contactFirstName,
      lodgeId: quote.bookingRequest.lodgeId ?? null,
      token,
      checkIn: quote.bookingRequest.checkIn,
      checkOut: quote.bookingRequest.checkOut,
      guestCount: parseBookingRequestGuests(quote.bookingRequest.guests).length,
      requestType: quote.bookingRequest.type,
      schoolName: quote.bookingRequest.schoolName,
      options,
      message: quote.message,
      expiresAt,
    });
    /*
      A WITHHELD QUOTE IS NOT A DELIVERED ONE (#3035). `sendEmail` returns rather
      than throws when nothing was transmitted — the environment-safety boundary,
      a suppressed address, a placeholder recipient — so this used to record
      `outcome: "success"`, "Booking request quote sent" and hand
      `emailDelivered: true` back to the officer who pressed Send. The quote's
      response token is live and the requester has never seen it.
    */
    emailOutcome = outcome.status;
    if (outcome.status !== "sent") {
      emailDelivered = false;
      logger.warn(
        {
          bookingRequestId: quote.bookingRequestId,
          quoteId: quote.id,
          outcome: outcome.status,
          reason: "reason" in outcome ? outcome.reason : undefined,
        },
        "Booking request quote email was not transmitted"
      );
    }
  } catch (err) {
    emailDelivered = false;
    emailOutcome = "error";
    logger.error(
      { err, bookingRequestId: quote.bookingRequestId, quoteId: quote.id },
      "Failed to send booking request quote email"
    );
  }

  logAudit({
    action: "booking_request.quote_sent",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    targetId: quote.bookingRequestId,
    entityType: "BookingRequest",
    entityId: quote.bookingRequestId,
    category: "booking",
    outcome: emailDelivered ? "success" : "failure",
    summary: emailDelivered
      ? "Booking request quote sent"
      : "Booking request quote saved but the email could not be delivered",
    metadata: {
      quoteId: quote.id,
      version: quote.version,
      expiresAt: expiresAt.toISOString(),
      emailDelivered,
      emailOutcome,
    },
  });

  return { ...updated, options, responseTokenExpiresAt: expiresAt, emailDelivered };
}

async function loadSentQuoteByToken(token: string) {
  const tokenHash = hashActionToken(token);
  const quote = await prisma.bookingRequestQuote.findUnique({
    where: { responseTokenHash: tokenHash },
    include: {
      bookingRequest: {
        include: { lodge: { select: { name: true } } },
      },
    },
  });

  if (!quote) {
    throw new BookingRequestQuoteError("This quote is not valid.", 404);
  }
  if (quote.status !== BookingRequestQuoteStatus.SENT) {
    // Cancelled, accepted, or superseded by a newer quote: the requester should
    // use the most recent quote email rather than this stale link.
    throw new BookingRequestQuoteError("This quote is no longer active.", 409);
  }
  if (!quote.responseTokenExpiresAt || quote.responseTokenExpiresAt < new Date()) {
    throw new BookingRequestQuoteError("This quote has expired.", 410);
  }

  return quote;
}

export async function getBookingRequestQuoteContext(token: string) {
  const quote = await loadSentQuoteByToken(token);
  const options = parseBookingRequestQuoteOptions(quote.options);
  const request = quote.bookingRequest;

  // Presentation-only lodge context (ADR-002): single-lodge clubs, and
  // requests without an explicit lodge, surface no lodge copy.
  const lodgeName =
    request.lodgeId && request.lodge && (await countActiveLodges(prisma)) >= 2
      ? request.lodge.name
      : null;

  return {
    requestId: request.id,
    lodgeName,
    quoteId: quote.id,
    version: quote.version,
    status: quote.status,
    requestStatus: request.status,
    type: request.type,
    schoolName: request.schoolName,
    contactFirstName: request.contactFirstName,
    checkIn: request.checkIn.toISOString(),
    checkOut: request.checkOut.toISOString(),
    guestCount: parseBookingRequestGuests(request.guests).length,
    message: quote.message,
    expiresAt: quote.responseTokenExpiresAt!.toISOString(),
    options,
  };
}

type BookingRequestQuoteResponseAction =
  | "ACCEPT"
  | "CANCEL"
  | "MODIFY"
  | "QUERY";

export async function respondToBookingRequestQuote(input: {
  token: string;
  action: BookingRequestQuoteResponseAction;
  optionId?: string | null;
  message?: string | null;
}) {
  const quote = await loadSentQuoteByToken(input.token);
  const options = parseBookingRequestQuoteOptions(quote.options);
  const selectedOption = firstQuoteOption(options, input.optionId);
  if (input.action === "ACCEPT" && !selectedOption) {
    throw new BookingRequestQuoteError("Select one of the quoted options", 422);
  }

  const message = cleanNullableString(input.message);
  const respondedAt = new Date();

  if (input.action === "CANCEL") {
    // #1423 lock-ordering invariant: acquire the BookingRequest row lock BEFORE
    // the BookingRequestQuote row lock, matching decline's forced claim-first
    // order, so a concurrent decline + cancel on the same request cannot
    // deadlock (Postgres 40P01, which would otherwise abort one side into an
    // unhandled 500). The status update is also status-guarded: if a concurrent
    // admin decline already finalised the request (and released any hold), CANCEL
    // must NOT overwrite DECLINED/CONVERTED/etc. -> CANCELLED — it claims nothing
    // and touches neither the quote nor the hold.
    const cancelled = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const claimed = await tx.bookingRequest.updateMany({
        where: {
          id: quote.bookingRequestId,
          status: {
            notIn: [
              BookingRequestStatus.DECLINED,
              BookingRequestStatus.CANCELLED,
              BookingRequestStatus.CONVERTED,
              BookingRequestStatus.APPROVED,
            ],
          },
        },
        data: {
          status: BookingRequestStatus.CANCELLED,
          responseMessage: message,
          responseMessageAt: respondedAt,
          version: { increment: 1 },
        },
      });
      if (claimed.count === 0) {
        return { finalised: true as const, withdrawnMemberGuestIds: [] as string[] };
      }
      await tx.bookingRequestQuote.update({
        where: { id: quote.id },
        data: {
          status: BookingRequestQuoteStatus.CANCELLED,
          cancelledAt: respondedAt,
        },
      });
      // MG4 (#2309): who was told they were on the hold that is about to go.
      // Read BEFORE the cancellation, so this is the population as it stood
      // when the requester pressed cancel.
      const withdrawnMemberGuestIds = quote.bookingRequest.heldBookingId
        ? await collectNotifiedMemberGuestIds(tx, quote.bookingRequest.heldBookingId)
        : [];
      if (quote.bookingRequest.heldBookingId) {
        const heldBookingId = quote.bookingRequest.heldBookingId;
        await tx.booking.update({
          where: { id: heldBookingId },
          data: { status: BookingStatus.CANCELLED, nonMemberHoldUntil: null },
        });
        // Release the reserved beds and detach the pointer so the hold no longer
        // consumes capacity and a later re-hold can never reuse a cancelled row
        // (issue #1254). Locking the Booking row after the BookingRequest row
        // adds no new cycle — decline releases its hold in a SEPARATE self-locked
        // cancelBooking tx, outside decline's claim transaction.
        await reconcileBedAllocationsForBookingWithGlobalLockHeld({ bookingId: heldBookingId, db: tx });
        await tx.bookingRequest.update({
          where: { id: quote.bookingRequestId },
          data: { heldBookingId: null, version: { increment: 1 } },
        });
      }
      return { finalised: false as const, withdrawnMemberGuestIds };
    });
    if (cancelled.finalised) {
      // A concurrent admin decline (or a prior cancel) already finalised the
      // request in the narrow window after loadSentQuoteByToken read this quote
      // as SENT. Surface a clean 409 rather than letting a later write clobber
      // the finalised state.
      throw new BookingRequestQuoteError(
        "This quote can no longer be cancelled — the booking request has already been finalised.",
        409
      );
    }
    // MG4 (#2309), AFTER the commit: the hold is gone, so anybody the hold told
    // they were on a booking has to be told they are not. Without this the
    // member is left holding "the club has put you on a lodge booking" for a
    // booking that no longer exists, and only finds out if they ask.
    if (quote.bookingRequest.heldBookingId) {
      await notifyMemberGuestsHoldReleased({
        bookingId: quote.bookingRequest.heldBookingId,
        targetMemberIds: cancelled.withdrawnMemberGuestIds,
        logContext: { bookingRequestId: quote.bookingRequestId, quoteId: quote.id },
      });
    }

    logAudit({
      action: "booking_request.quote_cancelled",
      targetId: quote.bookingRequestId,
      entityType: "BookingRequest",
      entityId: quote.bookingRequestId,
      category: "booking",
      outcome: "success",
      summary: "Requester cancelled the booking request from the quote link",
      metadata: {
        actor: "requester",
        quoteId: quote.id,
        version: quote.version,
        releasedHeldBooking: Boolean(quote.bookingRequest.heldBookingId),
      },
    });
    return { outcome: "cancelled" as const };
  }

  if (input.action === "MODIFY" || input.action === "QUERY") {
    await prisma.$transaction(async (tx) => {
      // #1423 lock-ordering invariant + resurrection guard: acquire the
      // BookingRequest row lock FIRST (matching decline's claim-first order, so a
      // concurrent decline + modify/query cannot deadlock), and status-guard it.
      // A concurrent admin decline (or requester cancel) may have finalised this
      // request to DECLINED/CANCELLED between loadSentQuoteByToken and here (the
      // decline retires the SENT quote, but a POST already in flight had loaded
      // it a moment earlier). The guarded updateMany refuses to resurrect a
      // finalised request into MODIFICATION_REQUESTED/QUERY_PENDING; because it
      // runs BEFORE the quote supersede below, a throw on count 0 leaves the
      // quote untouched (no rollback needed). A normal MODIFY/QUERY on a live
      // QUOTE_SENT request passes (count 1), so no happy-path regression.
      const restated = await tx.bookingRequest.updateMany({
        where: {
          id: quote.bookingRequestId,
          status: {
            notIn: [
              BookingRequestStatus.DECLINED,
              BookingRequestStatus.CANCELLED,
            ],
          },
        },
        data: {
          status:
            input.action === "MODIFY"
              ? BookingRequestStatus.MODIFICATION_REQUESTED
              : BookingRequestStatus.QUERY_PENDING,
          responseMessage: message,
          responseMessageAt: respondedAt,
          version: { increment: 1 },
        },
      });
      if (restated.count === 0) {
        throw new BookingRequestQuoteError(
          "This quote can no longer be updated — the booking request has been declined or cancelled.",
          409
        );
      }
      await tx.bookingRequestQuote.update({
        where: { id: quote.id },
        data: {
          status: BookingRequestQuoteStatus.SUPERSEDED,
          supersededAt: respondedAt,
        },
      });
    });
    logAudit({
      action:
        input.action === "MODIFY"
          ? "booking_request.quote_modification_requested"
          : "booking_request.quote_query_raised",
      targetId: quote.bookingRequestId,
      entityType: "BookingRequest",
      entityId: quote.bookingRequestId,
      category: "booking",
      outcome: "success",
      summary:
        input.action === "MODIFY"
          ? "Requester asked for changes to the quote"
          : "Requester sent a question about the quote",
      metadata: {
        actor: "requester",
        quoteId: quote.id,
        version: quote.version,
        hasMessage: Boolean(message),
      },
    });
    return {
      outcome:
        input.action === "MODIFY"
          ? ("modification_requested" as const)
          : ("query_sent" as const),
    };
  }

  const option = selectedOption!;
  const createdByMemberId = quote.createdByMemberId;
  if (!createdByMemberId) {
    throw new BookingRequestQuoteError(
      "This quote is missing its admin owner and cannot be accepted.",
      409
    );
  }

  // Re-arm the request to PRICED so approve can convert it. This is a
  // status-guarded `updateMany`, NOT a plain `update`, to close the
  // decline-wins-first resurrection race (#1423): an admin decline (or a
  // requester quote-cancel) may have finalised this request to DECLINED/CANCELLED
  // and released its capacity hold AFTER this accept passed the SENT-token check.
  // A plain overwrite to PRICED would resurrect that finalised request — approve
  // would see a null convertedBookingId, so its #1232 idempotency replay would
  // NOT fire and it would mint a brand-new PENDING booking + Payment + PaymentLink
  // off a declined request (money/capacity correctness bug). We therefore refuse
  // to re-arm only when the request is already DECLINED/CANCELLED.
  //
  // We deliberately use `notIn [DECLINED, CANCELLED]` rather than
  // `status = QUOTE_SENT`: a request already CONVERTED/APPROVED (the #1232
  // double-accept case) must STILL re-arm to PRICED so approve's idempotency
  // replay (booking-request.ts ~900-919 — reads the still-set convertedBookingId
  // and returns the existing booking) keeps returning the one real booking. Only
  // a decline/cancel finalisation blocks the re-arm.
  const rearmed = await prisma.bookingRequest.updateMany({
    where: {
      id: quote.bookingRequestId,
      status: {
        notIn: [BookingRequestStatus.DECLINED, BookingRequestStatus.CANCELLED],
      },
    },
    data: {
      status: BookingRequestStatus.PRICED,
      priceCents: option.totalCents,
      acceptedQuoteId: quote.id,
      acceptedQuoteOptionId: option.id,
      acceptedQuoteSnapshot: option as unknown as Prisma.InputJsonValue,
      acceptedPriceCents: option.totalCents,
      acceptedAt: respondedAt,
      responseMessage: message,
      responseMessageAt: message ? respondedAt : null,
      version: { increment: 1 },
    },
  });
  if (rearmed.count === 0) {
    throw new BookingRequestQuoteError(
      "This quote can no longer be accepted — the booking request has been declined or cancelled.",
      409
    );
  }

  const conversion =
    quote.bookingRequest.type === BookingRequestType.SCHOOL
      ? await approveSchoolBookingRequest({
          requestId: quote.bookingRequestId,
          adminMemberId: createdByMemberId,
        })
      : await approveBookingRequest({
          requestId: quote.bookingRequestId,
          adminMemberId: createdByMemberId,
        });

  if (conversion.type === "capacityExceeded") {
    // #1423: revert the losing accept to QUOTE_SENT, but ONLY if the request is
    // not already finalised — a concurrent admin decline (or requester cancel)
    // may have moved it to DECLINED/CANCELLED. Guard with updateMany + notIn so
    // the revert can never un-decline a finalised request; if it was finalised
    // we simply do not revert (the accept already 409s below via capacityExceeded).
    await prisma.bookingRequest.updateMany({
      where: {
        id: quote.bookingRequestId,
        status: {
          notIn: [BookingRequestStatus.DECLINED, BookingRequestStatus.CANCELLED],
        },
      },
      data: {
        status: BookingRequestStatus.QUOTE_SENT,
        acceptedQuoteId: null,
        acceptedQuoteOptionId: null,
        acceptedQuoteSnapshot: Prisma.JsonNull,
        acceptedPriceCents: null,
        acceptedAt: null,
        version: { increment: 1 },
      },
    });
    logAudit({
      action: "booking_request.quote_accept_capacity_blocked",
      targetId: quote.bookingRequestId,
      entityType: "BookingRequest",
      entityId: quote.bookingRequestId,
      category: "booking",
      outcome: "blocked",
      summary:
        "Quote acceptance reverted because the lodge filled before confirmation",
      metadata: {
        actor: "requester",
        quoteId: quote.id,
        optionId: option.id,
        fullNights: conversion.fullNights,
      },
    });
    const nights = conversion.fullNights.join(", ");
    throw new BookingRequestQuoteError(
      nights
        ? `The lodge filled up before your acceptance could be confirmed. These nights are now full: ${nights}. Your quote link is still active — reply to the booking team to discuss alternative dates.`
        : "The lodge filled up before your acceptance could be confirmed. Your quote link is still active — reply to the booking team to discuss alternative dates.",
      409
    );
  }

  await prisma.bookingRequestQuote.update({
    where: { id: quote.id },
    data: {
      status: BookingRequestQuoteStatus.ACCEPTED,
      acceptedAt: respondedAt,
    },
  });

  logAudit({
    action: "booking_request.quote_accepted",
    targetId: quote.bookingRequestId,
    entityType: "BookingRequest",
    entityId: quote.bookingRequestId,
    category: "booking",
    outcome: "success",
    summary: "Requester accepted the quote",
    metadata: {
      actor: "requester",
      quoteId: quote.id,
      version: quote.version,
      optionId: option.id,
      priceCents: option.totalCents,
      bookingId: conversion.bookingId,
    },
  });

  return {
    outcome: "accepted" as const,
    bookingId: conversion.bookingId,
    priceCents: option.totalCents,
    type: quote.bookingRequest.type,
  };
}

function getCapacityFullNights(
  nightDetails: Array<{ date: Date; availableBeds: number }>
): string[] {
  return nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => formatDateOnly(night.date));
}

export async function holdBookingRequestSlots(input: {
  requestId: string;
  adminMemberId: string;
  optionId?: string | null;
  /**
   * Optional existing non-login contact to own the held booking (issue #1255).
   * When set, the hold is attached to this contact instead of creating a new
   * NON_MEMBER/SCHOOL member. Because approval reuses the held booking's owner,
   * this fixes the map-or-create decision for the whole quote → accept flow. The
   * guard rejects any login-capable target.
   */
  ownerContactMemberId?: string | null;
}): Promise<
  | { type: "held"; bookingId: string; reused: boolean }
  | { type: "capacityExceeded"; fullNights: string[] }
> {
  const request = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
    include: {
      quotes: {
        orderBy: { version: "desc" },
        take: 1,
      },
    },
  });
  if (!request) {
    throw new BookingRequestError("Booking request not found", 404);
  }
  assertNotMemberWholeLodgeRequest(request, "Holding beds");
  if (!holdableStatuses.includes(request.status as never)) {
    throw new BookingRequestError("This booking request cannot be held", 409);
  }
  // MG4 (#2309): members a previous, now-dead hold over THIS request had
  // already told. Empty on every first hold, which is nearly all of them.
  let staleHoldNotifiedMemberIds: string[] = [];
  if (request.heldBookingId) {
    // Re-validate before reusing (#1254). An admin can now cancel a held
    // booking directly — every sent quote leaves one, tagged "Held" on the bed
    // board — which would leave this pointer dangling. Reusing a cancelled or
    // missing row would promise a quote for beds nothing reserves and then 409
    // on accept. If the hold is no longer a live AWAITING_REVIEW booking,
    // detach it and fall through to create a fresh hold.
    const existingHold = await prisma.booking.findUnique({
      where: { id: request.heldBookingId },
      select: { status: true },
    });
    if (existingHold?.status === BookingStatus.AWAITING_REVIEW) {
      return {
        type: "held" as const,
        bookingId: request.heldBookingId,
        reused: true,
      };
    }
    /**
     * MG4 (#2309): who the DEAD hold had already told they were on a booking.
     *
     * THE PROBLEM THIS SOLVES IS A SECOND STANDING NOTICE, not a missing one.
     * The stale hold is being replaced by a fresh one over the same request —
     * the same nights, the same lodge, the same guest list, because all three
     * come from the `BookingRequest` row and none of them can change here. So a
     * member who was on the old hold and is on the new one is not being added
     * to anything: they are already, as far as they know, on this stay. Sending
     * the added-notice again would put a second "the club has put you on a lodge
     * booking" in their inbox for one request, which reads as a duplicate
     * booking and invites them to ring the club about a problem that does not
     * exist.
     *
     * SUPPRESSED RATHER THAN RETRACTED-AND-RE-ADDED, and the reason is what
     * actually reaches this branch. The hold is detached here only when it is no
     * longer live, and every path that cancels it deliberately (the requester's
     * quote cancel, an officer's decline) detaches the pointer in the same
     * breath — so those never arrive here at all. What does is a hold cancelled
     * out from under the pointer, chiefly an admin cancelling the held booking
     * directly from the bed board. Those members have had no withdrawal notice,
     * so their standing belief — "I am on this stay" — is the one the fresh hold
     * is about to make true again. A retract-then-re-add would send two emails
     * to correct nothing.
     */
    staleHoldNotifiedMemberIds = await collectNotifiedMemberGuestIds(
      prisma,
      request.heldBookingId
    );
    await prisma.bookingRequest.updateMany({
      where: { id: request.id, heldBookingId: request.heldBookingId },
      data: { heldBookingId: null, version: { increment: 1 } },
    });
    request.heldBookingId = null;
    request.version += 1;
  }

  const guests = parseBookingRequestGuests(request.guests);
  const latestQuote = request.quotes[0] ?? null;
  const quoteOptions = latestQuote
    ? parseBookingRequestQuoteOptions(latestQuote.options)
    : [];
  const option =
    firstQuoteOption(quoteOptions, input.optionId) ??
    (request.priceCents != null
      ? {
          id: "LEGACY_PRICE",
          label: "Quoted price",
          cateringOption: null,
          totalCents: request.priceCents,
          pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
          guestBreakdown: [],
        }
      : null);

  if (!option) {
    throw new BookingRequestQuoteError("Create a quote before holding capacity", 409);
  }

  const placeholderPasswordHash = await hash(randomBytes(32).toString("hex"), 13);
  // MG4-D-b (#2309). Read BEFORE the transaction opens — the ordering rule in
  // `member-guest-add-policy.ts`: a settings read under the per-lodge capacity
  // lock is a second query held across the whole hold, for nothing.
  const memberGuestPolicy = await loadMemberGuestAddPolicy();
  const memberGuestActor: MemberGuestAddActor = {
    kind: "BOOKING_REQUEST",
    adminMemberId: input.adminMemberId,
  };
  const linkedMembers = linkedGuestMemberMap(request.linkedGuestMembers);
  const guestPriceCents = splitPriceAcrossGuests(option.totalCents, guests.length);
  // Persist the rate-membership-type snapshot (#1930, E4, D3) on the held
  // booking's guest rows, resolved at the request's check-in season year: an
  // admin-linked member of a custom MEMBER_RATE type records that type,
  // unlinked guests record the built-in NON_MEMBER type. Snapshot-only — the
  // quoted per-guest split above stays exactly as stored. rateSource is
  // resolver-internal and never persisted.
  // Annotated (#2739) so this producer is type-checked against the same shape
  // `buildApprovalGuestCreates` returns: the hold is the one write point that
  // builds its guest rows inline rather than through that helper, so without the
  // annotation nothing would check that it supplies a night set at all.
  const guestCreates: HeldBookingGuestInput[] = (
    await resolveGuestRateMembershipTypes(prisma, {
      seasonYear: getSeasonYear(request.checkIn),
      guests: guests.map((guest, index) => {
        const memberId = linkedMembers.get(index);
        return {
          firstName: guest.firstName,
          lastName: guest.lastName,
          ageTier: guest.ageTier,
          isMember: Boolean(memberId),
          memberId,
          stayStart: request.checkIn,
          stayEnd: request.checkOut,
          priceCents: guestPriceCents[index] ?? 0,
        };
      }),
    })
  ).map((guest) => ({
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    memberId: guest.memberId,
    stayStart: guest.stayStart,
    stayEnd: guest.stayEnd,
    priceCents: guest.priceCents,
    rateMembershipTypeId: guest.rateMembershipTypeId,
    // #2739. A hold is a capacity-holding booking that an officer can already
    // place beds on, so its guests need the canonical night set for exactly the
    // reason a converted booking's do — without it the board shows an
    // AWAITING_REVIEW booking with nobody on it. Built from the request's own
    // envelope, which is what the guest rows above take.
    nights: buildApprovalGuestNights({
      checkIn: request.checkIn,
      checkOut: request.checkOut,
      priceCents: guest.priceCents,
    }),
  }));

  let capacityFullNights: string[] | null = null;

  try {
    const booking = await prisma.$transaction(async (tx) => {
      // A null lodgeId means the club's default lodge.
      const bookingLodgeId = request.lodgeId ?? (await getDefaultLodgeId(tx));
      await acquireLodgeCapacityLock(tx, bookingLodgeId);

      // Re-read the exact linked-member snapshot after the canonical lodge
      // lock. The versioned claim below makes this read authoritative: if a
      // link changes before the claim, its version changes and the whole hold
      // rolls back. Lock the sorted/deduplicated ids before any guest is
      // created, then require the rows to remain active and unarchived under
      // that lock. This protects membership identity independently of whether
      // hosting enforcement is disabled, review-only, or enforced.
      const currentRequest = await tx.bookingRequest.findUnique({
        where: { id: request.id },
        select: { version: true, linkedGuestMembers: true },
      });
      if (!currentRequest || currentRequest.version !== request.version) {
        throw new BookingRequestError(
          "This booking request changed while beds were being held; review it and try again",
          409,
        );
      }
      const currentLinkedMembers = linkedGuestMemberMap(
        currentRequest.linkedGuestMembers,
      );
      const expectedLinkedEntries = [...linkedMembers.entries()].sort(
        ([left], [right]) => left - right,
      );
      const currentLinkedEntries = [...currentLinkedMembers.entries()].sort(
        ([left], [right]) => left - right,
      );
      if (
        JSON.stringify(currentLinkedEntries) !==
        JSON.stringify(expectedLinkedEntries)
      ) {
        throw new BookingRequestError(
          "This booking request changed while beds were being held; review it and try again",
          409,
        );
      }
      await lockActiveBookingRequestLinkedMembers(
        tx,
        [...currentLinkedMembers.values()],
      );

      const claimed = await tx.bookingRequest.updateMany({
        where: {
          id: request.id,
          version: request.version,
          heldBookingId: null,
          status: { in: [...holdableStatuses] },
        },
        // Claim marker (#1923): bumping version records the mutating write and
        // keeps this row's optimistic counter monotonic. @updatedAt still
        // auto-advances updatedAt on the same write.
        data: { version: { increment: 1 } },
      });
      if (claimed.count === 0) {
        const current = await tx.bookingRequest.findUnique({
          where: { id: request.id },
          select: { heldBookingId: true },
        });
        if (current?.heldBookingId) {
          // A concurrent hold already created the rows and already owes (or has
          // already sent) their notifications: this call created nothing, so it
          // notifies nobody. Sending here would double-mail the targets.
          return {
            id: current.heldBookingId,
            reused: true,
            memberGuestNotificationRows: [] as MemberGuestAddNotificationRow[],
          };
        }
        throw new BookingRequestError("This booking request cannot be held", 409);
      }

      const capacityRanges = guests.map(() => ({
        stayStart: request.checkIn,
        stayEnd: request.checkOut,
      }));
      const capacity = await checkCapacityForGuestRanges(
        bookingLodgeId,
        request.checkIn,
        request.checkOut,
        capacityRanges,
        undefined,
        tx
      );
      if (!capacity.available) {
        capacityFullNights = getCapacityFullNights(capacity.nightDetails);
        throw new Error("CAPACITY_EXCEEDED_SENTINEL");
      }

      // Block admin-mediated double-books: a request whose guests an admin
      // linked to real members must not put a member on overlapping nights
      // (issue #1158, invariant INV-CAP-017). A brand-new held
      // booking is being created, so there is nothing to exclude.
      await assertNoBookingMemberNightConflicts(tx, {
        actorMemberId: input.adminMemberId,
        actorRole: "ADMIN",
        checkIn: request.checkIn,
        checkOut: request.checkOut,
        guests: guestCreates,
      });

      const ownerName =
        request.type === BookingRequestType.SCHOOL
          ? request.schoolName ?? `${request.contactFirstName} ${request.contactLastName}`
          : request.contactFirstName;
      const ownerLastName =
        request.type === BookingRequestType.SCHOOL ? "" : request.contactLastName;
      // Held booking owners are non-login records, never paying members: school
      // requests become SCHOOL, all other request types become NON_MEMBER.
      const ownerRole =
        request.type === BookingRequestType.SCHOOL ? "SCHOOL" : "NON_MEMBER";

      let member: { id: string };
      if (input.ownerContactMemberId) {
        // Admin mapped this request to an existing non-login Organisation/School
        // contact at hold time (issue #1255). The held booking is owned by it,
        // and — because approval reuses held.memberId — the eventual conversion
        // and any Xero invoice reuse the same contact. The guard rejects any
        // login-capable target.
        const mappedId = await assertMappableOwnerContact(
          tx,
          input.ownerContactMemberId
        );
        member = { id: mappedId };
      } else {
        member = await tx.member.create({
          data: {
            email: request.contactEmail,
            passwordHash: placeholderPasswordHash,
            emailVerified: true,
            firstName: ownerName.slice(0, 100),
            lastName: ownerLastName.slice(0, 100),
            role: ownerRole,
            ageTier: AgeTier.ADULT,
            active: true,
            canLogin: false,
            phoneNumber: request.contactPhone,
          },
          select: { id: true },
        });
      }

      // MG4-D-b (#2309): the request pipeline is the LAST guest-write path that
      // could put a member on somebody else's booking with no record and no
      // word to them. The family boundary is computed against the held
      // booking's owner — the non-login contact created (or mapped) just above,
      // which is why this sits here and not beside `guestCreates`.
      //
      // In practice every linked member comes back BEYOND_FAMILY, because a
      // freshly created contact is in no family group. It is computed rather
      // than assumed for the mapped-contact case (`ownerContactMemberId`), where
      // an Organisation contact could in principle share a family group with a
      // linked member — and because assuming the answer is how a boundary
      // silently stops being one.
      const consentPlan = await planBookingRequestGuestConsent(tx, {
        bookingOwnerMemberId: member.id,
        guests: guestCreates,
        actor: memberGuestActor,
        policy: memberGuestPolicy,
        bookingCheckIn: request.checkIn,
      });

      const held = await tx.booking.create({
        data: {
          memberId: member.id,
          lodgeId: bookingLodgeId,
          checkIn: request.checkIn,
          checkOut: request.checkOut,
          status: BookingStatus.AWAITING_REVIEW,
          totalPriceCents: option.totalCents,
          finalPriceCents: option.totalCents,
          hasNonMembers: true,
          notes: request.message,
          createdById: input.adminMemberId,
          guests: { create: consentPlan.guests.map(toPipelineGuestCreateData) },
        },
        // The created rows' ids are needed to match the notification plan, and
        // this is the only moment they exist in hand.
        select: { id: true, guests: { select: { id: true, memberId: true } } },
      });

      // #2364. The hold is a capacity-holding booking carrying the requested
      // party — every guest a non-member, owned by a non-login contact — so it
      // is a hazard from the moment it exists, on the same terms as a
      // WAITLISTED booking (`booking-create.ts`). Recorded here rather than
      // deferred to the accept: an officer looking at the board should not have
      // to wait for the requester to pay before the club's own rule is visible.
      // The accept re-reconciles after it rewrites the guest list, so nothing
      // recorded here can go stale.
      //
      // #2569: at a lodge on the ENFORCED consequence this REFUSES rather than
      // records, rolling the hold back — a hold is a capacity-holding booking, so
      // it is the thing the club said it would not take. The hold route answers
      // the officer with the rule that stopped it.
      await reconcileAdultMemberHostingReviewWithSiblings(held.id, tx);

      await tx.bookingRequest.update({
        where: { id: request.id },
        data: { heldBookingId: held.id, version: { increment: 1 } },
      });

      return {
        id: held.id,
        reused: false,
        memberGuestNotificationRows:
          consentPlan.entriesByMemberId.size === 0
            ? []
            : matchMemberGuestNotificationRows({
                createdGuests: held.guests,
                entriesByMemberId: consentPlan.entriesByMemberId,
              }),
      };
    });


    // #2576 §7. Every path that can ENQUEUE bounded re-evaluation work must also
    // drain it: a queue row with nobody draining it turns the owner's "immediate
    // re-evaluation" into "within three hours", which is how long an officer-created
    // booking that has just RESTORED cover would leave a critical incident standing,
    // or one that removed it would leave the owner un-notified. Best-effort and
    // scoped to this booking's owner; the cron sweep is the authority on completion.
    await settleHostingCoverageAfterCommit({ bookingId: booking.id });

    // MG4-D-b (#2309), AFTER the commit and outside the capacity lock: no
    // provider call may sit inside a booking transaction. The dispatcher is
    // documented never to reject; the try/catch is belt and braces around an
    // already-committed hold, which must not fail because a mail did.
    //
    // AND NEVER TWICE FOR ONE REQUEST. A member who was already told by the
    // hold this one replaces is filtered out here rather than mailed again —
    // see `staleHoldNotifiedMemberIds` above for why suppression is the right
    // shape and a retract-then-re-add is not. The consent COLUMNS are written
    // on the fresh rows either way; only the mail is suppressed.
    const owedRows =
      staleHoldNotifiedMemberIds.length === 0
        ? booking.memberGuestNotificationRows
        : booking.memberGuestNotificationRows.filter(
            (row) => !staleHoldNotifiedMemberIds.includes(row.targetMemberId)
          );
    if (owedRows.length > 0) {
      const { sendMemberGuestAddNotifications } = await import(
        "@/lib/member-guest-consent-notifications"
      );
      try {
        await sendMemberGuestAddNotifications({
          bookingId: booking.id,
          rows: owedRows,
          actor: memberGuestActor,
        });
      } catch (err) {
        logger.error(
          { err, bookingId: booking.id, bookingRequestId: request.id },
          "Failed to dispatch member-guest add notifications for a held booking",
        );
      }
    }

    logAudit({
      action: "booking_request.capacity_held",
      memberId: input.adminMemberId,
      actorMemberId: input.adminMemberId,
      targetId: request.id,
      entityType: "BookingRequest",
      entityId: request.id,
      category: "booking",
      outcome: "success",
      summary: "Booking request capacity held",
      metadata: {
        bookingId: booking.id,
        reused: booking.reused,
        optionId: option.id,
        priceCents: option.totalCents,
      },
    });

    return { type: "held" as const, bookingId: booking.id, reused: booking.reused };
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "CAPACITY_EXCEEDED_SENTINEL" &&
      capacityFullNights
    ) {
      return { type: "capacityExceeded" as const, fullNights: capacityFullNights };
    }
    throw err;
  }
}
