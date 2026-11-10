import { describe, expect, it } from "vitest";

import { buildSetupReadiness } from "@/lib/setup-readiness";
import {
  buildDataEncryptionKeyCheck,
  tallyDataKeyUsage,
  type DataKeyRingSource,
  type DataKeyUsageSnapshot,
} from "@/lib/setup-readiness-data-keys";

/** The step as the running app's own page builds it (Admin → Setup). */
function appCheck(
  rawRing: string | undefined,
  usage: DataKeyUsageSnapshot | undefined,
  authSecret?: string,
  rawLegacyKey?: string,
  source: DataKeyRingSource = "app",
) {
  return buildDataEncryptionKeyCheck(rawRing, usage, authSecret, rawLegacyKey, source);
}

function testKey(seed: number, bytes = 32): string {
  return Buffer.from(Array.from({ length: bytes }, (_, index) => (seed * 43 + index * 17) % 256)).toString("base64");
}
const K1 = testKey(1);
const K2 = testKey(2);

function usage(overrides: Partial<DataKeyUsageSnapshot> = {}): DataKeyUsageSnapshot {
  return {
    credentialRowsByKeyId: {},
    totpRowsByKeyId: {},
    recoveryCodesByKeyId: {},
    ringKeyedDataPresent: false,
    ...overrides,
  };
}
const NOTHING_STORED = usage();
const LEGACY_STORED = usage({
  credentialRowsByKeyId: { "legacy-auth-secret": 3 },
  totpRowsByKeyId: { "legacy-auth-secret": 2 },
});

