import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The whole module, not just the export this file names. `dateRange` now reaches
// the kernel's declared `HOUSE_SHAPES.date` formatter instead of a hand-rolled
// `Intl.DateTimeFormat` (#3123), which reads `APP_LOCALE` at import — and a
// partial factory throws there before a single test runs.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  entranceFees: vi.fn(),
  lodge: vi.fn(),
  cancellation: vi.fn(),
  periods: vi.fn(),
  membershipTypes: vi.fn(),
  membershipTypeFindFirst: vi.fn(),
  lodges: vi.fn(),
  seasons: vi.fn(),
  ageTiers: vi.fn(),
  defaults: vi.fn(),
  minimumStays: vi.fn(),
  discount: vi.fn(),
  hostingPolicies: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  publicContentSettings: { findUnique: mocks.settings },
  entranceFee: { findMany: mocks.entranceFees },
  lodge: { findFirst: mocks.lodge, findMany: mocks.lodges },
  membershipType: { findMany: mocks.membershipTypes, findFirst: mocks.membershipTypeFindFirst },
  season: { findMany: mocks.seasons },
  ageTierSetting: { findMany: mocks.ageTiers },
  bookingDefaults: { findUnique: mocks.defaults },
  minimumStayPolicy: { findMany: mocks.minimumStays },
  adultMemberHostingPolicy: { findMany: mocks.hostingPolicies },
  groupDiscountSetting: { findUnique: mocks.discount },
  cancellationPolicy: { findMany: mocks.cancellation },
  bookingPeriod: { findMany: mocks.periods },
} }));

import {
  loadPublicAnnualFees,
  loadPublicCancellationPolicy,
  loadPublicHutFees,
  loadPublicJoiningFees,
  loadPublicBookingPolicy,
  describePublicCancellationRules,
} from "@/lib/public-page-content-tokens";

