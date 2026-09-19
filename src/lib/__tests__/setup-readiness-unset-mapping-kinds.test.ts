/**
 * The setup snapshot keeps the two kinds of undecided Xero mapping apart
 * (`INV-INT-021`, #2717 and #3529). A key with a registered fallback is "using
 * a fallback"; a key with NO fallback that declares what the system does
 * without it is named with that sentence and never called a fallback. Found
 * in the review of #3537: one list fed both fields, so the Bank Transfer
 * Refunds Account — whose registry entry says "NO fallback key, by owner
 * decision" — was reported as "using a fallback" beside the line saying its
 * notes are raised unsettled.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_MAPPING_FALLBACK_KEYS,
  ACCOUNT_MAPPING_KEYS_ASKING_WHILE_UNSET,
  MAPPING_LABELS,
} from "@/lib/xero-account-mapping-keys";

const db = vi.hoisted(() => {
  const nothing = async () => null;
  const none = async () => 0;
  const state = { mappingRows: [] as Array<{ key: string; code: string | null }> };
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

afterEach(() => {
  db.state.mappingRows = [];
});

describe("the two kinds of undecided mapping in the setup snapshot", () => {
  it("lists a fallback key under fallbacks and a no-fallback key under consequences, never both", async () => {
    // Nothing configured: every asking key is unset.
    const snapshot = await getSetupDatabaseSnapshot();

    const fallbackKeys = Object.keys(ACCOUNT_MAPPING_FALLBACK_KEYS);
    expect(fallbackKeys.length).toBeGreaterThan(0);
    expect(snapshot.xeroUnsetFallbackMappingLabels).toEqual(
      fallbackKeys.map((key) => MAPPING_LABELS[key] ?? key),
    );

    const bankTransferLabel = MAPPING_LABELS.bankTransferRefundAccount;
    expect(ACCOUNT_MAPPING_KEYS_ASKING_WHILE_UNSET).toContain("bankTransferRefundAccount");
    expect(fallbackKeys).not.toContain("bankTransferRefundAccount");
    expect(snapshot.xeroUnsetFallbackMappingLabels).not.toContain(bankTransferLabel);
    expect(snapshot.xeroUnsetMappingConsequences).toEqual([
      expect.stringMatching(new RegExp(`^${bankTransferLabel}: .*without a settling payment`)),
    ]);
  });

  it("drops a key from both lists once a code is chosen", async () => {
    db.state.mappingRows = [
      { key: "bankTransferRefundAccount", code: "090" },
      ...Object.keys(ACCOUNT_MAPPING_FALLBACK_KEYS).map((key) => ({ key, code: "400" })),
    ];
    const snapshot = await getSetupDatabaseSnapshot();
    expect(snapshot.xeroUnsetFallbackMappingLabels).toEqual([]);
    expect(snapshot.xeroUnsetMappingConsequences).toEqual([]);
  });
});
