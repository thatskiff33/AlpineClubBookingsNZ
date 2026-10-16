import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  seasonFindMany: vi.fn(),
  seasonFindFirst: vi.fn(),
  seasonFindUnique: vi.fn(),
  seasonCreate: vi.fn(),
  seasonUpdate: vi.fn(),
  lodgeFindFirst: vi.fn(),
  lodgeFindUnique: vi.fn(),
  membershipTypeFindMany: vi.fn(),
  rateDeleteMany: vi.fn(),
  rateCreateMany: vi.fn(),
  transaction: vi.fn(),
  logAudit: vi.fn(),
  revalidatePublicPageContent: vi.fn(),
  seasonDelete: vi.fn(),
  syncOwnOtherLodgesFromFees: vi.fn(),
}));

// #77: a saved season refills this club's own Other lodge; its own tests
// cover the fill, so here only that each successful save runs it.
vi.mock("@/lib/other-lodge-fees-sync", () => ({
  syncOwnOtherLodgesFromFees: mocks.syncOwnOtherLodgesFromFees,
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn(async () => null),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicPageContent: mocks.revalidatePublicPageContent,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn() },
    season: {
      findMany: mocks.seasonFindMany,
      findFirst: mocks.seasonFindFirst,
      findUnique: mocks.seasonFindUnique,
      create: mocks.seasonCreate,
      update: mocks.seasonUpdate,
      delete: mocks.seasonDelete,
    },
    membershipType: { findMany: mocks.membershipTypeFindMany },
    lodge: {
      findFirst: mocks.lodgeFindFirst,
      findUnique: mocks.lodgeFindUnique,
    },
    $transaction: mocks.transaction,
  },
}));

import { GET, POST } from "@/app/api/admin/seasons/route";
import { DELETE, PUT } from "@/app/api/admin/seasons/[id]/route";
import {
  buildCopiedSeasonPayload,
  membershipTypeSeasonRateInputSchema,
  type CopyableSeason,
} from "@/lib/season-rate-editor";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};

// The rate resolver / rate-bearing validation (#1930, E4) consults membership
// types: FULL is a MEMBER_RATE type; NON_MEMBER is rate-bearing by key;
// ASSOCIATE is a NON_MEMBER_RATE type that must NOT carry its own rates.
const MEMBERSHIP_TYPES: Record<
  string,
  { id: string; key: string; bookingBehavior: string }
> = {
  "mt-full": { id: "mt-full", key: "FULL", bookingBehavior: "MEMBER_RATE" },
  "mt-nonmember": { id: "mt-nonmember", key: "NON_MEMBER", bookingBehavior: "NON_MEMBER_RATE" },
  "mt-associate": { id: "mt-associate", key: "ASSOCIATE", bookingBehavior: "NON_MEMBER_RATE" },
};

// Membership-type-keyed rates (#1930, E4).
const validRates = [
  { membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 4500 },
];

