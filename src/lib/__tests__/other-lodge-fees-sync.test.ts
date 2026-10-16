import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadServerNzSettings: vi.fn(),
  membershipTypeFindUnique: vi.fn(),
  otherLodgeFindUnique: vi.fn(),
  otherLodgeUpdateMany: vi.fn(),
  seasonFindMany: vi.fn(),
  resolveLocalLodgeForCentralId: vi.fn(),
  createAuditLog: vi.fn(),
  today: vi.fn(),
}));

vi.mock("@/lib/servernz-settings", () => ({ loadServerNzSettings: mocks.loadServerNzSettings }));
vi.mock("@/lib/central-lodge-link", () => ({ resolveLocalLodgeForCentralId: mocks.resolveLocalLodgeForCentralId }));
vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));
vi.mock("@/lib/club-time/server", () => ({ clubTodayDateOnlyInstant: mocks.today }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    membershipType: { findUnique: mocks.membershipTypeFindUnique },
    otherLodge: { findUnique: mocks.otherLodgeFindUnique, updateMany: mocks.otherLodgeUpdateMany },
    season: { findMany: mocks.seasonFindMany },
  },
}));

import {
  FEES_FILL_PROBLEM_TEXT,
  feesDerivedOtherLodgeData,
  otherLodgeFeesProblem,
  syncOwnOtherLodgesFromFees,
  type FeesSeason,
} from "@/lib/other-lodge-fees-sync";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NM = "type-non-member";

/** A season with Non-Member rates per tier, plus a member type's rate that must be ignored. */
function season(
  type: "WINTER" | "SUMMER",
  start: string,
  end: string,
  rates: Partial<Record<"INFANT" | "CHILD" | "YOUTH" | "ADULT", number>> | number,
): FeesSeason {
  const nonMember =
    typeof rates === "number"
      ? [{ membershipTypeId: NM, ageTier: null, pricePerNightCents: rates }]
      : Object.entries(rates).map(([tier, cents]) => ({
          membershipTypeId: NM,
          ageTier: tier as "INFANT",
          pricePerNightCents: cents,
        }));
  return {
    type,
    startDate: day(start),
    endDate: day(end),
    rates: [...nonMember, { membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: 1 }],
  };
}

/** As Prisma reads a season: the rates under `membershipTypeRates`. */
const asRow = ({ rates, ...s }: FeesSeason) => ({ ...s, membershipTypeRates: rates });

const WINTER_2026 = season("WINTER", "2026-06-01", "2026-09-30", { INFANT: 0, CHILD: 2000, YOUTH: 3000, ADULT: 4500 });
const SUMMER_2026 = season("SUMMER", "2026-12-01", "2027-03-31", 3500);

