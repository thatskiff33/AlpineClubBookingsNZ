import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one MiroTalk resolver (#2940).
 *
 * Three things are proved here, and they are the three acceptance criteria that
 * can be proved without a browser: DATABASE -> ENVIRONMENT -> DERIVED
 * precedence per field; an environment-only install continuing to mint exactly
 * the links it minted before, with no row in the new table; and NOTHING
 * importing an environment value into the database, ever, by any path.
 *
 * The join-link cases marked "moved from calendar-events.test.ts" are the
 * original assertions for `buildMeetingJoinUrl`, unchanged except for the
 * await. They travelled with the function so the environment behaviour that
 * predates this issue keeps its coverage rather than being re-written into
 * something that agrees with the new code.
 */

const mocks = vi.hoisted(() => ({
  settingsFindUnique: vi.fn(),
  settingsUpsert: vi.fn(),
  credFindMany: vi.fn(),
  resolveIntegrationCredential: vi.fn(),
  setIntegrationCredential: vi.fn(),
  deleteIntegrationCredential: vi.fn(),
  invalidateProviderCredentialCache: vi.fn(),
  createAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mirotalkSettings: {
      findUnique: mocks.settingsFindUnique,
      upsert: mocks.settingsUpsert,
    },
    integrationCredential: { findMany: mocks.credFindMany },
  },
}));

vi.mock("@/lib/integration-credentials", () => ({
  resolveIntegrationCredential: mocks.resolveIntegrationCredential,
  setIntegrationCredential: mocks.setIntegrationCredential,
  deleteIntegrationCredential: mocks.deleteIntegrationCredential,
  invalidateProviderCredentialCache: mocks.invalidateProviderCredentialCache,
}));

vi.mock("@/lib/audit", () => ({ createAuditLog: mocks.createAuditLog }));

import {
  buildMeetingJoinUrl,
  getMirotalkConfigurationStatus,
  resetMirotalkWarningsForTests,
} from "@/lib/mirotalk-config";
import {
  clearMirotalkSecret,
  clearMirotalkSecretsForAddressMove,
  setMirotalkSecret,
  writeMirotalkSettings,
} from "@/lib/mirotalk-config-write";
import { MIROTALK_CREDENTIAL_KEYS } from "@/lib/mirotalk-settings-shared";

const MIRO_ENV_KEYS = [
  "MIROTALK_URL",
  "MIRO_JWT_KEY",
  "MIRO_JWT_EXP",
  "MIRO_MEETING_USERNAME",
  "MIRO_MEETING_PASSWORD",
  "MIRO_MEETING_PRESENTER",
  "NEXTAUTH_URL",
  "NEXT_PUBLIC_MIROTALK_URL",
] as const;

const savedEnv: Record<string, string | undefined> = {};

/** No row in `MirotalkSettings` — the state of every install that predates it. */
function noStoredSettings() {
  mocks.settingsFindUnique.mockResolvedValue(null);
}

function storedSettings(row: {
  baseUrl?: string | null;
  presenterEnabled?: boolean | null;
  tokenLifetime?: string | null;
}) {
  mocks.settingsFindUnique.mockResolvedValue({
    id: "default",
    baseUrl: row.baseUrl ?? null,
    presenterEnabled: row.presenterEnabled ?? null,
    tokenLifetime: row.tokenLifetime ?? null,
    updatedByMemberId: "mem-1",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  });
}

/** Nothing stored for any secret, so each falls through to the environment. */
function noStoredSecrets() {
  mocks.resolveIntegrationCredential.mockResolvedValue({
    status: "not_configured",
  });
}

