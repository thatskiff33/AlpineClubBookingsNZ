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
  mirotalkMeetingServerMoved,
  resetMirotalkWarningsForTests,
} from "@/lib/mirotalk-config";
import {
  clearMirotalkSecret,
  clearMirotalkSecretsForAddressMove,
  setMirotalkSecret,
  writeMirotalkSettings,
} from "@/lib/mirotalk-config-write";
import {
  MIROTALK_CREDENTIAL_KEYS,
  MIROTALK_ENV_NAMES,
} from "@/lib/mirotalk-settings-shared";

/**
 * Every environment name this suite has to isolate between cases.
 *
 * DERIVED from `MIROTALK_ENV_NAMES` rather than retyped (#2940 review, T8). The
 * hand-written copy was already the same six names in a second place, and the
 * failure mode it invites is the quiet one: a seventh env-backed field added to
 * the record is not saved and restored here, so whatever the host machine
 * happens to hold leaks into every case in this file and the suite passes or
 * fails for a reason that is not in the test.
 *
 * `NEXTAUTH_URL` and `NEXT_PUBLIC_MIROTALK_URL` are not MiroTalk settings — the
 * first is what the address is DERIVED from when nothing names one, the second
 * is the legacy client-side spelling the resolver still honours — so they stay
 * listed by hand.
 */
