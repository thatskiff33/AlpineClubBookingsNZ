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
import { storedNightPriceSourceIsInexact } from "@/lib/stored-sold-price-evidence";
import {
  applyRateDerivedNightRewrites,
  RateDerivedBackfillRacedError,
} from "@/lib/stored-night-price-repair-store";

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
  | "RATE_TABLE_DOES_NOT_REPRODUCE_TOTAL";

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
 * The sale-time rate source, read back from what was stored. It matters only
 * to the group-discount substitution, which lifts a `NON_MEMBER_DEFAULT` guest
 * to the configured type; a wrong reading here cannot invent money, because
 * the total check below refuses a vector that does not reproduce the sale.
 */
function rateSourceFromSnapshot(
  strand: StoredStrand,
  nonMemberTypeId: string | null,
): RateSource {
  if (strand.otherLodgeMember) return "OTHER_LODGE_MEMBER";
  if (!strand.isMember) return "NON_MEMBER_DEFAULT";
  return strand.rateMembershipTypeId !== null && strand.rateMembershipTypeId === nonMemberTypeId
    ? "TYPE_POLICY_FORCED"
    : "OWN_TYPE";
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

  const guests: GuestInput[] = priceable.map((strand) => ({
    ageTier: strand.ageTier,
    isMember: strand.isMember,
    otherLodgeMember: strand.otherLodgeMember ?? null,
    rateMembershipTypeId: strand.rateMembershipTypeId as string,
    rateSource: rateSourceFromSnapshot(strand, args.nonMemberTypeId),
    nights: strand.nights.map((night) => night.stayDate),
  }));

  let breakdown: ReturnType<typeof calculateBookingPrice>;
  try {
    breakdown = calculateBookingPrice(booking.checkIn, booking.checkOut, guests, args.seasons, args.groupDiscount);
  } catch {
    for (const strand of priceable) {
      if (candidates.includes(strand)) {
        residue.push({ bookingGuestId: strand.id, guestTotalCents: strand.priceCents, reason: "NO_SEASON_RATE" });
      }
    }
    return { bookingId: booking.id, rewrite, residue };
  }

  priceable.forEach((strand, index) => {
    if (!candidates.includes(strand)) return;
    const priced = breakdown.guests[index];
    const derivedTotalCents = priced?.perNightCents.reduce((sum, cents) => sum + cents, 0) ?? NaN;
    const nightDates = priced?.nightDates ?? [];
    const reproduces =
      priced !== undefined &&
      priced.perNightCents.length === strand.nights.length &&
      nightDates.length === strand.nights.length &&
      priced.perNightCents.every((cents) => Number.isInteger(cents) && cents >= 0) &&
      derivedTotalCents === strand.priceCents;
    if (!reproduces) {
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

/** The audit row's metadata for one booking's apply: every strand, before and after. */
export function rateDerivedBackfillAuditMetadata(plan: BookingBackfillPlan) {
  return {
    bookingId: plan.bookingId,
    rewrittenStrands: plan.rewrite.map((strand) => ({
      bookingGuestId: strand.bookingGuestId,
      guestTotalCents: strand.guestTotalCents,
      nightPrices: strand.nights.map((night) => ({
        date: night.date,
        fromPriceCents: night.fromPriceCents,
        fromSource: night.fromSource,
        toPriceCents: night.toPriceCents,
      })),
    })),
    residue: plan.residue,
  };
}

/** A human-readable report of a set of plans, for the dry run and the apply. */
export function formatRateDerivedBackfillReport(plans: readonly BookingBackfillPlan[]): string {
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
        `  rewrite guest ${strand.bookingGuestId} (total ${strand.guestTotalCents}c): ${strand.nights
          .map((night) => `${night.date} ${night.fromPriceCents}->${night.toPriceCents}`)
          .join(", ")}`,
      );
    }
    for (const item of plan.residue) {
      lines.push(
        `  residue guest ${item.bookingGuestId} (total ${item.guestTotalCents}c): ${item.reason}${
          item.derivedTotalCents !== undefined ? ` (derived ${item.derivedTotalCents}c)` : ""
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

const NON_MEMBER_MEMBERSHIP_TYPE_KEY = "NON_MEMBER";

/** The bookings that hold at least one candidate strand, oldest first. */
export async function findRateDerivationCandidateBookings(
  store: typeof prisma,
  scope: { bookingId?: string | null; limit?: number | null } = {},
): Promise<string[]> {
  const rows = await store.bookingGuestNight.findMany({
    where: {
      priceSource: { in: ["EVEN_SPLIT", "UNKNOWN"] },
      priceCents: { not: null },
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
    store.membershipType.findFirst({ where: { key: NON_MEMBER_MEMBERSHIP_TYPE_KEY }, select: { id: true } }),
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
  bookingId?: string | null;
  limit?: number | null;
}): Promise<RateDerivedBackfillRun> {
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
        const booking = await tx.booking.findUniqueOrThrow({
          where: { id: bookingId },
          select: { memberId: true, organisationId: true, member: { select: { id: true } }, organisation: { select: { name: true, email: true } } },
        });
        await createAuditLog(
          {
            action: "booking-payment.stored-night-price.rate-derived",
            // No session actor: an operator-run backfill. The subject is the
            // booking's owner, as the officer repair records it.
            memberId: null,
            subjectMemberId: bookingOwner(booking).memberId,
            targetId: bookingId,
            entityType: "Booking",
            entityId: bookingId,
            category: "payment",
            severity: "important",
            outcome: "success",
            summary: "Re-derived a booking's evenly-split night prices from the rate table; every guest total unchanged",
            details: `${plan.rewrite.length} strand(s), ${written} night row(s) now RATE_DERIVED; ${plan.residue.length} strand(s) listed as residue`,
            metadata: rateDerivedBackfillAuditMetadata(plan),
          },
          tx,
        );
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
