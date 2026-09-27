/**
 * The setup snapshot's club side of the Xero base-currency warning (#3633
 * review): the currency cards are actually CHARGED in, resolved through the
 * same fallback every reader uses, not the raw stored value. So readiness
 * agrees with the Club Currency & Locale page and the Xero wizard: no row at
 * all resolves to the same fallback they show, and a stored currency that is
 * not usable (no card is charged) gives nothing to compare.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const nothing = async () => null;
  const none = async () => 0;
  const state = {
    mappingRows: [] as Array<{ key: string; code: string | null }>,
    clubFormatRow: null as { currencyCode: string } | null,
  };
  const prisma = {
    member: { count: none },
    ageTierSetting: { count: none, findMany: async () => [] },
    season: { count: async () => 1, findMany: async () => [] },
    cancellationPolicy: { count: none },
    bookingDefaults: { findUnique: nothing },
    groupDiscountSetting: { findUnique: nothing },
    membershipCancellationSetting: { findUnique: nothing },
    xeroToken: { findFirst: nothing },
    xeroAccountMapping: {
      count: async () => 1,
      findMany: async (args: { where?: { key?: { in?: string[] } } }) => {
        const keys = args?.where?.key?.in ?? [];
        return state.mappingRows.filter((row) => keys.includes(row.key));
      },
    },
    xeroItemCodeMapping: { count: async () => 1 },
    clubIdentitySettings: { findUnique: nothing },
    emailMessageSetting: { findUnique: nothing },
    lodgeSettings: { findUnique: nothing },
    clubTimeSettings: { findUnique: nothing },
    publicContentSettings: { findUnique: nothing },
    pageContent: { count: none },
    membershipType: { findMany: async () => [] },
    membershipTypeSeasonRate: { findMany: async () => [] },
    clubFormatSettings: { findUnique: async () => state.clubFormatRow },
  };
  return { state, prisma };
});

vi.mock("@/lib/prisma", () => ({ prisma: db.prisma }));
vi.mock("@/config/modules", () => ({ readClubModuleSettingsRecord: async () => null }));
vi.mock("@/lib/environment-role", () => ({
  resolveEnvironmentRole: async () => ({ role: "UNKNOWN" }),
}));
vi.mock("@/lib/environment-safety-withheld", () => ({
  readWithheldApplicationEmail: async () => ({ available: false }),
}));
vi.mock("@/lib/lodge-capacity", () => ({ getDefaultLodgeCapacity: async () => 20 }));
vi.mock("@/lib/xero-token-store", () => ({
  getXeroTokenReadability: async () => ({ readable: false }),
}));
vi.mock("@/lib/stripe-config", () => ({
  getStripeSetupState: async () => ({
    secretKeySet: false,
    publishableKeySet: false,
    webhookSecretSet: false,
    needsReentry: false,
  }),
}));

import { getSetupDatabaseSnapshot } from "@/lib/setup-readiness-db";

beforeEach(() => {
  vi.stubEnv("CURRENCY", "");
});

afterEach(() => {
  db.state.clubFormatRow = null;
  vi.unstubAllEnvs();
});

describe("the club's charge currency in the setup snapshot (#3633)", () => {
  it("is the stored currency when it is usable, with the raw value beside it", async () => {
    db.state.clubFormatRow = { currencyCode: "AUD" };
    const snapshot = await getSetupDatabaseSnapshot();
    expect(snapshot.clubFormatCurrencyCode).toBe("AUD");
    expect(snapshot.clubChargeCurrencyCode).toBe("AUD");
  });

  it("is null for a stored currency no card can be charged in", async () => {
    db.state.clubFormatRow = { currencyCode: "JPY" };
    const snapshot = await getSetupDatabaseSnapshot();
    // The raw value still reaches the Stripe step, which blocks on it.
    expect(snapshot.clubFormatCurrencyCode).toBe("JPY");
    expect(snapshot.clubChargeCurrencyCode).toBeNull();
  });

  it("falls back exactly as the readers do when no row exists", async () => {
    const shipped = await getSetupDatabaseSnapshot();
    expect(shipped.clubFormatCurrencyCode).toBeNull();
    expect(shipped.clubChargeCurrencyCode).toBe("NZD");

    // The environment seed wins over the shipped default while nothing is stored.
    vi.stubEnv("CURRENCY", "CHF");
    const seeded = await getSetupDatabaseSnapshot();
    expect(seeded.clubChargeCurrencyCode).toBe("CHF");
  });
});
