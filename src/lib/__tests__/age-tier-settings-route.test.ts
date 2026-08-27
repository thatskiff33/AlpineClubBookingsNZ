import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { APP_TIME_ZONE } from "@/config/operational";
import { getTodayDateOnly } from "@/lib/date-only";

// Route-level tests for PUT /api/admin/age-tier-settings (issue #2009 — the
// age-tier SUBSET relaxation and the fail-closed tier-removal guard). The pure
// validity rule is exercised directly in age-tier-settings.test.ts; here we
// cover the DB-touching behaviour: subset save, tier deletion, and the
// removal-blocked 409.

const mocks = vi.hoisted(() => ({
  ageTierFindMany: vi.fn(),
  ageTierUpsert: vi.fn(),
  ageTierDeleteMany: vi.fn(),
  memberCount: vi.fn(),
  bookingGuestCount: vi.fn(),
  transaction: vi.fn(),
  logAudit: vi.fn(),
  revalidate: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: vi.fn(async () => ({
    ok: true as const,
    session: { user: { id: "admin-1" } },
  })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    ageTierSetting: {
      findMany: mocks.ageTierFindMany,
      upsert: mocks.ageTierUpsert,
      deleteMany: mocks.ageTierDeleteMany,
    },
    member: { count: mocks.memberCount },
    bookingGuest: { count: mocks.bookingGuestCount },
    // CT-4 (#2870): the route resolves the live-guest cut-off from the club's
    // PERSISTED timezone. Omit this delegate and
    // `loadPersistedClubTimeSettings()` returns null -- by design, it is
    // fail-soft in three separate places -- and the route falls back to the
    // container's `TZ` in silence. The suite then agrees with itself about the
    // wrong authority, which is exactly how this file used to pass.
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: mocks.revalidate,
}));

import { PUT } from "@/app/api/admin/age-tier-settings/route";

const CHILD = {
  tier: "CHILD",
  minAge: 0,
  maxAge: 17,
  label: "Child (0-17)",
  subscriptionRequiredForBooking: false,
  familyGroupRequestCreateMemberAllowed: true,
  sortOrder: 0,
};
const ADULT = {
  tier: "ADULT",
  minAge: 18,
  maxAge: null,
  label: "Adult (18+)",
  subscriptionRequiredForBooking: true,
  familyGroupRequestCreateMemberAllowed: false,
  sortOrder: 1,
};

/** Persist a club timezone for the route's `clubTime()` read to resolve. */
function persistClubZone(timeZone: string) {
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date(0),
  });
}

function putRequest(settings: unknown[]) {
  return new NextRequest("http://localhost/api/admin/age-tier-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings }),
  });
}

