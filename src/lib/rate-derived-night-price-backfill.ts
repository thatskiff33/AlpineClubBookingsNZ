/**
 * RATE-DERIVED NIGHT PRICES FOR THE EVENLY-SPLIT PAST (#3531 stage 3b,
 * programme #3527; owner decision D-3531-2, 21 September 2026).
 *
 * Two backfills (#1098, #2739) gave every pre-#713 booking and every approved
 * request a night row per night by dividing the guest's stored total evenly.
 * Those rows reconcile - they sum to the total - but no night among them was
 * ever sold at its own figure, and `INV-MOD-028` refuses to read one as a
 * night's price. Since 3a that only matters for a strand an edit MOVES; this
 * module is for those.
 *
 * WHAT COUNTS AS EVIDENCE, and what does not. The pricing engine is run once
 * over the booking's whole party, from what was SOLD: each guest's stored
 * rate-type snapshot, age tier and membership, over the nights their rows
 * hold, against the lodge's rate table. A strand is rewritten ONLY when the
 * engine's per-night vector sums to that strand's stored total to the cent -
 * the total is the one figure the sale left behind, and a rate-table vector
 * that reproduces it is derived from evidence rather than manufactured from a
 * division (#3272 D2). Anything else is LISTED with a reason, never priced.
 * The rows it writes carry `RATE_DERIVED`, so a reader can always tell them
 * from a night somebody sold (`SOLD`) or an officer valued (`OFFICER_PRICED`).
 *
 * NOTHING A MEMBER SEES MOVES (#3272 D3): guest totals, booking totals and
 * every settled figure are untouched; only the split of a total across its
 * nights, and its provenance, change.
 *
 * Planning is pure over rows the caller loaded; applying is a compare-and-set
 * per row on the caller's transaction, the officer repair's single-flight
 * rule (`stored-night-price-repair-store.ts`): a row that no longer holds the
 * price and provenance it was planned from matches nothing and the booking
 * rolls back.
 */
import type {
  AgeTier,
  BookingGuestNightPriceSource,
  Prisma,
} from "@prisma/client";
import {
  calculateBookingPrice,
  type GroupDiscountConfig,
  type GuestInput,
  type RateSource,
  type SeasonRateData,
} from "@/lib/pricing";
import { formatDateOnly } from "@/lib/date-only";
import {
  INEXACT_NIGHT_PRICE_SOURCES,
  storedNightPriceSourceIsInexact,
} from "@/lib/stored-sold-price-evidence";
import { NON_MEMBER_RATE_HOLDER_KEY } from "@/lib/membership-type-rate-coverage";
import {
  applyRateDerivedNightRewrites,
  RateDerivedBackfillRacedError,
} from "@/lib/stored-night-price-repair-store";
import { formatCents } from "@/lib/utils";

/** A stored night row as the planner reads it. */
export type StoredNightRow = {
  id: string;
  stayDate: Date;
  priceCents: number | null;
  priceSource: BookingGuestNightPriceSource;
};

/** A guest strand as stored, with every row it holds. */
export type StoredStrand = {
  id: string;
  ageTier: AgeTier;
  isMember: boolean;
  otherLodgeMember?: boolean | null;
  rateMembershipTypeId: string | null;
  priceCents: number;
  nights: readonly StoredNightRow[];
};

export type StoredBookingForBackfill = {
  id: string;
  checkIn: Date;
  checkOut: Date;
  guests: readonly StoredStrand[];
};

/** Why a candidate strand is listed rather than rewritten. */
export type RateDerivationResidueReason =
  /** The strand carries no rate-type snapshot (a pre-#1930 booking). */
  | "NO_RATE_SNAPSHOT"
  /** A night's price is NULL - what it sold for is not known (3a's blank rule). */
  | "UNVALUED_NIGHT"
  /** The engine could not price a night: no active season rate covers it. */
  | "NO_SEASON_RATE"
  /** The engine's vector does not reproduce the stored total to the cent. */
  | "RATE_TABLE_DOES_NOT_REPRODUCE_TOTAL"
  /**
   * A member priced at the non-member type may have been a type-forced member
   * (no group discount) or a #2543 lockout reprice (discount-eligible); the
   * snapshot cannot say which, and BOTH readings reproduce the total with
   * different splits. Listed rather than guessed.
   */
  | "AMBIGUOUS_RATE_SOURCE";

