import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #3123: a joining fee's schedule window is evaluated on the CLUB's day.
 *
 * `getEffectiveJoiningFee` picks the `JoiningFee` row whose effective window
 * contains `asOf` (`effectiveFrom <= asOf`, `effectiveTo >= asOf` or null), and
 * that row's `amountCents` is the money an applicant is asked to pay. `asOf` used
 * to be a POSITIONAL DEFAULT reading `APP_TIME_ZONE` — the environment's claim —
 * both here and in `joining-fee.ts`. For a club configured behind its
 * container's zone that started a new fee a day early: the WRONG PRICE, quoted
 * to an admin and written onto an immutable Xero invoice. `INV-MONEY`,
 * `docs/AUTHORITATIVE_FEES.md`.
 *
 * `asOf` is not a lodge night, which is why the classification lanes flagged it
 * as "different intent" — but it is still "what day is it at the club": when no
 * caller names a day, "as of" means today, and today has to be the club's.
 *
 * ## What makes this file discriminating
 *
 * It asserts the WINDOW BOUND handed to Prisma, and then the AMOUNT that bound
 * selects. `effectiveFrom` and `effectiveTo` are `@db.Date` calendar days, so
 * the bound must be that day at UTC midnight (`INV-DATE-026`); a club-LOCAL
 * midnight would be `2026-06-30T06:00Z` and Prisma narrows it against a DATE
 * column with nothing to warn you.
 *
 * `APP_TIME_ZONE` is pinned to `Pacific/Auckland` — the answer the replaced
 * default gave, and this codebase's own fallback, so it is the one value a wrong
 * fix could still pass under. The PERSISTED zone is `America/Denver`, behind
 * Greenwich. Under the frozen clock (`2026-07-01T00:00:00.000Z`) the club's day
 * is 30 June and the environment's is 1 July, so no assertion here can agree by
 * coincidence and no `vi.setSystemTime` is needed.
 *
 * THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL ON THE PRISMA MOCK.
 * `getClubTimeZone` degrades silently to the environment when the delegate is
 * missing, when the query throws, and when the row is absent.
 */

// Inlined literals: `vi.mock` factories hoist above every const in this file.
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
}));

const ENVIRONMENT_ZONE = "Pacific/Auckland";
const PERSISTED_ZONE = "America/Denver";

/** The fee that took effect on the club's TOMORROW, and must not be quoted yet. */
const TOMORROWS_FEE_CENTS = 25000;
/** The fee in force on the club's today. */
const TODAYS_FEE_CENTS = 10000;

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  joiningFeeFindFirst: vi.fn(),
  memberFindUnique: vi.fn(),
  membershipTypeFindFirst: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
  resolvePolicy: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    joiningFee: { findFirst: (...a: unknown[]) => mocks.joiningFeeFindFirst(...a) },
    member: { findUnique: (...a: unknown[]) => mocks.memberFindUnique(...a) },
    membershipType: {
      findFirst: (...a: unknown[]) => mocks.membershipTypeFindFirst(...a),
      findUnique: vi.fn(),
    },
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
  },
}));
vi.mock("@/lib/membership-type-policy", () => ({
  resolveMembershipTypePolicyForMember: (...a: unknown[]) => mocks.resolvePolicy(...a),
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { clubToday, requireClubTimeZone } from "@/lib/club-time";
import { POST } from "@/app/api/admin/members/[id]/joining-fee/preview/route";

function dayIn(zone: string) {
  return clubToday(requireClubTimeZone(zone));
}

/** The `effectiveFrom` upper bound the fee lookup handed Prisma. */
function asOfBound(): Date {
  const call = mocks.joiningFeeFindFirst.mock.calls.at(-1)?.[0] as {
    where: { effectiveFrom: { lte: Date } };
  };
  return call.where.effectiveFrom.lte;
}

async function previewMember() {
  const response = await POST(
    new NextRequest(
      "http://localhost/api/admin/members/m1/joining-fee/preview",
      { method: "POST", headers: { "Content-Type": "application/json" } },
    ),
    { params: Promise.resolve({ id: "m1" }) },
  );
  return (await response.json()) as { defaultAmountCents: number | null };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mocks.memberFindUnique.mockResolvedValue({ ageTier: "ADULT" });
  mocks.resolvePolicy.mockResolvedValue({
    membershipType: { id: "type-full", key: "FULL" },
  });
  mocks.membershipTypeFindFirst.mockResolvedValue({ id: "type-full" });
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone: PERSISTED_ZONE,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  // A schedule with a rise that takes effect on 1 July — the environment's
  // "today" and the club's TOMORROW. Only a row whose window actually contains
  // the bound is returned, so the bound alone decides the price.
  mocks.joiningFeeFindFirst.mockImplementation(
    (args: { where: { effectiveFrom: { lte: Date } } }) => {
      const asOf = args.where.effectiveFrom.lte;
      if (asOf >= new Date("2026-07-01T00:00:00.000Z")) {
        return Promise.resolve({
          amountCents: TOMORROWS_FEE_CENTS,
          effectiveFrom: new Date("2026-07-01T00:00:00.000Z"),
        });
      }
      return Promise.resolve({
        amountCents: TODAYS_FEE_CENTS,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      });
    },
  );
});

describe("a joining fee's schedule window is evaluated on club time (#3123)", () => {
  it("PREMISE: the persisted zone and the environment's disagree about the day", () => {
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(dayIn(PERSISTED_ZONE)).toBe("2026-06-30");
    expect(dayIn(ENVIRONMENT_ZONE)).toBe("2026-07-01");
  });

  it("bounds the schedule window on the CLUB's day, at UTC midnight", async () => {
    await previewMember();
    expect(asOfBound().toISOString()).toBe("2026-06-30T00:00:00.000Z");
  });

  it("quotes the fee in force TODAY, not the rise that starts tomorrow", async () => {
    // The money assertion, and the defect stated as an amount: on the
    // environment's 1 July this preview quoted $250. The club is still on
    // 30 June, so the answer is $100.
    const preview = await previewMember();
    expect(preview.defaultAmountCents).toBe(TODAYS_FEE_CENTS);
    expect(preview.defaultAmountCents).not.toBe(TOMORROWS_FEE_CENTS);
  });

  it("MOVES with the persisted zone, which kills a hard-coded Pacific/Auckland", async () => {
    mocks.clubTimeSettingsFindUnique.mockResolvedValue({
      timeZone: "Pacific/Kiritimati",
      updatedByMemberId: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const east = await previewMember();

    mocks.clubTimeSettingsFindUnique.mockResolvedValue({
      timeZone: "Pacific/Pago_Pago",
      updatedByMemberId: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const west = await previewMember();

    // A club east of the date line has already reached the new fee; one west of
    // it has not. Same instant, same schedule, two prices — which is exactly
    // what a per-club persisted zone has to be able to express.
    expect(east.defaultAmountCents).toBe(TOMORROWS_FEE_CENTS);
    expect(west.defaultAmountCents).toBe(TODAYS_FEE_CENTS);
  });

  it("uses the club's day for the raw-inputs branch too", async () => {
    const response = await POST(
      new NextRequest(
        "http://localhost/api/admin/members/m1/joining-fee/preview",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ membershipTypeKey: "FULL", ageTier: "ADULT" }),
        },
      ),
      { params: Promise.resolve({ id: "m1" }) },
    );
    const preview = (await response.json()) as {
      defaultAmountCents: number | null;
    };
    expect(asOfBound().toISOString()).toBe("2026-06-30T00:00:00.000Z");
    expect(preview.defaultAmountCents).toBe(TODAYS_FEE_CENTS);
  });
});
