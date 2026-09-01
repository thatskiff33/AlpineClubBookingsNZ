/**
 * Historical Xero invoice rounding-drift audit (issue #1318, read-only).
 *
 * PR #1231 fixed issue #1163: before it, `buildInvoiceLineItems` grouped a
 * guest's nights into contiguous **date** runs only (issue #713) and billed each
 * run as `quantity: nightCount, unitAmount: round(totalCents / nightCount) / 100`.
 * When a single contiguous run mixed nightly prices (a season boundary, or
 * locked-vs-re-priced nights), `nightCount * round(totalCents / nightCount)` could
 * not represent the exact cent total, so the issued Xero invoice's guest-line
 * total drifted 1–2 cents from the true ledger. The same rounding also bit the
 * legacy no-per-night path whenever `guest.priceCents` was not divisible by the
 * night count. #1231 split every run to a single price so the lines reconcile by
 * construction — but it did NOT retroactively heal invoices already issued.
 *
 * This module is a **diagnostic only**. It replays the pre-#1231 line maths over
 * persisted booking/guest/night data — entirely in integer cents — and flags
 * issued invoices whose guest-line total would have drifted. It makes ZERO live
 * provider calls (no Xero, no Stripe), opens no transactions, and mutates
 * nothing. See `scripts/audit-xero-invoice-rounding.ts` for the operator CLI and
 * `docs/xero/ARCHITECTURE.md` for the fresh-install / fork stance.
 *
 * IMPORTANT: a flag means "this booking's data would have produced a drifting
 * line total under the pre-#1231 builder." It does NOT prove the live Xero
 * invoice is still wrong: the invoice may have been issued after #1231 was
 * deployed (already correct), or since voided/credited/superseded. Operators
 * must confirm against Xero before treating a flag as a real accounting error.
 */

import { BookingStatus } from "@prisma/client";
import { getStayNights } from "./pricing";
import { formatDateOnly } from "@/lib/date-only";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface AuditGuestNight {
  stayDate: Date;
  /**
   * A NUMBER, always. #3170 made `BookingGuestNight.priceCents` nullable, and a
   * null is deliberately unrepresentable HERE: `mapAuditGuest` drops a guest's
   * whole per-night detail the moment one night is unknown, exactly as the
   * invoice builder does, so nothing downstream of that filter has to remember
   * that a night price might be missing.
   */
  priceCents: number;
}

export interface AuditGuest {
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  priceCents: number;
  // Per-night rows (issue #713). Empty/null => legacy flat-total path.
  nights?: AuditGuestNight[] | null;
}

/** One contiguous pre-#1231 date run and the drift its rounding introduced. */
interface DriftRun {
  startDate: string; // YYYY-MM-DD
  endExclusive: string; // YYYY-MM-DD
  nightCount: number;
  /** True cent ledger for the run (sum of the nights' prices). */
  totalCents: number;
  /** The rounded per-night amount the old builder billed: round(totalCents/n). */
  roundedPerNightCents: number;
  /** What Xero charged for the run: nightCount * roundedPerNightCents. */
  emittedTotalCents: number;
  /** emittedTotalCents - totalCents. Non-zero => this run drifted. */
  driftCents: number;
  /** True when nights within the run mixed prices (the #1163 trigger). */
  mixedPrices: boolean;
}

export interface GuestDrift {
  guestName: string;
  ageTier: string;
  isMember: boolean;
  /** Only the runs that actually drifted (driftCents !== 0). */
  driftedRuns: DriftRun[];
  /** Sum of driftCents across the guest's runs. */
  guestDriftCents: number;
}

/**
 * Which builder path issued the invoice:
 *  - BOOKING: a per-booking invoice (`Payment.xeroInvoiceId`).
 *  - GROUP_SETTLEMENT: one combined ORGANISER_PAYS settlement invoice
 *    (`GroupBookingSettlement.xeroInvoiceId`) aggregating many child bookings.
 * Both paths run through the same `buildInvoiceLineItems`, so both share the
 * pre-#1231 drift exposure.
 */
type RoundingDriftSource = "BOOKING" | "GROUP_SETTLEMENT";

