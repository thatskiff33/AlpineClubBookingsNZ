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

const NOTHING_STORED: DataKeyUsageSnapshot = { credentialRowsByKeyId: {}, legacyTotpSecrets: 0 };
const LEGACY_STORED: DataKeyUsageSnapshot = {
  credentialRowsByKeyId: { "legacy-auth-secret": 3 },
  legacyTotpSecrets: 2,
};

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
    expect(check.details.join(" ")).toMatch(/older release cannot read/);
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
    const check = buildDataEncryptionKeyCheck(`k2:${K2}`, {
      credentialRowsByKeyId: { k1: 4, k2: 1 },
      legacyTotpSecrets: 0,
    });
    expect(check.status).toBe("blocked");
    expect(check.details).toEqual([expect.stringContaining('4 provider credentials under the key "k1"')]);
  });

  it("is amber while a ring is set but stored data still depends on AUTH_SECRET", () => {
    const check = buildDataEncryptionKeyCheck(`k1:${K1}`, LEGACY_STORED);
    expect(check.status).toBe("warning");
    expect(check.message).toMatch(/data key "k1"/);
    expect(check.message).toMatch(/rotating it now would make that data unreadable/);
  });

  it("is complete when a ring is set and nothing depends on AUTH_SECRET", () => {
    const check = buildDataEncryptionKeyCheck(`k2:${K2},k1:${K1}`, {
      credentialRowsByKeyId: { k2: 2, k1: 1 },
      legacyTotpSecrets: 0,
    });
    expect(check.status).toBe("complete");
    expect(check.message).toBe('Data is encrypted under the data key "k2".');
  });

  it("tallies stored rows per key id, folding both auth-secret spellings into the legacy key", () => {
    expect(
      tallyDataKeyUsage(
        [
          { secretSource: "AUTH_SECRET", count: 2 },
          { secretSource: "NEXTAUTH_SECRET", count: 1 },
          { secretSource: "DATA_ENCRYPTION_KEY:k1", count: 4 },
          { secretSource: "SOMETHING_ELSE", count: 1 },
        ],
        5,
      ),
    ).toEqual({
      credentialRowsByKeyId: { "legacy-auth-secret": 3, k1: 4, "unrecognised:SOMETHING_ELSE": 1 },
      legacyTotpSecrets: 5,
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
