import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  #4456 review: the Data Encryption Key step counts stored data per key id, and
  says "not checked" — never green — when that count cannot be read.

  Driven through the real `getSetupDatabaseSnapshot` over a whole-client
  stand-in in which every other delegate answers with the empty shape its caller
  tolerates (the pattern `setup-readiness-lodges-not-set-up.test.ts` uses). Only
  the three reads behind `dataKeyUsage` are arranged.
*/
const { state, mockPrisma } = vi.hoisted(() => {
  const state = {
    credentialSources: [] as Array<{ secretSource: string; _count: { _all: number } }>,
    totpSecrets: [] as Array<{ totpSecret: string | null }>,
    recoveryHashes: [] as Array<{ codeHash: string }>,
    countFails: false,
  };
  const emptyDelegate = new Proxy(
    {},
    {
      get: (_target, method: string) => {
        if (method === "count") return async () => 0;
        if (method === "findMany") return async () => [];
        return async () => null;
      },
    },
  );
  const integrationCredential = new Proxy(
    {},
    {
      get: (_target, method: string) => {
        if (method === "groupBy") {
          return async () => {
            if (state.countFails) throw new Error("credential table unreadable");
            return state.credentialSources;
          };
        }
        // The guard's own question (#4456 review), answered from the rows above.
        if (method === "count") {
          return async (args?: { where?: { secretSource?: { startsWith?: string } } }) => {
            // A LIKE prefix as `exactPrefix` writes it: drop its escapes to compare literally.
            const prefix = args?.where?.secretSource?.startsWith?.replace(/\\(.)/g, "$1");
            return prefix === undefined
              ? 0
              : state.credentialSources
                  .filter((row) => row.secretSource.startsWith(prefix))
                  .reduce((sum, row) => sum + row._count._all, 0);
          };
        }
        if (method === "findMany") return async () => [];
        return async () => null;
      },
    },
  );
  const member = new Proxy(
    {},
    {
      get: (_target, method: string) => {
        if (method === "findMany") {
          return async (args?: { where?: { totpSecret?: unknown } }) =>
            args?.where?.totpSecret ? state.totpSecrets : [];
        }
        if (method === "count") {
          return async (args?: { where?: { totpSecret?: { startsWith?: string } } }) => {
            const prefix = args?.where?.totpSecret?.startsWith;
            return prefix === undefined
              ? 0
              : state.totpSecrets.filter((row) => row.totpSecret?.startsWith(prefix)).length;
          };
        }
        return async () => null;
      },
    },
  );
  const twoFactorRecoveryCode = {
    findMany: async () => state.recoveryHashes,
    count: async (args?: { where?: { codeHash?: { contains?: string } } }) => {
      const part = args?.where?.codeHash?.contains;
      return part === undefined ? 0 : state.recoveryHashes.filter((row) => row.codeHash.includes(part)).length;
    },
  };
  const mockPrisma = new Proxy(
    {},
    {
      get: (_target, model: string) =>
        model === "integrationCredential"
          ? integrationCredential
          : model === "member"
            ? member
            : model === "twoFactorRecoveryCode"
              ? twoFactorRecoveryCode
              : emptyDelegate,
    },
  );
  return { state, mockPrisma };
});

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/stripe-config", () => ({
  getStripeSetupState: vi.fn(async () => ({
    secretKeySet: false,
    publishableKeySet: false,
    webhookSecretSet: false,
    needsReentry: false,
  })),
}));
vi.mock("@/lib/xero-token-store", () => ({
  getXeroTokenReadability: vi.fn(async () => "readable"),
}));

import { getSetupDatabaseSnapshot } from "@/lib/setup-readiness-db";
import { buildDataEncryptionKeyCheck } from "@/lib/setup-readiness-data-keys";

const RING_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => (index * 29 + 7) % 256)).toString("base64");

beforeEach(() => {
  state.credentialSources = [];
  state.totpSecrets = [];
  state.recoveryHashes = [];
  state.countFails = false;
});

describe("getSetupDatabaseSnapshot — stored data per data key (#4456 review)", () => {
  it("counts credentials, authenticator secrets and unused recovery codes by the key each names", async () => {
    state.credentialSources = [
      { secretSource: "AUTH_SECRET", _count: { _all: 2 } },
      { secretSource: "NEXTAUTH_SECRET", _count: { _all: 1 } },
      { secretSource: "DATA_ENCRYPTION_KEY:k1", _count: { _all: 4 } },
    ];
    state.totpSecrets = [
      { totpSecret: "v1:iv:tag:ct" },
      { totpSecret: "v2:k1:iv:tag:ct" },
      { totpSecret: "v2:k1:iv:tag:ct" },
    ];
    state.recoveryHashes = [{ codeHash: "bare-legacy-hash" }, { codeHash: "k1:ring-hash" }];

    const snapshot = await getSetupDatabaseSnapshot();

    expect(snapshot.dataKeyUsage).toEqual({
      credentialRowsByKeyId: { "legacy-auth-secret": 3, k1: 4 },
      totpRowsByKeyId: { "legacy-auth-secret": 1, k1: 2 },
      recoveryCodesByKeyId: { "legacy-auth-secret": 1, k1: 1 },
      ringKeyedDataPresent: true,
    });
  });

  it("reads the writers' own answer for ring data: recovery codes alone under a ring id name the missing ring (#4456 review)", async () => {
    state.credentialSources = [{ secretSource: "AUTH_SECRET", _count: { _all: 1 } }];
    state.totpSecrets = [{ totpSecret: "v1:iv:tag:ct" }];
    state.recoveryHashes = [{ codeHash: "k1:ring-hash" }];

    const snapshot = await getSetupDatabaseSnapshot();

    expect(snapshot.dataKeyUsage?.ringKeyedDataPresent).toBe(true);
    const check = buildDataEncryptionKeyCheck(undefined, snapshot.dataKeyUsage);
    expect(check.status).toBe("blocked");
    expect(check.message).toMatch(/DATA_ENCRYPTION_KEYS is not set, so it cannot be read/);
    expect(check.details).toContain('1 unused recovery code under the data key "k1".');
  });

  it("finds no ring data in legacy rows and unknown formats, so never names a missing ring (#4456 review)", async () => {
    state.credentialSources = [
      { secretSource: "AUTH_SECRET", _count: { _all: 1 } },
      { secretSource: "SOMETHING_ELSE", _count: { _all: 1 } },
    ];
    state.recoveryHashes = [{ codeHash: "bare-legacy-hash" }];

    const snapshot = await getSetupDatabaseSnapshot();

    expect(snapshot.dataKeyUsage?.ringKeyedDataPresent).toBe(false);
    const check = buildDataEncryptionKeyCheck(undefined, snapshot.dataKeyUsage);
    expect(check.message).not.toMatch(/data-encryption key, but/);
    expect(check.details).toContain("1 provider credential in a format no release writes, so it cannot be read.");
  });

  it("omits the counts when they cannot be read, and the step then says not checked, never complete", async () => {
    state.countFails = true;

    const snapshot = await getSetupDatabaseSnapshot();

    expect(snapshot.dataKeyUsage).toBeUndefined();
    const check = buildDataEncryptionKeyCheck(`k1:${RING_KEY}`, snapshot.dataKeyUsage);
    expect(check.status).toBe("warning");
    expect(check.message).toMatch(/stored data was not checked/);
  });
});