export type StrandRewritePlan = {
  bookingGuestId: string;
  guestTotalCents: number;
  /** Every row, planned from the price and provenance it was read holding. */
  nights: ReadonlyArray<{
    id: string;
    date: string;
    fromPriceCents: number;
    fromSource: BookingGuestNightPriceSource;
    toPriceCents: number;
  }>;
};

export type StrandResidue = {
  bookingGuestId: string;
  guestTotalCents: number;
  reason: RateDerivationResidueReason;
  /** The engine's sum where it priced the strand but disagreed. */
  derivedTotalCents?: number;
};

export { RateDerivedBackfillRacedError };

export type BookingBackfillPlan = {
  bookingId: string;
  rewrite: StrandRewritePlan[];
  residue: StrandResidue[];
};

/**
 * Is this strand one the backfill is for: every row carries a price and none
 * was sold or officer-valued night by night?
 */
export function isRateDerivationCandidate(strand: StoredStrand): boolean {
  return (
    strand.nights.length > 0 &&
    strand.nights.every((night) => storedNightPriceSourceIsInexact(night.priceSource))
  );
}

/**
 * The sale-time rate source, read back from what was stored. The engine keys
 * a night's RATE on the stored snapshot; the source decides only whether the
 * group discount may substitute the guest's type, and it does so for
 * `NON_MEMBER_DEFAULT` alone (`calculateBookingPrice`).
 *
 * ONE SHAPE IS AMBIGUOUS: a member whose snapshot is the built-in NON_MEMBER
 * type was either a type-forced member (`TYPE_POLICY_FORCED`, no discount) or
 * a #2543 unpaid-subscription reprice (`NON_MEMBER_DEFAULT`, discount-eligible),
 * and the snapshot records neither. The planner evaluates such a strand under
 * BOTH readings and accepts only a reading that reproduces the total while the
 * other does not, or both reproducing identically; two different reproducing
 * splits are `AMBIGUOUS_RATE_SOURCE`. A wrong reading elsewhere cannot invent
 * money, because the total check refuses a vector that does not reproduce.
 */
function rateSourceFromSnapshot(
  strand: StoredStrand,
  nonMemberTypeId: string | null,
  ambiguousMemberReading: "TYPE_POLICY_FORCED" | "NON_MEMBER_DEFAULT",
): RateSource {
  if (strand.otherLodgeMember) return "OTHER_LODGE_MEMBER";
  if (!strand.isMember) return "NON_MEMBER_DEFAULT";
  return strand.rateMembershipTypeId !== null && strand.rateMembershipTypeId === nonMemberTypeId
    ? ambiguousMemberReading
    : "OWN_TYPE";
}

function isAmbiguousMember(strand: StoredStrand, nonMemberTypeId: string | null): boolean {
  return (
    strand.isMember &&
    !strand.otherLodgeMember &&
    strand.rateMembershipTypeId !== null &&
    strand.rateMembershipTypeId === nonMemberTypeId
  );
}

/**
 * Plan one booking: run the engine over the whole party as sold, then judge
 * each candidate strand by whether the vector reproduces its stored total.
 * Non-candidate strands (already `SOLD` / `OFFICER_PRICED`, or `RATE_DERIVED`
 * from an earlier run) take part in the pricing - they count towards the
 * party for the group discount - and are never rewritten.
 */
