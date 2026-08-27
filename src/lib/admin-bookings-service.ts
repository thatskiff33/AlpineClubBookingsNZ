import { BookingStatus, type Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildXeroActivityByRecord,
  deriveXeroState,
  emptyXeroActivitySummary,
  mergeXeroActivitySummaries,
  matchesXeroStateFilter,
  paymentSourceFilters,
  xeroStateFilters,
  type PaymentSourceFilter,
  type XeroActivitySummary,
  type XeroState,
} from "@/lib/admin-operational-state";
import { isAdditionalPaymentOwed } from "@/lib/additional-payment-chase";
import { BED_ALLOCATABLE_BOOKING_STATUSES } from "@/lib/bed-allocation-lifecycle";
import {
  bookingStatusLifecycleRank,
  capacityHoldingBookingFilter,
  UPCOMING_CHECK_IN_BOOKING_STATUSES,
} from "@/lib/booking-status";
import { bookingsOverlap, sameLodgeNullTolerant } from "@/lib/capacity";
import { isPublishableDiagnosticsFilterValue } from "@/lib/diagnostics/page-context/types";
import {
  buildBookingDeletedWhere,
  parseBookingDeletedVisibility,
} from "@/lib/booking-delete-visibility";
import {
  dateOnlyInstantOf,
  endOfClubDayExclusive,
  requireCalendarDate,
  startOfClubDay,
  type BoundClubTime,
  type ClubTimeZone,
} from "@/lib/club-time";
import {
  addDaysDateOnly,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import {
  getGuestBedNightKeys,
  type BookingStayRange,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { buildAdditionalOwedWhere } from "@/lib/unpaid-finished-stays";
import { prisma } from "@/lib/prisma";

export type BookingSortBy = "member" | "lastUpdated" | "checkIn" | "guests" | "total" | "status";
export type SortDir = "asc" | "desc";
type BedStateFilter = "all" | "unallocated" | "partial" | "complete" | "warning";
type BedState = Exclude<BedStateFilter, "all">;
type ChangeStateFilter = "all" | "requiresReview" | "pendingRequest" | "hasModification" | "creditGenerated";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// One page of the admin bookings list. Kept as a constant so the service and
// its callers share a single window size (previously a bare `100`).
export const ADMIN_BOOKINGS_PAGE_SIZE = 100;

// Chunk size for the derived-filter candidate scan (#1884): bookings whose
// filters can only be evaluated in JS are loaded in id-ordered chunks of this
// size instead of one unbounded findMany, bounding peak memory while keeping
// exact totals and page contents.
export const ADMIN_BOOKINGS_DERIVED_SCAN_CHUNK_SIZE = 500;

const bookingSortColumns = new Set<BookingSortBy>([
  "member",
  "lastUpdated",
  "checkIn",
  "guests",
  "total",
  "status",
]);

const validBookingStatuses = new Set<BookingStatus>(Object.values(BookingStatus));

export const adminBookingsQuerySchema = z.object({
  status: z.string().optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  updatedFrom: dateSchema.optional(),
  updatedTo: dateSchema.optional(),
  checkInFrom: dateSchema.optional(),
  checkInTo: dateSchema.optional(),
  // Check-out range (#1709): lets the dashboard "Unpaid Finished Stays" card
  // deep-link to status=PAYMENT_PENDING&checkOutTo=<today> — every finished
  // stay with payment still owing (retroactive card creates qualify from the
  // moment of creation).
  checkOutFrom: dateSchema.optional(),
  checkOutTo: dateSchema.optional(),
  search: z.string().trim().max(100).optional(),
  upcoming: z.string().optional(),
  sort: z.string().optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
  month: z.string().optional(),
  deleted: z.string().optional(),
  // Lodge filter (multi-lodge phase 8); the UI only offers it once a second
  // active lodge exists.
  lodgeId: z.string().min(1).optional(),
  paymentSource: z.enum(paymentSourceFilters).optional().default("all"),
  xeroState: z.enum(xeroStateFilters).optional().default("all"),
  bedState: z.enum(["all", "unallocated", "partial", "complete", "warning"]).optional().default("all"),
  // Unsettled upward-modification deltas (#1723): "owed" narrows to settled
  // (CONFIRMED/PAID/COMPLETED) bookings whose additional card payment was
  // never collected. The dashboard "Finished Stays With Unpaid Additions"
  // card deep-links here as additionalOwed=owed&checkOutTo=<today>; the SQL
  // fragment is shared with that card's count via unpaid-finished-stays.ts.
  additionalOwed: z.enum(["all", "owed"]).optional().default("all"),
  changeState: z.enum(["all", "requiresReview", "pendingRequest", "hasModification", "creditGenerated"]).optional().default("all"),
  // Member-guest consent queues (#2307, owner decision MG2-M-3 as ticked):
  // "waiting" narrows to bookings holding an unanswered (PENDING) consent
  // request; "attention" to bookings carrying a stuck DECLINED/EXPIRED row the
  // system could not resolve (D-15's exception list — the page swaps in the
  // per-guest attention table for that one).
  consentState: z.enum(["all", "waiting", "attention"]).optional().default("all"),
  // Page number (1-based). Field-scoped `.catch(1)` so garbage (`page=abc`,
  // `0`, `-3`, `2.5`) coerces to page 1 instead of failing the whole parse and
  // dropping every other filter; an out-of-range page is clamped to the last
  // non-empty page in the service.
  page: z.coerce.number().int().min(1).catch(1),
});

export type AdminBookingsQuery = z.infer<typeof adminBookingsQuerySchema>;

type BookingCandidate = Awaited<ReturnType<typeof loadBookingCandidates>>[number];

interface AdminBookingOperationalState {
  paymentSource: PaymentSourceFilter;
  /**
   * Extra still owed after an upward booking change (#2350). Zero when nothing
   * is outstanding; positive for a PENDING, FAILED, or legacy-null additional
   * payment, which the owed predicate treats identically.
   */
  outstandingAdditionalCents: number;
  xeroState: XeroState;
  xeroActivity: XeroActivitySummary;
  invoiceLinked: boolean;
  invoiceExpected: boolean;
  bedState: BedState;
  expectedGuestNights: number;
  allocatedGuestNights: number;
  unapprovedBedAllocations: number;
  bedWarningCount: number;
  hasPerGuestDates: boolean;
  guestDateRanges: Array<{
    guestId: string;
    guestName: string;
    stayStart: string;
    stayEnd: string;
  }>;
  requiresReview: boolean;
  pendingChangeRequest: boolean;
  hasModification: boolean;
  creditGenerated: boolean;
  refundGenerated: boolean;
}

export type AdminBookingRow = BookingCandidate & {
  operational: AdminBookingOperationalState;
  // This booking overlaps another booking's exclusive whole-lodge hold
  // (ADR-001 decision 1, issue #119). Admin-only signal; flagged so staff see
  // the clash from the ordinary booking's side. A held booking itself is never
  // flagged (it is not overlapping anything — it IS the hold).
  overlapsExclusiveHold: boolean;
};

/**
 * Flag every page row that overlaps another booking's exclusive whole-lodge
 * hold (issue #119). One extra query per page: the capacity-holding held
 * bookings whose nights intersect the page's date span, matched to each row
 * in-memory (same-lodge, half-open overlap). Reuses the capacity engine's
 * overlap + hold-population logic rather than reimplementing it. Admin-only:
 * this list is never rendered to members (decision 6).
 */
async function annotateExclusiveHoldOverlaps(
  rows: AdminBookingRow[]
): Promise<void> {
  if (rows.length === 0) return;
  let minCheckIn = rows[0].checkIn;
  let maxCheckOut = rows[0].checkOut;
  for (const row of rows) {
    if (row.checkIn < minCheckIn) minCheckIn = row.checkIn;
    if (row.checkOut > maxCheckOut) maxCheckOut = row.checkOut;
  }

  const holds = await prisma.booking.findMany({
    where: {
      wholeLodgeHold: true,
      deletedAt: null,
      checkIn: { lt: maxCheckOut },
      checkOut: { gt: minCheckIn },
      // Only a capacity-holding hold blocks admissions; nest under AND so the
      // filter's top-level OR composes with the scalar/date clauses.
      AND: [capacityHoldingBookingFilter()],
    },
    select: { id: true, checkIn: true, checkOut: true, lodgeId: true },
  });

  for (const row of rows) {
    row.overlapsExclusiveHold = holds.some(
      (held) =>
        held.id !== row.id &&
        sameLodgeNullTolerant(held.lodgeId, row.lodgeId) &&
        bookingsOverlap(held, row)
    );
  }
}

export interface AdminBookingsResult {
  bookings: AdminBookingRow[];
  total: number;
  page: number;
  totalPages: number;
  pageSize: number;
  sortBy: BookingSortBy;
  sortDir: SortDir;
}

/**
 * Windows an already-sorted list to one page, for the paths that still sort
 * in JS (member/status sorts and the derived-filter scan — see
 * listAdminBookings; SQL-sortable defaults window via skip/take instead).
 * Clamps the requested page into [1, totalPages] so a narrowed filter never
 * strands the user on an empty page with no way back.
 */
function clampPageWindow<T>(
  items: T[],
  requestedPage: number,
  pageSize = ADMIN_BOOKINGS_PAGE_SIZE
) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const start = (page - 1) * pageSize;
  return { pageItems: items.slice(start, start + pageSize), total, page, totalPages };
}

export interface AdminBookingsOptions {
  bedAllocationEnabled?: boolean;
}

/**
 * The club's temporal facts for ONE render of the bookings page (#3123).
 *
 * Two things, deliberately bundled, because this module answers two different
 * temporal questions and both were reading `APP_TIME_ZONE` — the container's
 * claim about where the club is — rather than the club's persisted setting
 * (`INV-CONFIG-002`):
 *
 *  - `today` bounds `Booking.checkIn`, a `@db.Date` column
 *    (`prisma/schema.prisma:1662`), so it is the UTC-midnight encoding of a
 *    calendar day.
 *  - `zone` bounds `Booking.updatedAt`, a bare `DateTime @updatedAt`
 *    (`prisma/schema.prisma:1845`) — a real INSTANT column, where a
 *    UTC-midnight encoding would be the wrong shape and a genuine instant
 *    boundary is right.
 *
 * `today` is ONE resolved value rather than a clock each consumer reads for
 * itself. `appliedBookingViewFilters` exists only to describe what
 * `buildBookingWhere` did; if the two resolved the club's today independently
 * they could disagree across club midnight, and the diagnostics panel would
 * then report a filter the list is not using.
 */
export interface AdminBookingsClubDay {
  readonly zone: ClubTimeZone;
  readonly today: Date;
}

/** One clock read, shared by every consumer of this module in one render. */
export function adminBookingsClubDay(club: BoundClubTime): AdminBookingsClubDay {
  return { zone: club.zone, today: dateOnlyInstantOf(club.today()) };
}

function parseDateOnlyFilter(value: string) {
  return parseDateOnly(value);
}

/**
 * The `updatedAt` bounds. That column is a real instant, so these are instant
 * boundaries in the CLUB's zone — half-open at the top, because Postgres keeps
 * microseconds and an inclusive millisecond bound can drop a row written in the
 * final millisecond of the day.
 */
function parseDateTimeStart(value: string, zone: ClubTimeZone) {
  return startOfClubDay(requireCalendarDate(value), zone);
}

function parseDateTimeEnd(value: string, zone: ClubTimeZone) {
  return endOfClubDayExclusive(requireCalendarDate(value), zone);
}

function monthEndDateOnly(year: number, month: number) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function getAdminBookingSortBy(params: { sortBy?: string; sort?: string }): BookingSortBy {
  const requested = params.sortBy ?? params.sort;
  return bookingSortColumns.has(requested as BookingSortBy)
    ? (requested as BookingSortBy)
    : "lastUpdated";
}

export function getDefaultAdminBookingSortDir(sortBy: BookingSortBy): SortDir {
  return sortBy === "member" || sortBy === "status" ? "asc" : "desc";
}

function memberSortValue(booking: BookingCandidate) {
  return `${booking.member.lastName} ${booking.member.firstName}`.toLowerCase();
}

function compareValues(left: string | number | Date | null, right: string | number | Date | null) {
  const normalizedLeft = left instanceof Date ? left.getTime() : left ?? "";
  const normalizedRight = right instanceof Date ? right.getTime() : right ?? "";

  if (typeof normalizedLeft === "number" && typeof normalizedRight === "number") {
    return normalizedLeft - normalizedRight;
  }

  return String(normalizedLeft).localeCompare(String(normalizedRight));
}

function sortValue(booking: BookingCandidate, sortBy: BookingSortBy) {
  switch (sortBy) {
    case "member":
      return memberSortValue(booking);
    case "checkIn":
      return booking.checkIn;
    case "guests":
      return booking.guests.length;
    case "total":
      return booking.finalPriceCents;
    case "status":
      return bookingStatusLifecycleRank(booking.status);
    case "lastUpdated":
    default:
      return booking.updatedAt;
  }
}

/**
 * The lifecycle statuses this list actually NARROWS to, in the order the URL asked
 * for them. Empty means "no status narrowing was applied" — either none was asked
 * for, or `all` was.
 *
 * Shared with `appliedBookingViewFilters` (AI Diagnostics, #2816), which publishes
 * the filter state the page APPLIED rather than the one the address bar shows and
 * must therefore ask the same code that builds the query rather than re-deriving
 * the vocabulary. Note an empty result is NOT the same thing as an empty query
 * clause: `?status=BOGUS` asks for narrowing and gets `{ in: [] }` below, which
 * matches nothing — see `bookingStatusWhere`, and `appliedBookingViewFilters` for
 * how that case is reported.
 */
function appliedBookingStatuses(
  statusFilter: string | undefined,
): BookingStatus[] {
  if (!statusFilter || statusFilter === "all") return [];
  return statusFilter
    .split(",")
    .map((status) => status.trim())
    .filter((status): status is BookingStatus =>
      validBookingStatuses.has(status as BookingStatus)
    );
}

function bookingStatusWhere(statusFilter: string | undefined): Prisma.BookingWhereInput["status"] {
  if (statusFilter === "DRAFT") {
    return BookingStatus.DRAFT;
  }

  if (statusFilter && statusFilter !== "all") {
    const statuses = appliedBookingStatuses(statusFilter);
    return statuses.length === 1 ? statuses[0] : { in: statuses };
  }

  return { not: BookingStatus.DRAFT };
}

/**
 * The AI Diagnostics registry vocabulary for one booking status: lowercase, with
 * underscores hyphenated (`PAYMENT_PENDING` → `payment-pending`). It is the SAME
 * mapping the ask route applies to the wire's `status` token, applied here so the
 * two spellings the model can be shown — `- status: confirmed` for one applied
 * status, `- filter status: confirmed,paid` for several — are one vocabulary
 * rather than two (review finding, 13 Aug 2026).
 */
function diagnosticsStatusToken(status: string): string {
  return status.trim().toLowerCase().replace(/_/g, "-");
}

/**
 * THE VIEW STATE THIS LIST ACTUALLY APPLIED, in the AI Diagnostics registry row's
 * own vocabulary (#2816, owner decision 13 Aug 2026).
 *
 * IT LIVES HERE, BESIDE `buildBookingWhere`, because it is a claim about what that
 * function did. The first cut derived it in the page from `query` alone and got the
 * date window wrong in both directions: it suppressed the LOSING legacy alias but
 * never published the WINNING bound, so `?checkOutTo=2026-08-14` — a URL two
 * dashboard cards deep-link to (`unpaid-finished-stays.ts`) — reported a narrowed
 * list as unnarrowed. Anything that reads `query` and claims to describe the query
 * has to be maintained in the same edit as the builder, so it is in the same file.
 *
 * WHAT IT PUBLISHES, and the precedence is `buildBookingWhere`'s own, field by
 * field (last writer wins there, so last writer wins here):
 *  - `status` — the ONE token the wire's status field holds, when exactly one
 *    lifecycle status was applied. Several go in the allowlisted `status` FILTER
 *    instead, because sending the first would misstate the selection.
 *  - `filters.checkInFrom` / `checkInTo` / `checkOutFrom` / `checkOutTo` — the
 *    effective bound on each end of each date column, whichever parameter produced
 *    it: the legacy aliases, the explicit named bounds, `?month=`, or `?upcoming=`
 *    (whose window is computed, not in the URL at all).
 *  - `filters.search` / `filters.lodgeId` — post-parse, so post-trim.
 *
 * EVERY DATE KEY NAMES THE COLUMN IT BOUNDS, and the first cut's two keys could
 * not (evidence review of PR #2831, 14 Aug 2026). It published `from`/`to`, and
 * `buildBookingWhere` is ASYMMETRIC about that pair: legacy `from` feeds
 * `checkIn.gte`, legacy `to` feeds `checkOut.lte`. So `?month=2026-08` published
 * `to: 2026-08-31` — a check-IN upper bound — under the key that this page's URL
 * and its own deployed source both define as a check-OUT bound. A model handed
 * that source excerpt reads the bound against the wrong column and confidently
 * names the wrong bookings for "why isn't this booking showing?", which is the
 * flagship question this channel exists to answer. The registry row now allowlists
 * the four precise keys and no longer allowlists the ambiguous pair, so a check-in
 * bound can never again be labelled `to`.
 *
 * WHAT IT DELIBERATELY DOES NOT PUBLISH. The default `status: { not: DRAFT }` — a
 * real narrowing, and inexpressible as an inclusion token. Every filter key this
 * page has that the registry row does not list (`paymentSource`, `xeroState`,
 * `bedState`, `additionalOwed`, `changeState`, `updatedFrom`/`updatedTo`,
 * `deleted`, `consentState`, and the legacy `from`/`to` aliases): the route drops
 * an unlisted key, and publishing to be dropped is not a contract.
 */
export function appliedBookingViewFilters(
  query: AdminBookingsQuery,
  clubDay: AdminBookingsClubDay,
): {
  status?: string;
  filters?: Record<string, string>;
} {
  const filters: Record<string, string> = {};
  const statuses = appliedBookingStatuses(query.status);
  const upcomingDays = query.upcoming ? parseInt(query.upcoming, 10) : null;
  const upcomingApplied = upcomingDays !== null && !isNaN(upcomingDays);

  /**
   * Publish one filter, or DROP it — never truncate it, because a truncated value
   * would tell the model the operator filtered by something they did not.
   *
   * THE LENGTH CHECK IS ON EVERY KEY, not just the unknown-status one (review
   * finding, 14 Aug 2026), and it asks
   * `isPublishableDiagnosticsFilterValue` rather than restating the bound: the
   * ask route drops a value over `filterValueMaxChars`, so publishing one is
   * publishing to be dropped, and the model is then told nothing about a filter
   * that IS narrowing the list. `lodgeId` is the live case —
   * `adminBookingsQuerySchema` bounds `search` to 100 characters and fails the
   * WHOLE parse above that, but it bounds `lodgeId` only to non-empty, so a
   * crafted link can apply an arbitrarily long one.
   */
  const publish = (key: string, value: string) => {
    if (!isPublishableDiagnosticsFilterValue(value)) return;
    filters[key] = value;
  };

  let singleStatus: string | undefined;
  if (statuses.length === 1) {
    singleStatus = diagnosticsStatusToken(statuses[0]);
  } else if (statuses.length > 1) {
    publish("status", statuses.map(diagnosticsStatusToken).join(","));
  } else if (query.status && query.status !== "all") {
    // `?status=BOGUS` applies `{ in: [] }` — a narrowing that matches NOTHING.
    // This is the one URL where the list is empty BECAUSE OF the filter, so
    // saying nothing about it is the worst possible answer to "why is this list
    // empty?". It goes in the free-text filter rather than the token field
    // because it is, by construction, not in the token vocabulary. Overlong junk
    // is dropped rather than published, because the route would drop it anyway.
    publish("status", diagnosticsStatusToken(query.status));
  } else if (upcomingApplied && !query.status) {
    // `?upcoming=N` (the dashboard's "Bookings" card) narrows check-in to
    // [today, today+N] AND pins a status set. The status half IS expressible
    // here, so it is published — but the builder's guard is `if (!query.status)`,
    // and `?status=all` is TRUTHY there: it leaves the default `{ not: DRAFT }`
    // standing and pins nothing. The guard is repeated exactly rather than
    // approximated, or `?upcoming=7&status=all` would report a status set the
    // list is not using.
    publish(
      "status",
      [...UPCOMING_CHECK_IN_BOOKING_STATUSES]
        .map(diagnosticsStatusToken)
        .join(","),
    );
  }

  // THE DATE BOUNDS, in `buildBookingWhere`'s own assignment order, because there
  // the LAST writer to each field wins: `?upcoming=` seeds both check-in bounds,
  // `?month=` overwrites both, then each explicit named bound overwrites its own.
  let checkInFrom: string | undefined;
  let checkInTo: string | undefined;
  if (upcomingApplied) {
    // The SAME `today` `buildBookingWhere` used — see `AdminBookingsClubDay`.
    const today = clubDay.today;
    checkInFrom = formatDateOnly(today);
    checkInTo = formatDateOnly(addDaysDateOnly(today, upcomingDays));
  }
  if (query.month && /^\d{4}-\d{2}$/.test(query.month)) {
    const [year, month] = query.month.split("-").map(Number);
    checkInFrom = `${year}-${String(month).padStart(2, "0")}-01`;
    checkInTo = monthEndDateOnly(year, month);
  }
  // `checkInFrom ?? from`: the legacy alias only ever feeds the check-in lower
  // bound, and loses to the explicit one.
  const explicitCheckInFrom = query.checkInFrom ?? query.from;
  if (explicitCheckInFrom) checkInFrom = explicitCheckInFrom;
  if (query.checkInTo) checkInTo = query.checkInTo;

  // Legacy `to` bounds CHECK-OUT, and only when neither named upper bound is set —
  // `legacyToDate` in the builder, repeated here rather than approximated.
  const checkOutTo =
    query.checkOutTo ?? (query.checkInTo ? undefined : query.to);

  // Each bound under the key that names the column it narrowed. All four can be
  // applied at once, which with `status`, `search` and `lodgeId` is seven filters
  // against the selector's `maxFilters` of eight.
  if (checkInFrom) publish("checkInFrom", checkInFrom);
  if (checkInTo) publish("checkInTo", checkInTo);
  if (query.checkOutFrom) publish("checkOutFrom", query.checkOutFrom);
  if (checkOutTo) publish("checkOutTo", checkOutTo);

  if (query.search) publish("search", query.search);
  if (query.lodgeId) publish("lodgeId", query.lodgeId);

  return {
    ...(singleStatus ? { status: singleStatus } : {}),
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
  };
}

function buildBookingWhere(
  query: AdminBookingsQuery,
  clubDay: AdminBookingsClubDay,
): Prisma.BookingWhereInput {
  const where: Prisma.BookingWhereInput = {
    status: bookingStatusWhere(query.status),
  };
  const checkInFilter: Prisma.DateTimeFilter = {};
  const checkOutFilter: Prisma.DateTimeFilter = {};
  const updatedAtFilter: Prisma.DateTimeFilter = {};
  const checkInFrom = query.checkInFrom ?? query.from;
  const checkInTo = query.checkInTo;
  // Legacy `to` historically bounded check-out; the explicit named params
  // (checkInTo / checkOutTo) take precedence over it.
  const legacyToDate = query.checkInTo || query.checkOutTo ? undefined : query.to;
  const upcomingDays = query.upcoming ? parseInt(query.upcoming, 10) : null;

  Object.assign(where, buildBookingDeletedWhere(parseBookingDeletedVisibility(query.deleted)));

  if (upcomingDays !== null && !isNaN(upcomingDays)) {
    // The club's today, resolved once by the caller (#3123). `checkIn` is
    // `@db.Date`, so this is the UTC-midnight encoding, not an instant.
    const today = clubDay.today;
    const futureDate = addDaysDateOnly(today, upcomingDays);
    checkInFilter.gte = today;
    checkInFilter.lte = futureDate;

    if (!query.status) {
      // Shared with the dashboard "Bookings" officer card so its headline count
      // matches this pre-filtered list (booking-status.ts).
      where.status = {
        in: [...UPCOMING_CHECK_IN_BOOKING_STATUSES],
      };
    }
  }

  if (query.month && /^\d{4}-\d{2}$/.test(query.month)) {
    const [year, month] = query.month.split("-").map(Number);
    checkInFilter.gte = parseDateOnly(`${year}-${String(month).padStart(2, "0")}-01`);
    checkInFilter.lte = parseDateOnly(monthEndDateOnly(year, month));
  }

  if (checkInFrom) checkInFilter.gte = parseDateOnlyFilter(checkInFrom);
  if (checkInTo) checkInFilter.lte = parseDateOnlyFilter(checkInTo);
  if (legacyToDate) checkOutFilter.lte = parseDateOnlyFilter(legacyToDate);
  if (query.checkOutFrom) checkOutFilter.gte = parseDateOnlyFilter(query.checkOutFrom);
  if (query.checkOutTo) checkOutFilter.lte = parseDateOnlyFilter(query.checkOutTo);
  if (query.updatedFrom)
    updatedAtFilter.gte = parseDateTimeStart(query.updatedFrom, clubDay.zone);
  if (query.updatedTo)
    updatedAtFilter.lt = parseDateTimeEnd(query.updatedTo, clubDay.zone);

  if (query.search?.trim()) {
    const queryTerms = query.search.trim().split(/\s+/).filter(Boolean);
    where.member = {
      is: {
        AND: queryTerms.map((term) => ({
          OR: [
            { firstName: { contains: term, mode: "insensitive" } },
            { lastName: { contains: term, mode: "insensitive" } },
            { email: { contains: term, mode: "insensitive" } },
          ],
        })),
      },
    };
  }

  if (Object.keys(checkInFilter).length > 0) where.checkIn = checkInFilter;
  if (Object.keys(checkOutFilter).length > 0) where.checkOut = checkOutFilter;
  if (Object.keys(updatedAtFilter).length > 0) where.updatedAt = updatedAtFilter;

  // AND-composed so an explicit status/date choice in the same URL still
  // narrows the result instead of being overwritten by the queue fragment.
  const andFragments: Prisma.BookingWhereInput[] = [];
  if (query.additionalOwed === "owed") {
    andFragments.push(buildAdditionalOwedWhere());
  }

  // #2307 (MG2-M-3): the consent chips narrow in SQL, AND-composed like the
  // additional-owed queue so they stack with any other filter in the URL.
  if (query.consentState === "waiting") {
    andFragments.push({ guests: { some: { consentStatus: "PENDING" } } });
  } else if (query.consentState === "attention") {
    andFragments.push({
      guests: { some: { consentStatus: { in: ["DECLINED", "EXPIRED"] } } },
    });
  }

  if (andFragments.length > 0) {
    where.AND = andFragments;
  }

  if (query.lodgeId) {
    // Null-tolerant: bookings still missing a lodgeId (expand-release
    // tolerance) show under every lodge rather than disappearing.
    Object.assign(where, lodgeNullTolerantScope(query.lodgeId));
  }

  // paymentSource is a real Payment column (#1884), so it filters in SQL
  // rather than in the JS derived-state pass. Payment.source is a
  // non-nullable enum on an optional to-one relation, so "NONE" (the
  // `booking.payment?.source ?? "NONE"` derivation) is exactly "no payment
  // row".
  if (query.paymentSource === "NONE") {
    where.payment = { is: null };
  } else if (query.paymentSource !== "all") {
    where.payment = { is: { source: query.paymentSource } };
  }

  return where;
}

/**
 * The SQL half of this list's filter, for callers that need to COUNT what a
 * filtered view will show without paying for the whole list pipeline.
 *
 * #2307's "Waiting for consent · N" chip is the caller: clicking it stacks with
 * whatever filters are already in the URL, so its number has to be taken inside
 * the same filter or it promises rows the click then hides.
 *
 * IT IS THE SQL HALF ONLY. The Xero/bed/change filters are derived in
 * JavaScript after this query (see `listAdminBookings`), so a count taken
 * through this clause is an upper bound while one of those three is active.
 * Anything that must be exact has to run the list itself.
 */
export function buildAdminBookingsWhere(
  query: AdminBookingsQuery,
  clubDay: AdminBookingsClubDay,
): Prisma.BookingWhereInput {
  return buildBookingWhere(query, clubDay);
}

/**
 * SQL-expressible orderings (#1884). Returns null for the two sort modes that
 * genuinely need the JS comparator: "member" sorts on the lowercased
 * "lastName firstName" string and "status" on the lifecycle rank (#1215),
 * neither of which is a plain column ordering. The `id` tie-break mirrors the
 * JS comparators' `localeCompare` fallback; ids are cuids (lowercase
 * alphanumerics), for which database and locale orderings agree.
 */
function buildBookingSqlOrderBy(
  sortBy: BookingSortBy,
  sortDir: SortDir
): Prisma.BookingOrderByWithRelationInput[] | null {
  switch (sortBy) {
    case "checkIn":
      return [{ checkIn: sortDir }, { id: "asc" }];
    case "lastUpdated":
      return [{ updatedAt: sortDir }, { id: "asc" }];
    case "total":
      return [{ finalPriceCents: sortDir }, { id: "asc" }];
    case "guests":
      return [{ guests: { _count: sortDir } }, { id: "asc" }];
    case "member":
    case "status":
      return null;
  }
}

/**
 * Lightweight first pass for the default list view (#1146): only the columns
 * the sort comparator needs. The heavy relation load then happens for just
 * the page of bookings actually returned, instead of every match.
 */
async function loadBookingSortRows(where: Prisma.BookingWhereInput) {
  return prisma.booking.findMany({
    where,
    select: {
      id: true,
      checkIn: true,
      updatedAt: true,
      finalPriceCents: true,
      status: true,
      member: { select: { firstName: true, lastName: true } },
      _count: { select: { guests: true } },
    },
  });
}

type BookingSortRow = Awaited<ReturnType<typeof loadBookingSortRows>>[number];

/**
 * Sort key for the lightweight rows. MUST stay semantically identical to
 * sortValue() below — the fast path is only valid because the two comparators
 * order the same bookings the same way.
 */
function sortRowValue(row: BookingSortRow, sortBy: BookingSortBy) {
  switch (sortBy) {
    case "member":
      return `${row.member.lastName} ${row.member.firstName}`.toLowerCase();
    case "checkIn":
      return row.checkIn;
    case "guests":
      return row._count?.guests ?? 0;
    case "total":
      return row.finalPriceCents;
    case "status":
      return bookingStatusLifecycleRank(row.status);
    case "lastUpdated":
    default:
      return row.updatedAt;
  }
}

/**
 * Heavy relation load. `scan` (#1884) turns the query into one bounded,
 * id-ordered chunk of a cursor walk so the derived-filter path never holds
 * more than ADMIN_BOOKINGS_DERIVED_SCAN_CHUNK_SIZE bookings (plus relations)
 * in memory at once.
 */
async function loadBookingCandidates(
  where: Prisma.BookingWhereInput,
  scan?: { take: number; cursorId?: string }
) {
  return prisma.booking.findMany({
    where,
    ...(scan
      ? {
          orderBy: { id: "asc" as const },
          take: scan.take,
          ...(scan.cursorId ? { cursor: { id: scan.cursorId }, skip: 1 } : {}),
        }
      : {}),
    include: {
      lodge: { select: { id: true, name: true } },
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phoneCountryCode: true,
          phoneAreaCode: true,
          phoneNumber: true,
        },
      },
      guests: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          ageTier: true,
          isMember: true,
          stayStart: true,
          stayEnd: true,
          // The canonical night set (#2628). `deriveBedState` compares expected
          // guest-nights against the booking's BedAllocation rows, so without
          // these a sparse stay's gap nights are expected, never allocated, and
          // the booking never reaches "complete".
          nights: { select: { stayDate: true } },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      payment: {
        select: {
          id: true,
          source: true,
          status: true,
          xeroInvoiceId: true,
          xeroInvoiceNumber: true,
          refundedAmountCents: true,
          // #2350: an upward change can leave money uncollected on a booking
          // whose lifecycle status still reads PAID. The list row says so.
          additionalAmountCents: true,
          additionalPaymentStatus: true,
        },
      },
      bedAllocations: {
        include: {
          bookingGuest: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              ageTier: true,
            },
          },
          room: { select: { id: true, name: true } },
          bed: { select: { id: true, name: true } },
        },
      },
      modifications: {
        select: {
          id: true,
          modificationType: true,
          priceDiffCents: true,
          createdAt: true,
          creditsFromModification: {
            select: {
              id: true,
              amountCents: true,
              xeroCreditNoteId: true,
            },
          },
        },
      },
      changeRequests: {
        select: {
          id: true,
          status: true,
          createdAt: true,
          linkedModificationId: true,
        },
      },
      creditsFromCancellation: {
        select: {
          id: true,
          amountCents: true,
          description: true,
          xeroCreditNoteId: true,
        },
      },
      refundRequests: {
        select: {
          id: true,
          status: true,
          approvedAmountCents: true,
        },
      },
    },
  });
}

