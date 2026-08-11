/**
 * Public non-member booking request flow (issue #707).
 *
 * Lifecycle: NEW -> (email verification) -> VERIFIED -> (officer pricing)
 * -> PRICED -> (officer decision) -> APPROVED/DECLINED -> CONVERTED.
 *
 * Approval converts the request into a non-login Member (canLogin: false)
 * plus a PENDING Booking owned by it, mirroring the membership application
 * pattern in src/lib/nomination.ts. Booking.memberId stays required.
 *
 * Conventions:
 *   - money stays integer cents
 *   - booking dates stay NZ date-only values
 *   - only SHA-256 token hashes are stored (issueActionToken)
 *   - external calls (email) run after the transaction commits
 */
import { randomBytes } from "crypto";
import { DEFAULT_BOOKING_REQUEST_SETTINGS } from "@/config/club-settings-defaults";
import { hash } from "bcryptjs";
import {
  AgeTier,
  BookingEventType,
  BookingRequestQuoteStatus,
  BookingRequestStatus,
  BookingRequestType,
  BookingStatus,
  PaymentStatus,
  Prisma,
  Role,
  type BookingRequest,
} from "@prisma/client";
import { z } from "zod";
import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import { settleHostingCoverageAfterCommit } from "@/lib/adult-member-hosting-coverage-drain";
import { reconcileAdultMemberHostingReviewWithSiblings } from "@/lib/adult-member-hosting-review";
import { isHostingCoverageParticipantRetry } from "@/lib/adult-member-hosting-queue-participants";
import { logAudit } from "@/lib/audit";
import { cancelBooking } from "@/lib/booking-cancel";
import { recordBookingEvent } from "@/lib/booking-events";
import {
  loadMemberGuestAddPolicy,
  matchMemberGuestNotificationRows,
  type MemberGuestAddNotificationRow,
  type MemberGuestAddPolicy,
} from "@/lib/member-guest-add-policy";
import {
  CONSENT_FREE_GUEST_COLUMNS,
  type MemberGuestAddActor,
} from "@/lib/member-guest-consent";
import {
  buildApprovalGuestCreates,
  claimAlreadyConvertedBookingRequest,
  collectNotifiedMemberGuestIds,
  getCapacityFullNights,
  notifyMemberGuestsHoldReleased,
  planBookingRequestGuestConsent,
  sendOwnerSubstitutionAdminAlert,
  toPipelineGuestCreateData,
  type HeldBookingGuestInput,
  type OwnerSubstitution,
} from "@/lib/booking-request-shared";
import { acquireLodgeCapacityLock, checkCapacityForGuestRanges } from "@/lib/capacity";
import { getDefaultLodgeCapacity, getLodgeCapacity } from "@/lib/lodge-capacity";
import { loadSchoolGroupSoftCap } from "@/lib/lodge-settings";
import { getNonMemberHoldDays } from "@/lib/cancellation";
import { endOfDateOnlyForTimeZone, formatDateOnly } from "@/lib/date-only";
import {
  sendAdminBookingRequestPendingEmail,
  sendBookingRequestApprovedEmail,
  sendBookingRequestDeclinedEmail,
  sendBookingRequestVerificationEmail,
} from "@/lib/email";
import logger from "@/lib/logger";
import {
  priceBookingGuests,
  toSeasonRateData,
} from "@/lib/policies/booking-route-decisions";
import { resolveGuestRateMembershipTypes } from "@/lib/membership-type-policy";
import { getSeasonYear } from "@/lib/utils";
import {
  getDefaultLodgeId,
  lodgeNullTolerantScope,
  lodgeOrderBy,
} from "@/lib/lodges";
import { otherLodgeOrderBy } from "@/lib/other-lodges";
// ONE definition of the open-status list, shared with the member DTO so the
// Withdraw affordance is derived from the same list this file's WHERE clauses
// name rather than restating it (#2263 review finding M3).
import { MEMBER_WHOLE_LODGE_OPEN_STATUSES } from "@/lib/member-whole-lodge-requests";
import { MEMBER_WHOLE_LODGE_GUEST_NAME_PREFIX } from "@/lib/placeholder-guest-names";
import { prisma } from "@/lib/prisma";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import { nameField } from "@/lib/zod-helpers";

export const BOOKING_REQUEST_VERIFICATION_TTL_MS = 48 * 60 * 60 * 1000;
/** Privacy Act 2020 retention: purge declined and never-verified requests. */
const BOOKING_REQUEST_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Booking-request statuses an admin may decline (#1423). Matches the panel's
 * LINKING_EDITOR_STATUSES (the six "editor/queue" states the Decline button is
 * shown for) — every one can carry a live AWAITING_REVIEW capacity hold, which
 * the claim-first hold-release below (#1365) frees. Terminal/converted states
 * (APPROVED/CONVERTED/DECLINED/CANCELLED) and NEW are intentionally excluded.
 */
const DECLINABLE_BOOKING_REQUEST_STATUSES = [
  BookingRequestStatus.VERIFIED,
  BookingRequestStatus.PRICED,
  BookingRequestStatus.QUOTED,
  BookingRequestStatus.QUOTE_SENT,
  BookingRequestStatus.QUERY_PENDING,
  BookingRequestStatus.MODIFICATION_REQUESTED,
] as const;

export const bookingRequestGuestSchema = z.object({
  firstName: nameField(),
  lastName: nameField(),
  ageTier: bookableAgeTierEnum,
});

export type BookingRequestGuest = z.infer<typeof bookingRequestGuestSchema>;

const bookingRequestLinkedGuestMemberSchema = z.object({
  guestIndex: z.number().int().min(0),
  memberId: z.string().min(1),
});

export type BookingRequestLinkedGuestMember = z.infer<
  typeof bookingRequestLinkedGuestMemberSchema
>;

export class BookingRequestError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "BookingRequestError";
    this.status = status;
  }
}

export class BookingRequestDeclineCommittedError extends BookingRequestError {
  readonly holdReleasePending: boolean;
  readonly holdReleaseStatusUnconfirmed: boolean;
  override readonly cause: unknown;

  constructor(input: {
    message: string;
    status: number;
    holdReleasePending: boolean;
    holdReleaseStatusUnconfirmed: boolean;
    cause?: unknown;
  }) {
    super(input.message, input.status);
    this.name = "BookingRequestDeclineCommittedError";
    this.holdReleasePending = input.holdReleasePending;
    this.holdReleaseStatusUnconfirmed = input.holdReleaseStatusUnconfirmed;
    this.cause = input.cause;
  }
}

function cleanString(value?: string | null) {
  return value?.replace(/[\r\n]/g, " ").trim() || "";
}

function cleanNullableString(value?: string | null) {
  const trimmed = cleanString(value);
  return trimmed || null;
}

/**
 * What an admin is told when a stored blob on a booking request cannot be read
 * back and they tried to ACT on it (#2342).
 *
 * These strings reach the officer verbatim — the admin panel renders
 * `error` from the route response — so they say what happened and what to do
 * instead, in plain English. They are NOT developer diagnostics: the schema
 * failure itself is a data condition, not a bug in the request being made,
 * which is why the accompanying status is 409 (conflict with the stored state)
 * rather than 500.
 *
 * There is no guest-edit affordance anywhere in the admin UI, so the honest
 * remedies are exactly two: decline the request, or have the stored row
 * repaired. Do not add "fix the details" wording until such a screen exists.
 */
export const UNREADABLE_STORED_GUESTS_MESSAGE =
  "This request's saved guest details could not be read, so it can't be approved, priced, quoted, or held. Decline it, or contact support to repair the stored data.";

/** Sibling of {@link UNREADABLE_STORED_GUESTS_MESSAGE} for the member links. */
export const UNREADABLE_STORED_LINKS_MESSAGE =
  "This request's saved member links could not be read, so it can't be approved, priced, quoted, or held. Decline it, or contact support to repair the stored data.";

/**
 * STRICT read of a stored guest list. Throws when the stored JSON does not
 * satisfy `bookingRequestGuestSchema`.
 *
 * This is the reader every WRITE, pricing, quoting and conversion path uses
 * (#2342): a request whose guests cannot be trusted must never be turned into
 * booking guests, priced, or invoiced. Read-only ADMIN display goes through
 * `readBookingRequestGuestsForDisplay` instead, which shows a bad row rather
 * than taking the whole page down with it.
 */
export function parseBookingRequestGuests(raw: unknown): BookingRequestGuest[] {
  const parsed = z.array(bookingRequestGuestSchema).safeParse(raw);
  if (!parsed.success) {
    throw new BookingRequestError(UNREADABLE_STORED_GUESTS_MESSAGE, 409);
  }
  return parsed.data;
}

/**
 * Display-only guest row for an ADMIN READ of a stored booking request (#2342).
 *
 * Deliberately looser than `BookingRequestGuest`: `ageTier` is a plain string,
 * because a row whose stored JSON fails `bookingRequestGuestSchema` may carry
 * anything at all and the point of this shape is to SHOW what is stored, not to
 * vouch for it. Never feed it to a write, pricing, or conversion path — those
 * keep using `parseBookingRequestGuests` and keep rejecting a bad row.
 */
export interface AdminBookingRequestGuestDisplay {
  firstName: string;
  lastName: string;
  ageTier: string;
}

/**
 * Salvage one stored field as display text. Anything that is not a string (a
 * number, null, a nested object) has no sensible rendering, so it becomes an
 * empty cell rather than "[object Object]".
 *
 * Full `nameField` parity on the two cleanups that are about SAFETY rather
 * than validity: the CR/LF collapse (#323 — this text reaches an admin JSON
 * payload having bypassed the schema that would normally have cleaned it) and
 * the 100-character cap (a stored blob that skipped the schema can be
 * arbitrarily long, and the queue renders it into a badge). Length and
 * emptiness are NOT re-validated: the whole point of this reader is to show
 * what is stored, and the row is flagged either way.
 */
function displayGuestText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 100);
}

/**
 * TOLERANT read of a stored guest list for admin display (#2342).
 *
 * A well-formed list parses strictly and comes back exactly as
 * `parseBookingRequestGuests` would have returned it, with
 * `needsAttention: false` — so nothing about a healthy row changes.
 *
 * A list that fails the schema — the seeded historical school request whose
 * children carried `lastName: ""` is the case that found this — is NOT thrown
 * on. The stored names are shown as saved (bar the CR/LF collapse and length
 * cap in `displayGuestText`) and the row is flagged, so one malformed
 * historical row costs one odd-looking row in the queue instead of a 500 that
 * takes down every request on the page (which is what the admin queue's "All"
 * filter did before this).
 */
export function readBookingRequestGuestsForDisplay(raw: unknown): {
  guests: AdminBookingRequestGuestDisplay[];
  needsAttention: boolean;
} {
  const strict = z.array(bookingRequestGuestSchema).safeParse(raw);
  if (strict.success) {
    return { guests: strict.data, needsAttention: false };
  }
  // Not an array at all (null, an object, a string): there is nothing to show,
  // but the row itself still renders — flagged — rather than throwing.
  const rows = Array.isArray(raw) ? raw : [];
  return {
    guests: rows.map((row) => {
      const guest = (row ?? {}) as Record<string, unknown>;
      return {
        firstName: displayGuestText(guest.firstName),
        lastName: displayGuestText(guest.lastName),
        ageTier: displayGuestText(guest.ageTier),
      };
    }),
    needsAttention: true,
  };
}

/**
 * STRICT read of the stored linked-member list. Throws when the stored JSON
 * does not satisfy `bookingRequestLinkedGuestMemberSchema`.
 *
 * Exported (#2342) so `createBookingRequestQuote` can re-read the column
 * before it OVERWRITES it: the admin panel posts the tolerant display list,
 * which is empty for a row whose stored blob failed to parse, so without this
 * check one "Save quote" would replace a recoverable link with nothing.
 */
export function parseBookingRequestLinkedGuestMembers(
  raw: unknown
): BookingRequestLinkedGuestMember[] {
  if (!raw) return [];
  const parsed = z.array(bookingRequestLinkedGuestMemberSchema).safeParse(raw);
  if (!parsed.success) {
    throw new BookingRequestError(UNREADABLE_STORED_LINKS_MESSAGE, 409);
  }
  return parsed.data;
}

/**
 * TOLERANT read of the stored linked-member list for admin display (#2342).
 *
 * The other stored JSON blob the admin payload parses, and the other way one
 * bad row could 500 the whole queue. Same rule as the guest list: an unreadable
 * blob flags the row instead of throwing. It falls back to NO links rather than
 * to a salvaged half-list — a guest index or member id we cannot trust is worse
 * than none.
 *
 * The narrow claim this supports, and no wider one: a link dropped from the
 * DISPLAY cannot quietly unlink a guest **on conversion**, because approval and
 * hold both re-read the column strictly through `linkedGuestMemberMap`. It says
 * nothing about a WRITE that echoes the display list back — `linkedGuestMembers`
 * is an overwritten column on the quote save, which is why that path re-reads
 * the stored column strictly and refuses rather than replacing it.
 */