describe("setup readiness: the Data Encryption Key step (#4456)", () => {
  it("is amber when no ring is set and nothing is stored yet", () => {
    const check = appCheck(undefined, NOTHING_STORED);
    expect(check.status).toBe("warning");
    expect(check.required).toBe(false);
    expect(check.message).toMatch(/DATA_ENCRYPTION_KEYS is not set/);
    expect(check.details.join(" ")).toMatch(/openssl rand -base64 32/);
  });

  it("is amber, not red, when the database was not checked", () => {
    expect(appCheck(undefined, undefined).status).toBe("warning");
  });

  it("is red when no ring is set and stored data depends on AUTH_SECRET alone", () => {
    const check = appCheck(undefined, LEGACY_STORED);
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
    const check = appCheck(raw, NOTHING_STORED);
    expect(check.status).toBe("blocked");
    expect(check.details[0]).toMatch(reason);
    expect(JSON.stringify(check)).not.toContain(K1);
    expect(JSON.stringify(check)).not.toContain(K2);
  });

  it("is red when stored credentials name a key the ring no longer holds", () => {
    const check = appCheck(
      `k2:${K2}`,
      usage({ credentialRowsByKeyId: { k1: 4, k2: 1 }, totpRowsByKeyId: { k0: 2, k2: 5 } }),
    );
    expect(check.status).toBe("blocked");
    expect(check.details).toEqual([
      expect.stringMatching(/^The current key "k2" has the fingerprint [0-9a-f]{4}(-[0-9a-f]{4}){3}\. /),
      '4 provider credentials under the data key "k1".',
      '2 authenticator-app secrets under the data key "k0".',
      expect.stringMatching(/Put that key back in the ring/),
    ]);
  });

  it("is amber while a ring is set but stored data still depends on AUTH_SECRET", () => {
    const check = appCheck(`k1:${K1}`, LEGACY_STORED);
    expect(check.status).toBe("warning");
    expect(check.message).toMatch(/data key "k1"/);
    expect(check.message).toMatch(/rotating it now would make that data unreadable/);
    // The re-encrypt command (#4456 PR 2), dry run first.
    expect(check.details.join(" ")).toContain(
      "run pnpm run data-keys:reencrypt --dry-run, then pnpm run data-keys:reencrypt --expect-fingerprint <fingerprint from Admin → Setup>.",
    );
  });

  it("is complete when a ring is set and everything stored is under its current key", () => {
    const check = appCheck(
      `k2:${K2},k1:${K1}`,
      usage({ credentialRowsByKeyId: { k2: 2 }, totpRowsByKeyId: { k2: 3 }, recoveryCodesByKeyId: { k2: 10 } }),
    );
    expect(check.status).toBe("complete");
    expect(check.message).toBe('Data is encrypted under the data key "k2".');
  });

  // #4456 review round 2 (F1): an older ring key still in use is not "complete".
  it.each([
    ["a provider credential", { credentialRowsByKeyId: { k2: 2, k1: 1 } }, '1 provider credential under the data key "k1".'],
    ["an authenticator secret", { totpRowsByKeyId: { k1: 3 } }, '3 authenticator-app secrets under the data key "k1".'],
  ] as const)("warns, naming it, while %s is under an older key in the ring", (_label, stored, line) => {
    const check = appCheck(`k2:${K2},k1:${K1}`, usage(stored));
    expect(check.status).toBe("warning");
    expect(check.message).toMatch(/still under an older key in the ring\. Remove that key only once nothing is under it/);
    expect(check.details).toContain(line);
    expect(check.details).toContain(
      "Move them with pnpm run data-keys:reencrypt --expect-fingerprint <fingerprint from Admin → Setup>.",
    );
  });

  // Round 3 (S5): the removal gate must be met-able, and recovery codes cannot be moved.
  it("lists unused recovery codes under an older key as information, never amber, saying removal retires them", () => {
    const check = appCheck(`k2:${K2},k1:${K1}`, usage({ credentialRowsByKeyId: { k2: 1 }, recoveryCodesByKeyId: { k2: 4, k1: 2 } }));
    expect(check.status).toBe("complete");
    expect(check.details).toContain(
      '2 unused recovery codes under the older key "k1": they cannot be moved, and removing that key retires them (their members are told to generate a new set).',
    );
  });

  it("still lists those codes beside the credentials that do hold it amber", () => {
    const check = appCheck(`k2:${K2},k1:${K1}`, usage({ totpRowsByKeyId: { k1: 1 }, recoveryCodesByKeyId: { k1: 3 } }));
    expect(check.status).toBe("warning");
    expect(check.details).toEqual(
      expect.arrayContaining([
        '1 authenticator-app secret under the data key "k1".',
        expect.stringMatching(/^3 unused recovery codes under the older key "k1": they cannot be moved/),
      ]),
    );
  });

  it("lists older-key rows alongside AUTH_SECRET ones while both remain", () => {
    const check = appCheck(
      `k2:${K2},k1:${K1}`,
      usage({ credentialRowsByKeyId: { "legacy-auth-secret": 1, k1: 2 } }),
    );
    expect(check.status).toBe("warning");
    expect(check.details).toEqual(
      expect.arrayContaining(["1 provider credential encrypted under AUTH_SECRET.", '2 provider credentials under the data key "k1".']),
    );
  });

  it("is never complete when stored data was not checked, with a ring set (#4456 review)", () => {
    const check = appCheck(`k1:${K1}`, undefined);
    expect(check.status).toBe("warning");
    expect(check.message).toMatch(/stored data was not checked/);
  });

  it("is red when the ring is unset but stored data is under a ring key (#4456 review)", () => {
    for (const stored of [
      usage({ credentialRowsByKeyId: { k1: 1, "legacy-auth-secret": 2 }, ringKeyedDataPresent: true }),
      usage({ totpRowsByKeyId: { k1: 1 }, ringKeyedDataPresent: true }),
      usage({ recoveryCodesByKeyId: { k1: 10 }, ringKeyedDataPresent: true }),
    ]) {
      const check = appCheck(undefined, stored);
      expect(check.status).toBe("blocked");
      expect(check.message).toMatch(/encrypted under a data-encryption key, but DATA_ENCRYPTION_KEYS is not set/);
      expect(check.details.join(" ")).toMatch(/never unset it/);
    }
  });

  it("offers a new key as the way out when the old one cannot be put back (#4456 review)", () => {
    const check = appCheck(
      undefined,
      usage({ credentialRowsByKeyId: { k1: 1 }, ringKeyedDataPresent: true }),
    );
    expect(check.message).toMatch(/Put the ring back as it was, or set a new key and re-enter the credentials/);
  });

  it("names the missing ring over recovery codes alone under a ring id (#4456 review)", () => {
    const check = appCheck(
      undefined,
      usage({ recoveryCodesByKeyId: { k1: 10 }, ringKeyedDataPresent: true }),
    );
    expect(check.status).toBe("blocked");
    expect(check.message).toMatch(/DATA_ENCRYPTION_KEYS is not set, so it cannot be read/);
    expect(check.details).toContain('10 unused recovery codes under the data key "k1".');
  });

  it("names rows in an unknown format with no ring, but never claims saves are refused (#4456 review)", () => {
    const check = appCheck(
      undefined,
      usage({ credentialRowsByKeyId: { "unrecognised:SOMETHING_ELSE": 1 }, totpRowsByKeyId: { "unrecognised:format": 1 } }),
    );
    expect(check.status).toBe("warning");
    expect(check.message).not.toMatch(/cannot be saved|is saved under AUTH_SECRET alone|cannot be read/);
    expect(check.details).toContain("1 provider credential in a format no release writes, so it cannot be read.");
  });

  it("is red over a credential or an authenticator on AUTH_SECRET alone, but not over recovery codes alone", () => {
    expect(appCheck(undefined, usage({ totpRowsByKeyId: { "legacy-auth-secret": 1 } })).status).toBe("blocked");
    expect(
      appCheck(undefined, usage({ recoveryCodesByKeyId: { "legacy-auth-secret": 10 } })).status,
    ).toBe("warning");
  });

  it("never lets a ring key id cover rows in a format no release writes (#4456 review)", () => {
    // `unrecognised` is a valid key id; the bucket is not, so the ring cannot match it.
    const RING = `unrecognised:${K1}`;
    const stored = tallyDataKeyUsage({
      credentialSources: [],
      totpKeyIds: [null, "unrecognised"],
      recoveryCodeKeyIds: [],
      ringKeyedDataPresent: true,
    });
    const check = appCheck(RING, stored);
    expect(check.status).toBe("blocked");
    expect(check.details).toContain("1 authenticator-app secret in a format no release writes, so it cannot be read.");
  });

  it("reports recovery codes no lookup can match as information, never as red", () => {
    const check = appCheck(
      `k2:${K2}`,
      usage({ credentialRowsByKeyId: { k2: 1 }, recoveryCodesByKeyId: { "legacy-auth-secret": 7, k1: 3, k2: 10 } }),
    );
    expect(check.status).toBe("complete");
    expect(check.details).toContain(
      "10 unused recovery codes no longer work under this key ring; their members are told to generate a new set.",
    );
  });

  it("is red for a ring key that is the auth secret, read from the auth secret it is given", () => {
    expect(appCheck(`k1:${K1}`, NOTHING_STORED, K1).status).toBe("blocked");
    expect(appCheck(`k1:${K1}`, NOTHING_STORED, K1).details[0]).toMatch(/is weak: it is the auth secret/);
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
        ringKeyedDataPresent: true,
      }),
    ).toEqual({
      credentialRowsByKeyId: { "legacy-auth-secret": 3, k1: 4, "unrecognised:SOMETHING_ELSE": 1 },
      totpRowsByKeyId: { "legacy-auth-secret": 1, k1: 2, "unrecognised:format": 1 },
      recoveryCodesByKeyId: { "legacy-auth-secret": 1, k2: 1 },
      ringKeyedDataPresent: true,
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

describe("setup readiness: the legacy-read switch, DATA_ENCRYPTION_LEGACY_KEY (#4456 PR 2)", () => {
  const MOVED = usage({ credentialRowsByKeyId: { k1: 2 }, totpRowsByKeyId: { k1: 1 } });

  it("is red when the switch retires AUTH_SECRET reads while rows are still under it, and says how to recover", () => {
    const check = appCheck(`k1:${K1}`, LEGACY_STORED, undefined, "retired");
    expect(check.status).toBe("blocked");
    expect(check.message).toMatch(/DATA_ENCRYPTION_LEGACY_KEY=retired stops reading anything under AUTH_SECRET/);
    expect(check.details).toContain("3 provider credentials encrypted under AUTH_SECRET.");
    expect(check.details.join(" ")).toContain(
      "Unset DATA_ENCRYPTION_LEGACY_KEY and restart, run pnpm run data-keys:reencrypt --expect-fingerprint <fingerprint from Admin → Setup> until it reports nothing on AUTH_SECRET",
    );
  });

  it("is complete once nothing is under AUTH_SECRET, and offers the switch until it is set", () => {
    const offered = appCheck(`k1:${K1}`, MOVED);
    expect(offered.status).toBe("complete");
    expect(offered.details.join(" ")).toMatch(/set DATA_ENCRYPTION_LEGACY_KEY=retired and restart/);

    const set = appCheck(`k1:${K1}`, MOVED, undefined, "retired");
    expect(set.status).toBe("complete");
    expect(set.details.join(" ")).toMatch(/nothing is read under it \(DATA_ENCRYPTION_LEGACY_KEY=retired\)/);
  });

  it("is red, naming the switch, when it is set without a ring or to anything but retired", () => {
    const withoutRing = appCheck(undefined, NOTHING_STORED, undefined, "retired");
    expect(withoutRing.status).toBe("blocked");
    expect(withoutRing.details[0]).toMatch(/DATA_ENCRYPTION_LEGACY_KEY=retired needs DATA_ENCRYPTION_KEYS/);

    const typo = appCheck(`k1:${K1}`, MOVED, undefined, "retire");
    expect(typo.status).toBe("blocked");
    expect(typo.details[0]).toMatch(/DATA_ENCRYPTION_LEGACY_KEY: the only accepted value is "retired"/);
  });
});

describe("setup readiness: the current key's fingerprint (#4456 review S1)", () => {
  it("shows the running app's key fingerprint, the same one the re-encrypt prints for the same bytes", async () => {
    const { dataKeyFingerprint, parseDataEncryptionKeys } = await import("@/lib/data-encryption-key-material");
    const ring = parseDataEncryptionKeys(`k1:${K1}`);
    if (ring.status !== "configured") throw new Error("expected a ring");
    const fingerprint = dataKeyFingerprint(ring.current);

    for (const stored of [NOTHING_STORED, LEGACY_STORED, undefined]) {
      const check = appCheck(`k1:${K1}`, stored);
      expect(check.details).toContain(
        `The current key "k1" has the fingerprint ${fingerprint}. pnpm run data-keys:reencrypt writes only when run with --expect-fingerprint ${fingerprint}, and refuses if its own key differs.`,
      );
      expect(check.details.join(" ")).not.toContain(K1);
    }
    // Other bytes under the same id: a different fingerprint.
    expect(appCheck(`k1:${K2}`, NOTHING_STORED).details.join(" ")).not.toContain(fingerprint);
  });
});

describe("setup readiness: whose ring it is (#4456 review round 3, S1)", () => {
  const STORED = usage({ credentialRowsByKeyId: { "legacy-auth-secret": 1 } });

  it("from a shell (setup:check), never calls its key the current one and prints no fingerprint or command value", async () => {
    const { dataKeyFingerprint, parseDataEncryptionKeys } = await import("@/lib/data-encryption-key-material");
    const ring = parseDataEncryptionKeys(`k1:${K1}`);
    if (ring.status !== "configured") throw new Error("expected a ring");
    const fingerprint = dataKeyFingerprint(ring.current);

    for (const stored of [NOTHING_STORED, STORED, undefined, usage({ credentialRowsByKeyId: { k1: 1 } })]) {
      const check = buildDataEncryptionKeyCheck(`k1:${K1}`, stored, undefined, undefined, "shell");
      const text = [check.message, ...check.details].join(" ");
      expect(text).toContain(`This shell's ring lists "k1" first: this shell's key, not necessarily the running app's.`);
      expect(text).toContain("Take the fingerprint for pnpm run data-keys:reencrypt --expect-fingerprint only from Admin → Setup in the browser.");
      expect(text).not.toContain(fingerprint);
      expect(text).not.toMatch(/The current key|--expect-fingerprint [0-9a-f]{4}-/);
      expect(text).not.toMatch(/New data is encrypted under the data key|Data is encrypted under the data key/);
    }
  });

  it("from the running app (Admin → Setup), names the current key and the exact fingerprint to pass", async () => {
    const { dataKeyFingerprint, parseDataEncryptionKeys } = await import("@/lib/data-encryption-key-material");
    const ring = parseDataEncryptionKeys(`k1:${K1}`);
    if (ring.status !== "configured") throw new Error("expected a ring");
    const check = buildDataEncryptionKeyCheck(`k1:${K1}`, STORED, undefined, undefined, "app");
    expect(check.details).toContain(
      `The current key "k1" has the fingerprint ${dataKeyFingerprint(ring.current)}. pnpm run data-keys:reencrypt writes only when run with --expect-fingerprint ${dataKeyFingerprint(ring.current)}, and refuses if its own key differs.`,
    );
  });

  it("defaults to the shell wording, and setup readiness passes the source it is given", () => {
    expect(buildDataEncryptionKeyCheck(`k1:${K1}`, STORED).details[0]).toMatch(/^This shell's ring lists "k1" first/);
    const env = { DATA_ENCRYPTION_KEYS: `k1:${K1}` };
    const stepOf = (dataKeySource?: DataKeyRingSource) =>
      buildSetupReadiness({ env, dataKeySource })
        .categories.flatMap((category) => category.checks)
        .find((step) => step.id === "data-encryption-keys")!;
    expect(stepOf().details[0]).toMatch(/^This shell's ring lists "k1" first/);
    expect(stepOf("shell").details[0]).toMatch(/^This shell's ring lists "k1" first/);
    expect(stepOf("app").details[0]).toMatch(/^The current key "k1" has the fingerprint /);
  });
});

describe("which caller passes which source (#4456 review round 3, S1)", () => {
  it("the running app's route passes app, and setup:check passes shell", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("src/app/api/admin/setup/route.ts", "utf8");
    const cli = readFileSync("scripts/setup.ts", "utf8");
    expect(route).toMatch(/buildSetupReadiness\(\{[^}]*dataKeySource: "app"/s);
    expect(cli).toMatch(/buildSetupReadiness\(\{[^}]*dataKeySource: "shell"/s);
    expect(cli).not.toMatch(/dataKeySource: "app"/);
  });
});