describe("feesDerivedOtherLodgeData (#77)", () => {
  it("takes each age group from the Non-Member tier of the same name, and the season's dates", () => {
    const data = feesDerivedOtherLodgeData([WINTER_2026, SUMMER_2026], NM, day("2026-07-01"));
    expect(data).toMatchObject({
      winterRateUnder5Cents: 0,
      winterRate5To11Cents: 2000,
      winterRate12To17Cents: 3000,
      winterRateAdultCents: 4500,
      winterSeasonStart: day("2026-06-01"),
      winterSeasonEnd: day("2026-09-30"),
      summerSeasonStart: day("2026-12-01"),
      summerSeasonEnd: day("2027-03-31"),
    });
  });

  it("gives every age group the flat rate of a type without age groups", () => {
    const data = feesDerivedOtherLodgeData([SUMMER_2026], NM, day("2026-07-01"));
    expect([data.summerRateUnder5Cents, data.summerRate5To11Cents, data.summerRate12To17Cents, data.summerRateAdultCents]).toEqual([
      3500, 3500, 3500, 3500,
    ]);
  });

  it("leaves blank a tier with no Non-Member rate and no flat rate, and never takes another type's", () => {
    const partial = season("WINTER", "2026-06-01", "2026-09-30", { ADULT: 4500 });
    const data = feesDerivedOtherLodgeData([partial], NM, day("2026-07-01"));
    expect(data.winterRateAdultCents).toBe(4500);
    expect(data.winterRateUnder5Cents).toBeNull();
  });

  it("prefers the tier's own rate over a flat row in the same season", () => {
    const both = { ...WINTER_2026, rates: [...WINTER_2026.rates, { membershipTypeId: NM, ageTier: null, pricePerNightCents: 9999 }] };
    expect(feesDerivedOtherLodgeData([both], NM, day("2026-07-01")).winterRate5To11Cents).toBe(2000);
  });

  it("uses the season running today, else the next to start, and skips one that has ended", () => {
    const winter2027 = season("WINTER", "2027-06-01", "2027-09-30", { ADULT: 5000 });
    const seasons = [WINTER_2026, winter2027];
    expect(feesDerivedOtherLodgeData(seasons, NM, day("2026-09-30")).winterRateAdultCents).toBe(4500);
    expect(feesDerivedOtherLodgeData(seasons, NM, day("2026-10-01")).winterRateAdultCents).toBe(5000);
    expect(feesDerivedOtherLodgeData(seasons, NM, day("2026-10-01")).winterSeasonStart).toEqual(day("2027-06-01"));
    // Before both: the earlier of the two, whatever order they come in.
    expect(feesDerivedOtherLodgeData([winter2027, WINTER_2026], NM, day("2026-01-01")).winterRateAdultCents).toBe(4500);
  });

  it("keeps the season that ended last when none is running or coming, so a finished winter still shows", () => {
    const winter2025 = season("WINTER", "2025-06-01", "2025-09-30", { ADULT: 4000 });
    const data = feesDerivedOtherLodgeData([winter2025, WINTER_2026], NM, day("2026-10-01"));
    expect(data.winterRateAdultCents).toBe(4500);
    expect(data.winterSeasonStart).toEqual(day("2026-06-01"));
    expect(data.winterSeasonEnd).toEqual(day("2026-09-30"));
  });

  it("clears a season's rates and dates only when the Fees page has no season of that type at all", () => {
    const data = feesDerivedOtherLodgeData([WINTER_2026], NM, day("2026-07-01"));
    expect(data.summerRateAdultCents).toBeNull();
    expect(data.summerSeasonStart).toBeNull();
    expect(data.winterRateAdultCents).toBe(4500);
  });

  it("drops only the later season's dates when the two would overlap as yearly dates; the rates still go", () => {
    const longSummer = season("SUMMER", "2026-12-01", "2027-07-15", 3500);
    const data = feesDerivedOtherLodgeData([WINTER_2026, longSummer], NM, day("2026-07-01"));
    expect(data.winterRateAdultCents).toBe(4500);
    expect(data.summerRateAdultCents).toBe(3500);
    // Winter (running today) keeps its dates; the summer that starts later gives them up.
    expect([data.winterSeasonStart, data.winterSeasonEnd]).toEqual([day("2026-06-01"), day("2026-09-30")]);
    expect([data.summerSeasonStart, data.summerSeasonEnd]).toEqual([null, null]);
  });
});

