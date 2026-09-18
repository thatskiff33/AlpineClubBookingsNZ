import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE MIROTALK EXPOSURE CONTRACT (#2940).
 *
 * #2723 established that a secret is kept out of an audit row by the SHAPE of
 * the payload rather than by a redaction filter, because a filter lives in one
 * place and is blind to every door that never calls it. This issue is that
 * store's first club-editable consumer, and it adds two new doors a value could
 * walk out of: a status the admin API serialises to a browser, and a join URL
 * served to whoever clicked Join.
 *
 * So this suite drives the REAL resolver with sentinel secrets — one arriving
 * from the environment, one from the encrypted store — and proves they reach
 * neither. It is deliberately behavioural rather than a source scan: a source
 * scan asks whether today's code spells something a particular way, and this
 * asks whether a secret can get out, which is the thing that matters and the
 * thing a refactor can break without changing any spelling.
 *
 * MUTATION-VERIFIED: carrying the resolved plaintext into the status projection
 * fails "the status carries no field a secret value fits into" and the
 * sentinel assertion. Since the review round that added the meta/value split,
 * that mutation no longer TYPE-checks either — the projection is handed an
 * object with no plaintext field — so this suite is now the second line rather
 * than the only one. It stays because it is behavioural: it asks whether a
 * secret can get out, which a refactor can change without changing any
 * spelling, where a source scan asks only how today's code is written.
 */

const ENV_SENTINEL = "SENTINEL-FROM-THE-ENVIRONMENT-8f2a";
const DB_SENTINEL = "SENTINEL-FROM-THE-DATABASE-3c91";

const mocks = vi.hoisted(() => ({
  settingsFindUnique: vi.fn(),
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
    mirotalkSettings: { findUnique: mocks.settingsFindUnique, upsert: vi.fn() },
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
} from "@/lib/mirotalk-config";
import { MIROTALK_CREDENTIAL_KEYS } from "@/lib/mirotalk-settings-shared";

/** Exactly the fields a secret's status may carry. Nothing holds a value. */
const ALLOWED_SECRET_STATUS_KEYS = [
  "key",
  "needsReentry",
  "source",
  "updatedAt",
  "version",
];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MIROTALK_URL = "https://meet.lwtc.org.nz";
  process.env.MIRO_JWT_KEY = ENV_SENTINEL;
  process.env.MIRO_MEETING_USERNAME = "lwtc";
  process.env.MIRO_MEETING_PASSWORD = ENV_SENTINEL;
  mocks.settingsFindUnique.mockResolvedValue(null);
  mocks.credFindMany.mockResolvedValue([
    {
      key: MIROTALK_CREDENTIAL_KEYS.meetingPassword,
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
  ]);
  // The password is stored; the other two fall through to the environment, so
  // one sentinel of each provenance is live in the same resolution.
  mocks.resolveIntegrationCredential.mockImplementation(
    async (_provider: string, key: string) =>
      key === MIROTALK_CREDENTIAL_KEYS.meetingPassword
        ? {
            status: "configured",
            value: DB_SENTINEL,
            secretSource: "AUTH_SECRET",
            sourceFlipped: false,
            labelVersion: "v1",
            version: "ver-password",
          }
        : { status: "not_configured" },
  );
});

describe("no secret reaches the admin status", () => {
  it("serialises neither sentinel, whichever source it came from", async () => {
    const status = await getMirotalkConfigurationStatus();
    const serialised = JSON.stringify(status);

    expect(serialised).not.toContain(ENV_SENTINEL);
    expect(serialised).not.toContain(DB_SENTINEL);
    // And the resolution really did happen — an empty status would pass the
    // assertions above for the wrong reason.
    expect(status.tokenMintable).toBe(true);
    expect(status.secrets).toHaveLength(3);
  });

  it("carries no field a secret value fits into", async () => {
    const status = await getMirotalkConfigurationStatus();
    for (const secret of status.secrets) {
      expect(Object.keys(secret).sort()).toEqual(ALLOWED_SECRET_STATUS_KEYS);
    }
  });

  it("still says enough to run the screen", async () => {
    // The contract is "no value", not "no information": an administrator has to
    // be able to tell a stored secret from an environment one from a missing
    // one, or the fallback is invisible and unmanageable.
    const status = await getMirotalkConfigurationStatus();
    const bySource = Object.fromEntries(
      status.secrets.map((secret) => [secret.key, secret.source]),
    );
    expect(bySource[MIROTALK_CREDENTIAL_KEYS.meetingPassword]).toBe("database");
    expect(bySource[MIROTALK_CREDENTIAL_KEYS.jwtKey]).toBe("environment");
    const stored = status.secrets.find(
      (secret) => secret.key === MIROTALK_CREDENTIAL_KEYS.meetingPassword,
    );
    expect(stored?.version).toBe("ver-password");
    expect(stored?.updatedAt).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("no secret reaches the join link in the clear", () => {
  it("encrypts the host sign-in rather than putting it in the address", async () => {
    const url = await buildMeetingJoinUrl("room-abc");

    // The token DOES carry the host credentials — that is what MiroTalk reads —
    // but AES-encrypted under the signing key and then signed, so neither the
    // password nor the key itself appears in the address.
    expect(url).toContain("token=");
    expect(url).not.toContain(ENV_SENTINEL);
    expect(url).not.toContain(DB_SENTINEL);
    expect(url).not.toContain(encodeURIComponent(ENV_SENTINEL));
    expect(url).not.toContain(encodeURIComponent(DB_SENTINEL));
  });
});