export interface InvoiceRoundingDrift {
  source: RoundingDriftSource;
  /** Local record id: `Booking.id` (BOOKING) or `GroupBookingSettlement.id` (GROUP_SETTLEMENT). */
  sourceId: string;
  /** Group booking id for the GROUP_SETTLEMENT source; null for BOOKING. */
  groupBookingId: string | null;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  /**
   * Proxy for when the invoice was issued: `Payment.createdAt` (BOOKING) or
   * `GroupBookingSettlement.createdAt` (GROUP_SETTLEMENT). Both pre-exist the
   * Xero invoice, so filtering on them is over-inclusive-but-safe.
   */
  issuedAtProxy: string | null; // ISO
  /** Signed total drift across all guests (all children, for a settlement), integer cents. */
  totalDriftCents: number;
  guests: GuestDrift[];
}

/**
 * Replay the pre-#1231 grouping for one guest: split into contiguous **date**
 * runs (NO price boundary — that omission is exactly the bug) and, for each run,
 * apply the old `round(totalCents / nightCount)` per-night rounding.
 *
 * This intentionally reproduces the old code byte-for-byte, including the same
 * float `Math.round(...)` and the same `formatDateOnly`-based contiguity check, so
 * it detects the exact half-cent cases the audit exists to find. Do not
 * "improve" the rounding here.
 */
export function computeGuestRoundingDrift(
  guest: AuditGuest,
  bookingNights: number
): GuestDrift {
  const guestNights = guest.nights ?? [];
  const runs: DriftRun[] = [];

  if (guestNights.length === 0) {
    // Legacy flat-total path. The old builder emitted a single line
    // `quantity: nights, unitAmount: round(priceCents / nights) / 100`.
    // A degenerate range (nights <= 0) emitted quantity 0 in BOTH the old and
    // new builders (identical output), so it carries no #1163 drift — skip it.
    if (bookingNights > 0) {
      const rounded = Math.round(guest.priceCents / bookingNights);
      const emitted = bookingNights * rounded;
      runs.push({
        startDate: "",
        endExclusive: "",
        nightCount: bookingNights,
        totalCents: guest.priceCents,
        roundedPerNightCents: rounded,
        emittedTotalCents: emitted,
        driftCents: emitted - guest.priceCents,
        mixedPrices: false, // flat total, no per-night detail
      });
    }
  } else {
    // Per-night path: contiguous DATE runs, mirroring the pre-#1231
    // groupNightsIntoRuns (which did NOT split on price change).
    const sorted = [...guestNights].sort(
      (a, b) => a.stayDate.getTime() - b.stayDate.getTime()
    );
    interface RawRun {
      startDate: Date;
      endExclusive: Date;
      nightCount: number;
      totalCents: number;
      minPrice: number;
      maxPrice: number;
    }
    const rawRuns: RawRun[] = [];
    for (const night of sorted) {
      const last = rawRuns[rawRuns.length - 1];
      const contiguous =
        last !== undefined &&
        formatDateOnly(new Date(last.endExclusive)) === formatDateOnly(night.stayDate);
      if (last && contiguous) {
        // Pre-#1231: extend on date contiguity ALONE (no price check).
        last.endExclusive = new Date(night.stayDate.getTime() + ONE_DAY_MS);
        last.nightCount += 1;
        last.totalCents += night.priceCents;
        last.minPrice = Math.min(last.minPrice, night.priceCents);
        last.maxPrice = Math.max(last.maxPrice, night.priceCents);
      } else {
        rawRuns.push({
          startDate: night.stayDate,
          endExclusive: new Date(night.stayDate.getTime() + ONE_DAY_MS),
          nightCount: 1,
          totalCents: night.priceCents,
          minPrice: night.priceCents,
          maxPrice: night.priceCents,
        });
      }
    }
    for (const raw of rawRuns) {
      const rounded =
        raw.nightCount > 0
          ? Math.round(raw.totalCents / raw.nightCount)
          : raw.totalCents;
      const emitted = raw.nightCount * rounded;
      runs.push({
        startDate: formatDateOnly(new Date(raw.startDate)),
        endExclusive: formatDateOnly(new Date(raw.endExclusive)),
        nightCount: raw.nightCount,
        totalCents: raw.totalCents,
        roundedPerNightCents: rounded,
        emittedTotalCents: emitted,
        driftCents: emitted - raw.totalCents,
        mixedPrices: raw.minPrice !== raw.maxPrice,
      });
    }
  }

  const driftedRuns = runs.filter((run) => run.driftCents !== 0);
  const guestDriftCents = driftedRuns.reduce((sum, run) => sum + run.driftCents, 0);

  return {
    guestName: `${guest.firstName} ${guest.lastName}`.trim(),
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    driftedRuns,
    guestDriftCents,
  };
}

