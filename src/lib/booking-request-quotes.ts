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
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
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
  type BookingRequestGuest,
  type BookingRequestLinkedGuestMember,
} from "@/lib/booking-request";
import { reconcileBedAllocationsForBookingWithGlobalLockHeld } from "@/lib/bed-allocation-lifecycle";
import { requiredGuestPriceCents } from "@/lib/required-price-cents";
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
import {
  approveSchoolBookingRequest,
  resolveSchoolGuestOverride,
  schoolChildCountsSchema,
  type SchoolChildCounts,
} from "@/lib/school-booking-request";
import { seasonYearOfStoredDate } from "@/lib/financial-year";
import { getCapacityFullNights } from "@/lib/capacity-full-nights";
import { clubFormatValues } from "@/lib/club-format-server";

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
  /**
   * #3412 — the officer's adjusted bulk child counts on a SCHOOL request, in
   * the SAME schema approval takes, because it is the same decision made
   * earlier. Present only when the officer edited the group-number boxes.
   * Saving the quote is where that edit becomes real: the guest list is
   * regenerated and PERSISTED on the request in the quote's own transaction, so
   * the price, the requester's breakdown, the guest count in the email, the
   * send-time hold and the approval all read one list.
   */
  childCounts: schoolChildCountsSchema.optional(),
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
  /**
   * The CLUB's today, encoded at UTC midnight, resolved by the caller
   * (`INV-CONFIG-002`). Required and undefaulted for the same reason as every
   * other caller of the person-night guard: the guard must never resolve a day
   * for itself, because the authoritative callers reach it mid-transaction
   * (`INV-LOCK-004`). This advisory path holds no locks, but a default here
   * would be a default on the shared guard's contract.
   */
  today: Date;
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
    today: input.today,
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
  };
  /**
   * The party being priced — #3412. Taken as a parameter rather than re-parsed
   * from `request.guests`, because on a school request with an officer count
   * adjustment the list being quoted is the REGENERATED one the same save is
   * about to persist, and a second read of the stored column here would price
   * the group that is being replaced.
   */
  guests: BookingRequestGuest[];
  pricingMode: BookingRequestPricingMode;
  options: BookingRequestQuoteInput["options"];
  linkedGuestMembers: BookingRequestLinkedGuestMember[];
}): NormalizedQuoteOption[] {
  const guests = input.guests;
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

/**
 * #3412 — apply an officer's adjusted school group numbers to the quote about
 * to be saved, or refuse the change.
 *
 * Returns null when the input carries no counts, in which case the stored guest
 * list stands and nothing about the request's party is rewritten. Otherwise it
 * returns the list to price, and whether saving must PERSIST it.
 *
 * The ONE refusal that lives here rather than in the shared resolver, because
 * it is about the quote's surroundings rather than about the party itself:
 *
 * - **A live hold is not resized (409).** Sending a quote reserves the beds for
 *   the whole quote lifecycle (`INV-ADDPAY-006`), and that hold is reused as-is
 *   on re-send. Re-pricing under it would leave the requester a quote for one
 *   headcount against beds reserved for another. Releasing is the shared
 *   `cancelBooking` path with its own locks and notifications, and the officer
 *   already has it as one button — so this refuses and says which button. It is
 *   genuinely quote-path-only: approval CONSUMES the hold rather than having to
 *   protect it.
 *
 * The refusal of a member link on a row the regeneration renumbers is NOT here.
 * It lives in `resolveSchoolGuestOverride`, because approve applies its link map
 * positionally against the regenerated list exactly as this does — so a copy
 * here would have covered one of the two doors (#3412 review, B3).
 */
async function resolveSchoolCountAdjustment(input: {
  request: {
    id: string;
    type: BookingRequestType;
    teachers: Prisma.JsonValue;
    guests: Prisma.JsonValue;
    lodgeId: string | null;
    heldBookingId: string | null;
  };
  childCounts: BookingRequestQuoteInput["childCounts"];
  linkedGuestMembers: BookingRequestQuoteInput["linkedGuestMembers"];
}): Promise<{
  guests: BookingRequestGuest[];
  /**
   * How many people the request held BEFORE this save. Carried so the audit row
   * records the party that was overwritten (#3412 review, F11): on the first
   * adjusted save there is no superseded quote, so a mistyped 8 for 18 would
   * otherwise leave nothing anywhere holding the number the school submitted.
   */
  storedGuestCount: number;
  persist: boolean;
} | null> {
  if (input.childCounts === undefined) return null;
  if (input.request.type !== BookingRequestType.SCHOOL) {
    throw new BookingRequestQuoteError(
      "Group numbers can only be adjusted on a school booking request",
      422
    );
  }

  const resolution = await resolveSchoolGuestOverride({
    request: input.request,
    childCounts: input.childCounts,
    // The request's own lodge selector: a count change is refused below while a
    // hold exists, so there is no held booking whose concrete lodge could
    // differ from it here.
    lodgeId: input.request.lodgeId,
    // The POSTED links, because those are what this save is about to write over
    // `linkedGuestMembers` and what every later reader will then apply
    // positionally. The resolver refuses one that the regeneration would move.
    linkedGuestIndexes: (input.linkedGuestMembers ?? []).map(
      (link) => link.guestIndex
    ),
  });
  if (!resolution.changed) {
    // The officer re-sent the numbers already stored. Nothing to persist, and
    // nothing to refuse — a re-save under a live hold must keep working.
    return {
      guests: resolution.guests,
      storedGuestCount: resolution.storedGuests.length,
      persist: false,
    };
  }

  if (input.request.heldBookingId) {
    const hold = await prisma.booking.findUnique({
      where: { id: input.request.heldBookingId },
      select: { status: true },
    });
    // Only a LIVE hold blocks. A pointer left behind by a cancelled booking is
    // detached and replaced by `holdBookingRequestSlots` on the next send, so
    // it reserves nothing and must not trap the officer.
    if (hold?.status === BookingStatus.AWAITING_REVIEW) {
      throw new BookingRequestQuoteError(
        "Beds are already held for this request's current numbers. Release the hold first, then save and send the quote again.",
        409
      );
    }
  }

  return {
    guests: resolution.guests,
    storedGuestCount: resolution.storedGuests.length,
    persist: true,
  };
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
  // #3412 — the officer's adjusted group numbers, resolved through the SAME
  // helper approval uses, so the party priced here and the party converted
  // later cannot diverge. It strict-reads the stored guests (#2342), preserves
  // the named teachers, regenerates the bulk children and binds the lodge's bed
  // count; `changed` is false when the officer typed the current numbers back,
  // which the panel posts whenever they touched a box.
  const schoolCountAdjustment = await resolveSchoolCountAdjustment({
    request,
    childCounts: input.quote.childCounts,
    linkedGuestMembers: input.quote.linkedGuestMembers,
  });
  const guests = schoolCountAdjustment
    ? schoolCountAdjustment.guests
    : parseBookingRequestGuests(request.guests);
  const persistGuests = schoolCountAdjustment?.persist ?? false;
  const linkedGuestMembers = normalizeLinkedGuestMembers(
    input.quote.linkedGuestMembers,
    guests.length
  );
  await assertLinkedMembersExist(linkedGuestMembers);

  const options = normalizeQuoteOptions({
    request,
    guests,
    pricingMode: input.quote.pricingMode,
    options: input.quote.options,
    linkedGuestMembers,
  });

  // A single-option quote carries its price on the request; two or more leave
  // it null. "Exactly one" is a first with no rest, so the price stored is a
  // value this already holds (#2800).
  const [soleOption, ...extraOptions] = options;

  const message = cleanNullableString(input.quote.message);
  const quotedAt = new Date();

  const quote = await prisma.$transaction(async (tx) => {
    // #1423 lock-ordering invariant: lock the BookingRequest row BEFORE any
    // BookingRequestQuote row (matching decline's claim-first order) so a
    // concurrent decline + quote-create on the same request cannot deadlock.
    // Pure statement reorder — same writes, same transaction.
    //
    // #3412 / #2936: a CLAIM rather than the plain update this used to be, and
    // the guard has three parts, each of which this save would otherwise
    // silently overwrite:
    //
    //   - `version` — every writer of this row bumps it. Everything priced
    //     above was computed from the row read before the transaction opened,
    //     and on a school count adjustment this write REPLACES the party. A
    //     second officer's save, an accept, a hold or a correction landing in
    //     between must make this one 409 rather than re-price the row from a
    //     list that has since been rewritten. A correction
    //     (`booking-request-corrections.ts`) is the case `status` alone cannot
    //     see: it rewrites the request's dates, its party and its member links
    //     and drops it back to VERIFIED, which IS quoteable, so the status part
    //     passes both before and after one. Only the version fence refuses it,
    //     and without one a plain overwrite would restore the retired price,
    //     the retired option totals and the stale positional member links over
    //     the corrected row (#2936).
    //   - `status` — the same #1504 resurrection hole `sendBookingRequestQuote`
    //     closed, which create never had: a concurrent decline finalises the
    //     request (releasing its hold) in the window after the status check
    //     above, and a plain overwrite to QUOTED would resurrect it.
    //   - `heldBookingId` — only when the party is being replaced. The 409
    //     above refuses a count change while beds are held; this is the same
    //     rule at write time, against a hold placed in between.
    //
    // Claim-first: the throw below rolls the whole transaction back before any
    // quote row is touched, so a losing save leaves the request exactly as the
    // winner left it — and a corrected request exactly as the correction left
    // it. Same shape as `holdBookingRequestSlots`' claim and the approvals'
    // (#1923).
    const claimed = await tx.bookingRequest.updateMany({
      where: {
        id: request.id,
        version: request.version,
        status: { in: [...quoteableStatuses] },
        ...(persistGuests ? { heldBookingId: request.heldBookingId } : {}),
      },
      data: {
        status: BookingRequestStatus.QUOTED,
        priceCents:
          extraOptions.length === 0 ? (soleOption?.totalCents ?? null) : null,
        pricedByMemberId: input.adminMemberId,
        pricedAt: quotedAt,
        linkedGuestMembers: linkedGuestMembers as unknown as Prisma.InputJsonValue,
        // #3412: the officer's adjusted numbers become the request's party
        // HERE, in the same transaction that mints the quote pricing them — so
        // the price, the requester's breakdown, the guest count in the email,
        // the send-time hold and the approval all read one list. Written only
        // when the counts actually changed the party.
        ...(persistGuests
          ? { guests: guests as unknown as Prisma.InputJsonValue }
          : {}),
        responseMessage: null,
        responseMessageAt: null,
        version: { increment: 1 },
      },
    });
    if (claimed.count === 0) {
      throw new BookingRequestError(
        "This booking request changed while the quote was being saved, so nothing was saved. Reload the queue and quote it again.",
        409
      );
    }

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
      // #3412: a save that rewrote the school party is a different act from one
      // that only re-priced it, and the guest count is what the money was
      // computed over. Both belong in the record of who changed what.
      guestCount: guests.length,
      guestListRegenerated: persistGuests,
      // #3412 (review, F11): the party this save REPLACED. The overwrite is
      // the point of the fix, but on the first adjusted save no superseded
      // quote exists yet, so without this the number the school actually
      // submitted survives nowhere in the application — a mistyped 8 for 18
      // would leave no record that it had ever been 29. Written only on a save
      // that rewrote the list, so an ordinary re-price stays quiet.
      ...(persistGuests
        ? { previousGuestCount: schoolCountAdjustment?.storedGuestCount ?? null }
        : {}),
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
  /**
   * #3412 (review, B1) — the school group numbers currently showing in the
   * officer's panel, when they are showing any.
   *
   * Sending a quote is the OTHER button that holds beds and emails the school,
   * and it does both from the request's stored party. An officer who saves a
   * quote, then edits the boxes, then presses Send would therefore reserve and
   * quote the numbers they just replaced — which is #3412's defect exactly, one
   * button over. The panel disables Send while an unsaved edit exists; this
   * field is what lets the service refuse it too, because a disabled button is
   * not a backstop. Undefined means the officer has typed nothing, which is
   * unchanged from before this issue.
   */
  childCounts?: SchoolChildCounts;
}) {
  // The club's format (#3565), resolved once, before any transaction or
  // lock below — never per amount and never inside a transaction.
  const format = await clubFormatValues();
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

  // #3412 (review, B1): refuse to hold beds and email the school for one party
  // while the officer is looking at another. `changed` is the same question
  // saving asks — false when they typed the stored numbers back — so a panel
  // that posts the boxes on every send only ever blocks a real divergence.
  if (input.childCounts !== undefined) {
    if (quote.bookingRequest.type !== BookingRequestType.SCHOOL) {
      throw new BookingRequestQuoteError(
        "Group numbers can only be adjusted on a school booking request",
        422
      );
    }
    const pending = await resolveSchoolGuestOverride({
      request: quote.bookingRequest,
      childCounts: input.childCounts,
      lodgeId: quote.bookingRequest.lodgeId,
      // Nothing is written and nothing is renumbered here: this asks only
      // whether the numbers on screen are the numbers on the row. The link
      // refusal belongs to the save that actually rewrites the list.
      linkedGuestIndexes: [],
    });
    if (pending.changed) {
      throw new BookingRequestQuoteError(
        "These group numbers have not been saved yet, so sending now would reserve beds and email the school for the numbers still on the request. Press Save quote first, then send.",
        409
      );
    }
  }

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

  const { updated, heldGuestCount } = await prisma.$transaction(async (tx) => {
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

    /*
      #3412 (review, B2) and #2936: THE QUOTE ROW IS CLAIMED ON ITS STATUS,
      NOT OVERWRITTEN.

      This used to be a plain `update` by id, and the quote it wrote was the one
      read before the beds were held — a read that `holdBookingRequestSlots`
      guarantees is stale, because it bumps the request's `version` twice, which
      is also why a version fence on the request claim above cannot cover this.

      The hole that leaves: A presses Send on quote v1 (priced for 29); B saves
      new numbers, which SUPERSEDES v1 and mints v2 for 18; A's hold reserves
      18 beds; A's plain update then flips the SUPERSEDED v1 back to SENT with a
      live accept token, and A emails the school a quote for 29. The requester
      can accept a party the club is not holding. Guarding on the two live
      statuses makes A lose instead: count 0 throws before the email, and the
      throw rolls the request claim back with it.

      A CORRECTION IS THE SAME HOLE BY ANOTHER ROUTE (#2936), and the
      request-status claim above cannot speak for that one either: a correction
      drops the request to VERIFIED, which is in `quoteableStatuses`, so that
      claim passes — while the same transaction SUPERSEDED this very quote.
      Without this guard a retired quote flips back to SENT and is minted a live
      response token, so the requester would hold an acceptable quote priced on
      the party BEFORE the correction, against the dates AFTER it, with no beds
      held — the correction's hold release runs after this.

      WHAT THE ROLLBACK DOES NOT COVER IS THE HOLD. `holdBookingRequestSlots`
      ran and COMMITTED before this transaction opened, so a refusal here leaves
      the request still pointing at beds it holds. That is the #1504 refusal's
      behaviour above too, unchanged by this guard, and the remedy is the
      officer's own Release button on the request — the stale-hold sweep cannot
      be relied on for it, because that sweep needs a lapsed response window and
      a send that never completed wrote none.
    */
    const claimedQuote = await tx.bookingRequestQuote.updateMany({
      where: {
        id: quote.id,
        status: {
          in: [
            BookingRequestQuoteStatus.DRAFT,
            BookingRequestQuoteStatus.SENT,
          ],
        },
      },
      data: {
        status: BookingRequestQuoteStatus.SENT,
        responseTokenHash: tokenHash,
        responseTokenExpiresAt: expiresAt,
        sentAt,
        reminderSentAt: null,
        createdByMemberId: quote.createdByMemberId ?? input.adminMemberId,
      },
    });
    if (claimedQuote.count === 0) {
      throw new BookingRequestQuoteError(
        "This quote was replaced or withdrawn while it was being sent, so nothing was sent. Reload the queue and send the current quote.",
        409
      );
    }

    // Both rows are re-read INSIDE the claim, under the locks it took. The
    // guest count is the one the email tells the school, and the party may have
    // been rewritten by a save that landed between this send's first read and
    // the hold — so reading it from that pre-hold snapshot is how the email
    // ends up naming a headcount nobody is holding (#3412 review, B2).
    const saved = await tx.bookingRequestQuote.findUniqueOrThrow({
      where: { id: quote.id },
    });
    const claimedRequest = await tx.bookingRequest.findUniqueOrThrow({
      where: { id: quote.bookingRequestId },
      select: { guests: true },
    });

    return {
      updated: saved,
      heldGuestCount: parseBookingRequestGuests(claimedRequest.guests).length,
    };
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
      // Read inside the claim transaction above, not from the pre-hold snapshot.
      guestCount: heldGuestCount,
      requestType: quote.bookingRequest.type,
      schoolName: quote.bookingRequest.schoolName,
      options,
      message: quote.message,
      expiresAt,
    }, format);
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
      // #2936: THE FOURTH WRITER A CORRECTION RE-OPENS PAST, and the one that is
      // deliberately NOT lock-fenced. The claim above has the defect shape this
      // issue named — it excludes only DECLINED and CANCELLED, and a corrected
      // request is VERIFIED — so a requester pressing "ask for changes" on a
      // quote link that was live a moment ago still flips a freshly corrected
      // request to MODIFICATION_REQUESTED/QUERY_PENDING.
      //
      // That is allowed to stand, and the reason is what it writes: a status and
      // the requester's own words. No price, no accepted snapshot, no hold, no
      // conversion — nothing the accept re-arm had to be fenced for. Refusing it
      // would throw away a message from the person whose booking it is, and both
      // statuses it can reach are correctable and swept exactly as VERIFIED is.
      // If a future version of this branch ever writes a price or converts, it
      // joins the fenced set and takes the key; until then the honest answer is
      // this comment rather than a lock. Registered as a deliberate omission in
      // `docs/CONCURRENCY_AND_LOCKING.md` and `INV-REQ-009`.
      //
      // The QUOTE write is narrowed, though, because that part is not cosmetic:
      // a bare update by id re-stamps a quote the correction already SUPERSEDED
      // (overwriting the officer's mark with the requester's timestamp) and
      // would flip a CANCELLED quote to SUPERSEDED. Claiming DRAFT/SENT is what
      // every other supersede writer in this tree already does — the quote save
      // above, the withdraw and the decline in `booking-request.ts` — so a
      // retired quote is simply left as the writer that retired it left it.
      await tx.bookingRequestQuote.updateMany({
        where: {
          id: quote.id,
          status: {
            in: [BookingRequestQuoteStatus.DRAFT, BookingRequestQuoteStatus.SENT],
          },
        },
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
  //
  // #2936: the request-status guard above cannot see a CORRECTION. Correcting a
  // request drops it back to VERIFIED — neither DECLINED nor CANCELLED — while
  // SUPERSEDING every DRAFT/SENT quote in the same transaction. Left as a bare
  // update this accept would write the RETIRED quote's price and snapshot onto
  // the corrected envelope and then convert it: a booking for the corrected
  // dates and party at yesterday's price, resolved to the corrected school's
  // organisation, with that organisation's invoice queued to Xero. Money and
  // the provider. So the re-arm now runs in a transaction that takes the global
  // key the correction holds — as the CANCEL branch above already does — and
  // re-reads the quote under it. The quote's own status is the exact evidence: a
  // correction retires it, and nothing else moves a SENT quote out of the live
  // set beneath a token that loaded it as SENT.
  //
  // The MODIFY/QUERY branch takes no key and is not fenced against a correction
  // at all: see the note there for what it writes and why that is deliberate.
  // "Every branch is fenced" would be the overclaim — three of the four are.
  //
  // The live set is deliberately "not retired" rather than "still SENT": a
  // double-accept (#1232) finds the quote already ACCEPTED and must STILL
  // re-arm, so approve's idempotency replay keeps returning the one real
  // booking. Only SUPERSEDED and CANCELLED block it.
  const rearmed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const live = await tx.bookingRequestQuote.findUnique({
      where: { id: quote.id },
      select: { status: true },
    });
    if (
      !live ||
      live.status === BookingRequestQuoteStatus.SUPERSEDED ||
      live.status === BookingRequestQuoteStatus.CANCELLED
    ) {
      return { count: 0, retired: true as const };
    }
    const claimed = await tx.bookingRequest.updateMany({
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
    return { count: claimed.count, retired: false as const };
  });
  if (rearmed.count === 0) {
    throw new BookingRequestQuoteError(
      rearmed.retired
        ? "This quote can no longer be accepted — the booking team changed this request and withdrew it. They will send you a new one."
        : "This quote can no longer be accepted — the booking request has been declined or cancelled.",
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
  // #3123 — the CLUB's day, from its persisted `ClubTimeSettings.timeZone`
  // (`INV-CONFIG-002`), resolved HERE, before the `prisma.$transaction` below
  // takes the per-lodge capacity key and the per-member night locks. The
  // person-night guard inside that transaction takes it as a value:
  // `INV-LOCK-004` forbids a `clubTimeSettings` read under those locks, because
  // it would need a second pooled connection while they are held.
  //
  // The runtime reader rather than `club-time/server`: `src/instrumentation.node.ts`
  // reaches this module through the booking-request cron chain, and `server-only`
  // is a bare throw at import outside the `react-server` condition.
  const clubTodayDateOnly = dateOnlyInstantOf(
    clubToday(await readClubTimeZoneOutsideRequest()),
  );
  const format = await clubFormatValues(); // the guard's refusal copy (#3566), before the locks

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
      seasonYear: seasonYearOfStoredDate(request.checkIn),
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
          // #3167 (epic #2797): NO `?? 0` — the rule is in
          // `required-price-cents.ts`. The #3167 census graded this site a
          // TAUTOLOGY, the strongest of its three verdicts: the split is taken
          // over `guests.length` and this loop iterates that same const, with
          // nothing between them that mutates it, so the refusal cannot fire on
          // any input. It goes in anyway — leaving one prohibited construct on a
          // money column because the reason it is safe is subtle is how the
          // subtlety gets forgotten.
          priceCents: requiredGuestPriceCents(
            guestPriceCents,
            index,
            "the booking-request capacity hold"
          ),
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
        // Resolved before this transaction opened (`INV-LOCK-004`).
        today: clubTodayDateOnly,
      }, format);

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
