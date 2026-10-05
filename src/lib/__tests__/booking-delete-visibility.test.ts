import { describe, expect, it } from "vitest";
import {
  buildBookingDeletedWhere,
  isBookingShownIn,
  type BookingDeletedVisibility,
} from "@/lib/booking-delete-visibility";
import { isInNetCollectedBookingScope } from "@/lib/payment-net-collected";

/** How PostgreSQL, through Prisma, applies the `deletedAt` filter to one row. */
function databaseReturns(
  where: ReturnType<typeof buildBookingDeletedWhere>,
  deletedAt: Date | null,
): boolean {
  if (!("deletedAt" in where)) return true;
  return where.deletedAt === null ? deletedAt === null : deletedAt !== null;
}

const VISIBILITIES: BookingDeletedVisibility[] = ["hide", "include", "only"];
const ROWS = [
  { label: "live", deletedAt: null },
  { label: "soft-deleted", deletedAt: new Date("2026-04-20T00:00:00.000Z") },
];

describe("booking deleted visibility (#3745, INV-SSOT)", () => {
  it("keeps the query filters Prisma is asked for", () => {
    expect(buildBookingDeletedWhere("hide")).toEqual({ deletedAt: null });
    expect(buildBookingDeletedWhere("include")).toEqual({});
    expect(buildBookingDeletedWhere("only")).toEqual({
      deletedAt: { not: null },
    });
  });

  // The query filter and the row test are one rule: a row a database read
  // returns is exactly a row the in-memory scope keeps.
  for (const visibility of VISIBILITIES) {
    for (const row of ROWS) {
      it(`agrees on a ${row.label} booking in the ${visibility} view`, () => {
        expect(isBookingShownIn(visibility, row)).toBe(
          databaseReturns(buildBookingDeletedWhere(visibility), row.deletedAt),
        );
      });
    }
  }

  it("scopes Net Collected to the hide view", () => {
    for (const row of ROWS) {
      expect(isInNetCollectedBookingScope(row)).toBe(
        databaseReturns(buildBookingDeletedWhere("hide"), row.deletedAt),
      );
    }
  });
});