/**
 * One block of line items the invoice builder emitted from a single
 * `buildInvoiceLineItems` call: a set of guests billed over one night count. A
 * per-booking invoice is one block; a group-settlement invoice is one block per
 * child booking (mirroring the per-child loop in
 * `xero-group-settlement-invoices.ts`).
 */
interface DriftLineBlock {
  bookingNights: number;
  guests: AuditGuest[];
}

function toIsoOrNull(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Merge the drift across one or more line blocks. A candidate exists iff at
 * least one guest run drifted. Net drift can be zero while individual runs
 * differ (rare ± cases); such invoices are kept, since their line totals were
 * still individually wrong under the old builder.
 */
function mergeBlockDrift(
  blocks: DriftLineBlock[]
): { guests: GuestDrift[]; totalDriftCents: number } {
  const guests: GuestDrift[] = [];
  for (const block of blocks) {
    for (const guest of block.guests) {
      const drift = computeGuestRoundingDrift(guest, block.bookingNights);
      if (drift.driftedRuns.length > 0) guests.push(drift);
    }
  }
  const totalDriftCents = guests.reduce((sum, g) => sum + g.guestDriftCents, 0);
  return { guests, totalDriftCents };
}

export interface BookingRoundingDriftInput {
  bookingId: string;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  issuedAtProxy: Date | string | null;
  bookingNights: number;
  guests: AuditGuest[];
}

/**
 * Compute the total pre-#1231 rounding drift for one booking's issued invoice.
 * Returns null when nothing drifted (the invoice is clean). Promo/entrance/
 * supplementary lines are `quantity: 1` exact-cent lines and never contribute
 * drift, so they are deliberately not modelled here.
 */
export function computeBookingRoundingDrift(
  input: BookingRoundingDriftInput
): InvoiceRoundingDrift | null {
  const { guests, totalDriftCents } = mergeBlockDrift([
    { bookingNights: input.bookingNights, guests: input.guests },
  ]);
  if (guests.length === 0) return null;

  return {
    source: "BOOKING",
    sourceId: input.bookingId,
    groupBookingId: null,
    xeroInvoiceId: input.xeroInvoiceId,
    xeroInvoiceNumber: input.xeroInvoiceNumber,
    issuedAtProxy: toIsoOrNull(input.issuedAtProxy),
    totalDriftCents,
    guests,
  };
}

export interface SettlementRoundingDriftInput {
  settlementId: string;
  groupBookingId: string;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  issuedAtProxy: Date | string | null;
  /** One block per settleable child booking (each its own date range/nights). */
  children: DriftLineBlock[];
}

/**
 * Compute the total pre-#1231 rounding drift for one group-settlement invoice.
 * The settlement invoice concatenates the line items of every settleable child
 * booking (see `xero-group-settlement-invoices.ts`), so its drift is the sum of
 * each child's per-guest run drift. Returns null when nothing drifted.
 */
export function computeSettlementRoundingDrift(
  input: SettlementRoundingDriftInput
): InvoiceRoundingDrift | null {
  const { guests, totalDriftCents } = mergeBlockDrift(input.children);
  if (guests.length === 0) return null;

  return {
    source: "GROUP_SETTLEMENT",
    sourceId: input.settlementId,
    groupBookingId: input.groupBookingId,
    xeroInvoiceId: input.xeroInvoiceId,
    xeroInvoiceNumber: input.xeroInvoiceNumber,
    issuedAtProxy: toIsoOrNull(input.issuedAtProxy),
    totalDriftCents,
    guests,
  };
}

// ---------------------------------------------------------------------------
// Read-only DB scanner
// ---------------------------------------------------------------------------

/** Guest + per-night rows as read from the DB (shared by both scan paths). */
interface RoundingAuditGuest {
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  priceCents: number;
  /**
   * #3170: `priceCents` is NULLABLE in the database now - a night a parked edit
   * committed without valuing. The scanner reads what is stored, and
   * `mapAuditGuest` decides what the replay may do with it.
   */
  nights: Array<{ stayDate: Date; priceCents: number | null }>;
}

/** A booking as the scanner reads it (child bookings omit `payment`). */
export interface RoundingAuditChildBooking {
  id: string;
  checkIn: Date;
  checkOut: Date;
  guests: RoundingAuditGuest[];
}

/** A per-booking invoice row: a booking plus its payment's Xero invoice link. */
export interface RoundingAuditBooking extends RoundingAuditChildBooking {
  payment: {
    xeroInvoiceId: string | null;
    xeroInvoiceNumber: string | null;
    createdAt: Date;
  } | null;
}

/** A group-settlement invoice row: the settlement plus its organiser booking id. */
export interface RoundingAuditSettlement {
  id: string;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  createdAt: Date;
  groupBooking: {
    id: string;
    organiserBookingId: string;
  };
}

type FindManyArgs = {
  where: Record<string, unknown>;
  include?: Record<string, unknown>;
  select?: Record<string, unknown>;
  orderBy?: Record<string, unknown>;
  take?: number;
  skip?: number;
  cursor?: { id: string };
};

/** Minimal read surface the scanner needs; satisfied by the Prisma client. */
export interface RoundingAuditPrismaClient {
  booking: {
    findMany: (args: FindManyArgs) => Promise<RoundingAuditBooking[]>;
  };
  groupBookingSettlement: {
    findMany: (args: FindManyArgs) => Promise<RoundingAuditSettlement[]>;
  };
}

export interface RoundingAuditScanOptions {
  /**
   * Only scan invoices whose issued-at proxy is strictly before this instant:
   * `Payment.createdAt` (booking invoices) / `GroupBookingSettlement.createdAt`
   * (settlement invoices). Set it to the date you deployed #1231 to exclude
   * already-correct invoices. Omit to scan every issued invoice.
   */
  issuedBefore?: Date | null;
  /** Page size for cursor pagination (default 200). */
  batchSize?: number;
  /** Optional cap on returned affected invoices (diagnostics). */
  limit?: number;
}

export interface RoundingAuditScanResult {
  /** Booking + settlement invoices scanned. */
  scannedInvoices: number;
  scannedBookingInvoices: number;
  scannedSettlementInvoices: number;
  /** Both sources, each labelled by `source`. */
  affected: InvoiceRoundingDrift[];
  totalDriftCents: number;
  affectedCount: number;
  issuedBefore: string | null;
}

/**
 * Count the nights in a stay exactly as the invoice builder did — via the
 * pricing engine's `getStayNights` (the pre-#1231 legacy path used
 * `getStayNights(checkIn, checkOut).length`). Reusing it, rather than
 * reimplementing the arithmetic, keeps the legacy-path replay faithful across
 * the engine's date-only / timezone normalisation.
 */
export function countStayNights(checkIn: Date, checkOut: Date): number {
  return getStayNights(checkIn, checkOut).length;
}

/**
 * #3170: ONE UNKNOWN NIGHT DISQUALIFIES THE WHOLE GUEST'S PER-NIGHT DETAIL, which
 * is the same `.every()` test `buildInvoiceLineItems` applies and is why it is
 * spelt the same way here.
 *
 * This module's entire promise is that it REPLAYS the builder - its own header
 * says it reproduces the old grouping byte for byte so the drift it reports is
 * the drift that was really invoiced. Since #3170 the builder sends a guest with
 * any unknown night down the whole-stay legacy branch, so an audit that stayed on
 * the per-night branch would be replaying a builder that no longer exists, for
 * precisely the population #3170 creates.
 *
 * The arithmetic mattered as much as the branch. Left alone, `totalCents +=
 * night.priceCents` adds a null as 0 and `Math.min(minPrice, null)` collapses to
 * 0, so the audit would value an unknown night at nothing and report a drift
 * figure that is not the drift - the null-as-zero this epic exists to forbid, in
 * a report a person acts on.
 *
 * Empty nights is not a loss of evidence: `computeGuestRoundingDrift` reads it as
 * the legacy flat-total path and replays `round(guest.priceCents / bookingNights)`
 * over the booking's own range, which is what the builder now emits for this
 * guest.
 */
function mapAuditGuest(guest: RoundingAuditGuest): AuditGuest {
  const pricedNights = guest.nights.every(
    (night): night is { stayDate: Date; priceCents: number } =>
      typeof night.priceCents === "number",
  )
    ? guest.nights
    : [];
  return {
    firstName: guest.firstName,
    lastName: guest.lastName,
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    priceCents: guest.priceCents,
    nights: pricedNights.map((n) => ({
      stayDate: n.stayDate,
      priceCents: n.priceCents,
    })),
  };
}

const guestInclude = {
  guests: {
    include: { nights: { select: { stayDate: true, priceCents: true } } },
  },
};

/**
 * Scan every issued per-booking invoice (`Payment.xeroInvoiceId`) for pre-#1231
 * rounding drift, reading in cursor-paginated batches so it never loads the
 * whole table at once and never opens a transaction. Read-only: only
 * `booking.findMany`.
 */
export async function scanBookingInvoiceRoundingDrift(
  client: RoundingAuditPrismaClient,
  options: RoundingAuditScanOptions = {}
): Promise<RoundingAuditScanResult> {
  const batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : 200;
  const issuedBefore = options.issuedBefore ?? null;

  const paymentWhere: Record<string, unknown> = { xeroInvoiceId: { not: null } };
  if (issuedBefore) {
    paymentWhere.createdAt = { lt: issuedBefore };
  }

  const affected: InvoiceRoundingDrift[] = [];
  let scannedInvoices = 0;
  let totalDriftCents = 0;
  let cursorId: string | null = null;

  for (;;) {
    const batch = await client.booking.findMany({
      where: { payment: { is: paymentWhere } },
      include: {
        payment: {
          select: {
            xeroInvoiceId: true,
            xeroInvoiceNumber: true,
            createdAt: true,
          },
        },
        ...guestInclude,
      },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });

    if (batch.length === 0) break;

    for (const booking of batch) {
      if (!booking.payment?.xeroInvoiceId) continue;
      scannedInvoices += 1;
      const drift = computeBookingRoundingDrift({
        bookingId: booking.id,
        xeroInvoiceId: booking.payment.xeroInvoiceId,
        xeroInvoiceNumber: booking.payment.xeroInvoiceNumber,
        issuedAtProxy: booking.payment.createdAt,
        bookingNights: countStayNights(booking.checkIn, booking.checkOut),
        guests: booking.guests.map(mapAuditGuest),
      });
      if (drift) {
        affected.push(drift);
        totalDriftCents += drift.totalDriftCents;
        if (options.limit && affected.length >= options.limit) break;
      }
    }
    if (options.limit && affected.length >= options.limit) break;

    cursorId = batch[batch.length - 1].id;
    if (batch.length < batchSize) break;
  }

  return {
    scannedInvoices,
    scannedBookingInvoices: scannedInvoices,
    scannedSettlementInvoices: 0,
    affected,
    affectedCount: affected.length,
    totalDriftCents,
    issuedBefore: issuedBefore ? issuedBefore.toISOString() : null,
  };
}

/**
 * Scan every issued group-settlement invoice (`GroupBookingSettlement.
 * xeroInvoiceId`) for pre-#1231 rounding drift. For each settlement it re-runs
 * the EXACT child query the real builder uses (see
 * `xero-group-settlement-invoices.ts` lines 104-112: `parentBookingId =
 * organiserBookingId`, `organiserSettled: true`, `deletedAt: null`,
 * `status in [CONFIRMED, PAID]`) so the reconstructed line-item input matches
 * what was invoiced, then sums each child's per-guest run drift. Read-only:
 * only `groupBookingSettlement.findMany` + `booking.findMany`, no transaction.
 */
export async function scanGroupSettlementRoundingDrift(
  client: RoundingAuditPrismaClient,
  options: RoundingAuditScanOptions = {}
): Promise<RoundingAuditScanResult> {
  const batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : 200;
  const issuedBefore = options.issuedBefore ?? null;

  const settlementWhere: Record<string, unknown> = { xeroInvoiceId: { not: null } };
  if (issuedBefore) {
    settlementWhere.createdAt = { lt: issuedBefore };
  }

  const affected: InvoiceRoundingDrift[] = [];
  let scannedInvoices = 0;
  let totalDriftCents = 0;
  let cursorId: string | null = null;

  for (;;) {
    const batch = await client.groupBookingSettlement.findMany({
      where: settlementWhere,
      select: {
        id: true,
        xeroInvoiceId: true,
        xeroInvoiceNumber: true,
        createdAt: true,
        groupBooking: { select: { id: true, organiserBookingId: true } },
      },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });

    if (batch.length === 0) break;

    for (const settlement of batch) {
      if (!settlement.xeroInvoiceId) continue;
      scannedInvoices += 1;

      // Verbatim children query from xero-group-settlement-invoices.ts (104-112).
      const children = await client.booking.findMany({
        where: {
          parentBookingId: settlement.groupBooking.organiserBookingId,
          organiserSettled: true,
          deletedAt: null,
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.PAID] },
        },
        include: { ...guestInclude },
        orderBy: { id: "asc" },
      });

      const drift = computeSettlementRoundingDrift({
        settlementId: settlement.id,
        groupBookingId: settlement.groupBooking.id,
        xeroInvoiceId: settlement.xeroInvoiceId,
        xeroInvoiceNumber: settlement.xeroInvoiceNumber,
        issuedAtProxy: settlement.createdAt,
        children: children.map((child) => ({
          bookingNights: countStayNights(child.checkIn, child.checkOut),
          guests: child.guests.map(mapAuditGuest),
        })),
      });
      if (drift) {
        affected.push(drift);
        totalDriftCents += drift.totalDriftCents;
        if (options.limit && affected.length >= options.limit) break;
      }
    }
    if (options.limit && affected.length >= options.limit) break;

    cursorId = batch[batch.length - 1].id;
    if (batch.length < batchSize) break;
  }

  return {
    scannedInvoices,
    scannedBookingInvoices: 0,
    scannedSettlementInvoices: scannedInvoices,
    affected,
    affectedCount: affected.length,
    totalDriftCents,
    issuedBefore: issuedBefore ? issuedBefore.toISOString() : null,
  };
}