function jsonRequest(url: string, method: "POST" | "PUT", body: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("admin season routes (multi-lodge phase 7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
    mocks.seasonFindFirst.mockResolvedValue(null);
    mocks.seasonCreate.mockResolvedValue({ id: "season-1", membershipTypeRates: [] });
    mocks.seasonFindUnique.mockResolvedValue({ id: "season-1", membershipTypeRates: [] });
    // Rate-bearing validation looks up the referenced types by id.
    mocks.membershipTypeFindMany.mockImplementation(
      async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in
          .map((id) => MEMBERSHIP_TYPES[id])
          .filter((t): t is (typeof MEMBERSHIP_TYPES)[string] => Boolean(t)),
    );
    // POST wraps the nested create in a transaction.
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        season: { create: mocks.seasonCreate, update: mocks.seasonUpdate, findUnique: mocks.seasonFindUnique },
        membershipTypeSeasonRate: {
          deleteMany: mocks.rateDeleteMany,
          createMany: mocks.rateCreateMany,
        },
      }),
    );
  });

  it("lists every season when no lodge filter is given", async () => {
    mocks.seasonFindMany.mockResolvedValue([]);

    const res = await GET(new NextRequest("http://localhost/api/admin/seasons"));

    expect(res.status).toBe(200);
    expect(mocks.seasonFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
  });

  it("filters seasons strictly to a lodge", async () => {
    mocks.seasonFindMany.mockResolvedValue([]);

    const res = await GET(
      new NextRequest("http://localhost/api/admin/seasons?lodgeId=lodge-2"),
    );

    expect(res.status).toBe(200);
    expect(mocks.seasonFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { lodgeId: "lodge-2" },
      }),
    );
  });

  it("creates a season at the requested lodge and scopes the overlap check to it", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const res = await POST(
      jsonRequest("http://localhost/api/admin/seasons", "POST", {
        name: "Winter 2026",
        type: "WINTER",
        startDate: "2026-06-01",
        endDate: "2026-09-30",
        membershipTypeRates: validRates,
        lodgeId: "lodge-2",
      }),
    );

    expect(res.status).toBe(201);
    expect(mocks.seasonFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { lodgeId: "lodge-2" },
          ]),
        }),
      }),
    );
    expect(mocks.seasonCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lodgeId: "lodge-2" }),
      }),
    );
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalledOnce();
    expect(mocks.syncOwnOtherLodgesFromFees).toHaveBeenCalledWith("fees season created");
  });

  it("persists the flat whole-lodge night rate on create when supplied (#2338)", async () => {
    const res = await POST(
      jsonRequest("http://localhost/api/admin/seasons", "POST", {
        name: "Winter 2026",
        type: "WINTER",
        startDate: "2026-06-01",
        endDate: "2026-09-30",
        membershipTypeRates: validRates,
        flatWholeLodgeNightCents: 60000,
      }),
    );

    expect(res.status).toBe(201);
    expect(mocks.seasonCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ flatWholeLodgeNightCents: 60000 }),
      }),
    );
  });

  it("defaults the flat whole-lodge night rate to null on create when omitted (#2338)", async () => {
    const res = await POST(
      jsonRequest("http://localhost/api/admin/seasons", "POST", {
        name: "Winter 2026",
        type: "WINTER",
        startDate: "2026-06-01",
        endDate: "2026-09-30",
        membershipTypeRates: validRates,
      }),
    );

    expect(res.status).toBe(201);
    expect(mocks.seasonCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ flatWholeLodgeNightCents: null }),
      }),
    );
  });

  it("updates the flat whole-lodge night rate through PUT, and clears it with null (#2338)", async () => {
    mocks.seasonFindUnique.mockResolvedValue({
      id: "season-1",
      lodgeId: "lodge-1",
      startDate: new Date("2026-06-01T00:00:00.000Z"),
      endDate: new Date("2026-09-30T00:00:00.000Z"),
      membershipTypeRates: [],
    });

    const res = await PUT(
      jsonRequest("http://localhost/api/admin/seasons/season-1", "PUT", {
        flatWholeLodgeNightCents: null,
      }),
      { params: Promise.resolve({ id: "season-1" }) },
    );

    expect(res.status).toBe(200);
    expect(mocks.seasonUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ flatWholeLodgeNightCents: null }),
      }),
    );
    expect(mocks.syncOwnOtherLodgesFromFees).toHaveBeenCalledWith("fees season updated");
  });

  it("refills this club's own Other lodge after a season is deleted, and not for an unknown one (#77)", async () => {
    mocks.seasonFindUnique.mockResolvedValue(null);
    const missing = await DELETE(new NextRequest("http://localhost/api/admin/seasons/nope", { method: "DELETE" }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(missing.status).toBe(404);
    expect(mocks.syncOwnOtherLodgesFromFees).not.toHaveBeenCalled();

    mocks.seasonFindUnique.mockResolvedValue({ id: "season-1", name: "Winter 2026" });
    mocks.seasonDelete.mockResolvedValue({ id: "season-1" });
    const res = await DELETE(new NextRequest("http://localhost/api/admin/seasons/season-1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "season-1" }),
    });
    expect(res.status).toBe(200);
    expect(mocks.syncOwnOtherLodgesFromFees).toHaveBeenCalledWith("fees season deleted");
  });

  it("leaves the flat whole-lodge night rate untouched on a windows-only PUT (#2338)", async () => {
    mocks.seasonFindUnique.mockResolvedValue({
      id: "season-1",
      lodgeId: "lodge-1",
      startDate: new Date("2026-06-01T00:00:00.000Z"),
      endDate: new Date("2026-09-30T00:00:00.000Z"),
      membershipTypeRates: [],
    });

    const res = await PUT(
      jsonRequest("http://localhost/api/admin/seasons/season-1", "PUT", {
        // A windows-only edit (the /admin/seasons page) never sends the flat rate.
        name: "Winter (renamed)",
      }),
      { params: Promise.resolve({ id: "season-1" }) },
    );

    expect(res.status).toBe(200);
    const updateData = mocks.seasonUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect(updateData).not.toHaveProperty("flatWholeLodgeNightCents");
  });

  it("rejects a season at an unknown or inactive lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: false });

    const res = await POST(
      jsonRequest("http://localhost/api/admin/seasons", "POST", {
        name: "Winter 2026",
        type: "WINTER",
        startDate: "2026-06-01",
        endDate: "2026-09-30",
        membershipTypeRates: validRates,
        lodgeId: "lodge-2",
      }),
    );

    expect(res.status).toBe(400);
    expect(mocks.seasonCreate).not.toHaveBeenCalled();
    expect(mocks.revalidatePublicPageContent).not.toHaveBeenCalled();
  });

  it("stamps the default lodge when none is requested", async () => {
    const res = await POST(
      jsonRequest("http://localhost/api/admin/seasons", "POST", {
        name: "Winter 2026",
        type: "WINTER",
        startDate: "2026-06-01",
        endDate: "2026-09-30",
        membershipTypeRates: validRates,
      }),
    );

    expect(res.status).toBe(201);
    expect(mocks.lodgeFindUnique).not.toHaveBeenCalled();
    expect(mocks.seasonCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lodgeId: "lodge-1" }),
      }),
    );
  });

  it("still rejects overlapping seasons at the same lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });
    mocks.seasonFindFirst.mockResolvedValue({
      id: "season-existing",
      name: "Existing Winter",
    });

    const res = await POST(
      jsonRequest("http://localhost/api/admin/seasons", "POST", {
        name: "Winter 2026",
        type: "WINTER",
        startDate: "2026-06-01",
        endDate: "2026-09-30",
        membershipTypeRates: validRates,
        lodgeId: "lodge-2",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("Existing Winter");
    expect(mocks.seasonCreate).not.toHaveBeenCalled();
    expect(mocks.syncOwnOtherLodgesFromFees).not.toHaveBeenCalled();
  });

  it("scopes the update overlap check to the season's own lodge", async () => {
    mocks.seasonFindUnique.mockResolvedValue({
      id: "season-1",
      name: "Winter 2026",
      lodgeId: "lodge-2",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-09-30"),
    });
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        season: {
          update: mocks.seasonUpdate,
          findUnique: mocks.seasonFindUnique,
        },
        membershipTypeSeasonRate: {
          deleteMany: mocks.rateDeleteMany,
          createMany: mocks.rateCreateMany,
        },
      }),
    );

    const res = await PUT(
      jsonRequest("http://localhost/api/admin/seasons/season-1", "PUT", {
        startDate: "2026-06-15",
        endDate: "2026-10-15",
      }),
      { params: Promise.resolve({ id: "season-1" }) },
    );

    expect(res.status).toBe(200);
    expect(mocks.seasonFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: "season-1" },
          AND: expect.arrayContaining([
            { lodgeId: "lodge-2" },
          ]),
        }),
      }),
    );
    expect(mocks.revalidatePublicPageContent).toHaveBeenCalledOnce();
  });

  it("round-trips a membership-type-keyed rate grid: creates rows then GETs them (#1930, E4)", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });
    const gridRates = [
      { membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 5000 },
      { membershipTypeId: "mt-full", ageTier: "CHILD", pricePerNightCents: 2500 },
      { membershipTypeId: "mt-nonmember", ageTier: "ADULT", pricePerNightCents: 7000 },
    ];
    const persisted = gridRates.map((r, i) => ({ id: `r${i}`, ...r }));
    mocks.seasonFindUnique.mockResolvedValue({
      id: "season-1",
      membershipTypeRates: persisted,
    });

    const res = await POST(
      jsonRequest("http://localhost/api/admin/seasons", "POST", {
        name: "Winter 2026",
        type: "WINTER",
        startDate: "2026-06-01",
        endDate: "2026-09-30",
        membershipTypeRates: gridRates,
        lodgeId: "lodge-2",
      }),
    );

    expect(res.status).toBe(201);
    // The nested create carries the membership-type rate rows.
    expect(mocks.seasonCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          membershipTypeRates: {
            create: expect.arrayContaining([
              expect.objectContaining({ membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 5000 }),
              expect.objectContaining({ membershipTypeId: "mt-nonmember", ageTier: "ADULT", pricePerNightCents: 7000 }),
            ]),
          },
        }),
      }),
    );
    const body = await res.json();
    expect(body.membershipTypeRates).toHaveLength(3);
  });

  it("rejects a rate for a non-rate-bearing membership type (#1930, E4, D2)", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const res = await POST(
      jsonRequest("http://localhost/api/admin/seasons", "POST", {
        name: "Winter 2026",
        type: "WINTER",
        startDate: "2026-06-01",
        endDate: "2026-09-30",
        // ASSOCIATE is NON_MEMBER_RATE and not NON_MEMBER, so it carries no rates.
        membershipTypeRates: [
          { membershipTypeId: "mt-associate", ageTier: "ADULT", pricePerNightCents: 5000 },
        ],
        lodgeId: "lodge-2",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("ASSOCIATE");
    expect(mocks.seasonCreate).not.toHaveBeenCalled();
  });

  it("PUT replaces the membership-type rate rows (delete + recreate) (#1930, E4)", async () => {
    mocks.seasonFindUnique.mockResolvedValue({
      id: "season-1",
      name: "Winter 2026",
      lodgeId: "lodge-2",
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-09-30"),
      membershipTypeRates: [],
    });

    const res = await PUT(
      jsonRequest("http://localhost/api/admin/seasons/season-1", "PUT", {
        membershipTypeRates: [
          { membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 6000 },
        ],
      }),
      { params: Promise.resolve({ id: "season-1" }) },
    );

    expect(res.status).toBe(200);
    expect(mocks.rateDeleteMany).toHaveBeenCalledWith({ where: { seasonId: "season-1" } });
    expect(mocks.rateCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            seasonId: "season-1",
            membershipTypeId: "mt-full",
            ageTier: "ADULT",
            pricePerNightCents: 6000,
          }),
        ]),
      }),
    );
  });

