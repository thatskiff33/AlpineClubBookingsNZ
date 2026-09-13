import { beforeEach, describe, expect, it, vi } from "vitest";

// DB-only Google OAuth config resolution (#2087): the resolver FAILS OPEN (never
// throws — a DB/decrypt failure degrades Google to "unconfigured"), and the
// setup state applies the verified-freshness rule so a credential swap drops the
// verified flag.
const {
  mockGetIntegrationCredentialValue,
  mockProviderNeedsReentry,
  mockSetIntegrationCredential,
  mockDeleteIntegrationCredential,
  mockFindMany,
} = vi.hoisted(() => ({
  mockGetIntegrationCredentialValue: vi.fn(),
  mockProviderNeedsReentry: vi.fn(),
  mockSetIntegrationCredential: vi.fn(),
  mockDeleteIntegrationCredential: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock("@/lib/integration-credentials", () => ({
  getIntegrationCredentialValue: mockGetIntegrationCredentialValue,
  providerNeedsReentry: mockProviderNeedsReentry,
  setIntegrationCredential: mockSetIntegrationCredential,
  deleteIntegrationCredential: mockDeleteIntegrationCredential,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { integrationCredential: { findMany: mockFindMany } },
}));

vi.mock("@/lib/logger", () => ({
  default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  clearGoogleVerified,
  getGoogleOAuthConfig,
  getGoogleSetupState,
  recordGoogleVerified,
} from "@/lib/google-config";

beforeEach(() => {
  vi.clearAllMocks();
  mockProviderNeedsReentry.mockResolvedValue(false);
});

describe("getGoogleOAuthConfig", () => {
  it("returns the config when both credentials resolve", async () => {
    mockGetIntegrationCredentialValue.mockImplementation(
      async (_provider: string, key: string) =>
        key === "client_id" ? "cid" : "csecret",
    );
    expect(await getGoogleOAuthConfig()).toEqual({
      clientId: "cid",
      clientSecret: "csecret",
    });
  });

  it("returns null when either credential is missing", async () => {
    mockGetIntegrationCredentialValue.mockImplementation(
      async (_provider: string, key: string) =>
        key === "client_id" ? "cid" : null,
    );
    expect(await getGoogleOAuthConfig()).toBeNull();
  });

  it("FAILS OPEN to null when the store throws (never propagates)", async () => {
    mockGetIntegrationCredentialValue.mockRejectedValue(
      new Error("DB unreachable"),
    );
    await expect(getGoogleOAuthConfig()).resolves.toBeNull();
  });
});

describe("getGoogleSetupState verified-freshness", () => {
  function rows(entries: Array<[string, Date]>) {
    return entries.map(([key, updatedAt]) => ({ key, updatedAt }));
  }

  it("is verified when the marker is at/after the newest credential write", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-01-01T00:05:00Z");
    mockFindMany.mockResolvedValue(
      rows([
        ["client_id", t0],
        ["client_secret", t0],
        ["verified_at", t1],
      ]),
    );
    const state = await getGoogleSetupState();
    expect(state.clientIdSet).toBe(true);
    expect(state.clientSecretSet).toBe(true);
    expect(state.verified).toBe(true);
  });

  it("drops verified when a credential is newer than the marker (post-swap)", async () => {
    const marker = new Date("2026-01-01T00:00:00Z");
    const swapped = new Date("2026-01-01T00:05:00Z");
    mockFindMany.mockResolvedValue(
      rows([
        ["client_id", swapped],
        ["client_secret", marker],
        ["verified_at", marker],
      ]),
    );
    expect((await getGoogleSetupState()).verified).toBe(false);
  });

  it("is not verified without both credentials", async () => {
    mockFindMany.mockResolvedValue(
      rows([["client_id", new Date()], ["verified_at", new Date()]]),
    );
    expect((await getGoogleSetupState()).verified).toBe(false);
  });
});

describe("verified marker writes", () => {
  it("recordGoogleVerified swallows store errors (best-effort)", async () => {
    mockSetIntegrationCredential.mockRejectedValue(new Error("weak secret"));
    await expect(recordGoogleVerified()).resolves.toBeUndefined();
  });

  it("clearGoogleVerified deletes the marker row", async () => {
    mockDeleteIntegrationCredential.mockResolvedValue(undefined);
    await clearGoogleVerified();
    expect(mockDeleteIntegrationCredential).toHaveBeenCalledWith({
      provider: "google",
      key: "verified_at",
      // Verify-reset is a NAMED background writer (#2723), distinguishable in
      // the audit log from the admin whose credential write triggered it.
      actor: { kind: "system", actor: "google-verify-reset" },
      expect: { expect: "any" },
    });
  });
});