function readLinkedGuestMembersForDisplay(raw: unknown): {
  links: BookingRequestLinkedGuestMember[];
  needsAttention: boolean;
} {
  if (!raw) return { links: [], needsAttention: false };
  const parsed = z.array(bookingRequestLinkedGuestMemberSchema).safeParse(raw);
  return parsed.success
    ? { links: parsed.data, needsAttention: false }
    : { links: [], needsAttention: true };
}

export function linkedGuestMemberMap(raw: unknown): Map<number, string> {
  return new Map(
    parseBookingRequestLinkedGuestMembers(raw).map((link) => [
      link.guestIndex,
      link.memberId,
    ])
  );
}

// ---------------------------------------------------------------------------
// Settings (pricing visibility)
// ---------------------------------------------------------------------------

export async function getBookingRequestSettings(db: Pick<typeof prisma, "bookingRequestSettings"> = prisma) {
  const record = await db.bookingRequestSettings.findUnique({
    where: { id: "default" },
  });
  return {
    showPricingToNonMembers:
      record?.showPricingToNonMembers ??
      DEFAULT_BOOKING_REQUEST_SETTINGS.showPricingToNonMembers,
    quoteResponseTtlDays:
      record?.quoteResponseTtlDays ??
      DEFAULT_BOOKING_REQUEST_SETTINGS.quoteResponseTtlDays,
    quoteReminderLeadDays:
      record?.quoteReminderLeadDays ??
      DEFAULT_BOOKING_REQUEST_SETTINGS.quoteReminderLeadDays,
    attendeeConfirmationLeadDays:
      record?.attendeeConfirmationLeadDays ??
      DEFAULT_BOOKING_REQUEST_SETTINGS.attendeeConfirmationLeadDays,
    attendeeConfirmationReminderDays:
      record?.attendeeConfirmationReminderDays ??
      DEFAULT_BOOKING_REQUEST_SETTINGS.attendeeConfirmationReminderDays,
  };
}

/**
 * Active lodges a public requester may choose between. Presentation rule
 * (docs/multi-lodge/decisions/ADR-002): a single-lodge club never surfaces
 * lodge copy, so this returns an empty list unless two or more lodges are
 * active. Public endpoint data — expose only id and name.
 */
export async function getPublicBookingRequestLodges(
  db: Pick<typeof prisma, "lodge"> = prisma
): Promise<
  Array<{ id: string; name: string; capacity: number; schoolGroupSoftCap: number }>
> {
  const lodges = await db.lodge.findMany({
    where: { active: true },
    orderBy: lodgeOrderBy(),
    select: { id: true, name: true },
  });
  if (lodges.length < 2) return [];
  // Each lodge's own capacity and school-group soft cap so the public forms
  // measure against the chosen lodge, not the default one (lodge-scoping
  // contract). Neither is sensitive and the server re-validates per lodge.
  return Promise.all(
    lodges.map(async (lodge) => ({
      id: lodge.id,
      name: lodge.name,
      capacity: await getLodgeCapacity(lodge.id),
      schoolGroupSoftCap: await loadSchoolGroupSoftCap(prisma, lodge.id),
    })),
  );
}

/**
 * The external / partner lodges a requester may say they belong to (#2749).
 * id + name only — this backs a public form drop-down. Unlike the own-lodge
 * list this is always returned (even for one entry); the form shows a "No"
 * default and treats a blank selection as "not a member of another lodge".
 */
export async function getPublicOtherLodges(
  db: Pick<typeof prisma, "otherLodge"> = prisma
): Promise<Array<{ id: string; name: string }>> {
  return db.otherLodge.findMany({
    orderBy: otherLodgeOrderBy(),
    select: { id: true, name: true },
  });
}

/**
 * Validate an optional requester-supplied "other lodge" selection. A provided
 * id must name an existing OtherLodge (400 otherwise); an omitted/blank id
 * returns null, meaning "No — not a member of another lodge".
 */
export async function assertRequestedOtherLodgeExists(
  otherLodgeId: string | null | undefined,
  db: Pick<typeof prisma, "otherLodge"> = prisma
): Promise<string | null> {
  if (!otherLodgeId) return null;
  const otherLodge = await db.otherLodge.findUnique({
    where: { id: otherLodgeId },
    select: { id: true },
  });
  if (!otherLodge) {
    throw new BookingRequestError("Selected lodge not found", 400);
  }
  return otherLodge.id;
}

/**
 * Validate an optional requester-supplied lodge selection. A provided id must
 * name an ACTIVE lodge; an omitted id returns null, which downstream readers
 * treat as the club's default lodge (BookingRequest.lodgeId null semantics).
 */
export async function assertRequestedLodgeActive(
  lodgeId: string | null | undefined,
  db: Pick<typeof prisma, "lodge"> = prisma
): Promise<string | null> {
  if (!lodgeId) return null;
  const lodge = await db.lodge.findUnique({
    where: { id: lodgeId },
    select: { id: true, active: true },
  });
  if (!lodge?.active) {
    throw new BookingRequestError("Lodge not found or not active", 400);
  }
  return lodge.id;
}

/**
 * Lodge name for public booking request summaries (verify/respond pages).
 * Presentation-only (ADR-002): returns null when the request carries no
 * explicit lodge or when the club has fewer than two active lodges, so a
 * single-lodge club never sees lodge copy.
 */
export async function resolvePublicRequestLodgeName(
  lodgeId: string | null | undefined,
  db: Pick<typeof prisma, "lodge"> = prisma
): Promise<string | null> {
  if (!lodgeId) return null;
  const activeLodgeCount = await db.lodge.count({ where: { active: true } });
  if (activeLodgeCount < 2) return null;
  const lodge = await db.lodge.findUnique({
    where: { id: lodgeId },
    select: { name: true },
  });
  return lodge?.name ?? null;
}

export async function updateBookingRequestSettings(input: {
  showPricingToNonMembers: boolean;
  quoteResponseTtlDays: number;
  quoteReminderLeadDays: number;
  attendeeConfirmationLeadDays: number;
  attendeeConfirmationReminderDays: number;
  adminMemberId: string;
}) {
  const settings = await prisma.bookingRequestSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      showPricingToNonMembers: input.showPricingToNonMembers,
      quoteResponseTtlDays: input.quoteResponseTtlDays,
      quoteReminderLeadDays: input.quoteReminderLeadDays,
      attendeeConfirmationLeadDays: input.attendeeConfirmationLeadDays,
      attendeeConfirmationReminderDays: input.attendeeConfirmationReminderDays,
      updatedByMemberId: input.adminMemberId,
    },
    update: {
      showPricingToNonMembers: input.showPricingToNonMembers,
      quoteResponseTtlDays: input.quoteResponseTtlDays,
      quoteReminderLeadDays: input.quoteReminderLeadDays,
      attendeeConfirmationLeadDays: input.attendeeConfirmationLeadDays,
      attendeeConfirmationReminderDays: input.attendeeConfirmationReminderDays,
      updatedByMemberId: input.adminMemberId,
    },
  });

  logAudit({
    action: "booking_request.settings_updated",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    entityType: "BookingRequestSettings",
    entityId: "default",
    category: "admin",
    outcome: "success",
    summary: "Booking request settings updated",
    metadata: {
      showPricingToNonMembers: input.showPricingToNonMembers,
      quoteResponseTtlDays: input.quoteResponseTtlDays,
      quoteReminderLeadDays: input.quoteReminderLeadDays,
    },
  });

  // The write echoes the STORED row back, in the same shape the GET returns
  // (#2162). The canonical settings-section pattern re-seeds a card's draft and
  // snapshot from this response, so a partial echo is not a cosmetic omission.
  //
  // The two attendee fields used to be missing, and that broke BOTH timing
  // cards after any save in the section, not just the attendee one: the admin
  // form re-seeded from the three-field echo, so both attendee inputs rendered
  // blank (their drafts became the string "undefined") and both attendee
  // settings became `undefined`. The next "Save quote timing" then spread those
  // `undefined`s into its whole-object body, `JSON.stringify` dropped the two
  // keys entirely, and the route's schema — which requires all five — rejected
  // the request with a 400 "Invalid input". The attendee card's own Save failed
  // earlier and more quietly: `Number("undefined")` is `NaN`, so its client-side
  // range check returned with a validation message before any fetch.
  return {
    showPricingToNonMembers: settings.showPricingToNonMembers,
    quoteResponseTtlDays: settings.quoteResponseTtlDays,
    quoteReminderLeadDays: settings.quoteReminderLeadDays,
    attendeeConfirmationLeadDays: settings.attendeeConfirmationLeadDays,
    attendeeConfirmationReminderDays: settings.attendeeConfirmationReminderDays,
  };
}

// ---------------------------------------------------------------------------
// Indicative non-member pricing
// ---------------------------------------------------------------------------

/**
 * Price a guest list at the public non-member rates for the given range.
 * Returns null when no active season covers the dates (no rate available).
 * Prices against the requested lodge's seasons; a null lodgeId means the
 * club's default lodge (BookingRequest.lodgeId null semantics).
 */
export async function calculateIndicativeNonMemberPriceCents(input: {
  checkIn: Date;
  checkOut: Date;
  guests: Array<{ ageTier: AgeTier }>;
  lodgeId?: string | null;
}): Promise<number | null> {
  const pricingLodgeId = input.lodgeId ?? (await getDefaultLodgeId(prisma));
  const seasons = await prisma.season.findMany({
    where: {
      active: true,
      startDate: { lte: input.checkOut },
      endDate: { gte: input.checkIn },
      ...lodgeNullTolerantScope(pricingLodgeId),
    },
    include: { membershipTypeRates: true },
  });

  if (seasons.length === 0) {
    return null;
  }

  // Non-member request estimate: resolve each guest's rate membership type
  // (all NON_MEMBER_DEFAULT here) so pricing keys on the NON_MEMBER type
  // (#1930, E4).
  const ratedGuests = await resolveGuestRateMembershipTypes(prisma, {
    seasonYear: getSeasonYear(input.checkIn),
    guests: input.guests.map((guest) => ({
      ageTier: guest.ageTier,
      isMember: false,
    })),
  });
  const price = priceBookingGuests({
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    guests: ratedGuests,
    seasons: toSeasonRateData(seasons),
  });

  return price.totalPriceCents;
}

// ---------------------------------------------------------------------------
// Public submission + verification
// ---------------------------------------------------------------------------

interface CreateBookingRequestInput {
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string;
  contactPhone?: string | null;
  checkIn: Date;
  checkOut: Date;
  guests: BookingRequestGuest[];
  message?: string | null;
  /**
   * Lodge the stay is requested at. Callers must validate it names an ACTIVE
   * lodge (assertRequestedLodgeActive). Null/omitted means the club's default
   * lodge (BookingRequest.lodgeId null semantics).
   */
  lodgeId?: string | null;
  /**
   * Other/partner lodge the requester says they belong to (#2749). Callers must
   * validate it names an existing OtherLodge (assertRequestedOtherLodgeExists).
   * Null/omitted means "No" (blank for backwards compatibility).
   */
  otherLodgeId?: string | null;
}

/**
 * Create a NEW booking request and email the requester a verification link.
 * The request only enters the admin queue once the email is verified.
 */
export async function createBookingRequest(input: CreateBookingRequestInput) {
  const contactEmail = cleanString(input.contactEmail).toLowerCase();
  const contactFirstName = cleanString(input.contactFirstName);
  const contactLastName = cleanString(input.contactLastName);

  if (!contactFirstName || !contactLastName || !contactEmail) {
    throw new BookingRequestError("Contact name and email are required", 422);
  }
  if (input.guests.length === 0) {
    throw new BookingRequestError("At least one guest is required", 422);
  }

  const requestedLodgeId = input.lodgeId ?? null;
  const settings = await getBookingRequestSettings();
  const indicativePriceCents = settings.showPricingToNonMembers
    ? await calculateIndicativeNonMemberPriceCents({
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        guests: input.guests,
        lodgeId: requestedLodgeId,
      })
    : null;

  const { token, tokenHash } = issueActionToken();
  const verificationTokenExpiresAt = new Date(
    Date.now() + BOOKING_REQUEST_VERIFICATION_TTL_MS
  );

  const request = await prisma.bookingRequest.create({
    data: {
      contactFirstName,
      contactLastName,
      contactEmail,
      contactPhone: cleanNullableString(input.contactPhone),
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guests: input.guests,
      message: cleanNullableString(input.message),
      indicativePriceCents,
      lodgeId: requestedLodgeId,
      otherLodgeId: input.otherLodgeId ?? null,
      verificationTokenHash: tokenHash,
      verificationTokenExpiresAt,
    },
  });

  try {
    await sendBookingRequestVerificationEmail({
      // A public request has no booking until it is approved (#2258).
      bookingContext: "none",
      email: contactEmail,
      firstName: contactFirstName,
      token,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guestCount: input.guests.length,
      expiresAt: verificationTokenExpiresAt,
      lodgeId: input.lodgeId ?? null,
    });
  } catch (err) {
    logger.error(
      { err, bookingRequestId: request.id },
      "Failed to send booking request verification email"
    );
  }

  logAudit({
    action: "booking_request.submitted",
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    outcome: "success",
    summary: "Public booking request submitted",
    metadata: {
      checkIn: input.checkIn.toISOString(),
      checkOut: input.checkOut.toISOString(),
      guestCount: input.guests.length,
      indicativePriceCents,
      pricingShown: settings.showPricingToNonMembers,
      lodgeId: requestedLodgeId,
      otherLodgeId: input.otherLodgeId ?? null,
    },
  });

  return request;
}

