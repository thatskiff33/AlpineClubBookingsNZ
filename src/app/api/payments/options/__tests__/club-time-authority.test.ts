import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #3123: the Internet Banking cutoff is decided on the CLUB's day.
 *
 * `checkInternetBankingLeadTime` refuses Internet Banking when a check-in is
 * closer than `minimumDaysBeforeCheckIn`, and it quotes the day it used back to
 * the payer as `cutoff.today`. That day used to default to
 * `getTodayDateOnly()`, which reads `APP_TIME_ZONE` — the ENVIRONMENT's claim.
 * For a club configured behind its container's zone that pushed the cutoff a day
 * early: Internet Banking disappeared from the payment options while the club
 * would still have accepted it, and the payer was shown the wrong date while it
 * happened. Stripe and Internet Banking are deliberately distinct settlement
 * paths, so this is a settlement-path decision taken from the wrong clock.
 *
 * ## What makes this file discriminating
 *
 * `APP_TIME_ZONE` is pinned to `Pacific/Auckland` — both the answer the replaced
 * helper gave AND this codebase's own fallback, so it is the one value a wrong
 * fix could still pass under. The PERSISTED club zone is `America/Denver`, which
 * is behind Greenwich. Under the repository's frozen clock
 * (`2026-07-01T00:00:00.000Z`) the club's day is 30 June while the environment
 * says 1 July, so no assertion below can agree by coincidence and no
 * `vi.setSystemTime` is needed.
 *
 * THE `clubTimeSettings` DELEGATE IS NOT OPTIONAL ON THE PRISMA MOCK.
 * `getClubTimeZone` is fail-soft three ways — no delegate, a throwing query, no
 * row — and every one of them degrades silently to the environment. A prisma
 * mock without it would pass for exactly the reason this file exists to rule
 * out.
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

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  loadInternetBankingPaymentSettings: vi.fn(),
  clubTimeSettingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));
vi.mock("@/lib/internet-banking-settings", async (importOriginal) => {
  // A PARTIAL mock: the settings LOAD is stubbed (it is a Prisma read this file
  // has no interest in), but `buildInternetBankingPaymentOptionState` and
  // `checkInternetBankingLeadTime` are the REAL ones — they are the subject.
  const actual =
    await importOriginal<typeof import("@/lib/internet-banking-settings")>();
  return {
    ...actual,
    loadInternetBankingPaymentSettings: mocks.loadInternetBankingPaymentSettings,
  };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubTimeSettings: { findUnique: mocks.clubTimeSettingsFindUnique },
  },
}));

import { APP_TIME_ZONE } from "@/config/operational";
import { clubToday, requireClubTimeZone } from "@/lib/club-time";
import { GET } from "@/app/api/payments/options/route";

type OptionsBody = {
  methods: {
    internetBanking: {
      enabled: boolean;
      cutoff: { allowed: boolean; today: string; checkIn: string | null };
    };
  };
};

function dayIn(zone: string) {
  return clubToday(requireClubTimeZone(zone));
}

async function optionsFor(checkIn: string): Promise<OptionsBody> {
  const response = await GET(
    new Request(`http://localhost/api/payments/options?checkIn=${checkIn}`),
  );
  return (await response.json()) as OptionsBody;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.loadEffectiveModuleFlags.mockResolvedValue({
    xeroIntegration: true,
    internetBankingPayments: true,
    groupBookings: false,
  });
  mocks.loadInternetBankingPaymentSettings.mockResolvedValue({
    holdBedSlots: false,
    holdDays: 0,
    minimumDaysBeforeCheckIn: 3,
  });
  mocks.clubTimeSettingsFindUnique.mockResolvedValue({
    timeZone: PERSISTED_ZONE,
    updatedByMemberId: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
});

describe("the Internet Banking cutoff is decided on club time (#3123)", () => {
  it("PREMISE: the persisted zone and the environment's disagree about the day", () => {
    expect(APP_TIME_ZONE).toBe(ENVIRONMENT_ZONE);
    expect(dayIn(PERSISTED_ZONE)).toBe("2026-06-30");
    expect(dayIn(ENVIRONMENT_ZONE)).toBe("2026-07-01");
  });

  it("quotes the CLUB's day back to the payer, not the environment's", async () => {
    const body = await optionsFor("2026-07-20");
    expect(body.methods.internetBanking.cutoff.today).toBe("2026-06-30");
    expect(body.methods.internetBanking.cutoff.today).not.toBe("2026-07-01");
  });

  it("keeps Internet Banking on offer on the day the club's clock still allows it", async () => {
    // Minimum 3 days before check-in. On the club's 30 June the cutoff date is
    // 3 July, so a 3 July check-in is exactly on the boundary and allowed. On
    // the environment's 1 July the cutoff would be 4 July and the SAME member
    // would be refused and pushed onto the card path.
    const body = await optionsFor("2026-07-03");
    expect(body.methods.internetBanking.cutoff.allowed).toBe(true);
    expect(body.methods.internetBanking.enabled).toBe(true);
  });

  it("still refuses a check-in genuinely inside the club's cutoff", async () => {
    const body = await optionsFor("2026-07-02");
    expect(body.methods.internetBanking.cutoff.allowed).toBe(false);
    expect(body.methods.internetBanking.enabled).toBe(false);
  });

  it("MOVES with the persisted zone, which kills a hard-coded Pacific/Auckland", async () => {
    // Two zones on opposite sides of the date line at the frozen instant. If the
    // answer were pinned to a constant — Auckland, the container, anything but
    // the row — these two would agree, and they must not.
    mocks.clubTimeSettingsFindUnique.mockResolvedValue({
      timeZone: "Pacific/Kiritimati",
      updatedByMemberId: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const east = await optionsFor("2026-07-20");

    mocks.clubTimeSettingsFindUnique.mockResolvedValue({
      timeZone: "Pacific/Pago_Pago",
      updatedByMemberId: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const west = await optionsFor("2026-07-20");

    expect(east.methods.internetBanking.cutoff.today).toBe("2026-07-01");
    expect(west.methods.internetBanking.cutoff.today).toBe("2026-06-30");
    expect(east.methods.internetBanking.cutoff.today).not.toBe(
      west.methods.internetBanking.cutoff.today,
    );
  });
});