export function planRateDerivedNightPrices(args: {
  booking: StoredBookingForBackfill;
  seasons: SeasonRateData[];
  groupDiscount: GroupDiscountConfig | undefined;
  nonMemberTypeId: string | null;
}): BookingBackfillPlan {
  const { booking } = args;
  const rewrite: StrandRewritePlan[] = [];
  const residue: StrandResidue[] = [];

  const candidates = booking.guests.filter(isRateDerivationCandidate);
  if (candidates.length === 0) {
    return { bookingId: booking.id, rewrite, residue };
  }

  // Refusals that need no engine run, and strands the engine must not be
  // handed at all (no snapshot means no rate rows to read).
  const priceable: StoredStrand[] = [];
  for (const strand of booking.guests) {
    const candidate = candidates.includes(strand);
    if (candidate && strand.nights.some((night) => night.priceCents === null)) {
      residue.push({ bookingGuestId: strand.id, guestTotalCents: strand.priceCents, reason: "UNVALUED_NIGHT" });
      continue;
    }
    if (strand.rateMembershipTypeId === null) {
      if (candidate) {
        residue.push({ bookingGuestId: strand.id, guestTotalCents: strand.priceCents, reason: "NO_RATE_SNAPSHOT" });
      }
      // A non-candidate without a snapshot still occupies beds for the party
      // count, but it cannot be priced; the engine is handed the party that
      // can be. A wrong party count changes only the discount, and a wrong
      // discount cannot pass the total check.
      continue;
    }
    priceable.push(strand);
  }

  // Two engine runs at most: every ambiguous member read as type-forced, then
  // as discount-eligible. A guest's own vector depends on its own reading only
  // (the party count that gates the discount counts everybody regardless), so
  // run A holds each ambiguous strand's forced vector and run B its eligible
  // one, whatever the other strands are.
  const guestsUnder = (reading: "TYPE_POLICY_FORCED" | "NON_MEMBER_DEFAULT"): GuestInput[] =>
    priceable.map((strand) => ({
      ageTier: strand.ageTier,
      isMember: strand.isMember,
      otherLodgeMember: strand.otherLodgeMember ?? null,
      rateMembershipTypeId: strand.rateMembershipTypeId as string,
      rateSource: rateSourceFromSnapshot(strand, args.nonMemberTypeId, reading),
      nights: strand.nights.map((night) => night.stayDate),
    }));
  const anyAmbiguous = priceable.some((strand) => isAmbiguousMember(strand, args.nonMemberTypeId));

  let forced: ReturnType<typeof calculateBookingPrice>;
  let eligible: ReturnType<typeof calculateBookingPrice> | null = null;
  try {
    forced = calculateBookingPrice(booking.checkIn, booking.checkOut, guestsUnder("TYPE_POLICY_FORCED"), args.seasons, args.groupDiscount);
    eligible = anyAmbiguous
      ? calculateBookingPrice(booking.checkIn, booking.checkOut, guestsUnder("NON_MEMBER_DEFAULT"), args.seasons, args.groupDiscount)
      : null;
  } catch {
    for (const strand of priceable) {
      if (candidates.includes(strand)) {
        residue.push({ bookingGuestId: strand.id, guestTotalCents: strand.priceCents, reason: "NO_SEASON_RATE" });
      }
    }
    return { bookingId: booking.id, rewrite, residue };
  }

  const reproduces = (strand: StoredStrand, priced: ReturnType<typeof calculateBookingPrice>["guests"][number] | undefined) => {
    const derivedTotalCents = priced?.perNightCents.reduce((sum, cents) => sum + cents, 0) ?? NaN;
    const ok =
      priced !== undefined &&
      priced.perNightCents.length === strand.nights.length &&
      (priced.nightDates ?? []).length === strand.nights.length &&
      priced.perNightCents.every((cents) => Number.isInteger(cents) && cents >= 0) &&
      derivedTotalCents === strand.priceCents;
    return { ok, derivedTotalCents };
  };

  priceable.forEach((strand, index) => {
    if (!candidates.includes(strand)) return;
    const forcedRead = reproduces(strand, forced.guests[index]);
    let priced = forced.guests[index];
    if (isAmbiguousMember(strand, args.nonMemberTypeId) && eligible !== null) {
      const eligibleRead = reproduces(strand, eligible.guests[index]);
      if (forcedRead.ok && eligibleRead.ok) {
        const same =
          forced.guests[index]!.perNightCents.length === eligible.guests[index]!.perNightCents.length &&
          forced.guests[index]!.perNightCents.every((cents, k) => cents === eligible!.guests[index]!.perNightCents[k]);
        if (!same) {
          residue.push({ bookingGuestId: strand.id, guestTotalCents: strand.priceCents, reason: "AMBIGUOUS_RATE_SOURCE", derivedTotalCents: strand.priceCents });
          return;
        }
      } else if (eligibleRead.ok) {
        priced = eligible.guests[index];
      }
    }
    const verdict = reproduces(strand, priced);
    const derivedTotalCents = verdict.derivedTotalCents;
    const nightDates = priced?.nightDates ?? [];
    if (!verdict.ok || priced === undefined) {
      residue.push({
        bookingGuestId: strand.id,
        guestTotalCents: strand.priceCents,
        reason: "RATE_TABLE_DOES_NOT_REPRODUCE_TOTAL",
        ...(Number.isFinite(derivedTotalCents) ? { derivedTotalCents } : {}),
      });
      return;
    }
    // Pair each derived night with the stored row for that date; a mismatch
    // in the date set is a planner defect, refused rather than guessed.
    const byDate = new Map(strand.nights.map((night) => [formatDateOnly(night.stayDate), night]));
    const nights: Array<StrandRewritePlan["nights"][number]> = [];
    for (let k = 0; k < nightDates.length; k += 1) {
      const date = formatDateOnly(nightDates[k]!);
      const row = byDate.get(date);
      if (!row || row.priceCents === null) {
        residue.push({ bookingGuestId: strand.id, guestTotalCents: strand.priceCents, reason: "RATE_TABLE_DOES_NOT_REPRODUCE_TOTAL", derivedTotalCents });
        return;
      }
      nights.push({
        id: row.id,
        date,
        fromPriceCents: row.priceCents,
        fromSource: row.priceSource,
        toPriceCents: priced.perNightCents[k]!,
      });
    }
    rewrite.push({ bookingGuestId: strand.id, guestTotalCents: strand.priceCents, nights });
  });

  return { bookingId: booking.id, rewrite, residue };
}