/**
 * Scan BOTH sources — per-booking invoices and group-settlement invoices — for
 * pre-#1231 rounding drift and merge the results. This is the entry the CLI
 * uses; a clean result means both scans found nothing. Read-only throughout.
 */
export async function scanXeroInvoiceRoundingDrift(
  client: RoundingAuditPrismaClient,
  options: RoundingAuditScanOptions = {}
): Promise<RoundingAuditScanResult> {
  const bookingResult = await scanBookingInvoiceRoundingDrift(client, options);

  // Respect the diagnostic cap across both scans.
  const remainingLimit =
    options.limit != null
      ? Math.max(0, options.limit - bookingResult.affectedCount)
      : undefined;
  const settlementResult =
    remainingLimit === 0
      ? {
          scannedInvoices: 0,
          scannedBookingInvoices: 0,
          scannedSettlementInvoices: 0,
          affected: [] as InvoiceRoundingDrift[],
          affectedCount: 0,
          totalDriftCents: 0,
          issuedBefore: bookingResult.issuedBefore,
        }
      : await scanGroupSettlementRoundingDrift(client, {
          ...options,
          limit: remainingLimit,
        });

  const affected = [...bookingResult.affected, ...settlementResult.affected];
  return {
    scannedInvoices: bookingResult.scannedInvoices + settlementResult.scannedInvoices,
    scannedBookingInvoices: bookingResult.scannedBookingInvoices,
    scannedSettlementInvoices: settlementResult.scannedSettlementInvoices,
    affected,
    affectedCount: affected.length,
    totalDriftCents: bookingResult.totalDriftCents + settlementResult.totalDriftCents,
    issuedBefore: bookingResult.issuedBefore,
  };
}

// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)} (${cents >= 0 ? "+" : ""}${cents}c)`;
}

/** Render a plain-text operator report for a scan result. */
export function formatRoundingAuditReport(result: RoundingAuditScanResult): string {
  const lines: string[] = [];
  lines.push("Xero invoice rounding-drift audit (#1318) — DIAGNOSTIC, read-only");
  lines.push("=".repeat(70));
  lines.push(
    "Scope note: scans BOTH per-booking invoices (Payment.xeroInvoiceId) AND " +
      "group-booking settlement invoices (GroupBookingSettlement.xeroInvoiceId); " +
      "both run through the same line builder and share the #1163 exposure."
  );
  lines.push(
    `Issued invoices scanned: ${result.scannedInvoices} ` +
      `(booking ${result.scannedBookingInvoices}, ` +
      `settlement ${result.scannedSettlementInvoices})`
  );
  lines.push(`Candidate affected invoices: ${result.affectedCount}`);
  lines.push(`Net drift across candidates: ${formatCents(result.totalDriftCents)}`);
  if (result.issuedBefore) {
    lines.push(`Scope: issued-at proxy (createdAt) < ${result.issuedBefore}`);
  } else {
    lines.push(
      "Scope: ALL issued invoices (no --issued-before). Some candidates may " +
        "have been issued AFTER #1231 and are already correct."
    );
  }
  lines.push("");

  if (result.affected.length === 0) {
    lines.push(
      "No candidate invoices matched the pre-#1231 drift pattern " +
        "(both per-booking and group-settlement invoices are clean)."
    );
    return lines.join("\n");
  }

  lines.push(
    "Each candidate matches the pre-#1231 pattern in LOCAL data only. Before " +
      "treating it as a real error, confirm in Xero that the invoice is still " +
      "live (not voided/credited/superseded) and was issued before you deployed " +
      "#1231. Remediation is a manual accounting correction, not automated here."
  );
  lines.push("");

  for (const invoice of result.affected) {
    const isSettlement = invoice.source === "GROUP_SETTLEMENT";
    lines.push("-".repeat(70));
    lines.push(
      `[${isSettlement ? "GROUP SETTLEMENT" : "BOOKING"}] ` +
        `Invoice ${invoice.xeroInvoiceNumber ?? "(no number)"} ` +
        `[${invoice.xeroInvoiceId ?? "unknown id"}]`
    );
    if (isSettlement) {
      lines.push(`  Settlement: ${invoice.sourceId} (group ${invoice.groupBookingId})`);
      lines.push(`  Issued-at proxy (settlement.createdAt): ${invoice.issuedAtProxy ?? "unknown"}`);
    } else {
      lines.push(`  Booking: ${invoice.sourceId}`);
      lines.push(`  Issued-at proxy (payment.createdAt): ${invoice.issuedAtProxy ?? "unknown"}`);
    }
    lines.push(`  Total drift: ${formatCents(invoice.totalDriftCents)}`);
    for (const guest of invoice.guests) {
      lines.push(
        `  Guest ${guest.guestName} (${guest.ageTier}` +
          `${guest.isMember ? ", Member" : ", Non-member"}): ` +
          `${formatCents(guest.guestDriftCents)}`
      );
      for (const run of guest.driftedRuns) {
        const range =
          run.startDate && run.endExclusive
            ? `${run.startDate} - ${run.endExclusive}`
            : "flat total (no per-night rows)";
        lines.push(
          `    ${run.nightCount} night(s) ${range}: ledger ${formatCents(
            run.totalCents
          )}, billed ${run.nightCount} x ${formatCents(
            run.roundedPerNightCents
          )} = ${formatCents(run.emittedTotalCents)} -> drift ${formatCents(
            run.driftCents
          )}${run.mixedPrices ? " [mixed nightly prices]" : ""}`
        );
      }
    }
  }

  return lines.join("\n");
}