function guestName(guest: { firstName: string; lastName: string }) {
  return [guest.firstName, guest.lastName].filter(Boolean).join(" ");
}

/**
 * The `guestId:night` keys this guest is expected to hold a bed on.
 *
 * Reads the canonical night set, NOT the `stayStart`/`stayEnd` envelope (#2628).
 * Expanding the envelope filled a sparse stay's internal gaps with nights the
 * guest is not there, and nothing ever allocates a bed for those — so a booking
 * with a non-contiguous stay could never reach `"complete"` and sat in the
 * operational queue for good. `getGuestBedNightKeys` falls back to the same
 * half-open envelope for a guest carrying no night rows, so nothing moves for
 * an ordinary contiguous stay or for a legacy guest.
 */
function guestNightKeys(
  guest: { id: string } & GuestStayRange,
  booking: BookingStayRange
) {
  return getGuestBedNightKeys(guest, booking).map(
    (night) => `${guest.id}:${night}`
  );
}

function buildBedWarnings(
  allocations: BookingCandidate["bedAllocations"]
) {
  const warnings: Array<{ bookingGuestId?: string; stayDate: string }> = [];
  const allocationsByNight = new Map<string, typeof allocations>();

  for (const allocation of allocations) {
    const key = `${allocation.bookingId}:${formatDateOnly(allocation.stayDate)}`;
    const current = allocationsByNight.get(key) ?? [];
    current.push(allocation);
    allocationsByNight.set(key, current);
  }

  for (const group of allocationsByNight.values()) {
    const roomIds = new Set(group.map((allocation) => allocation.roomId));
    if (roomIds.size > 1) {
      warnings.push({ stayDate: formatDateOnly(group[0].stayDate) });
    }

    for (const allocation of group) {
      if (allocation.bookingGuest.ageTier === "ADULT") continue;

      const hasBookingAdultInRoom = group.some(
        (candidate) =>
          candidate.roomId === allocation.roomId &&
          candidate.bookingGuest.ageTier === "ADULT"
      );
      if (!hasBookingAdultInRoom) {
        warnings.push({
          bookingGuestId: allocation.bookingGuestId,
          stayDate: formatDateOnly(allocation.stayDate),
        });
      }
    }
  }

  return warnings;
}

