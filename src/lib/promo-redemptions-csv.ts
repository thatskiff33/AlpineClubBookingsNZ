import { escapeCsvCell } from "./csv";
import { parseInstant, type BoundClubTime } from "@/lib/club-time";

// The 13-column export header. Kept as the single source of truth so the header
// row and every data row built by `buildPromoRedemptionCsvCells` stay aligned.
export const PROMO_REDEMPTIONS_CSV_HEADER = [
  "Redeemed",
  "Member",
  "Email",
  "Booking reference",
  "Booking ID",
  "Lodge",
  "Check-in",
  "Check-out",
  "Nights",
  "Guests",
  "Discount",
  "Free nights",
  "Member use #",
] as const;

// Structural subset of the panel's RedemptionRow needed to build a CSV row. The
// panel's richer row type is assignable to this.
export interface PromoRedemptionCsvRow {
  createdAt: string;
  member: { name: string; email: string };
  booking: {
    id: string;
    reference: string;
    lodgeName: string;
    checkIn: string;
    checkOut: string;
    nights: number;
  };
  eligibleGuestCount: number | null;
  discountCents: number;
  freeNightsUsed: number;
  memberUseIndex: number;
}

/**
 * The CSV's first column — when the promo code was redeemed.
 *
 * A REAL INSTANT, IN THE CLUB'S PERSISTED ZONE (#3123; `INV-CONFIG-002`).
 * `PromoRedemption.createdAt` is a `DateTime @default(now())`, not a `@db.Date`,
 * so it carries a time of day and has no civil date until a zone is chosen. It
 * used to go through `formatNZDateTime` and so through `APP_TIME_ZONE`: for a
 * club west of Greenwich that wrote the wrong day into a file somebody keeps,
 * which is why this issue leads with the durable exports.
 *
 * The `checkIn`/`checkOut` columns beside it are `@db.Date` calendar days,
 * passed straight through as the strings the payload carries, and are correct as
 * they are — they take no zone and must not be given one.
 *
 * It degrades to the raw value rather than throwing. The bare `new Date(value)`
 * this replaces reached a formatter that throws on an unparseable value, and an
 * export a manager clicked is a bad place for a whole page to fall over; the raw
 * text at least says what arrived.
 */
export function formatRedeemedAt(club: BoundClubTime, value: string): string {
  const instant = parseInstant(value);
  return instant === null ? value : club.instantDateTime(instant);
}

/**
 * Build the 13 raw (unescaped) cells for one redemption row. Discount cents are
 * rendered as dollars with two decimals; a null guest count becomes an empty
 * cell. Escaping is applied by `buildPromoRedemptionsCsvContent`.
 */
export function buildPromoRedemptionCsvCells(
  club: BoundClubTime,
  row: PromoRedemptionCsvRow
): string[] {
  return [
    formatRedeemedAt(club, row.createdAt),
    row.member.name,
    row.member.email,
    row.booking.reference,
    row.booking.id,
    row.booking.lodgeName,
    row.booking.checkIn,
    row.booking.checkOut,
    String(row.booking.nights),
    row.eligibleGuestCount != null ? String(row.eligibleGuestCount) : "",
    (row.discountCents / 100).toFixed(2),
    String(row.freeNightsUsed),
    String(row.memberUseIndex),
  ];
}

/**
 * Assemble the full CSV document: a title line, the header row, then one row per
 * redemption. Every cell is escaped via `escapeCsvCell` so formula-injection and
 * delimiter characters are neutralised. Rows are joined with `\n` (matching the
 * existing client export semantics).
 */
export function buildPromoRedemptionsCsvContent(
  club: BoundClubTime,
  code: string,
  rows: PromoRedemptionCsvRow[]
): string {
  const table: string[][] = [];
  table.push([`Promo code redemptions: ${code}`]);
  table.push([...PROMO_REDEMPTIONS_CSV_HEADER]);
  for (const row of rows) {
    table.push(buildPromoRedemptionCsvCells(club, row));
  }
  return table
    .map((cells) => cells.map(escapeCsvCell).join(","))
    .join("\n");
}
