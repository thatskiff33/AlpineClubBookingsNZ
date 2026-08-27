/**
 * #3123 — a booking-modification summary row's dates are lodge nights, and they
 * take NO timezone.
 *
 * This is the clearest example in the whole `nzst-date` migration of the trap
 * the issue warns about. Both of this module's date calls sit on one line, both
 * hold `Booking.checkIn`/`checkOut` values (`DateTime @db.Date`,
 * `prisma/schema.prisma:1662-1663`), and the file contains no instant at all.
 * A sweep that "moved the retired adapter onto the club's zone" would have
 * introduced two brand-new wrong-day defects on a member's date-change email
 * and fixed nothing that was wrong.
 *
 * ## What was actually wrong, and what this suite measures
 *
 * `formatNZDate` projected the stored UTC-midnight encoding through
 * `APP_TIME_ZONE`. For a club behind Greenwich that names the PREVIOUS night —
 * so the member reading "your dates changed" was shown the wrong ones. The
 * container is therefore pinned to `America/Denver` before the graph is
 * imported: on this repository's own machine `APP_TIME_ZONE` is
 * `Pacific/Auckland`, whose projection of a UTC-midnight day is that same day,
 * and a suite that left it alone would watch the old code be right by
 * coincidence.
 *
 * The club's PERSISTED zone is varied across `Pacific/Auckland` (east, where the
 * projection would agree anyway — the current-adopter regression case) and
 * `Pacific/Honolulu` (west, where a projection through EITHER wrong authority
 * lands a day early). The rows must be identical under both, and identical to
 * the unprojected stored day. That equality is the assertion, and it is what
 * stops a later sweep quietly re-introducing a zone here.
 *
 * The Prisma mock carries `clubTimeSettings` even though the correct answer
 * needs no zone: without it the persisted read fails soft to the environment,
 * and a suite that cannot distinguish "consulted no zone" from "consulted the
 * environment and got lucky" is measuring nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const CONTAINER_ZONE = "America/Denver";
process.env.NEXT_PUBLIC_TZ = CONTAINER_ZONE;
delete process.env.TZ;

const mocks = vi.hoisted(() => ({
  clubTimeSettingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.resetModules();

const { APP_TIME_ZONE } = await import("@/config/operational");
const { __resetEmailClubTimeZoneForTests, primeEmailClubTimeZone } =
  await import("@/lib/email-templates-club-time");
const { bookingModificationSummaryRows } = await import(
  "@/lib/booking-money-lines"
);

/** Stored `@db.Date` lodge nights: exact UTC midnight, which is the encoding. */
const OLD_CHECK_IN = new Date("2026-08-01T00:00:00.000Z");
const OLD_CHECK_OUT = new Date("2026-08-03T00:00:00.000Z");
const NEW_CHECK_IN = new Date("2026-08-05T00:00:00.000Z");
const NEW_CHECK_OUT = new Date("2026-08-07T00:00:00.000Z");

const PERSISTED_ZONES = [
  {
    label: "Pacific/Auckland (east — every deployment today)",
    zone: "Pacific/Auckland",
  },
  {
    label: "Pacific/Honolulu (west — both wrong authorities land a day early)",
    zone: "Pacific/Honolulu",
  },
] as const;

/** An independent oracle, written by hand rather than imported. */
const houseDay = (zone: string) =>
  new Intl.DateTimeFormat("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: zone,
  });

function rows(): Array<{ label: string; value: string }> {
  return bookingModificationSummaryRows({
    oldCheckIn: OLD_CHECK_IN,
    oldCheckOut: OLD_CHECK_OUT,
    newCheckIn: NEW_CHECK_IN,
    newCheckOut: NEW_CHECK_OUT,
    oldGuestCount: 2,
    newGuestCount: 2,
    oldFinalPriceCents: 12000,
    newFinalPriceCents: 12000,
    changeFeeCents: 0,
  });
}

const valueOf = (label: string) =>
  rows().find((row) => row.label === label)?.value;

async function withPersistedZone(zone: string): Promise<void> {
  __resetEmailClubTimeZoneForTests();
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({ timeZone: zone });
  await primeEmailClubTimeZone();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the premise these assertions rest on", () => {
  it("the container really is pinned behind Greenwich", () => {
    expect(APP_TIME_ZONE).toBe(CONTAINER_ZONE);
  });

  it("the stored night and its projections really do disagree", () => {
    expect(houseDay("UTC").format(OLD_CHECK_IN)).toBe("1 Aug 2026");
    expect(houseDay(CONTAINER_ZONE).format(OLD_CHECK_IN)).toBe("31 Jul 2026");
    expect(houseDay("Pacific/Honolulu").format(OLD_CHECK_IN)).toBe(
      "31 Jul 2026"
    );
  });
});

describe("the modification rows name the stored nights, under every zone", () => {
  for (const { label, zone } of PERSISTED_ZONES) {
    it(`is unprojected with the club on ${label}`, async () => {
      await withPersistedZone(zone);

      expect(valueOf("Previous Dates")).toBe("1 Aug 2026 – 3 Aug 2026");
      expect(valueOf("New Dates")).toBe("5 Aug 2026 – 7 Aug 2026");
    });

    it(`names no previous-day projection with the club on ${label}`, async () => {
      await withPersistedZone(zone);

      const rendered = rows()
        .map((row) => row.value)
        .join(" | ");
      // What the container's zone, and a western club's, would have said.
      expect(rendered).not.toContain("31 Jul 2026");
      expect(rendered).not.toContain("2 Aug 2026");
      expect(rendered).not.toContain("4 Aug 2026");
      expect(rendered).not.toContain("6 Aug 2026");
    });
  }

  it("renders byte-identically whichever zone the club has persisted", async () => {
    await withPersistedZone("Pacific/Auckland");
    const east = JSON.stringify(rows());

    await withPersistedZone("Pacific/Honolulu");
    const west = JSON.stringify(rows());

    // A calendar day has no zone, so moving the club's cannot move these rows.
    // This is the assertion a future "sweep it onto the club zone" would fail.
    expect(east).toBe(west);
  });

  it("states an unchanged stay window once, still unprojected", async () => {
    await withPersistedZone("Pacific/Honolulu");

    const unchanged = bookingModificationSummaryRows({
      oldCheckIn: OLD_CHECK_IN,
      oldCheckOut: OLD_CHECK_OUT,
      newCheckIn: OLD_CHECK_IN,
      newCheckOut: OLD_CHECK_OUT,
      oldGuestCount: 2,
      newGuestCount: 3,
      oldFinalPriceCents: 12000,
      newFinalPriceCents: 18000,
      changeFeeCents: 0,
    });

    expect(unchanged.find((row) => row.label === "Dates")?.value).toBe(
      "1 Aug 2026 – 3 Aug 2026"
    );
    expect(unchanged.some((row) => row.label === "Previous Dates")).toBe(false);
  });

  it("refuses a real timestamp handed in as a lodge night", async () => {
    await withPersistedZone("Pacific/Auckland");

    expect(() =>
      bookingModificationSummaryRows({
        oldCheckIn: new Date("2026-08-01T11:30:00.000Z"),
        oldCheckOut: OLD_CHECK_OUT,
        newCheckIn: NEW_CHECK_IN,
        newCheckOut: NEW_CHECK_OUT,
        oldGuestCount: 2,
        newGuestCount: 2,
        oldFinalPriceCents: 12000,
        newFinalPriceCents: 12000,
        changeFeeCents: 0,
      })
    ).toThrow(/takes a stored calendar day, not a moment/);
  });
});
