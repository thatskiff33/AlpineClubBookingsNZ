import { describe, expect, it, vi } from "vitest";

/*
  `APP_TIME_ZONE` IS PINNED BEHIND GREENWICH, AND IT IS NOT THE CLUB ZONE BELOW.

  Two jobs, both live. It is what makes the #3123 cases at the foot of this file
  a migration proof rather than a spelling check: before that change the
  "Redeemed" column went through `formatNZDateTime`, whose zone IS
  `APP_TIME_ZONE`, so those cases read 9 July and now read 10 July. And it stays
  a standing guard — if a future edit puts a config-zone read back into this
  module, the assertions produce Denver's day and fail.

  It is deliberately NOT `Pacific/Auckland`: that is exactly what `APP_TIME_ZONE`
  falls back to, so a suite persisting it could not tell the club's configured
  zone from the container's (#3123 execution contract).
*/
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import {
  PROMO_REDEMPTIONS_CSV_HEADER,
  buildPromoRedemptionCsvCells,
  buildPromoRedemptionsCsvContent,
  formatRedeemedAt,
  type PromoRedemptionCsvRow,
} from "@/lib/promo-redemptions-csv";

/** The club's configured zone under test. Held apart from the mock above. */
const CLUB = bindClubTime(requireClubTimeZone("Pacific/Auckland"));

const ROW: PromoRedemptionCsvRow = {
  createdAt: "2026-07-10T02:00:00.000Z",
  // Leading "=" exercises the formula-injection guard once escaped.
  member: { name: "=Alice", email: "alice@example.com" },
  booking: {
    id: "bk-1",
    reference: "AAAAAA03",
    lodgeName: "Main Lodge",
    checkIn: "2026-08-01",
    checkOut: "2026-08-04",
    nights: 3,
  },
  eligibleGuestCount: null,
  discountCents: 5000,
  freeNightsUsed: 0,
  memberUseIndex: 2,
};

describe("buildPromoRedemptionCsvCells", () => {
  it("produces 13 cells aligned with the header", () => {
    const cells = buildPromoRedemptionCsvCells(CLUB, ROW);
    expect(cells).toHaveLength(PROMO_REDEMPTIONS_CSV_HEADER.length);
    expect(PROMO_REDEMPTIONS_CSV_HEADER).toHaveLength(13);
  });

  it("formats cents as dollars, blanks a null guest count, and stringifies counts", () => {
    const cells = buildPromoRedemptionCsvCells(CLUB, ROW);
    // Raw (unescaped) cells — escaping happens in the content builder.
    expect(cells[1]).toBe("=Alice");
    expect(cells[2]).toBe("alice@example.com");
    expect(cells[8]).toBe("3"); // nights
    expect(cells[9]).toBe(""); // null guest count
    expect(cells[10]).toBe("50.00"); // 5000c -> dollars
    expect(cells[11]).toBe("0"); // free nights
    expect(cells[12]).toBe("2"); // member use index
  });

  it("renders a non-null guest count", () => {
    const cells = buildPromoRedemptionCsvCells(CLUB, {
      ...ROW,
      eligibleGuestCount: 4,
    });
    expect(cells[9]).toBe("4");
  });
});

describe("buildPromoRedemptionsCsvContent", () => {
  it("emits a title line, a 13-column header, and formula-escaped data", () => {
    const content = buildPromoRedemptionsCsvContent(CLUB, "WINTER20", [ROW]);
    const lines = content.split("\n");
    expect(lines[0]).toBe("Promo code redemptions: WINTER20");
    // Header cells carry no commas, so a naive split is safe here.
    expect(lines[1].split(",")).toHaveLength(13);
    // The member name's leading "=" is neutralised with a single quote.
    expect(content).toContain("'=Alice");
  });

  it("handles an empty row set (title + header only)", () => {
    const content = buildPromoRedemptionsCsvContent(CLUB, "WINTER20", []);
    const lines = content.split("\n");
    expect(lines).toHaveLength(2);
  });
});

/*
  #3123 — the "Redeemed" column is the CLUB's day, and a wrong one PERSISTS.

  `PromoRedemption.createdAt` is a `DateTime @default(now())` with no `@db.Date`,
  so it is a real instant and has no civil date until a zone is chosen. This is
  one of the three durable exports the issue leads with: the wrong day here goes
  into a file a manager keeps, where nothing later corrects it.
*/
describe("the Redeemed column takes the club's configured zone (#3123)", () => {
  /** 2:00 UTC: 10 July 14:00 in Auckland, 9 July 20:00 in Denver. */
  const STRADDLES = "2026-07-10T02:00:00.000Z";

  it("PREMISE: the environment and the club disagree about this instant", () => {
    // Without this leg every case below passes just as well when the two zones
    // agree, which is the false green #3123's contract names.
    const inEnvironment = new Intl.DateTimeFormat("en-NZ", {
      timeZone: "America/Denver",
      dateStyle: "medium",
    }).format(new Date(STRADDLES));
    expect(inEnvironment).toBe("9 Jul 2026");
    expect(formatRedeemedAt(CLUB, STRADDLES)).toContain("10 Jul 2026");
  });

  it("names the club's day in the exported cell, not the container's", () => {
    // BEFORE the migration this cell read "9 Jul 2026" (APP_TIME_ZONE = Denver).
    const cells = buildPromoRedemptionCsvCells(CLUB, {
      ...ROW,
      createdAt: STRADDLES,
    });
    expect(cells[0]).toContain("10 Jul 2026");
    expect(cells[0]).not.toContain("9 Jul 2026");
  });

  it("moves with the configured zone — kills a hard-coded Pacific/Auckland", () => {
    // The leg a literal club zone cannot pass.
    const ahead = bindClubTime(requireClubTimeZone("Pacific/Kiritimati"));
    const behind = bindClubTime(requireClubTimeZone("Pacific/Pago_Pago"));
    expect(formatRedeemedAt(ahead, STRADDLES)).toContain("10 Jul 2026");
    expect(formatRedeemedAt(behind, STRADDLES)).toContain("9 Jul 2026");
  });

  it("leaves the check-in and check-out CALENDAR days untouched by the zone", () => {
    /*
      THE OTHER HALF OF THE CONTRACT, and the assertion that stops a future
      "move everything onto the club zone" sweep breaking this file.
      `Booking.checkIn`/`checkOut` are `@db.Date` lodge nights: they are passed
      through as the strings the payload carries and must read identically under
      every zone on earth. If these two ever start moving, a calendar day has
      been given a zone it does not have.
    */
    const behind = bindClubTime(requireClubTimeZone("Pacific/Pago_Pago"));
    const inClub = buildPromoRedemptionCsvCells(CLUB, ROW);
    const wayBehind = buildPromoRedemptionCsvCells(behind, ROW);
    expect(inClub[6]).toBe("2026-08-01");
    expect(inClub[7]).toBe("2026-08-04");
    expect(wayBehind[6]).toBe(inClub[6]);
    expect(wayBehind[7]).toBe(inClub[7]);
  });

  it("keeps the raw value rather than throwing on an unreadable timestamp", () => {
    // An export a manager clicked is a bad place for the page to fall over; the
    // bare `new Date(value)` this replaced reached a formatter that throws.
    expect(formatRedeemedAt(CLUB, "not-a-timestamp")).toBe("not-a-timestamp");
  });
});