// ---------------------------------------------------------------------------
// Member whole-lodge request (#2263, epic #2245)
// ---------------------------------------------------------------------------

/**
 * How many whole-lodge requests one member may have open at a time (owner
 * decision D3, #2263). A creation-time guard, not an invariant: a member merge
 * can transiently re-point a loser's requests onto a master who then holds more
 * than this (documented in docs/STATE_MACHINES.md and in the member-merge
 * relation spec). Withdrawing frees a slot.
 */
export const MEMBER_WHOLE_LODGE_OPEN_REQUEST_CAP = 2;

/**
 * True when this row came through the authenticated member whole-lodge door
 * (#2263) rather than the public or school front-doors. The single discriminator
 * the whole feature keys on: it decides the admin badge, the direct-approve
 * branch, the audit-log-only decline note, the quote-lifecycle rejections, and
 * whether the row can appear in a member's "My requests".
 */
export function isMemberWholeLodgeRequest(
  request: Pick<BookingRequest, "requestedByMemberId" | "exclusivityRequested">
): boolean {
  return request.requestedByMemberId != null && request.exclusivityRequested;
}

/**
 * Build the placeholder guest list for an approximate headcount. Every guest is
 * ADULT: the member gives no ages at request time either, and the approving
 * officer prices the confirmed headcount before the booking exists.
 */
export function buildMemberWholeLodgePlaceholderGuests(
  headcount: number
): BookingRequestGuest[] {
  return Array.from({ length: headcount }, (_, index) => ({
    firstName: MEMBER_WHOLE_LODGE_GUEST_NAME_PREFIX,
    lastName: String(index + 1),
    ageTier: AgeTier.ADULT,
  }));
}

/**
 * Fold the member's two free-text fields into the single `message` column the
 * request pipeline already has. CRLF is stripped (the column feeds emails and
 * the converted booking's notes), so the two parts are joined inline.
 */
function buildMemberWholeLodgeMessage(
  groupDescription: string,
  notes?: string | null
): string {
  const group = cleanString(groupDescription);
  const extra = cleanString(notes);
  return extra ? `${group} — Notes: ${extra}` : group;
}

/**
 * Count a member's open whole-lodge requests (the cap in D3). Reads only
 * `BookingRequest` — account state, never availability.
 */
async function countOpenMemberWholeLodgeRequests(
  memberId: string,
  db: Pick<typeof prisma, "bookingRequest"> = prisma
): Promise<number> {
  return db.bookingRequest.count({
    where: {
      requestedByMemberId: memberId,
      exclusivityRequested: true,
      status: { in: [...MEMBER_WHOLE_LODGE_OPEN_STATUSES] },
    },
  });
}

/**
 * Create a whole-lodge request on behalf of a signed-in member (#2263).
 *
 * Deliberately NOT an extension of `createBookingRequest`: the public GENERAL
 * front-door's input type still has no exclusivity field, so no anonymous
 * submission can ever ask for sole occupancy (ADR-001 decision 6 / the pinning
 * tests in booking-request.test.ts).
 *
 * The row enters the existing admin pipeline at `VERIFIED` — the requester is
 * authenticated, so there is nothing to email-verify and no verification token
 * is minted — with `exclusivityRequested: true` and no capacity held. Nothing
 * here queries availability, occupancy, seasons or pricing: the ONLY capacity
 * touch is the static configured lodge capacity used to bound the headcount,
 * exactly as the school door does. That is what makes the caller's
 * acknowledgement uniform by construction rather than by padding — a full lodge,
 * an empty lodge and an exclusively-held lodge all run the identical statements.
 */
export async function createMemberWholeLodgeRequest(input: {
  /** ALWAYS from the session. Never read from a request body. */
  memberId: string;
  checkIn: Date;
  checkOut: Date;
  /** Approximate party size; bounded by the static lodge capacity. */
  headcount: number;
  /**
   * Lodge the stay is requested at. Callers must validate it names an ACTIVE
   * lodge (assertRequestedLodgeActive). Null/omitted means the club's default
   * lodge (BookingRequest.lodgeId null semantics).
   */
  lodgeId?: string | null;
  /** Who the group is, in the member's words. */
  groupDescription: string;
  notes?: string | null;
}) {
  const member = await prisma.member.findUnique({
    where: { id: input.memberId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phoneNumber: true,
    },
  });
  if (!member) {
    throw new BookingRequestError("Member not found", 404);
  }

  const groupDescription = cleanString(input.groupDescription);
  if (!groupDescription) {
    throw new BookingRequestError("Tell us who the group is", 422);
  }

  if (!Number.isInteger(input.headcount) || input.headcount < 1) {
    throw new BookingRequestError("Enter how many people are coming", 422);
  }

  const requestedLodgeId = input.lodgeId ?? null;
  // Static CONFIGURED capacity of the lodge — a property of the building, not of
  // who is staying in it. Reading it tells the member nothing about occupancy.
  const lodgeCapacity = requestedLodgeId
    ? await getLodgeCapacity(requestedLodgeId)
    : await getDefaultLodgeCapacity();
  if (input.headcount > lodgeCapacity) {
    throw new BookingRequestError(
      `A whole-lodge request cannot exceed the lodge capacity of ${lodgeCapacity} guests`,
      422
    );
  }

  // Account-state guard (D3), not an availability guard: how many requests this
  // member already has open. Runs before the write so the cap cannot be raced
  // past by more than the usual single-request window.
  const openRequests = await countOpenMemberWholeLodgeRequests(input.memberId);
  if (openRequests >= MEMBER_WHOLE_LODGE_OPEN_REQUEST_CAP) {
    // Audit the REFUSAL, not just the success. A member hammering this door is
    // the cheapest signal that something is wrong (a broken client, or someone
    // probing), and an audit trail that records only successes cannot show it.
    // Carries no availability data — the cap is account state.
    logAudit({
      action: "booking_request.member_whole_lodge_refused",
      memberId: member.id,
      actorMemberId: member.id,
      subjectMemberId: member.id,
      entityType: "BookingRequest",
      category: "booking",
      outcome: "failure",
      summary:
        "Member whole-lodge request refused: the open-request cap was already reached",
      metadata: {
        reason: "open_request_cap",
        openRequests,
        cap: MEMBER_WHOLE_LODGE_OPEN_REQUEST_CAP,
      },
    });
    throw new BookingRequestError(
      `You already have ${MEMBER_WHOLE_LODGE_OPEN_REQUEST_CAP} whole-lodge requests waiting for a decision. Withdraw one before sending another.`,
      409
    );
  }

  const guests = buildMemberWholeLodgePlaceholderGuests(input.headcount);
  const verifiedAt = new Date();

  const request = await prisma.bookingRequest.create({
    data: {
      // Member requests stay GENERAL; the school door keeps SCHOOL. The
      // member-origin discriminator is requestedByMemberId, not the type.
      type: BookingRequestType.GENERAL,
      // The ASK for sole occupancy. Only an approving admin turns it into a
      // Booking.wholeLodgeHold (ADR-001: the flag is the admin capacity action).
      exclusivityRequested: true,
      // Enters the queue directly: an authenticated requester has nothing to
      // verify, so no verification token is issued at all.
      status: BookingRequestStatus.VERIFIED,
      verifiedAt,
      requestedByMemberId: member.id,
      // Contact details are SNAPSHOT from the member row, never accepted from
      // the body — the request must always be reachable at the account's own
      // address.
      contactFirstName: member.firstName,
      contactLastName: member.lastName,
      contactEmail: member.email,
      contactPhone: member.phoneNumber,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      guests,
      message: buildMemberWholeLodgeMessage(groupDescription, input.notes),
      lodgeId: requestedLodgeId,
      // Deliberately absent: indicativePriceCents (the member is shown no price
      // at request time) and every verification-token column.
    },
  });

  logAudit({
    action: "booking_request.member_whole_lodge_submitted",
    memberId: member.id,
    actorMemberId: member.id,
    subjectMemberId: member.id,
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    outcome: "success",
    summary: "Member submitted a whole-lodge booking request",
    metadata: {
      requestId: request.id,
      checkIn: input.checkIn.toISOString(),
      checkOut: input.checkOut.toISOString(),
      headcount: input.headcount,
      lodgeId: requestedLodgeId,
      exclusivityRequested: true,
    },
  });

  // Admin-audience alert. Admin alerts are never withheld by the per-booking
  // "No emails" switch (#2258) — there is no booking here at all yet.
  sendAdminBookingRequestPendingEmail({
    requesterName: `${member.firstName} ${member.lastName}`,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    guestCount: guests.length,
  }).catch((err) =>
    logger.error(
      { err, bookingRequestId: request.id },
      "Failed to send admin alert for a member whole-lodge booking request"
    )
  );

  return request;
}

/**
 * Withdraw a member's own pending whole-lodge request (D3, #2263).
 *
 * Owner-scoped: the WHERE names `requestedByMemberId`, so a member can only ever
 * clear their own row and an id belonging to somebody else behaves exactly like
 * an id that does not exist. Status-guarded, so the loser of a
 * withdraw-vs-approve/decline race gets a clean 409 rather than clobbering a
 * decision an officer already made.
 *
 * `heldBookingId: null` is load-bearing, not defensive noise: member withdraw has
 * NO hold-release machinery. If a row somehow acquired a capacity hold, flipping
 * it to CANCELLED here would strand an AWAITING_REVIEW hold booking forever with
 * no path that releases it — the beds sterilised indefinitely. Such a row must go
 * through admin decline instead, which does release holds.
 *
 * MG4 (#2309) ADDS NO WITHDRAWAL NOTICE HERE, and that is a consequence of the
 * clause above rather than an omission. A member-guest withdrawal notice is owed
 * when a hold that had ALREADY TOLD somebody they were on a booking goes away —
 * but this claim refuses to act on any request holding a booking at all, so no
 * such hold can be released down this path and there is nobody to tell. If the
 * `heldBookingId: null` guard is ever relaxed, the notice becomes owed with it:
 * see the decline path, which reads `collectNotifiedMemberGuestIds` before the
 * hold is cancelled and dispatches after.
 */
export async function withdrawMemberWholeLodgeRequest(input: {
  requestId: string;
  /** ALWAYS from the session. */
  memberId: string;
}) {
  const cancelledAt = new Date();

  // Claim the request row FIRST, then the quote rows — the #1423 lock-ordering
  // invariant every BookingRequest+quote transaction must keep.
  const claimed = await prisma.$transaction(async (tx) => {
    const result = await tx.bookingRequest.updateMany({
      where: {
        id: input.requestId,
        // Ownership is part of the claim, not a separate read: no TOCTOU window
        // between "is it mine?" and "cancel it".
        requestedByMemberId: input.memberId,
        exclusivityRequested: true,
        status: { in: [...MEMBER_WHOLE_LODGE_OPEN_STATUSES] },
        // See the docstring: never withdraw a row that holds capacity.
        heldBookingId: null,
      },
      data: {
        status: BookingRequestStatus.CANCELLED,
        version: { increment: 1 },
      },
    });
    if (result.count === 0) {
      return false;
    }

    // Belt and braces alongside the service-layer quote rejections: a withdrawn
    // request must never leave an acceptable token quote live. SUPERSEDED, not
    // CANCELLED — the same distinction the decline path draws.
    await tx.bookingRequestQuote.updateMany({
      where: {
        bookingRequestId: input.requestId,
        status: BookingRequestQuoteStatus.SENT,
      },
      data: {
        status: BookingRequestQuoteStatus.SUPERSEDED,
        supersededAt: cancelledAt,
      },
    });
    return true;
  });

  if (!claimed) {
    // Audit the refusal. The guarded claim deliberately cannot distinguish "not
    // yours", "already decided" and "does not exist" — that indistinguishability
    // IS the authorisation property — so the audit records the same three-way
    // ambiguity rather than resolving it with a second read. Repeated failures
    // against ids a member does not own are exactly what this row makes visible.
    logAudit({
      action: "booking_request.member_whole_lodge_withdraw_refused",
      memberId: input.memberId,
      actorMemberId: input.memberId,
      subjectMemberId: input.memberId,
      targetId: input.requestId,
      entityType: "BookingRequest",
      entityId: input.requestId,
      category: "booking",
      outcome: "failure",
      summary:
        "Member whole-lodge withdraw refused: the guarded claim matched nothing (not theirs, already decided, holding capacity, or no such request)",
      metadata: { requestId: input.requestId, reason: "claim_matched_nothing" },
    });
    throw new BookingRequestError(
      "This request can no longer be withdrawn. It may already have been decided — check My requests for its current state.",
      409
    );
  }

  logAudit({
    action: "booking_request.member_whole_lodge_withdrawn",
    memberId: input.memberId,
    actorMemberId: input.memberId,
    subjectMemberId: input.memberId,
    targetId: input.requestId,
    entityType: "BookingRequest",
    entityId: input.requestId,
    category: "booking",
    outcome: "success",
    summary: "Member withdrew their whole-lodge booking request",
    metadata: { requestId: input.requestId },
  });
}

