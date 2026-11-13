import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fork #118: the member side of work parties — who may see it, what an open
 * work party is, the dashboard card's list, and the stay a Join fills in.
 * Dates follow the frozen test clock: the club's today is 2026-07-01.
 */
const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { workPartyEvent: { findFirst: h.findFirst, findMany: h.findMany } },
}));

import { canViewWorkParties } from "@/lib/work-party-access";
import { OPEN_WORK_PARTY_EVENT_WHERE } from "@/lib/work-party-rules";
import {
  findMemberWorkParty,
  listUpcomingMemberWorkParties,
  workPartyJoinStay,
} from "@/lib/work-party-member";

const today = new Date("2026-07-01T00:00:00.000Z");
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

beforeEach(() => vi.clearAllMocks());

describe("canViewWorkParties (owner decision 7: members only)", () => {
  const cases: Array<[string, Parameters<typeof canViewWorkParties>[0], boolean]> = [
    ["a member", { accessRoles: ["USER"], role: "USER", canLogin: true }, true],
    [
      "a member who is also an admin",
      { accessRoles: ["USER", "ADMIN"], role: "ADMIN", canLogin: true },
      true,
    ],
    ["an organisation account", { accessRoles: ["ORG"], role: "USER", canLogin: true }, false],
    ["a legacy school login", { accessRoles: [], role: "SCHOOL", canLogin: true }, false],
    [
      "a school login that also holds USER",
      { accessRoles: ["USER"], role: "SCHOOL", canLogin: true },
      false,
    ],
    ["a non-member login", { accessRoles: [], role: "NON_MEMBER", canLogin: true }, false],
    ["an admin-only account", { accessRoles: ["ADMIN"], role: "ADMIN", canLogin: true }, false],
    ["a lodge kiosk", { accessRoles: ["LODGE"], role: "LODGE", canLogin: true }, false],
    [
      "a member whose login is disabled",
      { accessRoles: ["USER"], role: "USER", canLogin: false },
      false,
    ],
  ];
  it.each(cases)("%s → %s", (_label, user, expected) => {
    expect(canViewWorkParties(user)).toBe(expected);
  });
});

describe("workPartyJoinStay", () => {
  it("checks in on the first night and out the morning after the last", () => {
    expect(
      workPartyJoinStay({ startDate: d("2026-07-10"), endDate: d("2026-07-12") }, today),
    ).toEqual({ checkIn: "2026-07-10", checkOut: "2026-07-13" });
  });

  it("joins a work party that has started from today", () => {
    expect(
      workPartyJoinStay({ startDate: d("2026-06-28"), endDate: d("2026-07-02") }, today),
    ).toEqual({ checkIn: "2026-07-01", checkOut: "2026-07-03" });
  });

  it("can still be joined on its last night", () => {
    expect(
      workPartyJoinStay({ startDate: d("2026-06-30"), endDate: d("2026-07-01") }, today),
    ).toEqual({ checkIn: "2026-07-01", checkOut: "2026-07-02" });
  });

  it("cannot be joined once its last night has passed", () => {
    expect(
      workPartyJoinStay({ startDate: d("2026-06-28"), endDate: d("2026-06-30") }, today),
    ).toBeNull();
  });

  it("crosses a month boundary", () => {
    expect(
      workPartyJoinStay({ startDate: d("2026-07-30"), endDate: d("2026-07-31") }, today),
    ).toEqual({ checkIn: "2026-07-30", checkOut: "2026-08-01" });
  });
});

const row = {
  id: "wp-1",
  name: "Spring",
  description: "Bring gloves",
  startDate: d("2026-07-10"),
  endDate: d("2026-07-12"),
  discountPercent: 50,
  lodgeId: "lodge-1",
  lodge: { name: "Main Lodge" },
};

describe("findMemberWorkParty", () => {
  it("reads only an open work party, and never selects the promo code", async () => {
    h.findFirst.mockResolvedValue(row);
    const result = await findMemberWorkParty("wp-1", today);
    const query = h.findFirst.mock.calls[0][0];
    expect(query.where).toEqual({ id: "wp-1", ...OPEN_WORK_PARTY_EVENT_WHERE });
    expect(query.select).not.toHaveProperty("promoCode");
    expect(query.select).not.toHaveProperty("promoCodeId");
    expect(result).toEqual({
      id: "wp-1",
      name: "Spring",
      description: "Bring gloves",
      startDate: "2026-07-10",
      endDate: "2026-07-12",
      discountPercent: 50,
      lodgeId: "lodge-1",
      lodgeName: "Main Lodge",
      join: { checkIn: "2026-07-10", checkOut: "2026-07-13" },
    });
  });

  it("is null for an inactive or unknown id", async () => {
    h.findFirst.mockResolvedValue(null);
    await expect(findMemberWorkParty("nope", today)).resolves.toBeNull();
  });
});

describe("listUpcomingMemberWorkParties", () => {
  it("lists open work parties whose last night is on or after today, soonest first", async () => {
    h.findMany.mockResolvedValue([row]);
    const result = await listUpcomingMemberWorkParties(today, 5);
    expect(h.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...OPEN_WORK_PARTY_EVENT_WHERE, endDate: { gte: today } },
        orderBy: [{ startDate: "asc" }, { endDate: "asc" }, { id: "asc" }],
        take: 5,
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].lodgeName).toBe("Main Lodge");
  });

  it("an open work party means active with an active, unarchived promo", () => {
    expect(OPEN_WORK_PARTY_EVENT_WHERE).toEqual({
      active: true,
      promoCode: { active: true, archivedAt: null },
    });
  });
});