const MIRO_ENV_KEYS = [
  ...Object.values(MIROTALK_ENV_NAMES),
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

describe("the status says what is IN FORCE (#2940 review, C3)", () => {
  it("normalises a bare MIROTALK_URL before reporting it", async () => {
    // The page prints `effective` under the words "In force:". With
    // MIROTALK_URL=meet.example.org it used to say `meet.example.org` while
    // every join link went to `https://meet.example.org` — and stating what is
    // in force is the screen's whole job.
    process.env.MIROTALK_URL = "meet.example.org/";
    const status = await getMirotalkConfigurationStatus();
    expect(status.baseUrl.source).toBe("environment");
    expect(status.baseUrl.effective).toBe("https://meet.example.org");
    await expect(buildMeetingJoinUrl("xyz")).resolves.toBe(
      "https://meet.example.org/join/xyz",
    );
  });

  it("still says why an environment value would not be accepted here", async () => {
    // Normalising the display must not swallow the caveat: an environment
    // value is never refused, and the reason it would be is on `problem`.
    process.env.MIROTALK_URL = "http://192.168.1.10:3010";
    const status = await getMirotalkConfigurationStatus();
    expect(status.baseUrl.source).toBe("environment");
    expect(status.baseUrl.problem).toMatch(/MIROTALK_URL is in force/);
  });
});

describe("the derived address reads the ONE loopback rule (#2940 review, T2)", () => {
  it.each([
    ["the DNS root label", "http://localhost.:3000"],
    ["a loopback address other than .1", "http://127.0.0.2:3000"],
    ["the unspecified address", "http://0.0.0.0:3000"],
  ])("takes the dev fallback for an app origin with %s", async (_label, origin) => {
    // The private copy in this module missed all three, so `localhost.` derived
    // the meeting address `https://meet.localhost.` — a host that resolves on
    // whoever clicked the link, which is the failure the fallback exists to
    // avoid.
    process.env.NEXTAUTH_URL = origin;
    await expect(buildMeetingJoinUrl("xyz")).resolves.toBe(
      "http://localhost:3010/join/xyz",
    );
  });

  it("still derives from a real public origin", async () => {
    process.env.NEXTAUTH_URL = "https://www.club.org";
    await expect(buildMeetingJoinUrl("xyz")).resolves.toBe(
      "https://meet.club.org/join/xyz",
    );
  });
});

describe("what counts as MOVING the meeting server (#2940 review, C1)", () => {
  // The predicate the secret clear is allowed to ask. It compares the address
  // IN FORCE on each side, not the stored column, because the column is null on
  // every install that has only ever set MIROTALK_URL — and the cost of reading
  // that null as a move is three secrets nobody can read back.
  const NOTHING_STORED = {
    baseUrl: null,
    presenterEnabled: null,
    tokenLifetime: null,
    updatedAt: null,
  };

  it("does NOT move when the box is filled in with the address already in force", () => {
    // The loss this exists to prevent, end to end: a club runs on
    // MIROTALK_URL, a Full Admin stores the three secrets, then writes the
    // address they are already using into the box — which is what .env.example
    // now tells them to do — and presses Save.
    process.env.MIROTALK_URL = "https://meet.club.org";
    expect(
      mirotalkMeetingServerMoved(NOTHING_STORED, {
        ...NOTHING_STORED,
        baseUrl: "https://meet.club.org",
      }),
    ).toBe(false);
  });

  it("does NOT move when the environment spelled the same server differently", () => {
    // The two sides arrive by different routes: the stored one has been through
    // the URL parser and the environment one deliberately never is. A default
    // port, a trailing slash or a bare host is the same server written twice.
    process.env.MIROTALK_URL = "meet.club.org/";
    expect(
      mirotalkMeetingServerMoved(NOTHING_STORED, {
        ...NOTHING_STORED,
        baseUrl: "https://meet.club.org",
      }),
    ).toBe(false);
    process.env.MIROTALK_URL = "https://meet.club.org:443";
    expect(
      mirotalkMeetingServerMoved(NOTHING_STORED, {
        ...NOTHING_STORED,
        baseUrl: "https://meet.club.org",
      }),
    ).toBe(false);
  });

  it("DOES move when the box names a genuinely different server", () => {
    process.env.MIROTALK_URL = "https://meet.club.org";
    expect(
      mirotalkMeetingServerMoved(NOTHING_STORED, {
        ...NOTHING_STORED,
        baseUrl: "https://meet.elsewhere.org",
      }),
    ).toBe(true);
  });

  it("does NOT move when the box is CLEARED back onto the same environment value", () => {
    // The mirror case. Emptying the box returns the field to MIROTALK_URL; when
    // that names the same server, nothing moved and nothing may be deleted.
    process.env.MIROTALK_URL = "https://meet.club.org";
    expect(
      mirotalkMeetingServerMoved(
        { ...NOTHING_STORED, baseUrl: "https://meet.club.org" },
        NOTHING_STORED,
      ),
    ).toBe(false);
  });

  it("DOES move when the box is cleared onto a DIFFERENT environment value", () => {
    process.env.MIROTALK_URL = "https://meet.club.org";
    expect(
      mirotalkMeetingServerMoved(
        { ...NOTHING_STORED, baseUrl: "https://meet.elsewhere.org" },
        NOTHING_STORED,
      ),
    ).toBe(true);
  });

  it("DOES move between two stored addresses", () => {
    expect(
      mirotalkMeetingServerMoved(
        { ...NOTHING_STORED, baseUrl: "https://old.example.org" },
        { ...NOTHING_STORED, baseUrl: "https://new.example.org" },
      ),
    ).toBe(true);
  });

  it("does NOT move when only a non-address setting changed", () => {
    process.env.MIROTALK_URL = "https://meet.club.org";
    expect(
      mirotalkMeetingServerMoved(
        { ...NOTHING_STORED, presenterEnabled: true, tokenLifetime: "1h" },
        { ...NOTHING_STORED, presenterEnabled: false, tokenLifetime: "30m" },
      ),
    ).toBe(false);
  });

  it("does NOT move when neither side names one and the derived address governs", () => {
    // Nothing set anywhere: both sides derive from the app's own origin, so a
    // Save that touches only the presenter flag cannot be read as a move.
    process.env.NEXTAUTH_URL = "https://bookings.club.org";
    expect(mirotalkMeetingServerMoved(NOTHING_STORED, NOTHING_STORED)).toBe(false);
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