describe("PUT /api/admin/age-tier-settings — subset save (#2009)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The route now runs the removal guard + deleteMany + upserts inside ONE
    // interactive transaction (prisma.$transaction(async (tx) => …)). The mock
    // invokes the callback with a tx client backed by the same op mocks, so a
    // guard that throws inside the callback aborts exactly as it would against a
    // real DB (the throw rejects the $transaction promise, and the route's
    // catch turns a TierRemovalBlockedError into the 409).
    mocks.transaction.mockImplementation(
      async (fn: (tx: unknown) => unknown) =>
        fn({
          ageTierSetting: {
            upsert: mocks.ageTierUpsert,
            deleteMany: mocks.ageTierDeleteMany,
          },
          member: { count: mocks.memberCount },
          bookingGuest: { count: mocks.bookingGuestCount },
        }),
    );
    mocks.ageTierUpsert.mockReturnValue({ __op: "upsert" });
    mocks.ageTierDeleteMany.mockReturnValue({ __op: "delete" });
    mocks.memberCount.mockResolvedValue(0);
    mocks.bookingGuestCount.mockResolvedValue(0);
    persistClubZone("Pacific/Auckland");
    // 1st findMany = existing tiers (removal guard); 2nd = the reloaded set.
    mocks.ageTierFindMany
      .mockResolvedValueOnce([{ tier: "CHILD" }, { tier: "ADULT" }])
      .mockResolvedValueOnce([CHILD, ADULT]);
  });

  it("saves a valid CHILD + ADULT subset (200) and does not delete anything", async () => {
    const res = await PUT(putRequest([CHILD, ADULT]));
    expect(res.status).toBe(200);
    expect(mocks.ageTierUpsert).toHaveBeenCalledTimes(2);
    expect(mocks.ageTierDeleteMany).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("narrows every upsert's RETURNING, never naming the dropped xeroContactGroup* columns (#2130)", async () => {
    // Blue/green safety pin, WRITE half. Prisma emits an implicit RETURNING
    // over every scalar column of an upsert unless a `select` narrows it, so an
    // unnarrowed write would name AgeTierSetting.xeroContactGroupId /
    // xeroContactGroupName even after the reads were narrowed. That narrowing
    // is what made the #2130 STEP 2 contract migration
    // 20260721130000_contract_drop_ismember_and_agetier_xero_columns legal, and
    // the columns are now gone — so a bare upsert would be a hard 42703 rather
    // than a latent blue/green break. Guards against someone removing the
    // explicit select.
    const res = await PUT(putRequest([CHILD, ADULT]));
    expect(res.status).toBe(200);

    expect(mocks.ageTierUpsert).toHaveBeenCalledTimes(2);
    for (const [args] of mocks.ageTierUpsert.mock.calls) {
      const select = (args as { select?: Record<string, unknown> }).select;
      expect(select).toEqual({ tier: true });
      expect(select).not.toHaveProperty("xeroContactGroupId");
      expect(select).not.toHaveProperty("xeroContactGroupName");
    }
  });

  it("deletes tiers dropped from the set when no live person classifies into them", async () => {
    // Existing = full four; new set = CHILD + ADULT, so INFANT + YOUTH are dropped.
    mocks.ageTierFindMany.mockReset();
    mocks.ageTierFindMany
      .mockResolvedValueOnce([
        { tier: "INFANT" },
        { tier: "CHILD" },
        { tier: "YOUTH" },
        { tier: "ADULT" },
      ])
      .mockResolvedValueOnce([CHILD, ADULT]);

    const res = await PUT(putRequest([CHILD, ADULT]));
    expect(res.status).toBe(200);
    expect(mocks.ageTierDeleteMany).toHaveBeenCalledWith({
      where: { tier: { in: ["INFANT", "YOUTH"] } },
    });
  });

  it("fails closed (409) when a live member is still classified into a removed tier, aborting the in-tx delete", async () => {
    mocks.ageTierFindMany.mockReset();
    mocks.ageTierFindMany.mockResolvedValueOnce([
      { tier: "INFANT" },
      { tier: "CHILD" },
      { tier: "YOUTH" },
      { tier: "ADULT" },
    ]);
    // active = 3, archived = 0.
    mocks.memberCount.mockResolvedValueOnce(3).mockResolvedValueOnce(0);

    const res = await PUT(putRequest([CHILD, ADULT]));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/Cannot remove age tier/i);
    // The guard runs INSIDE the transaction and throws to abort it, so the
    // delete never lands even though the transaction callback was entered.
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.ageTierDeleteMany).not.toHaveBeenCalled();
    expect(mocks.ageTierUpsert).not.toHaveBeenCalled();
    expect(body.activeMembers).toBe(3);
    expect(body.archivedMembers).toBe(0);
  });

  it("fails closed (409) counting ARCHIVED members in a removed tier (would orphan on un-archive)", async () => {
    mocks.ageTierFindMany.mockReset();
    mocks.ageTierFindMany.mockResolvedValueOnce([
      { tier: "INFANT" },
      { tier: "CHILD" },
      { tier: "YOUTH" },
      { tier: "ADULT" },
    ]);
    // active = 0, archived = 2 — no live member, but archived ones still block.
    mocks.memberCount.mockResolvedValueOnce(0).mockResolvedValueOnce(2);

    const res = await PUT(putRequest([CHILD, ADULT]));
    expect(res.status).toBe(409);
    const body = await res.json();
    // New remediation message: edit the member's tier/DOB, not "widen a tier".
    expect(body.error).toMatch(/including 2 archived/i);
    expect(body.error).toMatch(/age tier or date of birth/i);
    expect(body.error).not.toMatch(/widen/i);
    expect(body.archivedMembers).toBe(2);
    expect(mocks.ageTierDeleteMany).not.toHaveBeenCalled();
  });

  it("fails closed (409) when an upcoming booking guest is classified into a removed tier", async () => {
    mocks.ageTierFindMany.mockReset();
    mocks.ageTierFindMany.mockResolvedValueOnce([
      { tier: "YOUTH" },
      { tier: "ADULT" },
    ]);
    mocks.bookingGuestCount.mockResolvedValue(1);

    const res = await PUT(putRequest([{ ...CHILD }, ADULT]));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.liveGuests).toBe(1);
    expect(mocks.ageTierDeleteMany).not.toHaveBeenCalled();
  });

  it("counts live guests from the CLUB's calendar day, not a local-midnight clock (#2838)", async () => {
    // `BookingGuest.stayEnd` is `@db.Date`, and `@prisma/adapter-pg` narrows a
    // bound `Date` for such a column to its UTC calendar date, discarding the
    // time (`formatDate` in `mapArg`). So `new Date()` + `setHours(0, 0, 0, 0)`
    // — NZ-local midnight, which is the PREVIOUS UTC day under the
    // `TZ=Pacific/Auckland` server pin — arrived as the day D-1 and counted a
    // guest whose stay ended YESTERDAY as still live. That erred towards
    // refusing a tier removal rather than towards deleting a tier someone still
    // classifies into, so it was a spurious block, never an unsafe allow. This
    // pins the cut-off to the club's own day.
    //
    // 01:30 on 2 July in New Zealand; 13:30 on 1 July in UTC; 23:30 on 1 July
    // in Brisbane.
    //
    // The club is PERSISTED as Pacific/Auckland here (the suite default), so
    // this is the New Zealand answer read from the club's own setting rather
    // than inherited from the container. The Denver case below is the one that
    // proves WHICH of the two authorities was consulted.
    vi.setSystemTime(new Date("2026-07-01T13:30:00.000Z"));

    mocks.ageTierFindMany.mockReset();
    mocks.ageTierFindMany
      .mockResolvedValueOnce([{ tier: "INFANT" }, { tier: "CHILD" }, { tier: "ADULT" }])
      .mockResolvedValueOnce([CHILD, ADULT]);

    const res = await PUT(putRequest([CHILD, ADULT]));
    expect(res.status).toBe(200);

    const where = (
      mocks.bookingGuestCount.mock.calls[0]?.[0] as {
        where: { stayEnd: { gte: Date } };
      }
    ).where;
    // UTC midnight, so the adapter's narrowing is lossless and the day
    // Postgres compares against is 2 July — the club's today.
    expect(where.stayEnd.gte.toISOString()).toBe("2026-07-02T00:00:00.000Z");
    expect(where.stayEnd.gte.toISOString().slice(0, 10)).toBe("2026-07-02");
  });

  /*
    CT-4 (#2870), epic #2988 -- and the reason the case above is not enough on
    its own.

    Until this test existed, this file had no `clubTimeSettings` delegate at all.
    `loadPersistedClubTimeSettings()` is deliberately fail-soft in three separate
    places -- no delegate, a thrown query, a null row -- and every one of them
    degrades quietly to the container's `TZ`. So the suite resolved the cut-off
    from the ENVIRONMENT, asserted the Auckland answer, and passed; a change that
    reverted the route to `getTodayDateOnly()` would have passed too. A guard
    that cannot fail is not a guard.

    Persisting a zone the environment disagrees with is what makes the answer
    attributable. 13:30Z on 1 July is 07:30 the SAME morning in Denver and 01:30
    the NEXT day in New Zealand, so the two authorities name different days and
    the bound below says which one the route asked.
  */
  it("takes the cut-off from the PERSISTED club zone, not the container's (CT-4, #2870)", async () => {
    vi.setSystemTime(new Date("2026-07-01T13:30:00.000Z"));
    persistClubZone("America/Denver");

    // The premise, measured as an ANSWER rather than as a zone identifier: two
    // different names can still produce the same day (`America/Chicago` gives
    // Denver's answer for every fixture in this file), and a name check would
    // pass while this assertion went vacuous.
    /*
     * `APP_TIME_ZONE` PASSED ON PURPOSE (#3123). Everywhere else an explicit
     * zone exists to get OFF the environment; here the environment IS the
     * subject of the assertion — the line measures what the environment
     * authority answers so it can prove the persisted zone answers differently.
     * A literal zone name here would assert something about that name instead,
     * and the premise would stop tracking the environment it is guarding.
     */
    expect(
      getTodayDateOnly(APP_TIME_ZONE).toISOString(),
      "INV-CONFIG-002: the environment authority now names the same day as the " +
        "persisted club zone, so this bound cannot tell which of the two the " +
        "route read. Pick a persisted zone the environment disagrees with.",
    ).not.toBe("2026-07-01T00:00:00.000Z");

    mocks.ageTierFindMany.mockReset();
    mocks.ageTierFindMany
      .mockResolvedValueOnce([{ tier: "INFANT" }, { tier: "CHILD" }, { tier: "ADULT" }])
      .mockResolvedValueOnce([CHILD, ADULT]);

    const res = await PUT(putRequest([CHILD, ADULT]));
    expect(res.status).toBe(200);

    const where = (
      mocks.bookingGuestCount.mock.calls[0]?.[0] as {
        where: { stayEnd: { gte: Date } };
      }
    ).where;
    // 1 July in Denver, encoded as UTC midnight for the `@db.Date` bound. The
    // environment would have said 2 July.
    expect(where.stayEnd.gte.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("does not read the club's timezone at all when no tier is being removed", async () => {
    // The cut-off only feeds the live-guest count, and that count only runs for
    // a save that DROPS a tier. An ordinary settings PUT should not pay for a
    // `ClubTimeSettings` round trip it will never use.
    const res = await PUT(putRequest([CHILD, ADULT]));
    expect(res.status).toBe(200);
    expect(mocks.ageTierDeleteMany).not.toHaveBeenCalled();
    expect(mocks.clubTimeSettingsFindUnique).not.toHaveBeenCalled();
  });

  it("rejects a set missing ADULT (400)", async () => {
    const res = await PUT(
      putRequest([
        { ...CHILD, maxAge: 9 },
        { tier: "YOUTH", minAge: 10, maxAge: 17, label: "Y", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 1 },
      ]),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must include the ADULT tier/i);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a subset whose youngest tier does not start at age 0 (400)", async () => {
    const res = await PUT(
      putRequest([{ ...CHILD, minAge: 5 }, ADULT]),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/must start at age 0/i);
  });
});