function storedSecrets(values: Record<string, string>) {
  mocks.resolveIntegrationCredential.mockImplementation(
    async (_provider: string, key: string) => {
      const value = values[key];
      if (value === undefined) return { status: "not_configured" };
      return {
        status: "configured",
        value,
        secretSource: "AUTH_SECRET",
        sourceFlipped: false,
        labelVersion: "v1",
        version: `ver-${key}`,
      };
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMirotalkWarningsForTests();
  for (const key of MIRO_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  noStoredSettings();
  noStoredSecrets();
  mocks.credFindMany.mockResolvedValue([]);
});

afterEach(() => {
  for (const key of MIRO_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("buildMeetingJoinUrl — the environment behaviour that predates this page", () => {
  // Moved from calendar-events.test.ts with the function.
  it("falls back to the localhost MiroTalk dev instance for a loopback app host", async () => {
    // getAppBaseUrl -> http://localhost:3000
    await expect(buildMeetingJoinUrl("room-abc")).resolves.toBe(
      "http://localhost:3010/join/room-abc",
    );
  });

  it("derives https://meet.<app-domain> from NEXTAUTH_URL when nothing is set", async () => {
    process.env.NEXTAUTH_URL = "https://lwtc.org.nz";
    await expect(buildMeetingJoinUrl("room-abc")).resolves.toBe(
      "https://meet.lwtc.org.nz/join/room-abc",
    );
  });

  it("drops a leading www. when deriving the meet.<domain> default", async () => {
    process.env.NEXTAUTH_URL = "https://www.lwtc.org.nz";
    await expect(buildMeetingJoinUrl("xyz")).resolves.toBe(
      "https://meet.lwtc.org.nz/join/xyz",
    );
  });

  it("uses the runtime MIROTALK_URL (server-only, no rebuild)", async () => {
    process.env.MIROTALK_URL = "https://meet.lwtc.org.nz";
    await expect(buildMeetingJoinUrl("xyz")).resolves.toBe(
      "https://meet.lwtc.org.nz/join/xyz",
    );
  });

  it("assumes https for a bare host with no scheme", async () => {
    process.env.MIROTALK_URL = "meet.lwtc.org.nz";
    await expect(buildMeetingJoinUrl("xyz")).resolves.toBe(
      "https://meet.lwtc.org.nz/join/xyz",
    );
  });

  it("ignores the dead build-time NEXT_PUBLIC_MIROTALK_URL", async () => {
    process.env.NEXT_PUBLIC_MIROTALK_URL = "https://baked.example.org";
    process.env.NEXTAUTH_URL = "https://lwtc.org.nz";
    await expect(buildMeetingJoinUrl("xyz")).resolves.toBe(
      "https://meet.lwtc.org.nz/join/xyz",
    );
  });

  it("uses the query-form URL with room + token when the environment configures JWT access", async () => {
    process.env.MIROTALK_URL = "https://meet.lwtc.org.nz";
    process.env.MIRO_JWT_KEY = "Zx7Qb2Lm9Rt4Vy6Kd8Np1Sw3Hj5Cf0Gu2";
    process.env.MIRO_MEETING_USERNAME = "lwtc";
    process.env.MIRO_MEETING_PASSWORD = "pw";
    const url = await buildMeetingJoinUrl("xyz");
    // MiroTalk only honours the token on /join?room=...&token=... .
    expect(url.startsWith("https://meet.lwtc.org.nz/join?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("room")).toBe("xyz");
    expect((params.get("token") ?? "").split(".")).toHaveLength(3);
  });

  it("mints no token when only some of the three secrets are present", async () => {
    process.env.MIROTALK_URL = "https://meet.lwtc.org.nz";
    process.env.MIRO_JWT_KEY = "Zx7Qb2Lm9Rt4Vy6Kd8Np1Sw3Hj5Cf0Gu2";
    process.env.MIRO_MEETING_USERNAME = "lwtc";
    // With HOST_USER_AUTH on, a token whose credentials do not match a
    // HOST_USERS entry is rejected outright, so a partial set mints nothing.
    await expect(buildMeetingJoinUrl("xyz")).resolves.toBe(
      "https://meet.lwtc.org.nz/join/xyz",
    );
  });
});

describe("precedence: database, then environment, then derived", () => {
  it("prefers the stored address over MIROTALK_URL", async () => {
    process.env.MIROTALK_URL = "https://env.example.org";
    storedSettings({ baseUrl: "https://meet.club.example" });
    await expect(buildMeetingJoinUrl("xyz")).resolves.toBe(
      "https://meet.club.example/join/xyz",
    );
  });

  it("falls back per FIELD, so one stored value does not strand the others", async () => {
    process.env.MIROTALK_URL = "https://env.example.org";
    process.env.MIRO_JWT_EXP = "30m";
    storedSettings({ presenterEnabled: false });

    const status = await getMirotalkConfigurationStatus();
    expect(status.baseUrl.source).toBe("environment");
    expect(status.presenter.source).toBe("database");
    expect(status.presenter.effective).toBe("off");
    expect(status.tokenLifetime.source).toBe("environment");
    expect(status.tokenLifetime.effective).toBe("30m");
  });

  it("treats a stored `false` as a real choice, not as absence", async () => {
    // The column is Boolean? for exactly this: MIRO_MEETING_PRESENTER=true in
    // the environment must NOT win over an administrator who turned it off.
    process.env.MIRO_MEETING_PRESENTER = "true";
    process.env.MIROTALK_URL = "https://meet.lwtc.org.nz";
    storedSecrets({
      [MIROTALK_CREDENTIAL_KEYS.jwtKey]: "Zx7Qb2Lm9Rt4Vy6Kd8Np1Sw3Hj5Cf0Gu2",
      [MIROTALK_CREDENTIAL_KEYS.meetingUsername]: "lwtc",
      [MIROTALK_CREDENTIAL_KEYS.meetingPassword]: "pw",
    });
    storedSettings({ presenterEnabled: false });

    const status = await getMirotalkConfigurationStatus();
    expect(status.presenter.source).toBe("database");
    expect(status.presenter.effective).toBe("off");
  });

  it("prefers a stored secret over the environment one", async () => {
    process.env.MIROTALK_URL = "https://meet.lwtc.org.nz";
    process.env.MIRO_JWT_KEY = "environment-key-not-used-here";
    process.env.MIRO_MEETING_USERNAME = "env-user";
    process.env.MIRO_MEETING_PASSWORD = "env-pw";
    storedSecrets({
      [MIROTALK_CREDENTIAL_KEYS.jwtKey]: "Zx7Qb2Lm9Rt4Vy6Kd8Np1Sw3Hj5Cf0Gu2",
      [MIROTALK_CREDENTIAL_KEYS.meetingUsername]: "db-user",
      [MIROTALK_CREDENTIAL_KEYS.meetingPassword]: "db-pw",
    });

    const url = await buildMeetingJoinUrl("xyz");
    const status = await getMirotalkConfigurationStatus();
    expect(url).toContain("token=");
    expect(status.secrets.map((secret) => secret.source)).toEqual([
      "database",
      "database",
      "database",
    ]);
  });

  it("ignores a stored address that no longer validates, and says so", async () => {
    process.env.MIROTALK_URL = "https://env.example.org";
    // Stored before the rule tightened, or written by something other than the
    // screen. It is discarded rather than trusted, and the club is told.
    storedSettings({ baseUrl: "http://192.168.1.10:3010" });

    const status = await getMirotalkConfigurationStatus();
    expect(status.baseUrl.source).toBe("environment");
    expect(status.baseUrl.problem).toContain("not being used");
    await expect(buildMeetingJoinUrl("xyz")).resolves.toBe(
      "https://env.example.org/join/xyz",
    );
  });

  it("keeps using an environment address the screen would refuse, and says that too", async () => {
    // NEVER refuse an environment value: an install that works today has to
    // keep working. Report it and carry on.
    process.env.MIROTALK_URL = "http://meet.lwtc.org.nz";
    const status = await getMirotalkConfigurationStatus();
    expect(status.baseUrl.source).toBe("environment");
    expect(status.baseUrl.problem).toContain("in force");
    await expect(buildMeetingJoinUrl("xyz")).resolves.toBe(
      "http://meet.lwtc.org.nz/join/xyz",
    );
  });

  it("falls back to the documented default when MIRO_JWT_EXP is nonsense", async () => {
    process.env.MIRO_JWT_EXP = "whenever";
    const status = await getMirotalkConfigurationStatus();
    expect(status.tokenLifetime.source).toBe("derived");
    expect(status.tokenLifetime.effective).toBe("1h");
    expect(status.tokenLifetime.problem).toContain("MIRO_JWT_EXP");
  });

  it("keeps using an environment lifetime the screen would refuse, and says that too", async () => {
    // THE SAME COURTESY THE ADDRESS GETS. Without this a club running a
    // seven-day value saw "in force, from the environment" with no caveat at
    // all, typed the same value into the box to make it explicit, and was
    // refused — the page telling them two different things about one value.
    process.env.MIRO_JWT_EXP = "7d";
    const status = await getMirotalkConfigurationStatus();
    expect(status.tokenLifetime.source).toBe("environment");
    expect(status.tokenLifetime.effective).toBe("7d");
    expect(status.tokenLifetime.problem).toContain("would not be accepted");
    // Reported, never refused: an install that works today keeps working.
    expect(status.tokenLifetime.problem).toContain("in force");
  });

  it("says nothing about an environment lifetime the screen would accept", async () => {
    process.env.MIRO_JWT_EXP = "30m";
    const status = await getMirotalkConfigurationStatus();
    expect(status.tokenLifetime.source).toBe("environment");
    expect(status.tokenLifetime.problem).toBeNull();
  });

  it("reads the secret versions past the store's cache, not out of it", async () => {
    // THE ONLY CONSUMER THAT DEPENDS ON THE TOKEN BEING CURRENT. Every other
    // caller passes the unconditional expectation, so a token up to 45 seconds
    // old costs them nothing; here it is what Save and Clear declare, and it
    // sits beside an `updatedAt` read straight from the database. Stale, the two
    // halves disagree: the admin sees the new timestamp with the old version,
    // presses Clear, is told somebody else got in first and to reload, and
    // reloading returns the same stale version until the TTL expires.
    await getMirotalkConfigurationStatus();
    expect(mocks.invalidateProviderCredentialCache).toHaveBeenCalledWith(
      "mirotalk",
    );
  });

  it("does NOT fall back to the environment for a secret that no longer decrypts", async () => {
    // Quietly using the environment value would hide the fact that the app
    // encryption key changed: meetings would keep working on credentials the
    // club replaced, and nobody would ever be told to re-enter them.
    process.env.MIROTALK_URL = "https://meet.lwtc.org.nz";
    process.env.MIRO_JWT_KEY = "environment-key";
    process.env.MIRO_MEETING_USERNAME = "env-user";
    process.env.MIRO_MEETING_PASSWORD = "env-pw";
    mocks.resolveIntegrationCredential.mockImplementation(
      async (_provider: string, key: string) =>
        key === MIROTALK_CREDENTIAL_KEYS.jwtKey
          ? { status: "needs_reentry", reason: "GCM failed", version: "ver-1" }
          : { status: "not_configured" },
    );

    const status = await getMirotalkConfigurationStatus();
    const jwt = status.secrets.find(
      (secret) => secret.key === MIROTALK_CREDENTIAL_KEYS.jwtKey,
    );
    expect(jwt?.needsReentry).toBe(true);
    expect(status.tokenMintable).toBe(false);
    // The link still works; it just carries no token.
    await expect(buildMeetingJoinUrl("xyz")).resolves.toBe(
      "https://meet.lwtc.org.nz/join/xyz",
    );
  });
});

describe("no environment value is ever imported into the database", () => {
  it("writes no row while only reading, however much the environment holds", async () => {
    process.env.MIROTALK_URL = "https://meet.lwtc.org.nz";
    process.env.MIRO_JWT_KEY = "Zx7Qb2Lm9Rt4Vy6Kd8Np1Sw3Hj5Cf0Gu2";
    process.env.MIRO_MEETING_USERNAME = "lwtc";
    process.env.MIRO_MEETING_PASSWORD = "pw";
    process.env.MIRO_MEETING_PRESENTER = "false";
    process.env.MIRO_JWT_EXP = "15m";

    await buildMeetingJoinUrl("xyz");
    await getMirotalkConfigurationStatus();

    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.setIntegrationCredential).not.toHaveBeenCalled();
    expect(mocks.deleteIntegrationCredential).not.toHaveBeenCalled();
  });

  it("stores only what the administrator typed", async () => {
    process.env.MIROTALK_URL = "https://env.example.org";
    process.env.MIRO_JWT_EXP = "15m";
    mocks.settingsUpsert.mockResolvedValue(undefined);

    await writeMirotalkSettings({
      draft: { baseUrl: "", presenterEnabled: true, tokenLifetime: "" },
      memberId: "mem-1",
      changedFields: ["presenter"],
    });

    const write = mocks.settingsUpsert.mock.calls[0][0];
    // Empty means "clear it and go back to the environment", which is the only
    // way back — NOT "copy what the environment currently says".
    expect(write.update.baseUrl).toBeNull();
    expect(write.update.tokenLifetime).toBeNull();
    expect(write.update.presenterEnabled).toBe(true);
  });
});

describe("the #2723 write contract, exercised from a club-editable path", () => {
  it("names the acting administrator and declares what it expects to find", async () => {
    await setMirotalkSecret({
      key: MIROTALK_CREDENTIAL_KEYS.jwtKey,
      value: "a-new-signing-key",
      actor: { kind: "admin", memberId: "mem-7" },
      expect: { expect: "version", version: "ver-abc" },
      request: { id: "req-1" },
    });

    const call = mocks.setIntegrationCredential.mock.calls[0][0];
    expect(call.provider).toBe("mirotalk");
    expect(call.actor).toEqual({ kind: "admin", memberId: "mem-7" });
    expect(call.expect).toEqual({ expect: "version", version: "ver-abc" });
    expect(call.request).toEqual({ id: "req-1" });
  });

  it("fences a clear on the exact version the screen was shown", async () => {
    await clearMirotalkSecret({
      key: MIROTALK_CREDENTIAL_KEYS.meetingPassword,
      actor: { kind: "admin", memberId: "mem-7" },
      expect: { expect: "version", version: "ver-xyz" },
    });

    const call = mocks.deleteIntegrationCredential.mock.calls[0][0];
    expect(call.expect).toEqual({ expect: "version", version: "ver-xyz" });
    // `any` would delete whatever replaced it and report success. The ONE
    // MiroTalk path that passes it is the address move below, where the intended
    // end state is "gone" however many times somebody else replaced it.
    expect(call.expect.expect).not.toBe("any");
  });

  it("audits a settings change without naming a value", async () => {
    mocks.settingsUpsert.mockResolvedValue(undefined);
    await writeMirotalkSettings({
      draft: {
        baseUrl: "https://meet.club.example",
        presenterEnabled: null,
        tokenLifetime: "",
      },
      memberId: "mem-7",
      changedFields: ["meeting server address"],
    });

    const row = mocks.createAuditLog.mock.calls[0][0];
    expect(row.action).toBe("mirotalk.settings.update");
    expect(row.memberId).toBe("mem-7");
    expect(row.entityType).toBe("MirotalkSettings");
    expect(row.details).toContain("meeting server address");
  });

  it("records which address the meetings moved from and to", async () => {
    // WITHOUT THIS THERE IS NO FORENSIC TRACE AT ALL. Redirect the address,
    // wait for a click, restore it, and "changed: meeting server address" is
    // the whole record — while the REFUSED attempt is audited with more
    // specificity than the accepted one. The address is not a secret: the
    // status hands it to any finance-view admin and the page renders it.
    mocks.settingsUpsert.mockResolvedValue(undefined);
    await writeMirotalkSettings({
      draft: {
        baseUrl: "https://meet.attacker.example",
        presenterEnabled: null,
        tokenLifetime: "",
      },
      memberId: "mem-7",
      changedFields: ["meeting server address"],
      addressChange: {
        from: "https://meet.club.example",
        to: "https://meet.attacker.example",
      },
      secretsCleared: [MIROTALK_CREDENTIAL_KEYS.jwtKey],
    });

    const row = mocks.createAuditLog.mock.calls[0][0];
    expect(row.details).toContain("https://meet.club.example");
    expect(row.details).toContain("https://meet.attacker.example");
    expect(row.details).toContain("stored secrets cleared");
    expect(row.metadata).toEqual({
      baseUrlBefore: "https://meet.club.example",
      baseUrlAfter: "https://meet.attacker.example",
    });
  });
});

describe("clearing the secrets when the address moves", () => {
  beforeEach(() => {
    noStoredSettings();
  });

  it("clears exactly the secrets that were really stored", async () => {
    // The three are meaningful only to the MiroTalk instance they were paired
    // with — the key must equal its JWT_KEY and the username/password must match
    // one of its HOST_USERS entries — so an address move invalidates them
    // exactly as it invalidates the central server's API key.
    mocks.credFindMany.mockResolvedValue([
      { key: MIROTALK_CREDENTIAL_KEYS.jwtKey },
      { key: MIROTALK_CREDENTIAL_KEYS.meetingPassword },
    ]);

    const cleared = await clearMirotalkSecretsForAddressMove({
      actor: { kind: "admin", memberId: "mem-7" },
      request: { id: "req-9" },
    });

    expect(cleared).toEqual([
      MIROTALK_CREDENTIAL_KEYS.jwtKey,
      MIROTALK_CREDENTIAL_KEYS.meetingPassword,
    ]);
    expect(mocks.deleteIntegrationCredential).toHaveBeenCalledTimes(2);
    for (const [call] of mocks.deleteIntegrationCredential.mock.calls) {
      expect(call.provider).toBe("mirotalk");
      expect(call.actor).toEqual({ kind: "admin", memberId: "mem-7" });
      expect(call.request).toEqual({ id: "req-9" });
      // Unconditional HERE, and only here: this is a consequence of a different
      // write rather than a read-modify-write against a displayed value, and the
      // intended end state is "gone" whoever replaced it in between.
      expect(call.expect).toEqual({ expect: "any" });
    }
  });

  it("does nothing when nothing was stored here", async () => {
    // An environment-only install has no rows, so a club that moves its address
    // is not handed a delete for something it never set.
    mocks.credFindMany.mockResolvedValue([]);
    const cleared = await clearMirotalkSecretsForAddressMove({
      actor: { kind: "admin", memberId: "mem-7" },
    });
    expect(cleared).toEqual([]);
    expect(mocks.deleteIntegrationCredential).not.toHaveBeenCalled();
  });
});