type VerifyBookingRequestOutcome =
  | { outcome: "verified"; request: BookingRequest }
  | { outcome: "already_verified"; request: BookingRequest }
  | { outcome: "expired" }
  | { outcome: "invalid" };

/**
 * Verify the requester's email address from the emailed token. On first
 * verification the request moves NEW -> VERIFIED and lands in the admin queue.
 */
export async function verifyBookingRequest(
  token: string
): Promise<VerifyBookingRequestOutcome> {
  const tokenHash = hashActionToken(cleanString(token));

  const request = await prisma.bookingRequest.findUnique({
    where: { verificationTokenHash: tokenHash },
  });

  if (!request) {
    return { outcome: "invalid" };
  }

  if (request.status !== BookingRequestStatus.NEW) {
    return { outcome: "already_verified", request };
  }

  if (
    !request.verificationTokenExpiresAt ||
    request.verificationTokenExpiresAt < new Date()
  ) {
    return { outcome: "expired" };
  }

  const verifiedAt = new Date();
  // Status-claim: only one concurrent verification can flip NEW -> VERIFIED.
  const claimed = await prisma.bookingRequest.updateMany({
    where: { id: request.id, status: BookingRequestStatus.NEW },
    data: { status: BookingRequestStatus.VERIFIED, verifiedAt, version: { increment: 1 } },
  });

  if (claimed.count === 0) {
    const latest = await prisma.bookingRequest.findUnique({
      where: { id: request.id },
    });
    return latest
      ? { outcome: "already_verified", request: latest }
      : { outcome: "invalid" };
  }

  const updated = { ...request, status: BookingRequestStatus.VERIFIED, verifiedAt };

  logAudit({
    action: "booking_request.verified",
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    outcome: "success",
    summary: "Booking request email verified",
  });

  sendAdminBookingRequestPendingEmail({
    requesterName: `${request.contactFirstName} ${request.contactLastName}`,
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    guestCount: parseBookingRequestGuests(request.guests).length,
  }).catch((err) =>
    logger.error(
      { err, bookingRequestId: request.id },
      "Failed to send admin booking request alert"
    )
  );

  return { outcome: "verified", request: updated };
}

// ---------------------------------------------------------------------------
// Officer pricing and decisions
// ---------------------------------------------------------------------------

/** Set or override the officer price on a verified request. */
export async function priceBookingRequest(input: {
  requestId: string;
  adminMemberId: string;
  priceCents: number;
}) {
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
    throw new BookingRequestError("Price must be a non-negative whole number of cents", 422);
  }

  const pricedAt = new Date();
  const existing = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!existing) {
    throw new BookingRequestError("Booking request not found", 404);
  }
  // #2263: the officer-price op belongs to the quote lifecycle, which a member
  // whole-lodge request never enters. Its price is set at approval instead (the
  // priced-headcount field, or the price-override when no season covers the
  // dates), so pricing one here would only strand it in PRICED with a number the
  // approval path does not read. Refused at the service layer for the same
  // reason as the quote ops (booking-request-quotes.ts).
  if (isMemberWholeLodgeRequest(existing)) {
    throw new BookingRequestError(
      "Pricing is not available for a member's whole-lodge request. Set the priced headcount when you approve it.",
      409
    );
  }
  // #2342: refuse to price a request whose stored guest data cannot be read
  // back. This route is the ONE admin action on that list that never needed to
  // read the guests — it only stamps priceCents — so it returned 200 on a row
  // that approve, quote and hold all refuse. That is not a harmless
  // inconsistency:
  // the price it stamps is split across the guest list later (approval and
  // hold both call splitPriceAcrossGuests over the STRICT list), and for a
  // GENERAL request reaching PRICED is precisely what arms the Approve button.
  // Pricing therefore refuses on the same terms as the rest, which is also
  // what docs/guides/booking-requests.md now tells operators.
  parseBookingRequestGuests(existing.guests);
  parseBookingRequestLinkedGuestMembers(existing.linkedGuestMembers);

  const claimed = await prisma.bookingRequest.updateMany({
    where: {
      id: input.requestId,
      status: {
        in: [BookingRequestStatus.VERIFIED, BookingRequestStatus.PRICED],
      },
    },
    data: {
      status: BookingRequestStatus.PRICED,
      priceCents: input.priceCents,
      pricedByMemberId: input.adminMemberId,
      pricedAt,
      version: { increment: 1 },
    },
  });

  if (claimed.count === 0) {
    throw new BookingRequestError(
      "Only verified booking requests can be priced",
      409
    );
  }

  logAudit({
    action: "booking_request.priced",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    targetId: input.requestId,
    entityType: "BookingRequest",
    entityId: input.requestId,
    category: "booking",
    outcome: "success",
    summary: "Booking request priced by officer",
    metadata: {
      priceCents: input.priceCents,
      previousPriceCents: existing.priceCents,
      indicativePriceCents: existing.indicativePriceCents,
    },
  });

  return prisma.bookingRequest.findUnique({ where: { id: input.requestId } });
}

/**
 * Decline a held/editor booking request (any of
 * DECLINABLE_BOOKING_REQUEST_STATUSES — VERIFIED, PRICED, QUOTED, QUOTE_SENT,
 * QUERY_PENDING, MODIFICATION_REQUESTED), release any live capacity hold, and
 * email the requester (#1423 broadened this from VERIFIED/PRICED only).
 */
export async function declineBookingRequest(input: {
  requestId: string;
  adminMemberId: string;
  reason?: string | null;
  // #1791: admin per-action email choice. Absent/undefined = notify the
  // requester (default); false = suppress the decline email. The recipient
  // (request.contactEmail) is always present, so decline always sends unless
  // the admin opted out — the suppression is recorded in the audit log.
  notifyMember?: boolean;
  ipAddress?: string;
}) {
  const request = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!request) {
    throw new BookingRequestError("Booking request not found", 404);
  }

  const reviewedAt = new Date();
  const officerNote = cleanNullableString(input.reason);
  // #2263 (privacy decision D11/D5): on a MEMBER-ORIGIN whole-lodge request the
  // officer's note is an internal record only — it must never reach the member.
  // The school/public path's `declineReason` is the field the requester is shown
  // (it is interpolated into the decline email), and an availability-derived
  // sentence in it — "we're holding the lodge for another group that week" — is
  // precisely the disclosure ADR-001 decision 6 forbids. So for these rows the
  // note is NOT persisted on the request at all: it lives only in the decline
  // audit metadata below. Not persisting is deliberately stronger than
  // persist-and-filter, because no present or future member-facing surface can
  // leak a column that is null.
  const memberOrigin = isMemberWholeLodgeRequest(request);
  const declineReason = memberOrigin ? null : officerNote;
  // Claim the request AND retire any outstanding SENT quote in ONE interactive
  // transaction (#1423). Retiring the live quote is what makes the decline truly
  // final for a QUOTE_SENT request: `loadSentQuoteByToken` requires
  // `status === SENT`, so with the quote flipped to SUPERSEDED every requester
  // quote action (accept / modify / query / cancel) 409s and can no longer
  // resurrect the DECLINED request, AND the pre-expiry reminder cron (which
  // selects SENT quotes with no request-status filter) skips it instead of
  // nudging a just-declined requester. We use SUPERSEDED (an ADMIN retired the
  // quote), NOT CANCELLED (that is the requester-cancel semantic). The claim is
  // still status-guarded, so a wrong-state decline claims NOTHING and must touch
  // NOTHING — the quote retirement runs only when the claim succeeded, and the
  // 409 is thrown OUTSIDE the transaction so a failed decline never opens a
  // write. Everything after the claim (email, audit, and the #1365 hold-release)
  // stays OUTSIDE the transaction: `cancelBooking` self-locks on advisory key 1
  // and runs its own transactions, so it must never nest inside this one.
  const claimResult = await prisma.$transaction(async (tx) => {
    const claimed = await tx.bookingRequest.updateMany({
      where: {
        id: input.requestId,
        status: { in: [...DECLINABLE_BOOKING_REQUEST_STATUSES] },
      },
      data: {
        status: BookingRequestStatus.DECLINED,
        reviewedByMemberId: input.adminMemberId,
        reviewedAt,
        declineReason,
        version: { increment: 1 },
      },
    });
    if (claimed.count === 0) {
      // Wrong-state decline: touch nothing, signal the caller to 409 outside.
      return { claimed: false as const };
    }
    await tx.bookingRequestQuote.updateMany({
      where: {
        bookingRequestId: input.requestId,
        status: BookingRequestQuoteStatus.SENT,
      },
      data: {
        status: BookingRequestQuoteStatus.SUPERSEDED,
        supersededAt: reviewedAt,
      },
    });
    return { claimed: true as const };
  });

  if (!claimResult.claimed) {
    throw new BookingRequestError(
      "This booking request can no longer be declined (it may already be approved, converted, cancelled, or declined).",
      409
    );
  }

  try {

  // #1791: decline always emails the requester unless the admin chose not to
  // notify (default is notify; the suppression is audited below). Only the
  // decline email is gated — the approve/quote path emails carry the
  // payment/quote link and stay always-send.
  if (input.notifyMember !== false) {
    try {
      await sendBookingRequestDeclinedEmail({
        // Every DECLINABLE_BOOKING_REQUEST_STATUS precedes approval, so no
        // booking has been created for this request (#2258).
        bookingContext: "none",
        email: request.contactEmail,
        firstName: request.contactFirstName,
        checkIn: request.checkIn,
        checkOut: request.checkOut,
        // Null on a member-origin whole-lodge decline, so the template renders
        // its one fixed generic body with no note and nothing derived from
        // availability (#2263).
        reason: declineReason,
        lodgeId: request.lodgeId ?? null,
      });
    } catch (err) {
      logger.error(
        { err, bookingRequestId: request.id },
        "Failed to send booking request declined email"
      );
    }
  }

  // #1791: honesty rule — record the notify choice only when a requester email
  // was actually suppressed. `request.contactEmail` is a non-nullable field, so
  // the decline path always sends unless the admin opted out; there is no
  // email-presence guard to fold in.
  const notifyAuditFields =
    input.notifyMember === false ? { notifyMember: false } : {};

  logAudit({
    action: "booking_request.declined",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    targetId: input.requestId,
    entityType: "BookingRequest",
    entityId: input.requestId,
    category: "booking",
    outcome: "success",
    summary: "Booking request declined",
    metadata: {
      // For a member-origin whole-lodge request this audit row is the ONLY
      // place the officer's note exists (#2263): `declineReason` on the row is
      // null and the member's email carries the fixed generic copy.
      reason: officerNote,
      ...(memberOrigin
        ? { memberWholeLodgeRequest: true, declineNoteAuditOnly: true }
        : {}),
      ...notifyAuditFields,
    },
  });

  // #1365 (F18): a declined request that still holds capacity — a held
  // AWAITING_REVIEW booking (a SCHOOL manual hold or the auto-hold-on-send,
  // #1280, pointed to by `heldBookingId`) — must have that hold released,
  // otherwise the beds stay sterilised forever after the decline. This runs
  // CLAIM-FIRST: strictly AFTER the status-guarded flip above actually claimed
  // the request (count > 0). A wrong-state decline therefore 409s WITHOUT ever
  // touching the hold.
  //
  // #1423: decline now covers all six held/editor states
  // (DECLINABLE_BOOKING_REQUEST_STATUSES), including QUOTE_SENT which DOES carry
  // a live SENT quote a requester could still accept. That reintroduces a
  // decline-vs-accept race, closed on BOTH sides:
  //   * accept-wins-first — the requester accept converts the held booking to a
  //     live PENDING booking before this decline runs; `requireRequestHold: true`
  //     (below, #1406) makes `cancelBooking` refuse (409, no side effect) rather
  //     than clobber it, so decline never destroys a paid booking.
  //   * decline-wins-first — this decline claims DECLINED and releases the hold
  //     first; the concurrent accept's status-guarded re-arm
  //     (booking-request-quotes.ts, notIn [DECLINED, CANCELLED]) then refuses to
  //     resurrect the finalised request, so no new booking is ever created.
  // Because the hold-release runs only after the request is claimed DECLINED,
  // `cancelBooking` here can only ever act on a still-held AWAITING_REVIEW
  // booking, never a booking a winning accept already converted. Releasing
  // reuses the shared `cancelBooking` path (mirroring the admin "Release hold"
  // route): it cancels the held booking, reconciles/frees the beds, detaches
  // `heldBookingId`, and audits. It self-locks on advisory key 1 and runs its
  // own transactions, so it stays OUTSIDE any surrounding transaction — called
  // plainly here. SCHOOL requests use this same function, covered with no type
  // branch.
  if (request.heldBookingId) {
    const held = await prisma.booking.findUnique({
      where: { id: request.heldBookingId },
      select: { id: true, status: true },
    });
    if (held && held.status === BookingStatus.AWAITING_REVIEW) {
      // MG4 (#2309): read the population BEFORE the hold is released. These are
      // the members the hold emailed to say the club had put them on a lodge
      // booking; the decline takes that booking away, and until now took it away
      // in silence. Read here rather than after, so the answer describes the
      // hold as it stood rather than whatever the cancel left behind.
      const notifiedMemberGuestIds = await collectNotifiedMemberGuestIds(
        prisma,
        request.heldBookingId
      );
      const result = await cancelBooking(
        request.heldBookingId,
        input.adminMemberId,
        "ADMIN",
        input.ipAddress ?? "",
        "card",
        {
          // Admin declining, not the requester cancelling: suppress the
          // requester's "booking cancelled" email. The detach/reconcile/audit in
          // the shared cancel path still run.
          suppressCustomerNotification: true,
          // #1406/#1423: a QUOTE_SENT request carries a live SENT quote whose
          // AWAITING_REVIEW hold a concurrent requester accept could convert to a
          // live PENDING booking. This opt-in guard makes the shared cancel path
          // refuse (409, no side effect) rather than clobber that PENDING booking
          // if the accept won the race — the accept-wins-first half of the
          // decline-vs-accept race for the broadened declinable set (#1423).
          requireRequestHold: true,
        }
      );
      // Defensive: a 409 here means the held booking is no longer a releasable
      // AWAITING_REVIEW hold. Either a concurrent cancel of the SAME held booking
      // (a double-submitted decline, or a simultaneous admin "Release hold") won
      // cancelBooking's single-flight (#1160/#1311), or — for a QUOTE_SENT
      // request (#1423) — a requester accept already converted the hold to a live
      // PENDING booking and `requireRequestHold` refused to clobber it. Either
      // way this decline must NOT destroy that booking, so forward the 409.
      if (result.status === 409) {
        throw new BookingRequestDeclineCommittedError({
          message: result.error,
          status: 409,
          holdReleasePending: false,
          holdReleaseStatusUnconfirmed: true,
        });
      }
      if (result.status !== 200) {
        logger.error(
          {
            requestId: request.id,
            bookingId: request.heldBookingId,
            error: result.error,
          },
          "Failed to release booking-request hold during decline"
        );
        throw new BookingRequestDeclineCommittedError({
          message: "Could not release the booking request's capacity hold",
          status: result.status,
          holdReleasePending: true,
          holdReleaseStatusUnconfirmed: false,
        });
      }
      // Success: cancelBooking cancelled the held booking, reconciled/freed its
      // beds, and detached `heldBookingId` itself.
      //
      // MG4 (#2309): and the people it had put on that booking are told it has
      // gone. `cancelBooking` runs its own transactions and has committed by
      // here, so this is a post-commit dispatch like every other one, and it is
      // failure-safe: the hold is already released, and a mail problem must not
      // turn a completed decline into an error.
      await notifyMemberGuestsHoldReleased({
        bookingId: request.heldBookingId,
        targetMemberIds: notifiedMemberGuestIds,
        logContext: { bookingRequestId: request.id },
      });
    } else {
      // The held pointer is stale or the booking is no longer a live hold
      // (already CANCELLED, or gone). Nothing to cancel — just detach the
      // pointer so the declined request stops referencing a dead hold.
      await prisma.bookingRequest.updateMany({
        where: { id: request.id, heldBookingId: request.heldBookingId },
        data: { heldBookingId: null, version: { increment: 1 } },
      });
    }
  }

    const updated = await prisma.bookingRequest.findUnique({
      where: { id: input.requestId },
    });
    if (!updated) {
      throw new Error("Declined booking request could not be reloaded");
    }
    return updated;
  } catch (error) {
    if (error instanceof BookingRequestDeclineCommittedError) throw error;
    const holdReleasePending = isHostingCoverageParticipantRetry(error);
    const holdReleaseStatusUnconfirmed =
      !holdReleasePending && request.heldBookingId !== null;
    throw new BookingRequestDeclineCommittedError({
      message: holdReleasePending || holdReleaseStatusUnconfirmed
        ? "The request was declined, but its capacity hold status could not be confirmed. Open the held booking and check its status before retrying."
        : "The request was declined, but the updated request could not be loaded. Reload the request queue before continuing.",
      status:
        error instanceof BookingRequestError
          ? error.status
          : holdReleasePending
            ? 409
            : 500,
      holdReleasePending,
      holdReleaseStatusUnconfirmed,
      cause: error,
    });
  }
}

