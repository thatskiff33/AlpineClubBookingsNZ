import { describe, expect, it } from "vitest";

import { buildSetupReadiness } from "@/lib/setup-readiness";
import {
  buildDataEncryptionKeyCheck,
  tallyDataKeyUsage,
  type DataKeyUsageSnapshot,
} from "@/lib/setup-readiness-data-keys";

function testKey(seed: number, bytes = 32): string {
  return Buffer.from(Array.from({ length: bytes }, (_, index) => (seed * 43 + index * 17) % 256)).toString("base64");
}
const K1 = testKey(1);
const K2 = testKey(2);

function usage(overrides: Partial<DataKeyUsageSnapshot> = {}): DataKeyUsageSnapshot {
  return { credentialRowsByKeyId: {}, totpRowsByKeyId: {}, recoveryCodesByKeyId: {}, ...overrides };
}
const NOTHING_STORED = usage();
const LEGACY_STORED = usage({
  credentialRowsByKeyId: { "legacy-auth-secret": 3 },
  totpRowsByKeyId: { "legacy-auth-secret": 2 },
});

describe("setup readiness: the Data Encryption Key step (#4456)", () => {
  it("is amber when no ring is set and nothing is stored yet", () => {
    const check = buildDataEncryptionKeyCheck(undefined, NOTHING_STORED);
    expect(check.status).toBe("warning");
    expect(check.required).toBe(false);
    expect(check.message).toMatch(/DATA_ENCRYPTION_KEYS is not set/);
    expect(check.details.join(" ")).toMatch(/openssl rand -base64 32/);
  });

  it("is amber, not red, when the database was not checked", () => {
    expect(buildDataEncryptionKeyCheck(undefined, undefined).status).toBe("warning");
  });

  it("is red when no ring is set and stored data depends on AUTH_SECRET alone", () => {
    const check = buildDataEncryptionKeyCheck(undefined, LEGACY_STORED);
    expect(check.status).toBe("blocked");
    expect(check.details).toEqual(
      expect.arrayContaining([
        "3 provider credentials encrypted under AUTH_SECRET.",
        "2 authenticator-app secrets encrypted under AUTH_SECRET.",
      ]),
    );
    // The rollout caveat: an older release cannot read ring rows.
    expect(check.details.join(" ")).toMatch(/roll back to an older release/);
  });

  it.each([
    ["a short key", `k1:${testKey(3, 16)}`, /16 bytes/],
    ["a duplicate id", `k1:${K1},k1:${K2}`, /appears more than once/],
    ["a malformed entry", "not-a-ring", /not in the form/],
    ["a key repeating one byte", `k1:${Buffer.alloc(32, 7).toString("base64")}`, /repeats one byte/],
  ])("is red for %s, naming why but never the value", (_label, raw, reason) => {
    const check = buildDataEncryptionKeyCheck(raw, NOTHING_STORED);
    expect(check.status).toBe("blocked");
    expect(check.details[0]).toMatch(reason);
    expect(JSON.stringify(check)).not.toContain(K1);
    expect(JSON.stringify(check)).not.toContain(K2);
  });

  it("is red when stored credentials name a key the ring no longer holds", () => {
    const check = buildDataEncryptionKeyCheck(
      `k2:${K2}`,
      usage({ credentialRowsByKeyId: { k1: 4, k2: 1 }, totpRowsByKeyId: { k0: 2, k2: 5 } }),
    );
    expect(check.status).toBe("blocked");
    expect(check.details).toEqual([
      '4 provider credentials under the data key "k1".',
      '2 authenticator-app secrets under the data key "k0".',
      expect.stringMatching(/Put that key back in the ring/),
    ]);
  });

  it("is amber while a ring is set but stored data still depends on AUTH_SECRET", () => {
    const check = buildDataEncryptionKeyCheck(`k1:${K1}`, LEGACY_STORED);
    expect(check.status).toBe("warning");
    expect(check.message).toMatch(/data key "k1"/);
    expect(check.message).toMatch(/rotating it now would make that data unreadable/);
    // The manual routes, until the re-encrypt command ships (#4456 PR 2).
    expect(check.details.join(" ")).toMatch(/re-enter each provider credential in Admin → Integrations/);
    expect(check.details.join(" ")).toMatch(/re-enrol/);
  });

  it("is complete when a ring is set and nothing depends on AUTH_SECRET", () => {
    const check = buildDataEncryptionKeyCheck(
      `k2:${K2},k1:${K1}`,
      usage({ credentialRowsByKeyId: { k2: 2, k1: 1 }, totpRowsByKeyId: { k1: 3 }, recoveryCodesByKeyId: { k2: 10 } }),
    );
    expect(check.status).toBe("complete");
    expect(check.message).toBe('Data is encrypted under the data key "k2".');
  });

  it("is never complete when stored data was not checked, with a ring set (#4456 review)", () => {
    const check = buildDataEncryptionKeyCheck(`k1:${K1}`, undefined);
    expect(check.status).toBe("warning");
    expect(check.message).toMatch(/stored data was not checked/);
  });

  it("is red when the ring is unset but stored data is under a ring key (#4456 review)", () => {
    for (const stored of [
      usage({ credentialRowsByKeyId: { k1: 1, "legacy-auth-secret": 2 } }),
      usage({ totpRowsByKeyId: { k1: 1 } }),
    ]) {
      const check = buildDataEncryptionKeyCheck(undefined, stored);
      expect(check.status).toBe("blocked");
      expect(check.message).toMatch(/encrypted under a data-encryption key, but DATA_ENCRYPTION_KEYS is not set/);
      expect(check.details.join(" ")).toMatch(/never unset it/);
    }
  });

  it("reports recovery codes no lookup can match as information, never as red", () => {
    const check = buildDataEncryptionKeyCheck(
      `k2:${K2}`,
      usage({ credentialRowsByKeyId: { k2: 1 }, recoveryCodesByKeyId: { "legacy-auth-secret": 7, k1: 3, k2: 10 } }),
    );
    expect(check.status).toBe("complete");
    expect(check.details).toContain(
      "10 unused recovery codes no longer work under this key ring; their members are told to generate a new set.",
    );
  });

  it("is red for a ring key that is the auth secret, read from the auth secret it is given", () => {
    expect(buildDataEncryptionKeyCheck(`k1:${K1}`, NOTHING_STORED, K1).status).toBe("blocked");
    expect(buildDataEncryptionKeyCheck(`k1:${K1}`, NOTHING_STORED, K1).details[0]).toMatch(/is weak: it is the auth secret/);
  });

  it("tallies stored rows per key id, folding both auth-secret spellings into the legacy key", () => {
    expect(
      tallyDataKeyUsage({
        credentialSources: [
          { secretSource: "AUTH_SECRET", count: 2 },
          { secretSource: "NEXTAUTH_SECRET", count: 1 },
          { secretSource: "DATA_ENCRYPTION_KEY:k1", count: 4 },
          { secretSource: "SOMETHING_ELSE", count: 1 },
        ],
        totpKeyIds: ["legacy-auth-secret", "k1", "k1", null],
        recoveryCodeKeyIds: ["legacy-auth-secret", "k2"],
      }),
    ).toEqual({
      credentialRowsByKeyId: { "legacy-auth-secret": 3, k1: 4, "unrecognised:SOMETHING_ELSE": 1 },
      totpRowsByKeyId: { "legacy-auth-secret": 1, k1: 2, unrecognised: 1 },
      recoveryCodesByKeyId: { "legacy-auth-secret": 1, k2: 1 },
    });
  });

  it("appears in the foundation category of the readiness report, read from the env it is given", () => {
    const readiness = buildSetupReadiness({ env: { DATA_ENCRYPTION_KEYS: "k1:short" } });
    const foundation = readiness.categories.find((category) => category.id === "foundation");
    const check = foundation?.checks.find((candidate) => candidate.id === "data-encryption-keys");
    expect(check?.status).toBe("blocked");
    expect(check?.progress).toBe("open");
  });
});
