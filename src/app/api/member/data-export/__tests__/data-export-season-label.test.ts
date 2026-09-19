/**
 * The season a member DOWNLOADS is named the same way as the season on their
 * screen (#3103).
 *
 * The export used to build `seasonLabel` from its own
 * `${seasonYear}/${seasonYear + 1}`, which asserts that a season spans two
 * calendar years. That is true for eleven of the twelve possible year-ends and
 * false for December, where `seasonYearOfCalendarDate` returns the calendar year
 * itself — so the label would have contradicted the `seasonYear` printed beside
 * it in the same object.
 *
 * The owner's decision on #3103 is that the download and the screen agree, and
 * accepted that a file downloaded before this change labels the same season
 * differently from one downloaded after. Nothing already downloaded is rewritten
 * — the application never reads an exported file back.
 *
 * ## What each case is for
 *
 * - **March** is the shipped default and the no-change control for the SHAPE:
 *   the season really does span two calendar years, so this case proves the new
 *   label still names both of them.
 * - **December** is the discriminator. It is the only year-end whose season is
 *   one calendar year, so it is the case a re-inlined `seasonYear + 1` fails.
 *   A test asserting only the March string would pass with the template back.
 *
 * The pair of assertions on `seasonYear` is not padding: the decision changed
 * one STRING and nothing about the export's shape, so the machine-readable
 * field a consumer would actually parse has to be pinned as unchanged in the
 * same test that changes the label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  checkRateLimit: vi.fn(),
  memberFindUnique: vi.fn(),
  bookingFindMany: vi.fn(),
  choreFindMany: vi.fn(),
  subscriptionFindMany: vi.fn(),
  auditFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimiters: { dataExport: { limit: 5, windowSeconds: 86400 } },
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique },
    booking: { findMany: mocks.bookingFindMany },
    choreAssignment: { findMany: mocks.choreFindMany },
    memberSubscription: { findMany: mocks.subscriptionFindMany },
    auditLog: { findMany: mocks.auditFindMany },
  },
}));

import {
  DEFAULT_FINANCIAL_YEAR_END_MONTH,
  __setFinancialYearEndMonthForTesting,
} from "@/lib/financial-year";
import { GET as dataExportGet } from "@/app/api/member/data-export/route";

interface ExportedSubscription {
  seasonYear: number;
  seasonLabel: string;
  status: string;
}

async function exportedSubscriptions(): Promise<ExportedSubscription[]> {
  const res = await dataExportGet();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { subscriptions: ExportedSubscription[] };
  return body.subscriptions;
}

beforeEach(() => {
  vi.clearAllMocks();
  __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
  mocks.auth.mockResolvedValue({ user: { id: "m1" } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.checkRateLimit.mockResolvedValue({
    success: true,
    limit: 5,
    remaining: 4,
    resetAt: Date.now() + 1000,
  });
  mocks.memberFindUnique.mockResolvedValue({
    firstName: "Mere",
    lastName: "Member",
    email: "member@example.test",
    dateOfBirth: null,
    joinedDate: null,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    role: "MEMBER",
    ageTier: "ADULT",
    active: true,
  });
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.choreFindMany.mockResolvedValue([]);
  mocks.auditFindMany.mockResolvedValue([]);
  mocks.subscriptionFindMany.mockResolvedValue([
    {
      seasonYear: 2026,
      status: "PAID",
      paidAt: new Date("2026-05-01T00:00:00.000Z"),
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
    },
    {
      seasonYear: 2025,
      status: "PAID",
      paidAt: null,
      createdAt: new Date("2025-04-01T00:00:00.000Z"),
    },
  ]);
});

afterEach(() => {
  __setFinancialYearEndMonthForTesting(DEFAULT_FINANCIAL_YEAR_END_MONTH);
});

describe("the member data export names a season the way the screen does", () => {
  it("names both calendar years when the season spans two (March year-end)", async () => {
    const subscriptions = await exportedSubscriptions();

    expect(subscriptions.map((s) => s.seasonLabel)).toEqual([
      "2026 - 2027 (Apr-Mar)",
      "2025 - 2026 (Apr-Mar)",
    ]);
    // The stored column, untouched: the export's SHAPE did not change, so a
    // consumer reading the season as a number sees exactly what it always did.
    expect(subscriptions.map((s) => s.seasonYear)).toEqual([2026, 2025]);
  });

  it("names ONE calendar year under a December year-end", async () => {
    // The discriminator. A December year-end starts the season in January, so
    // the season and the calendar year are the same year and "2026 - 2027"
    // would contradict the `seasonYear` printed beside it.
    __setFinancialYearEndMonthForTesting(12);

    const subscriptions = await exportedSubscriptions();

    expect(subscriptions.map((s) => s.seasonLabel)).toEqual([
      "2026 (Jan-Dec)",
      "2025 (Jan-Dec)",
    ]);
    expect(subscriptions.map((s) => s.seasonYear)).toEqual([2026, 2025]);
  });

  it("no longer emits the two-calendar-year template anywhere in the payload", async () => {
    // The old shape, byte for byte. It appeared in `seasonLabel` and nowhere
    // else, so its absence from the WHOLE document is the strongest available
    // statement that the local copy is gone rather than moved.
    const res = await dataExportGet();
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("2026/2027");
    expect(text).not.toContain("2025/2026");
  });


  /*
    #3278 — THE MEMBER EXPORT CARRIES NO VERDICT, and this is the guard on it.

    The reconciliation verdict is OFFICER-ONLY (owner decision, 20 September
    2026). This export briefly carried it, which read as reasonable — it is the
    member's own booking, and the export is "the data we hold about you". It is
    not: the verdict is not stored data about the member at all, it is the
    club's current integrity assessment of its OWN records, derived fresh on
    every read. That is the same reason the booking page withholds it, in the
    same words, and a subject-access export is not an exception to a rule about
    who the assessment is for.

    The member's amounts are exported exactly as they were before the feature
    existed.
  */
  it("does not put the officer-only money verdict in a member's own export", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        checkIn: new Date("2026-08-01T00:00:00.000Z"),
        checkOut: new Date("2026-08-02T00:00:00.000Z"),
        status: "CONFIRMED",
        totalPriceCents: 10_000,
        discountCents: 1,
        finalPriceCents: 9_999,
        hasNonMembers: false,
        nonMemberHoldUntil: null,
        notes: null,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        guests: [],
        payment: null,
        promoRedemption: null,
      },
    ]);

    const response = await dataExportGet();
    const text = await response.text();
    const body = JSON.parse(text) as {
      bookings: Array<Record<string, unknown>>;
    };

    expect(body.bookings[0]!.finalPriceCents).toBe(9_999);
    expect(body.bookings[0]).not.toHaveProperty("moneyReconciliation");
    // Nor any reason token, anywhere in the payload.
    expect(text).not.toContain("MISMATCH");
  });
});