// ---------------------------------------------------------------------------
// Contact mapping (issue #1255)
// ---------------------------------------------------------------------------

/**
 * Non-login organisation/booking-contact roles a converted booking may be
 * owned by. Login-capable members (real people, ORG accounts) are deliberately
 * excluded so a booking request can never be mapped onto an account that can
 * sign in.
 */
export const MAPPABLE_CONTACT_ROLES = [Role.NON_MEMBER, Role.SCHOOL] as const;

/**
 * Validate an admin-selected existing contact to own a converted booking
 * (issue #1255). Enforces the invariant that a public booking request is NEVER
 * mapped onto a login-capable member: only non-login NON_MEMBER/SCHOOL
 * organisation contacts are eligible. Returns the contact id when valid and
 * throws a BookingRequestError otherwise. Runs inside the approval/hold
 * transaction (holding the booking advisory lock) so `canLogin` cannot race the
 * check.
 */
export async function assertMappableOwnerContact(
  tx: Prisma.TransactionClient,
  ownerContactMemberId: string
): Promise<string> {
  const contact = await tx.member.findUnique({
    where: { id: ownerContactMemberId },
    select: { id: true, canLogin: true, role: true, archivedAt: true, active: true },
  });
  if (!contact) {
    throw new BookingRequestError("The selected contact could not be found", 404);
  }
  // GUARD: never attach a booking request to a member that can sign in.
  if (contact.canLogin) {
    throw new BookingRequestError(
      "That member can sign in, so it can't be used as a booking-request contact. Pick an Organisation/School contact or create a new one.",
      422
    );
  }
  if (
    contact.role !== Role.NON_MEMBER &&
    contact.role !== Role.SCHOOL
  ) {
    throw new BookingRequestError(
      "Only Organisation/School booking contacts can be mapped to a request",
      422
    );
  }
  // Align with the suggestion endpoint's scope: an archived or deactivated
  // contact must not be reused.
  if (contact.archivedAt) {
    throw new BookingRequestError(
      "That contact has been archived and can't be reused",
      422
    );
  }
  if (!contact.active) {
    throw new BookingRequestError(
      "That contact is inactive and can't be reused",
      422
    );
  }
  return contact.id;
}

// ---------------------------------------------------------------------------
// Approval conversion
// ---------------------------------------------------------------------------

type ApproveBookingRequestOutcome =
  | {
      type: "approved";
      requestId: string;
      bookingId: string;
      memberId: string;
      priceCents: number;
      paymentLinkExpiresAt: Date;
    }
  | { type: "capacityExceeded"; fullNights: string[] };

/**
 * Split the officer-set total across the guest rows in integer cents.
 * The remainder goes to the first guest so the rows always sum exactly.
 */
export function splitPriceAcrossGuests(totalCents: number, guestCount: number): number[] {
  if (guestCount <= 0) return [];
  const base = Math.floor(totalCents / guestCount);
  const remainder = totalCents - base * guestCount;
  return Array.from({ length: guestCount }, (_, index) =>
    index === 0 ? base + remainder : base
  );
}

/**
 * Resolve when the booking's non-member hold expires. Member-priority
 * bumping applies until the requester pays. Late approvals still get at
 * least 48 hours to pay, but never beyond check-in.
 */
export function resolveRequestBookingHoldUntil(
  checkIn: Date,
  holdDays: number,
  now: Date = new Date()
): Date {
  const standardHold = new Date(checkIn.getTime() - holdDays * DAY_MS);
  const minimumHold = new Date(now.getTime() + 2 * DAY_MS);
  const hold = standardHold > minimumHold ? standardHold : minimumHold;
  return hold > checkIn ? checkIn : hold;
}

/**
 * Swap a held booking's guest rows to the accepted/approved guest list while
 * PRESERVING each row's identity (issue #1254). The held booking was created by
 * holdBookingRequestSlots with exactly this guest list in this order, so we
 * update the existing rows in place instead of the old delete-then-recreate.
 * Keeping each `bookingGuest.id` stable preserves everything that cascades off
 * it: an admin's pre-assigned BedAllocation rows (a destructive `deleteMany`
 * would silently drop them via onDelete: Cascade), BookingGuestNight sets
 * (#713), promo guest targets, and chore assignments.
 *
 * The guest list is fixed at request submission, so the counts should always
 * match; if they somehow diverge we fall back to delete+recreate so approval
 * still succeeds (that fallback loses pre-assigned beds but stays correct).
 * Returns whether the identity-preserving path was taken (for audit/tests).
 */
/**
 * What `reassignHeldBookingGuests` needs in order to obey MG4-D-b (#2309).
 *
 * DELIBERATELY REQUIRED, not optional. The rest of this feature fails closed by
 * defaulting a missing policy to "refuse" — but there is nothing to refuse here:
 * the swap has already been authorised by an officer, so a missing context could
 * only mean "write the rows with no consent record and tell nobody", which is
 * precisely the silent cross-family placement MG4-D-b exists to close. Making it
 * required means a third pipeline cannot be added without answering the question.
 */
export interface ReassignMemberGuestContext {
  /** The converted booking's owner — the family boundary is computed against them. */
  bookingOwnerMemberId: string;
  /** Always `{ kind: "BOOKING_REQUEST" }` today; typed so it cannot silently become an admin add. */
  actor: MemberGuestAddActor;
  policy: MemberGuestAddPolicy;
  /** The converted booking's check-in, for the D-4 expiry clamp. */
  bookingCheckIn: Date;
  /** Pinned by tests so every row in one swap carries the same timestamp. */
  now?: Date;
}

export interface ReassignHeldBookingGuestsResult {
  /** Whether the identity-preserving path was taken (for audit/tests). */
  preservedInPlace: boolean;
  /**
   * The cross-family member guests this swap ADDED, carried out of the
   * transaction for the caller's post-commit dispatch.
   */
  memberGuestNotificationRows: MemberGuestAddNotificationRow[];
  /**
   * Members who were told they were on this booking and are not on it any more —
   * the other half of the substitution the epic's plan calls "the subtle one".
   * A row can be preserved in place with a changed `memberId`, which swaps one
   * person for another on a live booking; telling only the newcomer would leave
   * the person who was dropped believing they still have a bed.
   */
  displacedMemberIds: string[];
}