function deriveBedState(
  booking: BookingCandidate,
  bedAllocationEnabled = true
): Pick<
  AdminBookingOperationalState,
  | "bedState"
  | "expectedGuestNights"
  | "allocatedGuestNights"
  | "unapprovedBedAllocations"
  | "bedWarningCount"
> {
  if (!bedAllocationEnabled) {
    return {
      bedState: "complete",
      expectedGuestNights: 0,
      allocatedGuestNights: 0,
      unapprovedBedAllocations: 0,
      bedWarningCount: 0,
    };
  }

  // An exclusive whole-lodge hold (ADR-001, #120) implicitly occupies every
  // bed — it needs NO per-bed allocation, so it must never register as an
  // "unallocated" bed-state gap / stuck state. Report it complete.
  if (booking.wholeLodgeHold) {
    return {
      bedState: "complete",
      expectedGuestNights: 0,
      allocatedGuestNights: 0,
      unapprovedBedAllocations: booking.bedAllocations.filter(
        (allocation) => !allocation.approvedAt
      ).length,
      bedWarningCount: 0,
    };
  }

  const expectedGuestNightKeys = new Set(
    booking.guests.flatMap((guest) => guestNightKeys(guest, booking))
  );
  const allocationKeys = new Set(
    booking.bedAllocations.map(
      (allocation) =>
        `${allocation.bookingGuestId}:${formatDateOnly(allocation.stayDate)}`
    )
  );
  const allocatedGuestNights = [...expectedGuestNightKeys].filter((key) =>
    allocationKeys.has(key)
  ).length;
  const bedWarnings = buildBedWarnings(booking.bedAllocations);
  const allocatable = (BED_ALLOCATABLE_BOOKING_STATUSES as readonly string[]).includes(
    booking.status
  );
  let bedState: BedState = "complete";

  if (bedWarnings.length > 0) {
    bedState = "warning";
  } else if (expectedGuestNightKeys.size > 0 && allocatable) {
    if (allocatedGuestNights === 0) bedState = "unallocated";
    else if (allocatedGuestNights < expectedGuestNightKeys.size) bedState = "partial";
    else bedState = "complete";
  }

  return {
    bedState,
    expectedGuestNights: expectedGuestNightKeys.size,
    allocatedGuestNights,
    unapprovedBedAllocations: booking.bedAllocations.filter(
      (allocation) => !allocation.approvedAt
    ).length,
    bedWarningCount: bedWarnings.length,
  };
}