describe("syncOwnOtherLodgesFromFees (#77)", () => {
  const stored = {
    id: "ol-1",
    name: "Waiopehu Hut",
    hiddenAt: null,
    ratesFromFees: true,
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    winterRateUnder5Cents: 0,
    winterRate5To11Cents: 2000,
    winterRate12To17Cents: 3000,
    winterRateAdultCents: 4500,
    summerRateUnder5Cents: 3500,
    summerRate5To11Cents: 3500,
    summerRate12To17Cents: 3500,
    summerRateAdultCents: 3500,
    winterSeasonStart: day("2026-06-01"),
    winterSeasonEnd: day("2026-09-30"),
    summerSeasonStart: day("2026-12-01"),
    summerSeasonEnd: day("2027-03-31"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadServerNzSettings.mockResolvedValue({ otherLodgesOwnedLodges: [{ id: "c-1", name: "Waiopehu Hut" }] });
    mocks.membershipTypeFindUnique.mockResolvedValue({ id: NM });
    mocks.otherLodgeFindUnique.mockResolvedValue(stored);
    mocks.otherLodgeUpdateMany.mockResolvedValue({ count: 1 });
    mocks.resolveLocalLodgeForCentralId.mockResolvedValue("lodge-1");
    mocks.today.mockResolvedValue(day("2026-07-01"));
    mocks.seasonFindMany.mockResolvedValue([WINTER_2026, SUMMER_2026].map(asRow));
  });

  it("writes nothing, and records nothing, when the lodge already matches its Fees page", async () => {
    expect(await syncOwnOtherLodgesFromFees("upload")).toEqual([
      { otherLodgeId: "ol-1", name: "Waiopehu Hut", problem: null, changed: false },
    ]);
    expect(mocks.otherLodgeUpdateMany).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
    // The lodge's ACTIVE seasons, found through the Central lodge link.
    expect(mocks.resolveLocalLodgeForCentralId).toHaveBeenCalledWith("c-1", [{ id: "c-1", name: "Waiopehu Hut" }]);
    expect(mocks.seasonFindMany.mock.calls[0][0].where).toEqual({ lodgeId: "lodge-1", active: true });
  });

  it("writes only the fields that changed, guarded on the row as read, and records them in words", async () => {
    mocks.otherLodgeFindUnique.mockResolvedValue({ ...stored, winterRateAdultCents: 4000, summerSeasonEnd: null });
    expect(await syncOwnOtherLodgesFromFees("lodge saved", "admin-1")).toEqual([
      { otherLodgeId: "ol-1", name: "Waiopehu Hut", problem: null, changed: true },
    ]);
    expect(mocks.otherLodgeUpdateMany).toHaveBeenCalledWith({
      where: { id: "ol-1", updatedAt: stored.updatedAt, ratesFromFees: true, hiddenAt: null },
      data: { winterRateAdultCents: 4500, summerSeasonEnd: day("2027-03-31") },
    });
    expect(mocks.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "OTHER_LODGE_RATES_FROM_FEES",
        category: "lodge",
        memberId: "admin-1",
        entityType: "OtherLodge",
        entityId: "ol-1",
        details: "Winter rate, Adult: $40.00 to $45.00; Summer season end date: blank to 2027-03-31 (lodge saved)",
      }),
    );
  });

  it("leaves a row saved in the meantime (the switch turned off, say), and records nothing", async () => {
    mocks.otherLodgeFindUnique.mockResolvedValue({ ...stored, winterRateAdultCents: 4000 });
    mocks.otherLodgeUpdateMany.mockResolvedValue({ count: 0 });
    expect(await syncOwnOtherLodgesFromFees("upload")).toEqual([]);
    expect(mocks.createAuditLog).not.toHaveBeenCalled();
  });

  it("leaves the stored rates as they are when the Fees page gives no Non-Member rate at all", async () => {
    mocks.seasonFindMany.mockResolvedValue([
      { ...asRow(WINTER_2026), membershipTypeRates: [{ membershipTypeId: "type-full", ageTier: "ADULT", pricePerNightCents: 1 }] },
    ]);
    mocks.otherLodgeFindUnique.mockResolvedValue({ ...stored, winterRateAdultCents: 4000 });
    expect(await syncOwnOtherLodgesFromFees("upload")).toEqual([
      { otherLodgeId: "ol-1", name: "Waiopehu Hut", problem: "no-rates", changed: false },
    ]);
    expect(mocks.otherLodgeUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a Fees rate over the central server's limit rather than failing the write", async () => {
    mocks.seasonFindMany.mockResolvedValue([asRow(season("WINTER", "2026-06-01", "2026-09-30", { ADULT: 10_000_000 }))]);
    mocks.otherLodgeFindUnique.mockResolvedValue({ ...stored, winterRateAdultCents: 4000 });
    expect((await syncOwnOtherLodgesFromFees("upload"))[0]?.problem).toBe("rate-too-high");
    expect(mocks.otherLodgeUpdateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["the switch is off", { ratesFromFees: false }],
    ["the lodge is hidden", { hiddenAt: new Date() }],
  ])("leaves the lodge alone, and reports nothing, when %s", async (_label, overrides) => {
    mocks.otherLodgeFindUnique.mockResolvedValue({ ...stored, winterRateAdultCents: 1, ...overrides });
    expect(await syncOwnOtherLodgesFromFees("upload")).toEqual([]);
    expect(mocks.otherLodgeUpdateMany).not.toHaveBeenCalled();
  });

  it.each([
    ["the owned list is unknown", () => mocks.loadServerNzSettings.mockResolvedValue({ otherLodgesOwnedLodges: null })],
    ["no Non-Member type exists", () => mocks.membershipTypeFindUnique.mockResolvedValue(null)],
    ["the owned lodge has no row here yet", () => mocks.otherLodgeFindUnique.mockResolvedValue(null)],
    ["no club lodge is linked to it", () => mocks.resolveLocalLodgeForCentralId.mockResolvedValue(null)],
  ])("writes nothing when %s", async (_label, arrange) => {
    // A lodge that WOULD change, so writing nothing is the guard's doing.
    mocks.otherLodgeFindUnique.mockResolvedValue({ ...stored, winterRateAdultCents: 1 });
    arrange();
    await syncOwnOtherLodgesFromFees("upload");
    expect(mocks.otherLodgeUpdateMany).not.toHaveBeenCalled();
  });

  it("says why it could not fill: an unlinked lodge, or no Non-Member type", async () => {
    mocks.resolveLocalLodgeForCentralId.mockResolvedValue(null);
    expect((await syncOwnOtherLodgesFromFees("upload"))[0]?.problem).toBe("no-local-lodge");
    mocks.membershipTypeFindUnique.mockResolvedValue(null);
    expect((await syncOwnOtherLodgesFromFees("upload"))[0]?.problem).toBe("no-non-member-type");
  });

  it("never throws to its caller: a failed lodge is reported and the next one is still filled", async () => {
    mocks.loadServerNzSettings.mockResolvedValue({
      otherLodgesOwnedLodges: [{ id: "c-1", name: "Waiopehu Hut" }, { id: "c-2", name: "Second Hut" }],
    });
    mocks.otherLodgeFindUnique.mockImplementation(async ({ where }: { where: { centralId: string } }) =>
      where.centralId === "c-1"
        ? { ...stored, winterRateAdultCents: 1 }
        : { ...stored, id: "ol-2", name: "Second Hut", winterRateAdultCents: 1 },
    );
    mocks.seasonFindMany
      .mockRejectedValueOnce(new Error("database down"))
      .mockResolvedValueOnce([WINTER_2026, SUMMER_2026].map(asRow));
    await expect(syncOwnOtherLodgesFromFees("fees season created")).resolves.toEqual([
      { otherLodgeId: "ol-1", name: "Waiopehu Hut", problem: "failed", changed: false },
      { otherLodgeId: "ol-2", name: "Second Hut", problem: null, changed: true },
    ]);
    expect(mocks.otherLodgeUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("never throws when the settings cannot be read", async () => {
    mocks.loadServerNzSettings.mockRejectedValue(new Error("database down"));
    await expect(syncOwnOtherLodgesFromFees("upload")).resolves.toEqual([]);
  });
});

describe("otherLodgeFeesProblem (#77)", () => {
  const owned = [{ id: "c-1", name: "Waiopehu Hut" }];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.membershipTypeFindUnique.mockResolvedValue({ id: NM });
    mocks.resolveLocalLodgeForCentralId.mockResolvedValue("lodge-1");
    mocks.today.mockResolvedValue(day("2026-07-01"));
    mocks.seasonFindMany.mockResolvedValue([asRow(WINTER_2026)]);
  });

  it("is null when the Fees page can fill the lodge, or when the switch is off", async () => {
    expect(await otherLodgeFeesProblem({ centralId: "c-1", ratesFromFees: true }, owned)).toBeNull();
    mocks.resolveLocalLodgeForCentralId.mockResolvedValue(null);
    expect(await otherLodgeFeesProblem({ centralId: "c-1", ratesFromFees: false }, owned)).toBeNull();
  });

  it("says why it cannot, in words", async () => {
    mocks.resolveLocalLodgeForCentralId.mockResolvedValue(null);
    expect(await otherLodgeFeesProblem({ centralId: "c-1", ratesFromFees: true }, owned)).toBe(
      FEES_FILL_PROBLEM_TEXT["no-local-lodge"],
    );
    mocks.resolveLocalLodgeForCentralId.mockResolvedValue("lodge-1");
    mocks.seasonFindMany.mockRejectedValue(new Error("down"));
    expect(await otherLodgeFeesProblem({ centralId: "c-1", ratesFromFees: true }, owned)).toBe(FEES_FILL_PROBLEM_TEXT.failed);
  });
});