export async function reassignHeldBookingGuests(
  tx: Prisma.TransactionClient,
  bookingId: string,
  guestCreates: HeldBookingGuestInput[],
  memberGuest: ReassignMemberGuestContext
): Promise<ReassignHeldBookingGuestsResult> {
  const existing = await tx.bookingGuest.findMany({
    where: { bookingId },
    // MG4 (#2309) widens this select from `{ id }`. The two extra columns are
    // what make a SUBSTITUTION visible: without the old `memberId` this
    // function cannot tell "row 3 keeps Priya" from "row 3 is now Sione", and
    // the person who was quietly dropped is never told.
    select: { id: true, memberId: true, consentStatus: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  // The consent decision for the INCOMING list, taken once for both branches so
  // the delete-and-recreate fallback cannot drift from the in-place path (that
  // divergence is exactly how the fallback lost bed allocations before #1254).
  const consentPlan = await planBookingRequestGuestConsent(tx, {
    bookingOwnerMemberId: memberGuest.bookingOwnerMemberId,
    guests: guestCreates,
    actor: memberGuest.actor,
    policy: memberGuest.policy,
    bookingCheckIn: memberGuest.bookingCheckIn,
    now: memberGuest.now,
  });
  const planned = consentPlan.guests;

  // Who was a member guest on the held booking and is not on the approved list.
  // Derived from the rows as they stand, not from the plan: a row the hold
  // created carries a non-null consentStatus exactly when the target was told
  // they were on this booking, so this is the set that was told something that
  // has since stopped being true. A row whose member is still on the list under
  // a different index has not been displaced and is not in this set.
  const incomingMemberIds = new Set(
    guestCreates
      .map((guest) => guest.memberId)
      .filter((memberId): memberId is string => Boolean(memberId))
  );
  const displacedMemberIds = [
    ...new Set(
      existing
        .filter(
          (row) =>
            row.memberId != null &&
            // Loose null check on purpose: `null` is "no consent record" and so
            // is a column a narrowed caller never selected. Treating an absent
            // value as "they were told" would mail a withdrawal notice to
            // somebody who was never told anything in the first place.
            row.consentStatus != null &&
            !incomingMemberIds.has(row.memberId)
        )
        .map((row) => row.memberId as string)
    ),
  ];

  /**
   * Who has ALREADY been told they are on this booking, so they are not told
   * again.
   *
   * The hold notifies at hold time (MG4-D-b); approval then rewrites the same
   * rows. Without this filter every approval would re-send the added-notice to
   * every member who survived the swap unchanged, and a re-hold-then-approve
   * cycle would do it twice. The columns are still re-stamped either way — only
   * the MAIL is suppressed, and only for a member who is on the booking both
   * before and after with a consent record already against their name.
   */
  const alreadyNotifiedMemberIds = new Set(
    existing
      .filter((row) => row.memberId != null && row.consentStatus != null)
      .map((row) => row.memberId as string)
  );
  const owedNotifications = (
    rows: MemberGuestAddNotificationRow[]
  ): MemberGuestAddNotificationRow[] =>
    rows.filter((row) => !alreadyNotifiedMemberIds.has(row.targetMemberId));

  if (existing.length !== guestCreates.length) {
    await tx.bookingGuest.deleteMany({ where: { bookingId } });
    // One `create` per guest rather than one `createMany` (#2739), then ONE
    // `createMany` for the whole party's night rows.
    //
    // The guests cannot stay a `createMany`: their night rows need their ids,
    // and reading the rows back to match them to their inputs would rest on an
    // order `createMany` does not promise — every row shares one statement
    // timestamp, so the tie-break is a cuid, and the wrong guest's nights is a
    // bed on the wrong night. Creating them one at a time hands the ids back, so
    // the read-back this replaced is gone as well.
    //
    // The NIGHTS are batched rather than nested per guest so the statement count
    // stays O(guests) instead of O(guests x nights): this runs inside the
    // approval transaction, on Prisma's default 5s interactive-transaction
    // timeout, and a school party is bounded only by lodge capacity — forty
    // guests over five nights is two hundred round trips nested, forty-one
    // batched.
    const created: Array<{ id: string; memberId: string | null }> = [];
    const nightRows: Array<{
      bookingGuestId: string;
      stayDate: Date;
      priceCents: number;
    }> = [];
    for (const guest of planned) {
      const row = await tx.bookingGuest.create({
        data: {
          bookingId,
          firstName: guest.firstName,
          lastName: guest.lastName,
          ageTier: guest.ageTier,
          isMember: guest.isMember,
          memberId: guest.memberId ?? null,
          stayStart: guest.stayStart,
          stayEnd: guest.stayEnd,
          priceCents: guest.priceCents,
          rateMembershipTypeId: guest.rateMembershipTypeId ?? null,
          ...(guest.memberGuestConsent ?? {}),
        },
        select: { id: true, memberId: true },
      });
      created.push(row);
      for (const night of guest.nights) {
        nightRows.push({
          bookingGuestId: row.id,
          stayDate: night.stayDate,
          priceCents: night.priceCents,
        });
      }
    }
    if (nightRows.length > 0) {
      await tx.bookingGuestNight.createMany({ data: nightRows });
    }
    return {
      preservedInPlace: false,
      memberGuestNotificationRows: owedNotifications(
        matchMemberGuestNotificationRows({
          createdGuests: created,
          entriesByMemberId: consentPlan.entriesByMemberId,
        })
      ),
      displacedMemberIds,
    };
  }

  for (let index = 0; index < planned.length; index += 1) {
    const guest = planned[index];
    const previous = existing[index];
    /**
     * Is this row still the SAME person it was before the swap?
     *
     * The whole consent decision below turns on this, and getting it wrong is
     * not symmetrical: leaving a stale record on a substituted row claims
     * consent for somebody who was never asked, while clearing one on an
     * unchanged row erases a record of somebody who WAS told.
     */
    const sameOccupant = (guest.memberId ?? null) === previous.memberId;
    await tx.bookingGuest.update({
      where: { id: previous.id },
      data: {
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageTier: guest.ageTier,
        isMember: guest.isMember,
        memberId: guest.memberId ?? null,
        stayStart: guest.stayStart,
        stayEnd: guest.stayEnd,
        priceCents: guest.priceCents,
        // Rate-membership-type snapshot (#1930, E4): the approval-time guest
        // list (with its admin member links) is authoritative for the swapped
        // rows, so overwrite the hold-time snapshot with the other identity
        // fields. Prices stay the admin-set split.
        rateMembershipTypeId: guest.rateMembershipTypeId ?? null,
        /**
         * MG4 (#2309), and the one case in this function that is NOT "write
         * whatever the planner said".
         *
         * A planned write always wins — the planner has decided this person's
         * consent afresh, and its answer is the current one.
         *
         * When the planner ABSTAINS (`undefined`), what that means depends
         * entirely on whether the person changed:
         *
         *  - SUBSTITUTED. The row is being handed to somebody else, and any
         *    consent record on it belongs to the person leaving. Left in place
         *    it would claim consent for somebody who was never asked and never
         *    told, which is exactly what `classifyMemberGuestConsent` calls a
         *    broken row. Cleared.
         *  - UNCHANGED. The columns describe THIS person and are still true, so
         *    they are left alone — not rewritten, not cleared. The clear was
         *    unconditional here, and the module being switched off between the
         *    hold and the approval was enough to reach it: the planner returns
         *    the guests untouched with the module off, so an approval would
         *    silently erase the CONFIRMED record of a member who had already
         *    been emailed to say they were on the booking. Turning a feature off
         *    must stop it doing new things, not rewrite what it already did.
         */
        ...(guest.memberGuestConsent ??
          (sameOccupant ? {} : CONSENT_FREE_GUEST_COLUMNS)),
      },
    });
  }

  /**
   * Re-sync the canonical night set to the approved envelope and the approved
   * price (#2739), the same delete-then-recreate every other night-set rewriter
   * uses (`booking-modify-plan.ts`, `booking-date-modification-service.ts`) —
   * once for the whole party rather than nested inside each `update`, so the
   * statement count stays O(guests) inside the approval transaction and its 5s
   * default timeout.
   *
   * REPLACED RATHER THAN LEFT ALONE, because both halves can have moved. The
   * rows are being handed the approval's dates and the approval's price — an
   * officer may have accepted a different quote option than the one the hold was
   * taken at — so night rows left over from the hold would describe a stay and a
   * total that no longer exist.
   *
   * This does NOT touch the beds #1254 preserves: `BedAllocation` keys on
   * `bookingGuestId` and `stayDate`, not on a night row's id, so deleting and
   * rewriting nights cascades to nothing. Guest ids still survive the swap,
   * which is the property that preservation actually rests on.
   */
  if (existing.length > 0) {
    await tx.bookingGuestNight.deleteMany({
      where: { bookingGuestId: { in: existing.map((row) => row.id) } },
    });
    const replacementNights = planned.flatMap((guest, index) =>
      guest.nights.map((night) => ({
        bookingGuestId: existing[index].id,
        stayDate: night.stayDate,
        priceCents: night.priceCents,
      }))
    );
    if (replacementNights.length > 0) {
      await tx.bookingGuestNight.createMany({ data: replacementNights });
    }
  }

  return {
    preservedInPlace: true,
    memberGuestNotificationRows: owedNotifications(
      matchMemberGuestNotificationRows({
        createdGuests: planned.map((guest, index) => ({
          id: existing[index].id,
          memberId: guest.memberId ?? null,
        })),
        entriesByMemberId: consentPlan.entriesByMemberId,
      })
    ),
    displacedMemberIds,
  };
}

/**
 * Approve a PRICED request: in a single transaction under the booking
 * advisory lock, create the non-login Member, the PENDING Booking with
 * capacity checking, the PENDING Payment, and the tokenised PaymentLink.
 * The payment link email is sent after commit.
 */
export async function approveBookingRequest(input: {
  requestId: string;
  adminMemberId: string;
  /**
   * Optional existing non-login contact to own the converted booking (issue
   * #1255). When set, the booking is attached to this contact instead of
   * creating a new NON_MEMBER member — reusing its Xero contact downstream. Only
   * honoured when the owner has not already been materialised by a capacity hold
   * (a held booking's owner was fixed at hold time; release + re-hold to change
   * it). Ignored on the held-booking reuse path.
   */
  ownerContactMemberId?: string | null;
}): Promise<ApproveBookingRequestOutcome> {
  const foundRequest = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!foundRequest) {
    throw new BookingRequestError("Booking request not found", 404);
  }
  let request: BookingRequest = foundRequest;
  if (request.status !== BookingRequestStatus.PRICED) {
    throw new BookingRequestError(
      "Only priced booking requests can be approved",
      409
    );
  }
  if (request.priceCents == null) {
    throw new BookingRequestError(
      "A price must be set before the request can be approved",
      409
    );
  }

  // A held booking has already materialised the request's null/default lodge
  // semantics into an immutable concrete Booking.lodgeId. Read only that lock
  // key before the transaction; the full request and booking are re-read after
  // global -> lodge locks below. Fresh conversions need no extra lookup.
  const expectedHeldBookingId = request.heldBookingId ?? null;
  const heldLodgeLocator = expectedHeldBookingId
    ? await prisma.booking.findUnique({
        where: { id: expectedHeldBookingId },
        select: { lodgeId: true },
      })
    : null;
  if (expectedHeldBookingId && !heldLodgeLocator) {
    throw new BookingRequestError("Held booking was not found", 409);
  }
  const expectedHeldLodgeId = heldLodgeLocator?.lodgeId ?? null;
  const approvalLodgeId = expectedHeldLodgeId ?? request.lodgeId ?? null;

  const guests = parseBookingRequestGuests(request.guests);
  const linkedMembers = linkedGuestMemberMap(request.linkedGuestMembers);
  const priceCents = request.priceCents;

  // Non-login members never authenticate; store a random bcrypt hash so the
  // row satisfies the schema without any usable credential.
  const placeholderPasswordHash = await hash(randomBytes(32).toString("hex"), 13);
  const holdDays = await getNonMemberHoldDays(request.checkIn, approvalLodgeId);
  const reviewedAt = new Date();
  const nonMemberHoldUntil = resolveRequestBookingHoldUntil(
    request.checkIn,
    holdDays,
    reviewedAt
  );
  // The payment link stays valid while the booking remains payable; the hard
  // ceiling is the end of the check-in day in NZT (not midnight UTC, which
  // would cut the day short in New Zealand — issue #740). Booking status checks
  // gate actual payment.
  const paymentLinkExpiresAt = endOfDateOnlyForTimeZone(
    formatDateOnly(request.checkIn)
  );
  const { token: paymentToken, tokenHash: paymentTokenHash } = issueActionToken();

  // MG4-D-b (#2309). Read BEFORE the transaction, per the ordering rule in
  // `member-guest-add-policy.ts` — this transaction holds both the global and
  // the per-lodge advisory lock, and a settings query under them buys nothing.
  const memberGuestPolicy = await loadMemberGuestAddPolicy();
  const memberGuestActor: MemberGuestAddActor = {
    kind: "BOOKING_REQUEST",
    adminMemberId: input.adminMemberId,
  };

  let capacityFullNights: string[] | null = null;
  let conversion: {
    bookingId: string;
    lodgeId: string;
    memberId: string;
    ownerSubstitution:
      | { invalidMemberId: string; substituteMemberId: string; reason: string }
      | null;
    alreadyConverted: boolean;
    memberGuestNotificationRows: MemberGuestAddNotificationRow[];
    displacedMemberGuestIds: string[];
  };

  try {
    conversion = await prisma.$transaction(async (tx) => {
      // Two-tier lock protocol (#1881). Converting the held AWAITING_REVIEW
      // booking to PENDING is BOTH a booking-status transition that must
      // mutually exclude the hold-release / cancel paths (which serialise on
      // the global lock(1) — booking-cancel.ts, cron-quote-expiry-reminders.ts)
      // AND a capacity-relevant claim for the request's lodge. Before #1881 the
      // accept took ONLY the per-lodge lock, so it did NOT mutually exclude
      // those releasers (they hold a different key): a release could cancel the
      // held booking out from under a converting accept. Take BOTH locks now,
      // global lock(1) FIRST (consistent global-before-per-lodge order → no
      // deadlock), then the per-lodge capacity lock.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const requestLodgeId = expectedHeldBookingId
        ? expectedHeldLodgeId!
        : request.lodgeId ?? (await getDefaultLodgeId(tx));
      await acquireLodgeCapacityLock(tx, requestLodgeId);

      const lockedRequest = await tx.bookingRequest.findUnique({
        where: { id: request.id },
      });
      if (!lockedRequest) {
        throw new BookingRequestError("Booking request not found", 404);
      }

      // Idempotency (#1232 double-charge guard): a prior approve for this
      // request — a concurrent double-accept, or a retry whose caller re-armed
      // the request to PRICED after it had already converted (line ~729 of
      // booking-request-quotes.ts overwrites CONVERTED->PRICED but never clears
      // convertedBookingId) — already created the booking. Under the advisory
      // lock we now observe its committed convertedBookingId, so return that
      // booking instead of creating a second one.
      const alreadyConverted = await claimAlreadyConvertedBookingRequest(
        tx,
        request.id
      );
      if (alreadyConverted) {
        return {
          bookingId: alreadyConverted.convertedBookingId,
          lodgeId: requestLodgeId,
          memberId: alreadyConverted.convertedMemberId,
          ownerSubstitution: null,
          alreadyConverted: true as const,
          // A replay wrote no rows, so it owes no mail. Re-sending here would
          // tell every member guest a second time that they were just added.
          memberGuestNotificationRows: [] as MemberGuestAddNotificationRow[],
          displacedMemberGuestIds: [] as string[],
        };
      }

      // Any edit to the approval snapshot (including attaching/detaching a
      // hold) increments version (#1923). Refuse this stale attempt so every
      // value used below was validated under the locks; the caller can retry
      // from the new request state. The explicit held-id comparison also
      // documents the global-lock decision instead of relying on the counter
      // alone. Version replaces the former updatedAt comparison, whose
      // TIMESTAMP(3) precision could collide for two same-millisecond writes.
      if (
        lockedRequest.version !== request.version ||
        (lockedRequest.heldBookingId ?? null) !== expectedHeldBookingId
      ) {
        throw new BookingRequestError(
          "This booking request changed while it was being approved; review it and try again",
          409
        );
      }
      request = lockedRequest;

      if (request.status !== BookingRequestStatus.PRICED || request.priceCents == null) {
        throw new BookingRequestError(
          "This booking request has already been processed",
          409
        );
      }

      // Re-read the complete held booking only after global -> concrete-lodge
      // locks. Its lodge identity must match the immutable locator used for the
      // lock; an explicit request lodge must also name that same lodge.
      let held: {
        id: string;
        lodgeId: string;
        memberId: string;
        status: BookingStatus;
      } | null = null;
      if (request.heldBookingId) {
        held = await tx.booking.findUnique({
          where: { id: request.heldBookingId },
          select: { id: true, lodgeId: true, memberId: true, status: true },
        });
        if (!held || held.status !== BookingStatus.AWAITING_REVIEW) {
          throw new BookingRequestError("Held booking is no longer available", 409);
        }
        if (
          held.lodgeId !== requestLodgeId ||
          (request.lodgeId != null && request.lodgeId !== held.lodgeId)
        ) {
          throw new BookingRequestError(
            "Held booking lodge no longer matches this booking request",
            409
          );
        }
      }

      // Status-claim so two admins cannot approve concurrently.
      const claimed = await tx.bookingRequest.updateMany({
        where: {
          id: request.id,
          // Optimistic version fence for mutable price/guest/hold state (#1923):
          // a writer that lands after the locked re-read cannot be silently
          // overwritten by an approval built from the older snapshot. Fences on
          // the integer version, not updatedAt (millisecond-collidable).
          version: request.version,
          status: BookingRequestStatus.PRICED,
        },
        data: {
          status: BookingRequestStatus.APPROVED,
          reviewedByMemberId: input.adminMemberId,
          reviewedAt,
          version: { increment: 1 },
        },
      });
      if (claimed.count === 0) {
        throw new BookingRequestError(
          "This booking request has already been processed",
          409
        );
      }

      const guestPriceCents = splitPriceAcrossGuests(priceCents, guests.length);
      const guestCreates = await buildApprovalGuestCreates(tx, {
        guests,
        linkedMembers,
        guestPriceCents,
        checkIn: request.checkIn,
        checkOut: request.checkOut,
        adminMemberId: input.adminMemberId,
        heldBookingId: request.heldBookingId ?? null,
      });

      let booking: { id: string };
      let member: { id: string };
      // MG4-D-b (#2309): collected in whichever branch runs, dispatched after
      // the commit.
      let memberGuestNotificationRows: MemberGuestAddNotificationRow[] = [];
      let displacedMemberGuestIds: string[] = [];
      // Set when the held owner failed re-validation at conversion and a fresh
      // contact was substituted (issue #1255 residual-risk decision 1); drives a
      // post-commit admin alert.
      let ownerSubstitution: OwnerSubstitution | null = null;

      if (held) {
        // Re-validate the held owner at conversion (issue #1255 residual-risk
        // decision 1). The owner was materialised earlier (at hold/quote-send).
        // If it had been MAPPED to a pre-existing contact, that contact could
        // have changed state during the quote→accept window (login enabled,
        // archived, deactivated, role changed). If it is no longer a valid
        // non-login booking contact, DO NOT fail the requester's accept: fall
        // back to a fresh non-login contact (the pre-#1255 default owner) and
        // flag an admin. Auto-created owners always pass this guard, so it is a
        // no-op except for a changed-state mapped contact.
        let ownerId = held.memberId;
        try {
          await assertMappableOwnerContact(tx, held.memberId);
        } catch (err) {
          // Only recover from validation failures; a real DB/other error must
          // still abort so we never silently substitute on a transient fault.
          if (!(err instanceof BookingRequestError)) throw err;
          const substitute = await tx.member.create({
            data: {
              email: request.contactEmail,
              passwordHash: placeholderPasswordHash,
              emailVerified: true,
              firstName: request.contactFirstName,
              lastName: request.contactLastName,
              role: "NON_MEMBER",
              ageTier: AgeTier.ADULT,
              active: true,
              canLogin: false,
              phoneNumber: request.contactPhone,
            },
            select: { id: true },
          });
          ownerId = substitute.id;
          ownerSubstitution = {
            invalidMemberId: held.memberId,
            substituteMemberId: substitute.id,
            reason: err.message,
          };
        }

        // Preserve the held booking's beds across the guest swap (issue #1254):
        // update guest rows in place rather than deleteMany+recreate. The date
        // range is unchanged (fixed at request submission), so existing bed
        // allocations remain valid — no reconcile needed.
        const reassigned = await reassignHeldBookingGuests(
          tx,
          held.id,
          guestCreates,
          {
            bookingOwnerMemberId: ownerId,
            actor: memberGuestActor,
            policy: memberGuestPolicy,
            bookingCheckIn: request.checkIn,
          }
        );
        memberGuestNotificationRows = reassigned.memberGuestNotificationRows;
        displacedMemberGuestIds = reassigned.displacedMemberIds;
        // Status-guarded claim (#1881, defense in depth alongside lock(1)):
        // flip the held booking ONLY while it is still AWAITING_REVIEW. Under
        // lock(1) the re-read above already established that and no releaser can
        // interleave, but the guard means a hold-release that somehow slipped
        // the lock can never be clobbered back to PENDING (which would resurrect
        // a cancelled hold as a live booking).
        const converted = await tx.booking.updateMany({
          where: { id: held.id, status: BookingStatus.AWAITING_REVIEW },
          data: {
            checkIn: request.checkIn,
            checkOut: request.checkOut,
            // Stays capacity-holding across the accept: AWAITING_REVIEW (holding
            // status) → PENDING, which now holds because it becomes the request's
            // convertedBooking (capacityHoldingBookingFilter, #1254 refining
            // #737). The bed is reserved until payment, expiry, or cancel.
            status: BookingStatus.PENDING,
            totalPriceCents: priceCents,
            finalPriceCents: priceCents,
            hasNonMembers: true,
            nonMemberHoldUntil,
            notes: request.message,
            createdById: input.adminMemberId,
            // Point the held booking at the (possibly substituted) owner. On the
            // no-substitution path this rewrites the same id (a no-op); bed
            // allocations live on guest rows and are unaffected by ownership.
            memberId: ownerId,
          },
        });
        if (converted.count === 0) {
          throw new BookingRequestError("Held booking is no longer available", 409);
        }
        booking = { id: held.id };
        member = { id: ownerId };
      } else {
        const capacityRanges = guests.map(() => ({
          stayStart: request.checkIn,
          stayEnd: request.checkOut,
        }));
        const capacity = await checkCapacityForGuestRanges(
          requestLodgeId,
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

        if (input.ownerContactMemberId) {
          // Admin mapped this request to an existing non-login Organisation/
          // School contact (issue #1255): attach the booking to it instead of
          // minting a duplicate member (and, downstream, a duplicate Xero
          // contact). The guard rejects any login-capable target.
          const mappedId = await assertMappableOwnerContact(
            tx,
            input.ownerContactMemberId
          );
          member = { id: mappedId };
        } else {
          // Mirror approveMemberApplication(): a non-login member owns the
          // booking. emailVerified is true because the address was verified in
          // the request flow before it entered the queue.
          member = await tx.member.create({
            data: {
              email: request.contactEmail,
              passwordHash: placeholderPasswordHash,
              emailVerified: true,
              firstName: request.contactFirstName,
              lastName: request.contactLastName,
              role: "NON_MEMBER",
              ageTier: AgeTier.ADULT,
              active: true,
              canLogin: false,
              phoneNumber: request.contactPhone,
            },
            select: { id: true },
          });
        }

        // MG4-D-b (#2309): the THIRD pipeline guest-write point — an approval
        // with no capacity hold behind it, which creates the booking and its
        // guest rows in one go. It is the same rule as the other two, and it was
        // missing from the issue body's list of write points.
        const consentPlan = await planBookingRequestGuestConsent(tx, {
          bookingOwnerMemberId: member.id,
          guests: guestCreates,
          actor: memberGuestActor,
          policy: memberGuestPolicy,
          bookingCheckIn: request.checkIn,
        });

        const createdBooking = await tx.booking.create({
          data: {
            memberId: member.id,
            lodgeId: requestLodgeId,
            checkIn: request.checkIn,
            checkOut: request.checkOut,
            status: BookingStatus.PENDING,
            totalPriceCents: priceCents,
            finalPriceCents: priceCents,
            hasNonMembers: true,
            nonMemberHoldUntil,
            notes: request.message,
            createdById: input.adminMemberId,
            guests: {
              create: consentPlan.guests.map(toPipelineGuestCreateData),
            },
          },
          select: { id: true, guests: { select: { id: true, memberId: true } } },
        });
        booking = { id: createdBooking.id };
        // Short-circuited on the plan, not on the rows: an ordinary booking
        // request owes nothing, and skipping the walk keeps the common path
        // free of it (the same shape `admin-booking-copy.ts` uses).
        memberGuestNotificationRows =
          consentPlan.entriesByMemberId.size === 0
            ? []
            : matchMemberGuestNotificationRows({
                createdGuests: createdBooking.guests,
                entriesByMemberId: consentPlan.entriesByMemberId,
              });
      }

      // #2364. An approved request is the purest form of the party the hosting
      // rule exists for: every guest is a non-member and the owner is a
      // non-login contact, so nobody on the booking can host. Recorded here, in
      // the approving transaction, and covering BOTH branches above — the fresh
      // create and the held-booking conversion, whose guest list was just
      // rewritten wholesale. Without it the hazard would sit unrecorded until
      // some unrelated later edit (an admin date shift, say) materialised it out
      // of nowhere, months after the decision it belongs to.
      //
      // The review opens PENDING, never APPROVED: the admin approved the
      // REQUEST, which is not the same act as accepting a hosting exception with
      // a reason attached (D-R4). Under the REVIEW consequence the approval is not
      // blocked — the requester gets their booking and the club gets the review.
      //
      // #2569: under the ENFORCED consequence it IS blocked, and deliberately so.
      // A public request is an all-non-member party owned by a non-login contact,
      // which is precisely the booking a lodge set to "stop uncovered bookings"
      // has said it will not take. The throw rolls this approval back and the
      // route answers the officer with the rule that stopped it; their remedies
      // are to put a qualifying adult member in the party, move the request to
      // another lodge, or change the lodge's setting. School and organisation
      // requests are exempt (§13) and pass `enforcement: "REVIEW_ONLY"` in
      // `school-booking-request.ts`; this general path is not one of them.
      await reconcileAdultMemberHostingReviewWithSiblings(booking.id, tx);

      await tx.payment.create({
        data: {
          bookingId: booking.id,
          amountCents: priceCents,
          status: PaymentStatus.PENDING,
        },
      });

      await tx.paymentLink.create({
        data: {
          bookingId: booking.id,
          bookingRequestId: request.id,
          tokenHash: paymentTokenHash,
          expiresAt: paymentLinkExpiresAt,
        },
      });

      await tx.bookingRequest.update({
        where: { id: request.id },
        data: {
          status: BookingRequestStatus.CONVERTED,
          convertedBookingId: booking.id,
          convertedMemberId: member.id,
          version: { increment: 1 },
        },
      });

      return {
        bookingId: booking.id,
        lodgeId: requestLodgeId,
        memberId: member.id,
        ownerSubstitution,
        alreadyConverted: false as const,
        memberGuestNotificationRows,
        displacedMemberGuestIds,
      };
    });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "CAPACITY_EXCEEDED_SENTINEL" &&
      capacityFullNights
    ) {
      return { type: "capacityExceeded", fullNights: capacityFullNights };
    }
    throw err;
  }


  // #2576 §7. Every path that can ENQUEUE bounded re-evaluation work must also
  // drain it: a queue row with nobody draining it turns the owner's "immediate
  // re-evaluation" into "within three hours", which is how long an officer-created
  // booking that has just RESTORED cover would leave a critical incident standing,
  // or one that removed it would leave the owner un-notified. Best-effort and
  // scoped to this booking's owner; the cron sweep is the authority on completion.
  if (!conversion.alreadyConverted) {
    await settleHostingCoverageAfterCommit({ bookingId: conversion.bookingId });
  }

  // On the idempotent replay path the tx body was skipped, so no new booking,
  // payment or paymentLink exists: the freshly generated paymentToken was NEVER
  // persisted as a PaymentLink. Guard every side effect on !alreadyConverted so
  // we never re-record the CREATED event, never re-log a conversion, and — most
  // importantly — never email the member a broken (unpersisted) payment link.
  // The working payment email already went out with the first accept.
  if (!conversion.alreadyConverted) {
  // MG4-D-b (#2309), AFTER the commit and outside both advisory locks. Two
  // directions, because an approval can do both at once: a swap adds one member
  // guest and drops another, and telling only the newcomer would leave the
  // person who was dropped believing they still have a bed.
  if (
    conversion.memberGuestNotificationRows.length > 0 ||
    conversion.displacedMemberGuestIds.length > 0
  ) {
    const {
      sendMemberGuestAddNotifications,
      sendMemberGuestWithdrawnNotifications,
    } = await import("@/lib/member-guest-consent-notifications");
    try {
      if (conversion.memberGuestNotificationRows.length > 0) {
        await sendMemberGuestAddNotifications({
          bookingId: conversion.bookingId,
          rows: conversion.memberGuestNotificationRows,
          actor: memberGuestActor,
        });
      }
      if (conversion.displacedMemberGuestIds.length > 0) {
        await sendMemberGuestWithdrawnNotifications({
          bookingId: conversion.bookingId,
          targetMemberIds: conversion.displacedMemberGuestIds,
          context: "BOOKING_REQUEST_REPLACED",
        });
      }
    } catch (err) {
      logger.error(
        { err, bookingId: conversion.bookingId, bookingRequestId: request.id },
        "Failed to dispatch member-guest notifications after a booking-request approval",
      );
    }
  }

    await recordBookingEvent({
      bookingId: conversion.bookingId,
      type: BookingEventType.CREATED,
      actorMemberId: input.adminMemberId,
      amountCents: priceCents,
    });

    try {
      await sendBookingRequestApprovedEmail({
        bookingContext: {
          bookingId: conversion.bookingId,
          recipientMemberId: conversion.memberId,
        },
        email: request.contactEmail,
        firstName: request.contactFirstName,
        token: paymentToken,
        checkIn: request.checkIn,
        checkOut: request.checkOut,
        guestCount: guests.length,
        lodgeId: conversion.lodgeId,
        priceCents,
        bookingReference: conversion.bookingId,
        expiresAt: paymentLinkExpiresAt,
      });
    } catch (err) {
      logger.error(
        { err, bookingRequestId: request.id, bookingId: conversion.bookingId },
        "Failed to send booking request approved email"
      );
    }

    logAudit({
      action: "booking_request.approved",
      memberId: input.adminMemberId,
      actorMemberId: input.adminMemberId,
      subjectMemberId: conversion.memberId,
      targetId: request.id,
      entityType: "BookingRequest",
      entityId: request.id,
      category: "booking",
      outcome: "success",
      summary: "Booking request approved and converted to booking",
      metadata: {
        bookingId: conversion.bookingId,
        memberId: conversion.memberId,
        priceCents,
        guestCount: guests.length,
        checkIn: request.checkIn.toISOString(),
        checkOut: request.checkOut.toISOString(),
        nonMemberHoldUntil: nonMemberHoldUntil.toISOString(),
        paymentLinkExpiresAt: paymentLinkExpiresAt.toISOString(),
      },
    });

    // The held owner failed re-validation and a fresh contact was substituted
    // (issue #1255 residual-risk decision 1). Surface it for admin follow-up:
    // the booking (and any Xero invoice) now bill the fresh contact rather than
    // the intended mapped organisation, so an admin must reconcile the Xero
    // contact. Two attention channels run post-commit (outside the tx/advisory
    // lock): a durable audit row (queryable in the admin audit log) AND an active
    // admin email alert (F20 residual #2 / #1377) routed to the Xero-sync-error
    // audience so finance/Xero admins are told to repoint the invoice's contact.
    if (conversion.ownerSubstitution) {
      const ownerSubstitution = conversion.ownerSubstitution;
      logger.warn(
        {
          bookingRequestId: request.id,
          bookingId: conversion.bookingId,
          invalidMemberId: ownerSubstitution.invalidMemberId,
          substituteMemberId: ownerSubstitution.substituteMemberId,
          reason: ownerSubstitution.reason,
        },
        "Held booking owner was invalid at conversion; substituted a fresh non-login contact"
      );
      logAudit({
        action: "booking_request.owner_substituted",
        memberId: input.adminMemberId,
        actorMemberId: input.adminMemberId,
        subjectMemberId: conversion.memberId,
        targetId: request.id,
        entityType: "BookingRequest",
        entityId: request.id,
        category: "booking",
        outcome: "success",
        summary:
          "Held booking-request owner was no longer a valid non-login contact at conversion; a fresh contact was substituted so the accept could proceed",
        metadata: {
          bookingId: conversion.bookingId,
          requestId: request.id,
          invalidMemberId: ownerSubstitution.invalidMemberId,
          substituteMemberId: ownerSubstitution.substituteMemberId,
          reason: ownerSubstitution.reason,
        },
      });

      // Fire-and-forget admin email alert. A failed alert must NOT fail the
      // conversion (the booking is already committed), so it mirrors the
      // approved-email try/catch above. Names are a best-effort readability
      // lookup outside the tx; ids are the source of truth if a name is missing.
      await sendOwnerSubstitutionAdminAlert({
        request,
        bookingId: conversion.bookingId,
        ownerSubstitution,
        failureLogMessage: "Failed to send owner-substitution admin alert",
      });
    }
  } else {
    // Observability-only note that a duplicate accept was absorbed (#1232).
    logAudit({
      action: "booking_request.approve_idempotent_replay",
      memberId: input.adminMemberId,
      actorMemberId: input.adminMemberId,
      targetId: request.id,
      entityType: "BookingRequest",
      entityId: request.id,
      category: "booking",
      outcome: "success",
      summary: "Booking request approve replayed idempotently; no second conversion",
      metadata: { bookingId: conversion.bookingId, requestId: request.id },
    });
  }

  return {
    type: "approved",
    requestId: request.id,
    bookingId: conversion.bookingId,
    memberId: conversion.memberId,
    priceCents,
    paymentLinkExpiresAt,
  };
}

// ---------------------------------------------------------------------------
// Privacy Act retention purge
// ---------------------------------------------------------------------------

/**
 * Permanently delete declined, member-withdrawn and never-verified requests once
 * the retention window has passed (Privacy Act 2020 — personal information may
 * only be kept while there is a lawful purpose).
 *
 * Member-origin whole-lodge requests (#2263) follow the SAME 90-day clock as
 * everything else here (owner decision OD-B): a declined one is already covered
 * by the declined sweep, and a member-withdrawn one — status `CANCELLED`, which
 * nothing purged before — is swept alongside it. "My requests" therefore shows a
 * bounded history rather than a permanent one, and its UI copy says so.
 *
 * The CANCELLED sweep is scoped to `requestedByMemberId != null` on purpose: a
 * public/school request also reaches CANCELLED (a requester cancelling their own
 * quote), and OD-B decided retention for the member-origin rows only. Widening it
 * would silently change an unrelated flow's retention.
 */
export async function purgeExpiredBookingRequests(
  now: Date = new Date(),
  db: Pick<typeof prisma, "bookingRequest"> = prisma
) {
  const cutoff = new Date(now.getTime() - BOOKING_REQUEST_RETENTION_DAYS * DAY_MS);

  const [declined, neverVerified, memberWithdrawn] = await Promise.all([
    db.bookingRequest.deleteMany({
      where: {
        status: BookingRequestStatus.DECLINED,
        updatedAt: { lte: cutoff },
      },
    }),
    db.bookingRequest.deleteMany({
      where: {
        status: BookingRequestStatus.NEW,
        verifiedAt: null,
        createdAt: { lte: cutoff },
      },
    }),
    db.bookingRequest.deleteMany({
      where: {
        status: BookingRequestStatus.CANCELLED,
        requestedByMemberId: { not: null },
        updatedAt: { lte: cutoff },
      },
    }),
  ]);

  if (declined.count > 0 || neverVerified.count > 0 || memberWithdrawn.count > 0) {
    logAudit({
      action: "booking_request.retention_purge",
      category: "privacy",
      outcome: "success",
      summary: "Expired booking requests purged per retention policy",
      metadata: {
        declinedPurged: declined.count,
        neverVerifiedPurged: neverVerified.count,
        memberWithdrawnPurged: memberWithdrawn.count,
        retentionDays: BOOKING_REQUEST_RETENTION_DAYS,
      },
    });
  }

  return {
    declinedPurged: declined.count,
    neverVerifiedPurged: neverVerified.count,
    memberWithdrawnPurged: memberWithdrawn.count,
  };
}

// ---------------------------------------------------------------------------
// Admin queue serialisation
// ---------------------------------------------------------------------------

type AdminBookingRequestStatusFilter =
  | BookingRequestStatus
  | "QUEUE"
  | "ALL";

export function buildBookingRequestListWhere(
  filter: AdminBookingRequestStatusFilter
): Prisma.BookingRequestWhereInput | undefined {
  if (filter === "ALL") return undefined;
  if (filter === "QUEUE") {
    return {
      status: {
        in: [
          BookingRequestStatus.VERIFIED,
          BookingRequestStatus.PRICED,
          BookingRequestStatus.QUOTED,
          BookingRequestStatus.QUOTE_SENT,
          BookingRequestStatus.QUERY_PENDING,
          BookingRequestStatus.MODIFICATION_REQUESTED,
        ],
      },
    };
  }
  return { status: filter };
}

function parseAdminTeachers(raw: unknown) {
  const schema = z.array(
    z.object({
      firstName: z.string(),
      lastName: z.string(),
      email: z.string().nullable().optional(),
    })
  );
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export function serializeBookingRequestForAdmin(
  request: BookingRequest & {
    lodge?: { name: string } | null;
    otherLodge?: { name: string } | null;
  }
) {
  // #2342: an admin READ never dies on one malformed historical row. This is
  // the single serialiser behind BOTH the queue list
  // (GET /api/admin/booking-requests, including status=ALL) and the
  // per-request payloads the price and decline routes return, so making it
  // tolerant covers the list and the detail together. (Pricing a flagged row
  // is refused before it gets here; decline is the path that reaches this
  // serialiser with a flagged row, and it is the intended one.)
  //
  // The two stored blobs are flagged SEPARATELY (#2342 review finding D). One
  // OR'd flag forced the panel to describe both failures whichever had
  // happened, so a row whose links were fine was told its links were hidden,
  // and a row whose names were fine was told to distrust them. Each flag means
  // exactly one thing: that blob failed its schema.
  const guestDisplay = readBookingRequestGuestsForDisplay(request.guests);
  const linkedDisplay = readLinkedGuestMembersForDisplay(request.linkedGuestMembers);
  return {
    id: request.id,
    type: request.type,
    status: request.status,
    // Null lodgeId means the club's default lodge (pre-multi-lodge rows and
    // single-lodge submissions); lodgeName is only present when the caller
    // included the lodge relation.
    lodgeId: request.lodgeId,
    lodgeName: request.lodge?.name ?? null,
    // Other/partner lodge the requester said they belong to (#2749). Null
    // otherLodgeId means "No"; otherLodgeName is present only when the caller
    // included the otherLodge relation.
    otherLodgeId: request.otherLodgeId,
    otherLodgeName: request.otherLodge?.name ?? null,
    // Whole-lodge exclusivity (ADR-001). Emitted so the admin queue can badge
    // it — for SCHOOL rows too, closing a display gap that predates #2263 — and
    // so the member-origin approval branch can be selected at all.
    exclusivityRequested: request.exclusivityRequested,
    // Member attribution (#2263). Null for every public/school request. ADMIN
    // payload only: no member-facing serialiser reads this function.
    requestedByMemberId: request.requestedByMemberId,
    schoolName: request.schoolName,
    teachers: parseAdminTeachers(request.teachers),
    cateringPreference: request.cateringPreference,
    linkedGuestMembers: linkedDisplay.links,
    contactFirstName: request.contactFirstName,
    contactLastName: request.contactLastName,
    contactEmail: request.contactEmail,
    contactPhone: request.contactPhone,
    checkIn: request.checkIn.toISOString(),
    checkOut: request.checkOut.toISOString(),
    guests: guestDisplay.guests,
    // Each flag is emitted ONLY when THAT blob failed its schema, so a
    // well-formed row's payload stays byte-for-byte what it was before #2342
    // and no client has to care about a flag until there is something to flag.
    // `guests` above is then the salvaged list rather than validated data.
    ...(guestDisplay.needsAttention ? { guestDataNeedsAttention: true } : {}),
    // `linkedGuestMembers` above is then empty — no half-trusted links.
    ...(linkedDisplay.needsAttention
      ? { linkedMemberDataNeedsAttention: true }
      : {}),
    message: request.message,
    indicativePriceCents: request.indicativePriceCents,
    priceCents: request.priceCents,
    verifiedAt: request.verifiedAt?.toISOString() ?? null,
    pricedAt: request.pricedAt?.toISOString() ?? null,
    pricedByMemberId: request.pricedByMemberId,
    reviewedAt: request.reviewedAt?.toISOString() ?? null,
    reviewedByMemberId: request.reviewedByMemberId,
    declineReason: request.declineReason,
    convertedBookingId: request.convertedBookingId,
    attendeesConfirmedAt: request.attendeesConfirmedAt?.toISOString() ?? null,
    convertedMemberId: request.convertedMemberId,
    heldBookingId: request.heldBookingId,
    acceptedQuoteId: request.acceptedQuoteId,
    acceptedQuoteOptionId: request.acceptedQuoteOptionId,
    acceptedPriceCents: request.acceptedPriceCents,
    acceptedAt: request.acceptedAt?.toISOString() ?? null,
    responseMessage: request.responseMessage,
    responseMessageAt: request.responseMessageAt?.toISOString() ?? null,
    createdAt: request.createdAt.toISOString(),
  };
}
