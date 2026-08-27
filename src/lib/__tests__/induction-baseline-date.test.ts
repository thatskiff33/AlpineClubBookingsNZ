import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The trusted induction baseline refuses a date later than TODAY — and #3123
 * settles whose today that is: the club's, from the persisted
 * `ClubTimeSettings.timeZone`, never the container's `TZ` (`INV-CONFIG-002`).
 *
 * DISCRIMINATION, and why this file previously measured nothing. `APP_TIME_ZONE`
 * — the only thing the replaced `todayDateOnlyForTimeZone()` ever read — is
 * pinned to `America/Denver`, BEHIND Greenwich, which is the side the defect
 * shows on and is deliberately not `Pacific/Auckland` (that is `APP_TIME_ZONE`'s
 * own fallback, so a club on it cannot be told apart from the environment's
 * claim). The persisted club zone is `Pacific/Auckland`. At the pinned instant
 * `2026-07-31T00:00:00.000Z` Denver reads 30 July and Auckland reads 31 July, so
 * the two never agree and no assertion here can pass by coincidence.
 *
 * THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL ON THIS MOCK. The zone reader
 * is fail-soft three ways — no delegate, a throwing query, no row — and every
 * one of them degrades silently to the environment. A prisma mock without it
 * passes for exactly the reason this file exists to rule out.
 */
vi.mock("@/config/operational", () => ({
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
  APP_TIME_ZONE: "America/Denver",
  APP_LOCALE: "en-NZ",
}));

const { mockClubTimeSettingsFindUnique } = vi.hoisted(() => ({
  mockClubTimeSettingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: { findUnique: mockClubTimeSettingsFindUnique },
  },
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { runInductionBaseline } from "@/lib/induction-baseline";

const ENVIRONMENT_ZONE = "America/Denver";
const CLUB_ZONE = "Pacific/Auckland";

/** The instant the two zones straddle: 30 July in Denver, 31 July in Auckland. */
const PINNED = new Date("2026-07-31T00:00:00.000Z");

function persistClubZone(timeZone: string) {
  mockClubTimeSettingsFindUnique.mockResolvedValue({
    timeZone,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
}

const BASE_OPTIONS = {
  actorMemberId: "admin-1",
  provenanceNote: "Committee minute 2024-07",
  databaseTarget: {
    host: "postgres.internal:5432",
    databaseName: "alpine_club",
  },
  fallbackClubName: "unused",
  fallbackClubNameSource: "primary" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  persistClubZone(CLUB_ZONE);
  // This suite pins its own instant, and the root re-freeze restores the
  // DEFAULT one rather than this pin — so it is re-installed per test
  // (`AGENTS.md`, the frozen-clock rule).
  vi.useFakeTimers();
  vi.setSystemTime(PINNED);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("trusted induction baseline date boundary", () => {
  it("PREMISE: the container and the club disagree about today", () => {
    // Without this leg the suite passes just as well when both zones agree,
    // which is the false green #3123's contract names.
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    const inEnvironment = new Intl.DateTimeFormat("en-CA", {
      timeZone: ENVIRONMENT_ZONE,
    }).format(PINNED);
    const inClub = new Intl.DateTimeFormat("en-CA", {
      timeZone: CLUB_ZONE,
    }).format(PINNED);
    expect(inEnvironment).toBe("2026-07-30");
    expect(inClub).toBe("2026-07-31");
  });

  it("allows the CLUB's current date, which the container calls tomorrow", async () => {
    // The whole point. 31 July is today at the club and still the future in the
    // container's zone, so before the migration this was refused outright —
    // an operator locked out of their own last permissible day.
    const transaction = vi.fn(async () => {
      throw new Error("transaction reached");
    });

    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        baselineDate: "2026-07-31",
        store: { $transaction: transaction } as never,
      }),
    ).rejects.toThrow("transaction reached");
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("still rejects a date after the club's today, before opening a transaction", async () => {
    const transaction = vi.fn();

    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        baselineDate: "2026-08-01",
        store: { $transaction: transaction } as never,
      }),
    ).rejects.toThrow("The baseline date cannot be later than the club's current date.");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("MOVES with the persisted zone — kills a hard-coded club zone", async () => {
    // The leg a literal "Pacific/Auckland" cannot pass. On Pago Pago (UTC-11)
    // the pinned instant is still 30 July, so 31 July becomes the future again.
    persistClubZone("Pacific/Pago_Pago");
    const transaction = vi.fn();

    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        baselineDate: "2026-07-31",
        store: { $transaction: transaction } as never,
      }),
    ).rejects.toThrow("The baseline date cannot be later than the club's current date.");
    expect(transaction).not.toHaveBeenCalled();

    // ...and on Kiritimati (UTC+14) it is already 31 July, so the same date is
    // allowed through to the transaction.
    persistClubZone("Pacific/Kiritimati");
    const reached = vi.fn(async () => {
      throw new Error("transaction reached");
    });
    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        baselineDate: "2026-07-31",
        store: { $transaction: reached } as never,
      }),
    ).rejects.toThrow("transaction reached");
  });

  it("reads the club's timezone from the persisted row, not the environment", async () => {
    // The fail-soft trap, made visible: if this delegate were absent the reader
    // would fall back to `APP_TIME_ZONE` and every assertion above would still
    // pass — measuring nothing.
    await expect(
      runInductionBaseline({
        ...BASE_OPTIONS,
        baselineDate: "2026-08-01",
        store: { $transaction: vi.fn() } as never,
      }),
    ).rejects.toThrow();
    expect(mockClubTimeSettingsFindUnique).toHaveBeenCalledWith({
      where: { id: "default" },
      select: { timeZone: true },
    });
  });
});