/**
 * Write one booking's plan on the caller's transaction. The write itself lives
 * in `stored-night-price-repair-store.ts` - the one module that rewrites a
 * night row in place (`INV-MOD-028`'s census) - and this hands it the plan.
 */
export async function applyRateDerivedNightPrices(
  plan: BookingBackfillPlan,
  store: Pick<Prisma.TransactionClient, "bookingGuestNight">,
): Promise<number> {
  return applyRateDerivedNightRewrites(plan.rewrite, store);
}

/**
 * The audit rows one booking's apply writes: ONE PER REWRITTEN STRAND, carrying
 * that strand's every before/after pair, plus one for the booking with the
 * counts and the residue. Per strand rather than one row per booking because
 * the audit writer caps a row's metadata and drops a non-string field whole
 * past it (`audit-structured-detail.ts`); a large imported party would lose
 * exactly the before/after pairs that are this rewrite's reverse path. A
 * strand's nights are a handful, so a strand row always fits.
 */
export function rateDerivedBackfillAuditRows(plan: BookingBackfillPlan, format: ClubFormat): Array<{
  entityType: "Booking" | "BookingGuest";
  entityId: string;
  summary: string;
  details: string;
  metadata: Record<string, unknown>;
}> {
  const strandRows = plan.rewrite.map((strand) => ({
    entityType: "BookingGuest" as const,
    entityId: strand.bookingGuestId,
    summary: "Re-derived a guest's evenly-split night prices from the rate table; the guest's total unchanged",
    details: `${strand.nights.length} night row(s) now RATE_DERIVED; guest total ${formatCents(strand.guestTotalCents, format)} unchanged`,
    metadata: {
      bookingId: plan.bookingId,
      bookingGuestId: strand.bookingGuestId,
      guestTotalCents: strand.guestTotalCents,
      nightPrices: strand.nights.map((night) => ({
        date: night.date,
        fromPriceCents: night.fromPriceCents,
        fromSource: night.fromSource,
        toPriceCents: night.toPriceCents,
      })),
    },
  }));
  const bookingRow = {
    entityType: "Booking" as const,
    entityId: plan.bookingId,
    summary: "Re-derived a booking's evenly-split night prices from the rate table; every guest total unchanged",
    details: `${plan.rewrite.length} strand(s) rewritten as RATE_DERIVED (one entry each); ${plan.residue.length} strand(s) listed as residue`,
    metadata: {
      bookingId: plan.bookingId,
      rewrittenStrandIds: plan.rewrite.map((strand) => strand.bookingGuestId),
      residue: plan.residue,
    },
  };
  return [...strandRows, bookingRow];
}