function matchesPaymentSourceFilter(
  paymentSource: PaymentSourceFilter,
  filter: PaymentSourceFilter
) {
  return filter === "all" || paymentSource === filter;
}

function matchesBedStateFilter(bedState: BedState, filter: BedStateFilter) {
  return filter === "all" || bedState === filter;
}

function matchesChangeStateFilter(
  state: AdminBookingOperationalState,
  filter: ChangeStateFilter
) {
  switch (filter) {
    case "requiresReview":
      return state.requiresReview;
    case "pendingRequest":
      return state.pendingChangeRequest;
    case "hasModification":
      return state.hasModification;
    case "creditGenerated":
      return state.creditGenerated;
    case "all":
    default:
      return true;
  }
}

function deriveBookingOperationalState(
  booking: BookingCandidate,
  activityByRecord: Map<string, XeroActivitySummary>,
  invoiceLinkedPaymentIds: Set<string>,
  options: AdminBookingsOptions = {}
): AdminBookingOperationalState {
  const paymentSource = (booking.payment?.source ?? "NONE") as PaymentSourceFilter;
  const activity = mergeXeroActivitySummaries([
    activityByRecord.get(`Booking:${booking.id}`) ?? emptyXeroActivitySummary(),
    booking.payment
      ? activityByRecord.get(`Payment:${booking.payment.id}`) ?? emptyXeroActivitySummary()
      : emptyXeroActivitySummary(),
    ...booking.modifications.map(
      (modification) =>
        activityByRecord.get(`BookingModification:${modification.id}`) ??
        emptyXeroActivitySummary()
    ),
  ]);
  const invoiceExpected = booking.payment
    ? ["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(booking.payment.status)
    : false;
  const invoiceLinked =
    Boolean(booking.payment?.xeroInvoiceId) ||
    (booking.payment ? invoiceLinkedPaymentIds.has(booking.payment.id) : false);
  const hasPerGuestDates = booking.guests.some(
    (guest) =>
      formatDateOnly(guest.stayStart) !== formatDateOnly(booking.checkIn) ||
      formatDateOnly(guest.stayEnd) !== formatDateOnly(booking.checkOut)
  );
  const guestDateRanges = hasPerGuestDates
    ? booking.guests.map((guest) => ({
        guestId: guest.id,
        guestName: guestName(guest),
        stayStart: formatDateOnly(guest.stayStart),
        stayEnd: formatDateOnly(guest.stayEnd),
      }))
    : [];
  const creditGenerated =
    booking.creditsFromCancellation.length > 0 ||
    booking.modifications.some((modification) => modification.creditsFromModification.length > 0);

  return {
    paymentSource,
    outstandingAdditionalCents: isAdditionalPaymentOwed({
      bookingStatus: booking.status,
      payment: booking.payment,
    })
      ? booking.payment?.additionalAmountCents ?? 0
      : 0,
    xeroState: deriveXeroState({ invoiceExpected, invoiceLinked, activity }),
    xeroActivity: activity,
    invoiceLinked,
    invoiceExpected,
    ...deriveBedState(booking, options.bedAllocationEnabled ?? true),
    hasPerGuestDates,
    guestDateRanges,
    requiresReview:
      booking.requiresAdminReview || booking.adminReviewStatus === "PENDING",
    pendingChangeRequest: booking.changeRequests.some(
      (request) => request.status === "REQUESTED"
    ),
    hasModification: booking.modifications.length > 0,
    creditGenerated,
    refundGenerated:
      (booking.payment?.refundedAmountCents ?? 0) > 0 ||
      booking.refundRequests.some((request) => request.status === "APPROVED"),
  };
}

async function loadXeroStateInputs(bookings: BookingCandidate[]) {
  const bookingIds = bookings.map((booking) => booking.id);
  const paymentIds = bookings
    .map((booking) => booking.payment?.id)
    .filter((id): id is string => Boolean(id));
  const modificationIds = bookings.flatMap((booking) =>
    booking.modifications.map((modification) => modification.id)
  );
  const operationScope: Prisma.XeroSyncOperationWhereInput[] = [
    ...(bookingIds.length ? [{ localModel: "Booking", localId: { in: bookingIds } }] : []),
    ...(paymentIds.length ? [{ localModel: "Payment", localId: { in: paymentIds } }] : []),
    ...(modificationIds.length
      ? [{ localModel: "BookingModification", localId: { in: modificationIds } }]
      : []),
  ];

  const [activityOperations, primaryInvoiceLinks] = await Promise.all([
    operationScope.length
      ? prisma.xeroSyncOperation.findMany({
          where: { OR: operationScope },
          select: {
            id: true,
            status: true,
            localModel: true,
            localId: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve([]),
    paymentIds.length
      ? prisma.xeroObjectLink.findMany({
          where: {
            localModel: "Payment",
            localId: { in: paymentIds },
            xeroObjectType: "INVOICE",
            role: "PRIMARY_INVOICE",
            active: true,
          },
          select: { localId: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    activityByRecord: buildXeroActivityByRecord(activityOperations),
    invoiceLinkedPaymentIds: new Set(primaryInvoiceLinks.map((link) => link.localId)),
  };
}

/**
 * Loads the heavy relations + Xero activity for one page of booking ids and
 * derives each row's operational state, preserving the given id order. Every
 * list path funnels through this so only ADMIN_BOOKINGS_PAGE_SIZE bookings
 * ever carry the full include tree.
 */
async function hydrateBookingPage(
  pageIds: string[],
  bedAllocationEnabled: boolean
): Promise<AdminBookingRow[]> {
  const pageCandidates = await loadBookingCandidates({ id: { in: pageIds } });
  const { activityByRecord, invoiceLinkedPaymentIds } =
    await loadXeroStateInputs(pageCandidates);
  const rowsById = new Map(
    pageCandidates.map((booking): [string, AdminBookingRow] => [
      booking.id,
      {
        ...booking,
        operational: deriveBookingOperationalState(
          booking,
          activityByRecord,
          invoiceLinkedPaymentIds,
          { bedAllocationEnabled }
        ),
        // Defaulted here so the row type is satisfied; set for real by
        // annotateExclusiveHoldOverlaps on the hydrated page (#119).
        overlapsExclusiveHold: false,
      },
    ])
  );

  return pageIds.flatMap((id) => rowsById.get(id) ?? []);
}

export async function listAdminBookings(
  query: AdminBookingsQuery,
  options: AdminBookingsOptions,
  /**
   * The club's day and zone for this render. REQUIRED (#3123): the page also
   * calls `buildAdminBookingsWhere` and `appliedBookingViewFilters`, and all
   * three must describe the same day or the diagnostics panel reports a filter
   * the list is not using.
   */
  clubDay: AdminBookingsClubDay,
): Promise<AdminBookingsResult> {
  const sortBy = getAdminBookingSortBy(query);
  const sortDir = query.sortDir ?? getDefaultAdminBookingSortDir(sortBy);
  const bedAllocationEnabled = options.bedAllocationEnabled ?? true;
  const where = buildBookingWhere(query, clubDay);

  // The Xero/bed/change filters are derived from relations + Xero activity in
  // JS, so they force a candidate scan (bounded since #1884, below). When they
  // are all "all" (the default view, including any paymentSource choice —
  // that one filters in SQL) the JS filter step is a no-op and the page can be
  // resolved without scanning candidates at all.
  const derivedFiltersActive =
    query.xeroState !== "all" ||
    (bedAllocationEnabled && query.bedState !== "all") ||
    query.changeState !== "all";

  if (!derivedFiltersActive) {
    const sqlOrderBy = buildBookingSqlOrderBy(sortBy, sortDir);

    if (sqlOrderBy) {
      // Fully pushed-down path (#1884): count + one SQL-ordered page window,
      // then hydrate just that page. Page clamping mirrors clampPageWindow.
      const total = await prisma.booking.count({ where });
      const totalPages = Math.max(1, Math.ceil(total / ADMIN_BOOKINGS_PAGE_SIZE));
      const page = Math.min(Math.max(1, query.page), totalPages);
      const pageRows = await prisma.booking.findMany({
        where,
        select: { id: true },
        orderBy: sqlOrderBy,
        skip: (page - 1) * ADMIN_BOOKINGS_PAGE_SIZE,
        take: ADMIN_BOOKINGS_PAGE_SIZE,
      });

      const bookings = await hydrateBookingPage(
        pageRows.map((row) => row.id),
        bedAllocationEnabled
      );
      await annotateExclusiveHoldOverlaps(bookings);

      return {
        bookings,
        total,
        page,
        totalPages,
        pageSize: ADMIN_BOOKINGS_PAGE_SIZE,
        sortBy,
        sortDir,
      };
    }

    // Fast path (#1146) for the JS-only comparators ("member" lowercased
    // name, "status" lifecycle rank): sort a lightweight projection, then
    // load the heavy relations for only the page actually returned.
    const direction = sortDir === "asc" ? 1 : -1;
    const sortRows = await loadBookingSortRows(where);
    sortRows.sort((left, right) => {
      const primary =
        compareValues(sortRowValue(left, sortBy), sortRowValue(right, sortBy)) *
        direction;
      if (primary !== 0) return primary;
      return left.id.localeCompare(right.id);
    });

    const { pageItems, total, page, totalPages } = clampPageWindow(
      sortRows,
      query.page
    );
    const bookings = await hydrateBookingPage(
      pageItems.map((row) => row.id),
      bedAllocationEnabled
    );
    await annotateExclusiveHoldOverlaps(bookings);

    return {
      bookings,
      total,
      page,
      totalPages,
      pageSize: ADMIN_BOOKINGS_PAGE_SIZE,
      sortBy,
      sortDir,
    };
  }

  // Derived-filter path (#1884): the candidates are scanned in bounded,
  // id-ordered chunks. Each chunk derives operational state, applies the JS
  // filters and keeps only { id, sort key } for the survivors, so peak memory
  // is one chunk of relation-heavy rows regardless of how many bookings
  // match. Chunk-scoped Xero activity lookups are equivalent to a global load
  // because deriveBookingOperationalState only reads records keyed by the
  // booking's own ids. Totals and page contents stay exact — the whole match
  // set is still visited, never truncated.
  const matches: Array<{ id: string; key: string | number | Date }> = [];
  let cursorId: string | undefined;
  for (;;) {
    const chunk = await loadBookingCandidates(where, {
      take: ADMIN_BOOKINGS_DERIVED_SCAN_CHUNK_SIZE,
      cursorId,
    });
    if (chunk.length === 0) break;
    const { activityByRecord, invoiceLinkedPaymentIds } =
      await loadXeroStateInputs(chunk);

    for (const booking of chunk) {
      const operational = deriveBookingOperationalState(
        booking,
        activityByRecord,
        invoiceLinkedPaymentIds,
        { bedAllocationEnabled }
      );
      if (!matchesPaymentSourceFilter(operational.paymentSource, query.paymentSource)) {
        continue;
      }
      if (!matchesXeroStateFilter(operational.xeroState, query.xeroState)) {
        continue;
      }
      if (
        bedAllocationEnabled &&
        !matchesBedStateFilter(operational.bedState, query.bedState)
      ) {
        continue;
      }
      if (!matchesChangeStateFilter(operational, query.changeState)) {
        continue;
      }
      matches.push({ id: booking.id, key: sortValue(booking, sortBy) });
    }

    if (chunk.length < ADMIN_BOOKINGS_DERIVED_SCAN_CHUNK_SIZE) break;
    cursorId = chunk[chunk.length - 1].id;
  }

  const direction = sortDir === "asc" ? 1 : -1;
  matches.sort((left, right) => {
    const primary = compareValues(left.key, right.key) * direction;
    if (primary !== 0) return primary;
    return left.id.localeCompare(right.id);
  });

  const { pageItems, total, page, totalPages } = clampPageWindow(
    matches,
    query.page
  );
  const bookings = await hydrateBookingPage(
    pageItems.map((item) => item.id),
    bedAllocationEnabled
  );
  await annotateExclusiveHoldOverlaps(bookings);

  return {
    bookings,
    total,
    page,
    totalPages,
    pageSize: ADMIN_BOOKINGS_PAGE_SIZE,
    sortBy,
    sortDir,
  };
}