// The lodge-setup wizard's "copy seasons" step (#2129). It had been posting the
// legacy `rates` key, which `seasonSchema` stopped accepting at the E4 re-key,
// so every copy silently 400'd. These tests pin the repaired contract by driving
// the REAL POST handler with the payload the page actually builds, so the page
// and the route can never drift apart again without a red test.
describe("copy-seasons payload (lodge setup wizard, #2129)", () => {
  // Exactly the shape GET /api/admin/seasons returns and the page reads.
  const sourceSeason: CopyableSeason = {
    name: "Winter 2026",
    type: "WINTER",
    // The GET returns full ISO timestamps; the POST needs date-only.
    startDate: "2026-06-01T00:00:00.000Z",
    endDate: "2026-09-30T00:00:00.000Z",
    active: true,
    membershipTypeRates: [
      { membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 4500 },
      // A flat (ageGroupsApply=false) type carries a single NULL-ageTier row.
      { membershipTypeId: "mt-nonmember", ageTier: null, pricePerNightCents: 9000 },
    ],
  };

  beforeEach(() => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });
  });

  it("sends membershipTypeRates, never the legacy `rates` key", () => {
    const payload = buildCopiedSeasonPayload(sourceSeason, "lodge-2");

    expect(payload).not.toHaveProperty("rates");
    expect(payload.membershipTypeRates).toEqual([
      { membershipTypeId: "mt-full", ageTier: "ADULT", pricePerNightCents: 4500 },
      { membershipTypeId: "mt-nonmember", ageTier: null, pricePerNightCents: 9000 },
    ]);
    // Date-only truncation, and the season lands at the TARGET lodge.
    expect(payload.startDate).toBe("2026-06-01");
    expect(payload.endDate).toBe("2026-09-30");
    expect(payload.lodgeId).toBe("lodge-2");
  });

  it("builds rate rows the shared rate-input schema accepts", () => {
    const payload = buildCopiedSeasonPayload(sourceSeason, "lodge-2");

    expect(
      membershipTypeSeasonRateInputSchema.safeParse(payload.membershipTypeRates)
        .success,
    ).toBe(true);
  });

  it("is accepted end-to-end by the real POST route and writes the rate rows", async () => {
    const res = await POST(
      jsonRequest(
        "http://localhost/api/admin/seasons",
        "POST",
        buildCopiedSeasonPayload(sourceSeason, "lodge-2"),
      ),
    );

    expect(res.status).toBe(201);
    expect(mocks.seasonCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Winter 2026", lodgeId: "lodge-2" }),
      }),
    );
    // POST nests the rate rows under the season create. Membership type ids
    // carry across lodges unchanged (MembershipType has no lodge scoping), so
    // the copied rows keep the source's type ids.
    expect(mocks.seasonCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          membershipTypeRates: {
            create: [
              {
                membershipTypeId: "mt-full",
                ageTier: "ADULT",
                pricePerNightCents: 4500,
              },
              {
                membershipTypeId: "mt-nonmember",
                ageTier: null,
                pricePerNightCents: 9000,
              },
            ],
          },
        }),
      }),
    );
  });

  it("regression: the pre-fix legacy `rates` body is rejected with a 400", async () => {
    const { membershipTypeRates, ...withoutRates } = buildCopiedSeasonPayload(
      sourceSeason,
      "lodge-2",
    );

    const res = await POST(
      jsonRequest("http://localhost/api/admin/seasons", "POST", {
        ...withoutRates,
        // What the page used to send.
        rates: membershipTypeRates,
      }),
    );

    expect(res.status).toBe(400);
    expect(mocks.seasonCreate).not.toHaveBeenCalled();
  });

  it("a NOT_APPLICABLE source row fails loudly as a 400, not silently", async () => {
    // `MembershipTypeSeasonRate.ageTier` is the full AgeTier enum and so permits
    // NOT_APPLICABLE, but `bookableAgeTierEnum` deliberately excludes it. Such a
    // row can only arrive via direct SQL. The wizard collects the rejection into
    // its `failed[]` list and shows it, so this is a rough edge, not a defect.
    const res = await POST(
      jsonRequest(
        "http://localhost/api/admin/seasons",
        "POST",
        buildCopiedSeasonPayload(
          {
            ...sourceSeason,
            membershipTypeRates: [
              {
                membershipTypeId: "mt-full",
                ageTier: "NOT_APPLICABLE",
                pricePerNightCents: 4500,
              },
            ],
          },
          "lodge-2",
        ),
      ),
    );

    expect(res.status).toBe(400);
    expect(mocks.seasonCreate).not.toHaveBeenCalled();
  });
});
});