/** A human-readable report of a set of plans, for the dry run and the apply. */
export function formatRateDerivedBackfillReport(plans: readonly BookingBackfillPlan[], format: ClubFormat): string {
  const rewriteStrands = plans.reduce((n, plan) => n + plan.rewrite.length, 0);
  const rewriteRows = plans.reduce(
    (n, plan) => n + plan.rewrite.reduce((m, strand) => m + strand.nights.length, 0),
    0,
  );
  const residueByReason = new Map<RateDerivationResidueReason, number>();
  for (const plan of plans) {
    for (const item of plan.residue) {
      residueByReason.set(item.reason, (residueByReason.get(item.reason) ?? 0) + 1);
    }
  }
  const lines = [
    `Bookings examined: ${plans.length}`,
    `Strands to rewrite: ${rewriteStrands} (${rewriteRows} night rows)`,
    `Residue (listed, never priced): ${[...residueByReason.values()].reduce((a, b) => a + b, 0)}`,
    ...[...residueByReason.entries()].map(([reason, count]) => `  ${reason}: ${count}`),
  ];
  for (const plan of plans) {
    if (plan.rewrite.length === 0 && plan.residue.length === 0) continue;
    lines.push(`Booking ${plan.bookingId}:`);
    for (const strand of plan.rewrite) {
      lines.push(
        `  rewrite guest ${strand.bookingGuestId} (total ${formatCents(strand.guestTotalCents, format)}): ${strand.nights
          .map((night) => `${night.date} ${formatCents(night.fromPriceCents, format)}->${formatCents(night.toPriceCents, format)}`)
          .join(", ")}`,
      );
    }
    for (const item of plan.residue) {
      lines.push(
        `  residue guest ${item.bookingGuestId} (total ${formatCents(item.guestTotalCents, format)}): ${item.reason}${
          item.derivedTotalCents !== undefined ? ` (derived ${formatCents(item.derivedTotalCents, format)})` : ""
        }`,
      );
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The store-facing runner: load, plan, and (on --apply) write with an audit row
// ---------------------------------------------------------------------------

import { prisma } from "./prisma";
import { createAuditLog } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import { loadActiveSeasonRates } from "@/lib/booking-modify-plan";
import { toGroupDiscountConfig } from "@/lib/policies/booking-route-decisions";
import type { ClubFormat } from "@/lib/club-format";

/** The bookings that hold at least one candidate strand, oldest first. */
export async function findRateDerivationCandidateBookings(
  store: typeof prisma,
  scope: { bookingId?: string | null; limit?: number | null } = {},
): Promise<string[]> {
  const rows = await store.bookingGuestNight.findMany({
    where: {
      // The same set the candidate predicate reads, so the pre-filter cannot
      // stop finding what the planner would judge. NULL rows are kept so a
      // strand holding one is LISTED (`UNVALUED_NIGHT`) rather than unseen.
      priceSource: { in: [...INEXACT_NIGHT_PRICE_SOURCES] },
      ...(scope.bookingId ? { bookingGuest: { bookingId: scope.bookingId } } : {}),
    },
    select: { bookingGuest: { select: { bookingId: true, booking: { select: { createdAt: true } } } } },
    distinct: ["bookingGuestId"],
  });
  const byBooking = new Map<string, Date>();
  for (const row of rows) {
    const id = row.bookingGuest.bookingId;
    if (!byBooking.has(id)) byBooking.set(id, row.bookingGuest.booking.createdAt);
  }
  const ordered = [...byBooking.entries()].sort((a, b) => a[1].getTime() - b[1].getTime()).map(([id]) => id);
  return scope.limit ? ordered.slice(0, scope.limit) : ordered;
}

/** Plan one booking from the database: its party as sold, its lodge's rates. */
export async function planBookingFromStore(
  store: typeof prisma,
  bookingId: string,
  config: { groupDiscount: GroupDiscountConfig | undefined; nonMemberTypeId: string | null },
): Promise<BookingBackfillPlan> {
  const booking = await store.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: {
      id: true,
      lodgeId: true,
      checkIn: true,
      checkOut: true,
      guests: {
        select: {
          id: true,
          ageTier: true,
          isMember: true,
          otherLodgeMember: true,
          rateMembershipTypeId: true,
          priceCents: true,
          nights: { select: { id: true, stayDate: true, priceCents: true, priceSource: true }, orderBy: { stayDate: "asc" } },
        },
      },
    },
  });
  const seasons = await loadActiveSeasonRates(store, booking.lodgeId);
  return planRateDerivedNightPrices({
    booking: { id: booking.id, checkIn: booking.checkIn, checkOut: booking.checkOut, guests: booking.guests },
    seasons,
    groupDiscount: config.groupDiscount,
    nonMemberTypeId: config.nonMemberTypeId,
  });
}

/** What the backfill needs once for every booking: the discount config and the NON_MEMBER type. */
export async function loadRateDerivationConfig(store: typeof prisma) {
  const [setting, nonMember] = await Promise.all([
    store.groupDiscountSetting.findUnique({ where: { id: "default" } }),
    store.membershipType.findFirst({ where: { key: NON_MEMBER_RATE_HOLDER_KEY }, select: { id: true } }),
  ]);
  return {
    // The FIRST-purchase mapper: the backfill reproduces what a sale priced,
    // and a sale never goes through the edit-time switch.
    groupDiscount: toGroupDiscountConfig(setting),
    nonMemberTypeId: nonMember?.id ?? null,
  };
}

export type RateDerivedBackfillRun = {
  mode: "dry-run" | "apply";
  plans: BookingBackfillPlan[];
  applied: Array<{ bookingId: string; rows: number }>;
  raced: string[];
};

/**
 * Plan every candidate booking and, on `apply`, write each in its own
 * transaction with its audit row. A raced booking is skipped and named; the
 * next run plans it again from what it then holds.
 */
export async function runRateDerivedNightPriceBackfill(args: {
  store?: typeof prisma;
  apply: boolean;
  format: ClubFormat;
  bookingId?: string | null;
  limit?: number | null;
}): Promise<RateDerivedBackfillRun> {
  // The caller resolves the club's format before this transaction-capable
  // library entry point; no second pooled setting read may occur under a lock.
  const format = args.format;
  const store = args.store ?? prisma;
  const config = await loadRateDerivationConfig(store);
  const bookingIds = await findRateDerivationCandidateBookings(store, { bookingId: args.bookingId, limit: args.limit });
  const plans: BookingBackfillPlan[] = [];
  const applied: RateDerivedBackfillRun["applied"] = [];
  const raced: string[] = [];
  for (const bookingId of bookingIds) {
    const plan = await planBookingFromStore(store, bookingId, config);
    plans.push(plan);
    if (!args.apply || plan.rewrite.length === 0) continue;
    try {
      const rows = await store.$transaction(async (tx) => {
        const written = await applyRateDerivedNightPrices(plan, tx);
        // The subject is the owner's member id, and only that: an
        // organisation-owned booking has none, exactly as the officer repair
        // records it (`bookingOwner` reads `memberId` alone from this shape).
        const booking = await tx.booking.findUniqueOrThrow({
          where: { id: bookingId },
          select: { memberId: true },
        });
        // One write site, several rows: a row per rewritten strand with its
        // before/after pairs, then the booking's own with the counts.
        for (const row of rateDerivedBackfillAuditRows(plan, format)) {
          await createAuditLog(
            {
              action: "booking-payment.stored-night-price.rate-derived",
              // No session actor: an operator-run backfill. The subject is the
              // booking's owner, as the officer repair records it.
              memberId: null,
              subjectMemberId: bookingOwner(booking).memberId,
              targetId: bookingId,
              entityType: row.entityType,
              entityId: row.entityId,
              category: "payment",
              severity: "important",
              outcome: "success",
              summary: row.summary,
              details: row.details,
              metadata: row.metadata,
            },
            tx,
          );
        }
        return written;
      });
      applied.push({ bookingId, rows });
    } catch (error) {
      if (error instanceof RateDerivedBackfillRacedError) {
        raced.push(bookingId);
        continue;
      }
      throw error;
    }
  }
  return { mode: args.apply ? "apply" : "dry-run", plans, applied, raced };
}