describe("public PageContent token view models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
      Object.fromEntries(Object.keys(select).map((key) => [key, true])),
    );
    mocks.periods.mockResolvedValue([]);
    mocks.minimumStays.mockResolvedValue([]);
    mocks.discount.mockResolvedValue(null);
    mocks.defaults.mockResolvedValue(null);
    mocks.hostingPolicies.mockResolvedValue([]);
  });

  it("keeps every block hidden when its persisted opt-in row is absent", async () => {
    mocks.settings.mockResolvedValue(null);
    await expect(loadPublicAnnualFees()).resolves.toEqual([]);
    await expect(loadPublicJoiningFees()).resolves.toEqual([]);
    await expect(loadPublicHutFees()).resolves.toEqual([]);
    await expect(loadPublicBookingPolicy()).resolves.toBeNull();
    await expect(loadPublicCancellationPolicy()).resolves.toBeNull();
    expect(mocks.membershipTypes).not.toHaveBeenCalled();
    expect(mocks.lodges).not.toHaveBeenCalled();
    expect(mocks.cancellation).not.toHaveBeenCalled();
  });

  it("groups public joining fees by membership type in configured age order (#1933)", async () => {
    mocks.membershipTypes.mockResolvedValue([
      { key: "FULL", name: "Full", ageGroupsApply: true, joiningFees: [
        { ageTier: "ADULT", amountCents: 12500 },
        { ageTier: "YOUTH", amountCents: 5000 },
      ] },
    ]);
    mocks.ageTiers.mockResolvedValue([
      { tier: "YOUTH", label: "Youth", sortOrder: 1 },
      { tier: "ADULT", label: "Adult", sortOrder: 2 },
    ]);
    await expect(loadPublicJoiningFees()).resolves.toEqual([
      { heading: "Full", rows: [
        { label: "Youth", fee: { amountCents: 5000, label: "$50.00" } },
        { label: "Adult", fee: { amountCents: 12500, label: "$125.00" } },
      ] },
    ]);
    expect(mocks.membershipTypes).toHaveBeenCalledWith(expect.objectContaining({ where: { isActive: true, publiclyListed: true } }));
  });

  it("regroups public joining fees by age tier when byAge is set (#1933)", async () => {
    mocks.membershipTypes.mockResolvedValue([
      { key: "FULL", name: "Full", ageGroupsApply: true, joiningFees: [{ ageTier: "ADULT", amountCents: 12500 }] },
      { key: "ASSOC", name: "Associate", ageGroupsApply: true, joiningFees: [{ ageTier: "ADULT", amountCents: 8000 }] },
    ]);
    mocks.ageTiers.mockResolvedValue([{ tier: "ADULT", label: "Adult", sortOrder: 2 }]);
    await expect(loadPublicJoiningFees({ byAge: true })).resolves.toEqual([
      { heading: "Adult", rows: [
        { label: "Full", fee: { amountCents: 12500, label: "$125.00" } },
        { label: "Associate", fee: { amountCents: 8000, label: "$80.00" } },
      ] },
    ]);
  });

  it("returns the empty state for an unknown/unlisted joining-fee type (#1933)", async () => {
    mocks.membershipTypes.mockResolvedValue([
      { key: "FULL", name: "Full", ageGroupsApply: true, joiningFees: [{ ageTier: "ADULT", amountCents: 12500 }] },
    ]);
    mocks.ageTiers.mockResolvedValue([{ tier: "ADULT", label: "Adult", sortOrder: 2 }]);
    await expect(loadPublicJoiningFees({ typeKey: "NOT_LISTED" })).resolves.toEqual([]);
  });

  it("fails closed for an invalid lodge slug", async () => {
    mocks.lodge.mockResolvedValue(null);
    await expect(loadPublicHutFees("missing-lodge")).resolves.toEqual([]);
    await expect(loadPublicBookingPolicy("missing-lodge")).resolves.toBeNull();
    await expect(loadPublicCancellationPolicy("missing-lodge")).resolves.toBeNull();
    expect(mocks.seasons).not.toHaveBeenCalled();
    expect(mocks.cancellation).not.toHaveBeenCalled();
  });

  it("lists annual fee totals per listed type and omits no-invoice schedules (#1933)", async () => {
    mocks.membershipTypes.mockResolvedValue([
      { key: "FULL", name: "Full", annualFees: [{ amountCents: 15000, billingBasis: "PER_MEMBER", components: [] }] },
      { key: "LIFE", name: "Life", annualFees: [{ amountCents: 0, billingBasis: "NO_INVOICE", components: [] }] },
    ]);
    await expect(loadPublicAnnualFees()).resolves.toEqual([
      { heading: "Annual membership fees", rows: [{ label: "Full", fee: { amountCents: 15000, label: "$150.00" } }] },
    ]);
    expect(mocks.membershipTypes).toHaveBeenCalledWith(expect.objectContaining({ where: { isActive: true, publiclyListed: true } }));
  });

  it("expands annual fee components when components is set (#1933)", async () => {
    mocks.membershipTypes.mockResolvedValue([
      { key: "FULL", name: "Full", annualFees: [{ amountCents: 15000, billingBasis: "PER_MEMBER", components: [
        { label: "Base membership", amountCents: 10000 },
        { label: "Work party", amountCents: 5000 },
      ] }] },
    ]);
    await expect(loadPublicAnnualFees({ components: true })).resolves.toEqual([
      { heading: "Full", rows: [
        { label: "Base membership", fee: { amountCents: 10000, label: "$100.00" } },
        { label: "Work party", fee: { amountCents: 5000, label: "$50.00" } },
      ] },
    ]);
  });

  it("lists per-age-tier annual fees as 'Type — Tier' rows in age order (#2067)", async () => {
    mocks.ageTiers.mockResolvedValue([
      { tier: "YOUTH", label: "Youth", sortOrder: 1 },
      { tier: "ADULT", label: "Adult", sortOrder: 2 },
    ]);
    mocks.membershipTypes.mockResolvedValue([
      { key: "FULL", name: "Full", ageGroupsApply: true, annualFees: [
        { ageTier: "ADULT", amountCents: 15000, billingBasis: "PER_MEMBER", components: [] },
        { ageTier: "YOUTH", amountCents: 8000, billingBasis: "PER_MEMBER", components: [] },
      ] },
    ]);
    await expect(loadPublicAnnualFees()).resolves.toEqual([
      { heading: "Annual membership fees", rows: [
        { label: "Full — Youth", fee: { amountCents: 8000, label: "$80.00" } },
        { label: "Full — Adult", fee: { amountCents: 15000, label: "$150.00" } },
      ] },
    ]);
  });

  it("collapses per-tier rows to a plain type row when ageGroupsApply is false (#2067)", async () => {
    mocks.ageTiers.mockResolvedValue([{ tier: "ADULT", label: "Adult", sortOrder: 2 }]);
    mocks.membershipTypes.mockResolvedValue([
      { key: "ORG", name: "Org", ageGroupsApply: false, annualFees: [
        { ageTier: "ADULT", amountCents: 20000, billingBasis: "PER_MEMBER", components: [] },
      ] },
    ]);
    await expect(loadPublicAnnualFees()).resolves.toEqual([
      { heading: "Annual membership fees", rows: [{ label: "Org", fee: { amountCents: 20000, label: "$200.00" } }] },
    ]);
  });

  it("dedupes to the current fee per tier and omits a tier whose current fee is no-invoice (#2067)", async () => {
    mocks.ageTiers.mockResolvedValue([
      { tier: "YOUTH", label: "Youth", sortOrder: 1 },
      { tier: "ADULT", label: "Adult", sortOrder: 2 },
    ]);
    mocks.membershipTypes.mockResolvedValue([
      { key: "FULL", name: "Full", ageGroupsApply: true, annualFees: [
        // effectiveFrom desc: first per tier is current.
        { ageTier: "ADULT", amountCents: 0, billingBasis: "NO_INVOICE", components: [] }, // current ADULT is no-invoice -> omit
        { ageTier: "ADULT", amountCents: 12000, billingBasis: "PER_MEMBER", components: [] }, // older ADULT must not resurface
        { ageTier: "YOUTH", amountCents: 8000, billingBasis: "PER_MEMBER", components: [] },
        { ageTier: "YOUTH", amountCents: 7000, billingBasis: "PER_MEMBER", components: [] }, // older YOUTH deduped away
      ] },
    ]);
    await expect(loadPublicAnnualFees()).resolves.toEqual([
      { heading: "Annual membership fees", rows: [
        { label: "Full — Youth", fee: { amountCents: 8000, label: "$80.00" } },
      ] },
    ]);
  });

  // ---------------------------------------------------------------------
  // Hut fees (#2129): sourced from MembershipTypeSeasonRate, rendered as a
  // real table of age tiers x collapsed membership-type rate columns.
  // ---------------------------------------------------------------------

  const hutType = (
    id: string,
    name: string,
    sortOrder: number,
    ageGroupsApply = true,
  ) => ({ id, name, sortOrder, ageGroupsApply });

  const hutSeason = (
    rates: Array<{ ageTier: string | null; pricePerNightCents: number; membershipType: ReturnType<typeof hutType> }>,
    overrides: Record<string, unknown> = {},
  ) => ({
    lodgeId: "l1",
    name: "Winter",
    startDate: new Date("2026-06-01"),
    endDate: new Date("2026-10-01"),
    membershipTypeRates: rates,
    ...overrides,
  });

  const twoAgeTiers = [
    { tier: "CHILD", label: "Child (5–12)", sortOrder: 1 },
    { tier: "ADULT", label: "Adult (18+)", sortOrder: 2 },
  ];

  it("tabulates public hut fees per season as age tiers x membership-type columns (#2129)", async () => {
    const full = hutType("t-full", "Full Member", 1);
    const nonMember = hutType("t-non", "Non-member", 9);
    mocks.lodges.mockResolvedValue([{ id: "l1", name: "River Lodge", slug: "river" }]);
    mocks.seasons.mockResolvedValue([hutSeason([
      { ageTier: "ADULT", pricePerNightCents: 4000, membershipType: full },
      { ageTier: "CHILD", pricePerNightCents: 2000, membershipType: full },
      { ageTier: "ADULT", pricePerNightCents: 6000, membershipType: nonMember },
      { ageTier: "CHILD", pricePerNightCents: 3000, membershipType: nonMember },
    ])]);
    mocks.ageTiers.mockResolvedValue(twoAgeTiers);
    const tables = await loadPublicHutFees();
    expect(tables).toHaveLength(1);
    expect(tables[0]?.heading).toContain("River Lodge — Winter");
    expect(tables[0]?.heading).toContain("nightly rates");
    expect(tables[0]?.rowHeading).toBe("Age");
    expect(tables[0]?.columns).toEqual(["Full Member", "Non-member"]);
    expect(tables[0]?.rows).toEqual([
      { label: "Child (5–12)", cells: [
        { amountCents: 2000, label: "$20.00" },
        { amountCents: 3000, label: "$30.00" },
      ] },
      { label: "Adult (18+)", cells: [
        { amountCents: 4000, label: "$40.00" },
        { amountCents: 6000, label: "$60.00" },
      ] },
    ]);
    // Only publicly-listed active types may earn a column.
    expect(mocks.seasons).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        membershipTypeRates: expect.objectContaining({
          where: { membershipType: { isActive: true, publiclyListed: true } },
        }),
      }),
    }));
  });

  it("never leaks a non-publicly-listed type's name or price into the table (#2129)", async () => {
    // The entire exposure story for this embed rests on ONE nested relation
    // filter. Rather than assert the filter object's shape (which passes even
    // if the filter is semantically wrong), drive the mock with a dataset that
    // contains a private type and have it APPLY the where-clause the loader
    // actually sent. If the loader ever stops filtering, or filters on the
    // wrong field, the private rows flow through and this fails.
    const listed = { id: "t-full", name: "Full Member", sortOrder: 1, ageGroupsApply: true };
    const secret = { id: "t-staff", name: "Staff Comp Rate", sortOrder: 2, ageGroupsApply: true };
    const publiclyListedById: Record<string, boolean> = { "t-full": true, "t-staff": false };
    const allRates = [
      { ageTier: "ADULT", pricePerNightCents: 4000, membershipType: listed },
      { ageTier: "ADULT", pricePerNightCents: 111, membershipType: secret },
      { ageTier: "CHILD", pricePerNightCents: 2000, membershipType: listed },
      { ageTier: "CHILD", pricePerNightCents: 222, membershipType: secret },
    ];
    mocks.lodges.mockResolvedValue([{ id: "l1", name: "River Lodge", slug: "river" }]);
    mocks.seasons.mockImplementation(({ select }: { select: Record<string, { where?: { membershipType?: { isActive?: boolean; publiclyListed?: boolean } } }> }) => {
      const where = select.membershipTypeRates?.where?.membershipType ?? {};
      return Promise.resolve([
        hutSeason(
          allRates.filter((rate) =>
            where.publiclyListed === true
              ? publiclyListedById[rate.membershipType.id] === true
              : true,
          ),
        ),
      ]);
    });
    mocks.ageTiers.mockResolvedValue(twoAgeTiers);
    const tables = await loadPublicHutFees();

    expect(tables[0]?.columns).toEqual(["Full Member"]);
    const serialised = JSON.stringify(tables);
    expect(serialised).not.toContain("Staff Comp Rate");
    expect(serialised).not.toContain("t-staff");
    // The prices themselves must not surface anywhere either — not as a stray
    // cell, not folded into another type's column.
    expect(serialised).not.toContain("111");
    expect(serialised).not.toContain("222");
    expect(serialised).not.toContain("$1.11");
    expect(serialised).not.toContain("$2.22");
  });

  it("renders a genuinely free $0.00 rate and an absent rate differently (#2129)", async () => {
    // Zero is a real price; absent is not. Both live in the SAME row here, so a
    // regression that conflated them (for example flattening cells to
    // Array<number | null>, making 0 falsy) turns a free infant night into "no
    // rate" and cannot hide behind a passing sibling assertion.
    const full = hutType("t-full", "Full Member", 1);
    const nonMember = hutType("t-non", "Non-member", 9);
    mocks.lodges.mockResolvedValue([{ id: "l1", name: "River Lodge", slug: "river" }]);
    mocks.seasons.mockResolvedValue([hutSeason([
      { ageTier: "CHILD", pricePerNightCents: 0, membershipType: full },
      // Non-member carries no CHILD row at all -> that cell must be null.
      { ageTier: "ADULT", pricePerNightCents: 4000, membershipType: full },
      { ageTier: "ADULT", pricePerNightCents: 6000, membershipType: nonMember },
    ])]);
    mocks.ageTiers.mockResolvedValue(twoAgeTiers);
    const tables = await loadPublicHutFees();
    expect(tables[0]?.rows).toEqual([
      { label: "Child (5–12)", cells: [{ amountCents: 0, label: "$0.00" }, null] },
      { label: "Adult (18+)", cells: [
        { amountCents: 4000, label: "$40.00" },
        { amountCents: 6000, label: "$60.00" },
      ] },
    ]);
  });

  it("collapses identically-priced membership types into one shared column (#2129)", async () => {
    const full = hutType("t-full", "Full Member", 1);
    const life = hutType("t-life", "Life", 2);
    const family = hutType("t-family", "Family", 3);
    const nonMember = hutType("t-non", "Non-member", 9);
    mocks.lodges.mockResolvedValue([{ id: "l1", name: "River Lodge", slug: "river" }]);
    mocks.seasons.mockResolvedValue([hutSeason([
      { ageTier: "ADULT", pricePerNightCents: 4000, membershipType: full },
      { ageTier: "ADULT", pricePerNightCents: 4000, membershipType: life },
      { ageTier: "ADULT", pricePerNightCents: 4000, membershipType: family },
      { ageTier: "ADULT", pricePerNightCents: 6000, membershipType: nonMember },
    ])]);
    mocks.ageTiers.mockResolvedValue(twoAgeTiers);
    const tables = await loadPublicHutFees();
    expect(tables[0]?.columns).toEqual(["Full Member, Life, Family", "Non-member"]);
    expect(tables[0]?.rows).toEqual([
      { label: "Adult (18+)", cells: [
        { amountCents: 4000, label: "$40.00" },
        { amountCents: 6000, label: "$60.00" },
      ] },
    ]);
  });

  it("splits a repriced type out of its collapsed column with no code change (#2129)", async () => {
    const full = hutType("t-full", "Full Member", 1);
    const life = hutType("t-life", "Life", 2);
    const family = hutType("t-family", "Family", 3);
    mocks.lodges.mockResolvedValue([{ id: "l1", name: "River Lodge", slug: "river" }]);
    mocks.seasons.mockResolvedValue([hutSeason([
      { ageTier: "ADULT", pricePerNightCents: 4000, membershipType: full },
      // Life has been repriced; Full and Family still match each other.
      { ageTier: "ADULT", pricePerNightCents: 4500, membershipType: life },
      { ageTier: "ADULT", pricePerNightCents: 4000, membershipType: family },
    ])]);
    mocks.ageTiers.mockResolvedValue(twoAgeTiers);
    const tables = await loadPublicHutFees();
    expect(tables[0]?.columns).toEqual(["Full Member, Family", "Life"]);
    expect(tables[0]?.rows[0]?.cells).toEqual([
      { amountCents: 4000, label: "$40.00" },
      { amountCents: 4500, label: "$45.00" },
    ]);
  });

  it("orders columns by the lowest sortOrder of the types sharing them (#2129)", async () => {
    mocks.lodges.mockResolvedValue([{ id: "l1", name: "River Lodge", slug: "river" }]);
    mocks.seasons.mockResolvedValue([hutSeason([
      { ageTier: "ADULT", pricePerNightCents: 6000, membershipType: hutType("t-non", "Non-member", 9) },
      { ageTier: "ADULT", pricePerNightCents: 5000, membershipType: hutType("t-assoc", "Associate", 5) },
      // Collapses with Associate but carries the lower sortOrder, so the
      // shared column sorts first and is headed "Full Member, Associate".
      { ageTier: "ADULT", pricePerNightCents: 5000, membershipType: hutType("t-full", "Full Member", 1) },
    ])]);
    mocks.ageTiers.mockResolvedValue(twoAgeTiers);
    const tables = await loadPublicHutFees();
    expect(tables[0]?.columns).toEqual(["Full Member, Associate", "Non-member"]);
  });

  it("renders a flat (NULL age tier) type as a single All ages row and dashes missing cells (#2129)", async () => {
    mocks.lodges.mockResolvedValue([{ id: "l1", name: "River Lodge", slug: "river" }]);
    mocks.seasons.mockResolvedValue([hutSeason([
      { ageTier: "ADULT", pricePerNightCents: 4000, membershipType: hutType("t-full", "Full Member", 1) },
      { ageTier: null, pricePerNightCents: 9000, membershipType: hutType("t-school", "School Group", 4, false) },
    ])]);
    mocks.ageTiers.mockResolvedValue(twoAgeTiers);
    const tables = await loadPublicHutFees();
    expect(tables[0]?.columns).toEqual(["Full Member", "School Group"]);
    expect(tables[0]?.rows).toEqual([
      { label: "Adult (18+)", cells: [{ amountCents: 4000, label: "$40.00" }, null] },
      { label: "All ages", cells: [null, { amountCents: 9000, label: "$90.00" }] },
    ]);
  });

  it("folds stray per-tier rows onto one flat rate when ageGroupsApply is false (#2129)", async () => {
    mocks.lodges.mockResolvedValue([{ id: "l1", name: "River Lodge", slug: "river" }]);
    mocks.seasons.mockResolvedValue([hutSeason([
      { ageTier: "ADULT", pricePerNightCents: 9000, membershipType: hutType("t-school", "School Group", 4, false) },
      { ageTier: "CHILD", pricePerNightCents: 1000, membershipType: hutType("t-school", "School Group", 4, false) },
    ])]);
    mocks.ageTiers.mockResolvedValue(twoAgeTiers);
    const tables = await loadPublicHutFees();
    expect(tables[0]?.rows).toEqual([
      { label: "All ages", cells: [{ amountCents: 9000, label: "$90.00" }] },
    ]);
  });

  it("filters hut fees to one membership type's column when type= is given (#2129)", async () => {
    mocks.lodges.mockResolvedValue([{ id: "l1", name: "River Lodge", slug: "river" }]);
    mocks.membershipTypeFindFirst.mockResolvedValue({ id: "t-full" });
    mocks.seasons.mockResolvedValue([hutSeason([
      { ageTier: "ADULT", pricePerNightCents: 4000, membershipType: hutType("t-full", "Full Member", 1) },
    ])]);
    mocks.ageTiers.mockResolvedValue(twoAgeTiers);
    const tables = await loadPublicHutFees(undefined, { typeKey: "full" });
    expect(tables[0]?.columns).toEqual(["Full Member"]);
    // The resolved type id is pushed into the rate query — type= now genuinely
    // filters rather than only validating (the #2129 semantic change).
    expect(mocks.seasons).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        membershipTypeRates: expect.objectContaining({
          where: expect.objectContaining({ membershipTypeId: "t-full" }),
        }),
      }),
    }));
  });

  it("fails closed for an unknown or unlisted hut-fee type key (#2129)", async () => {
    mocks.lodges.mockResolvedValue([{ id: "l1", name: "River Lodge", slug: "river" }]);
    mocks.membershipTypeFindFirst.mockResolvedValue(null);
    await expect(loadPublicHutFees(undefined, { typeKey: "NOT_LISTED" })).resolves.toEqual([]);
    expect(mocks.seasons).not.toHaveBeenCalled();
  });

  it("splits a hut-fee season into one table per membership-type column when group-by=type (#2129)", async () => {
    mocks.lodges.mockResolvedValue([{ id: "l1", name: "River Lodge", slug: "river" }]);
    mocks.seasons.mockResolvedValue([hutSeason([
      { ageTier: "ADULT", pricePerNightCents: 4000, membershipType: hutType("t-full", "Full Member", 1) },
      { ageTier: "ADULT", pricePerNightCents: 6000, membershipType: hutType("t-non", "Non-member", 9) },
    ])]);
    mocks.ageTiers.mockResolvedValue(twoAgeTiers);
    const tables = await loadPublicHutFees(undefined, { groupBy: new Set(["type"]) });
    expect(tables).toHaveLength(2);
    expect(tables[0]?.heading.endsWith("· Full Member")).toBe(true);
    expect(tables[1]?.heading.endsWith("· Non-member")).toBe(true);
    expect(tables.map((table) => table.columns)).toEqual([["Full Member"], ["Non-member"]]);
  });

  it("transposes the hut-fee table when group-by=age (#2129)", async () => {
    mocks.lodges.mockResolvedValue([{ id: "l1", name: "River Lodge", slug: "river" }]);
    mocks.seasons.mockResolvedValue([hutSeason([
      { ageTier: "ADULT", pricePerNightCents: 4000, membershipType: hutType("t-full", "Full Member", 1) },
      { ageTier: "CHILD", pricePerNightCents: 2000, membershipType: hutType("t-full", "Full Member", 1) },
      { ageTier: "ADULT", pricePerNightCents: 6000, membershipType: hutType("t-non", "Non-member", 9) },
    ])]);
    mocks.ageTiers.mockResolvedValue(twoAgeTiers);
    const tables = await loadPublicHutFees(undefined, { groupBy: new Set(["age"]) });
    expect(tables[0]?.rowHeading).toBe("Membership type");
    expect(tables[0]?.columns).toEqual(["Child (5–12)", "Adult (18+)"]);
    expect(tables[0]?.rows).toEqual([
      { label: "Full Member", cells: [
        { amountCents: 2000, label: "$20.00" },
        { amountCents: 4000, label: "$40.00" },
      ] },
      { label: "Non-member", cells: [null, { amountCents: 6000, label: "$60.00" }] },
    ]);
  });

  it("omits a season whose publicly-listed types carry no rates (#2129)", async () => {
    mocks.lodges.mockResolvedValue([{ id: "l1", name: "River Lodge", slug: "river" }]);
    mocks.seasons.mockResolvedValue([hutSeason([])]);
    mocks.ageTiers.mockResolvedValue(twoAgeTiers);
    await expect(loadPublicHutFees()).resolves.toEqual([]);
  });

  it("summarizes only customer-facing booking policy fields", async () => {
    mocks.defaults.mockResolvedValue({ nonMemberHoldEnabled: true, nonMemberHoldDays: 7, waitlistCrossLodgeOrder: "MERGED" });
    mocks.periods.mockResolvedValue([{ name: "School holidays", startDate: new Date("2026-09-01"), endDate: new Date("2026-09-10"), nonMemberHoldEnabled: false, nonMemberHoldDays: 3, lodgeId: null, cancellationRules: [{ secret: true }] }]);
    mocks.minimumStays.mockResolvedValue([{ name: "Weekend", startDate: new Date("2026-07-01"), endDate: new Date("2026-08-01"), minimumNights: 2, triggerDays: [6], capacityMode: "NO_HOLD", lodgeId: null }]);
    mocks.discount.mockResolvedValue({ enabled: true, minGroupSize: 5, summerOnly: true, id: "internal" });
    const policy = await loadPublicBookingPolicy();
    expect(policy).toEqual(expect.objectContaining({ hold: expect.stringContaining("7 days"), groupDiscount: expect.stringContaining("5") }));
    expect(policy?.minimumStays[0]?.triggerDays).toBe("Saturday");
    // #2363 ships the model and the admin card, not the public promise: no
    // member can request an exception yet, so the token publishes no sentence
    // about what happens to capacity during a review. #2365 turns it on.
    expect(policy?.minimumStays[0]?.capacityHandling).toBeNull();
    expect(mocks.minimumStays).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ capacityMode: true }),
      }),
    );
    expect(JSON.stringify(policy)).not.toContain("waitlistCrossLodgeOrder");
    expect(JSON.stringify(policy)).not.toContain("secret");
    expect(JSON.stringify(policy)).not.toContain("internal");
  });

  it("publishes no exception-capacity sentence for either mode while the workflow is unshipped", async () => {
    mocks.minimumStays.mockResolvedValue([
      {
        name: "Held",
        startDate: new Date("2026-07-01"),
        endDate: new Date("2026-08-01"),
        minimumNights: 2,
        triggerDays: [6],
        capacityMode: "HOLD",
        lodgeId: null,
      },
      {
        name: "Not held",
        startDate: new Date("2026-08-02"),
        endDate: new Date("2026-09-01"),
        minimumNights: 2,
        triggerDays: [0],
        capacityMode: "NO_HOLD",
        lodgeId: null,
      },
    ]);

    const policy = await loadPublicBookingPolicy();

    // Both modes publish nothing: the stored choice still drives the admin card
    // and configuration transfer, but the public page must not describe an
    // exception request a member cannot make yet (#2365 owns that).
    expect(policy?.minimumStays.map((row) => row.capacityHandling)).toEqual([
      null,
      null,
    ]);
    // The nights and trigger days a member CAN act on are still published.
    expect(policy?.minimumStays.map((row) => row.name)).toEqual([
      "Held",
      "Not held",
    ]);
    expect(JSON.stringify(policy)).not.toContain("exception");
  });

  it("publishes the adult-member hosting rule only when it is actually in force (#2364)", async () => {
    const clubRow = {
      id: "hosting-club",
      scopeKey: "club-wide",
      lodgeId: null,
      mode: "ADMIN_REVIEW_REQUIRED",
      capacityMode: "HOLD",
      version: 2,
    };

    mocks.hostingPolicies.mockResolvedValue([]);
    expect((await loadPublicBookingPolicy())?.adultMemberHosting).toBeNull();

    mocks.hostingPolicies.mockResolvedValue([{ ...clubRow, mode: "DISABLED" }]);
    expect((await loadPublicBookingPolicy())?.adultMemberHosting).toBeNull();

    mocks.hostingPolicies.mockResolvedValue([clubRow]);
    const on = await loadPublicBookingPolicy();
    expect(on?.adultMemberHosting).toMatch(/adult member on the same\s+booking/);
    // Says what the rule IS; never invites an exception request, and never
    // leaks the policy id, revision or capacity mode.
    expect(on?.adultMemberHosting).not.toMatch(/exception|request/i);
    expect(JSON.stringify(on)).not.toContain("hosting-club");
    expect(JSON.stringify(on)).not.toContain("HOLD");
  });

  it("publishes the configured same-owner scope instead of the built-in same-booking default (#2569)", async () => {
    const stored = {
      id: "hosting-club",
      scopeKey: "club-wide",
      lodgeId: null,
      mode: "ENFORCED",
      capacityMode: "HOLD",
      version: 3,
      hostScopeSameBooking: true,
      hostScopeSameBookingOwner: true,
    };
    // Model Prisma's projection rather than returning fields the loader did not
    // request. This kills the regression where the resolver silently received
    // no scope columns and substituted its narrower built-in default.
    mocks.hostingPolicies.mockImplementation(
      ({ select }: { select: Record<string, boolean> }) =>
        Promise.resolve([
          Object.fromEntries(
            Object.keys(select).map((key) => [
              key,
              stored[key as keyof typeof stored],
            ]),
          ),
        ]),
    );

    const policy = await loadPublicBookingPolicy();

    expect(policy?.adultMemberHosting).toContain(
      "covered by an adult member staying at the lodge",
    );
    expect(policy?.adultMemberHosting).not.toContain("same booking");
    expect(mocks.hostingPolicies).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          hostScopeSameBooking: true,
          hostScopeSameBookingOwner: true,
        }),
      }),
    );
  });

  it("answers a lodge page from that lodge's override, and a club page from the club row (#2364)", async () => {
    mocks.lodge.mockResolvedValue({ id: "lodge-1", name: "Lodge One", slug: "one" });
    const clubOn = {
      id: "hosting-club",
      scopeKey: "club-wide",
      lodgeId: null,
      mode: "ADMIN_REVIEW_REQUIRED",
      capacityMode: "HOLD",
      version: 1,
    };
    const lodgeOff = {
      id: "hosting-lodge",
      scopeKey: "lodge-1",
      lodgeId: "lodge-1",
      mode: "DISABLED",
      capacityMode: "NO_HOLD",
      version: 1,
    };
    mocks.hostingPolicies.mockResolvedValue([clubOn, lodgeOff]);

    // The lodge relaxed it, so its own page says nothing.
    expect((await loadPublicBookingPolicy("one"))?.adultMemberHosting).toBeNull();

    // A page with no lodge in the URL is answered by the CLUB row alone, so one
    // lodge's relaxation cannot soften the club's stated rule elsewhere.
    mocks.hostingPolicies.mockResolvedValue([clubOn]);
    expect((await loadPublicBookingPolicy())?.adultMemberHosting).not.toBeNull();
  });

  it("scopes the hosting policy READ, not just the resolution (#2364)", async () => {
    // The resolver re-filters whatever comes back, so a drift in this predicate
    // is invisible to every other test here: the double answers the same rows
    // regardless of `where`. Assert the query itself, or a one-token change to
    // the scope filter ships green.
    mocks.lodge.mockResolvedValue({ id: "lodge-1", name: "Lodge One", slug: "one" });
    await loadPublicBookingPolicy("one");
    expect(mocks.hostingPolicies.mock.calls[0][0].where).toEqual({
      OR: [{ lodgeId: "lodge-1" }, { lodgeId: null }],
    });

    mocks.hostingPolicies.mockClear();
    await loadPublicBookingPolicy();
    // No lodge in the URL: the club row alone, never a lodge override that
    // would let one lodge's setting speak for the whole club.
    expect(mocks.hostingPolicies.mock.calls[0][0].where).toEqual({
      lodgeId: null,
    });
  });

  it("describes divergent card and credit cancellation terms", async () => {
    mocks.cancellation.mockResolvedValue([{
      daysBeforeStay: 14,
      refundPercentage: 80,
      creditRefundPercentage: 100,
      fixedFeeCents: 2500,
      creditFixedFeeCents: 0,
      lodgeId: null,
    }]);
    const policy = await loadPublicCancellationPolicy();
    expect(policy?.tiers[0]?.description).toBe(
      "14 or more days before check-in: 80% card refund less a $25.00 fee; 100% credit refund",
    );
    expect(policy?.tiers.slice(1)).toEqual([
      { description: "0–13 days before check-in: no refund" },
      { description: "After check-in: no refund" },
    ]);
  });

  it("renders threshold ranges, a nonzero same-day tier, and post-check-in fallback accurately", () => {
    expect(describePublicCancellationRules([
      { daysBeforeStay: 14, refundPercentage: 100 },
      { daysBeforeStay: 7, refundPercentage: 50 },
      { daysBeforeStay: 0, refundPercentage: 25 },
    ])).toEqual([
      { description: "14 or more days before check-in: 100% refund" },
      { description: "7–13 days before check-in: 50% refund" },
      { description: "0–6 days before check-in: 25% refund" },
      { description: "After check-in: no refund" },
    ]);
  });

  it("adds an implicit no-refund gap when a schedule has no zero-day tier", () => {
    expect(describePublicCancellationRules([
      { daysBeforeStay: 10, refundPercentage: 80 },
      { daysBeforeStay: 3, refundPercentage: 20 },
    ])).toEqual([
      { description: "10 or more days before check-in: 80% refund" },
      { description: "3–9 days before check-in: 20% refund" },
      { description: "0–2 days before check-in: no refund" },
      { description: "After check-in: no refund" },
    ]);
  });

  it("keeps the first persisted rule when dirty JSON repeats a threshold", () => {
    expect(describePublicCancellationRules([
      { daysBeforeStay: 7, refundPercentage: 75 },
      { daysBeforeStay: 7, refundPercentage: 10 },
      { daysBeforeStay: 0, refundPercentage: 0 },
    ])).toEqual([
      { description: "7 or more days before check-in: 75% refund" },
      { description: "0–6 days before check-in: 0% refund" },
      { description: "After check-in: no refund" },
    ]);
  });

  it("uses the same accurate ranges for named booking-period cancellation rules", async () => {
    mocks.cancellation.mockResolvedValue([]);
    mocks.periods.mockResolvedValue([{ name: "Holiday", startDate: new Date("2026-12-01"), endDate: new Date("2026-12-31"), lodgeId: null, cancellationRules: [
      { daysBeforeStay: 5, refundPercentage: 40, creditRefundPercentage: 60, fixedFeeCents: 500 },
    ] }]);
    const policy = await loadPublicCancellationPolicy();
    expect(policy?.tiers).toEqual([]);
    expect(policy?.periods[0]?.tiers).toEqual([
      { description: "5 or more days before check-in: 40% card refund less a $5.00 fee; 60% credit refund less a $5.00 fee" },
      { description: "0–4 days before check-in: no refund" },
      { description: "After check-in: no refund" },
    ]);
  });

  it("states when provisional holds are disabled globally and for a period", async () => {
    mocks.defaults.mockResolvedValue({ nonMemberHoldEnabled: false, nonMemberHoldDays: 7 });
    mocks.periods.mockResolvedValue([{ name: "Peak", startDate: new Date("2026-12-01"), endDate: new Date("2026-12-10"), nonMemberHoldEnabled: false, nonMemberHoldDays: 2, lodgeId: null }]);
    const policy = await loadPublicBookingPolicy();
    expect(policy?.hold).toBe("Non-member bookings are not held provisionally.");
    expect(policy?.periods[0]?.hold).toBe("Non-member bookings are not held provisionally.");
  });
});
