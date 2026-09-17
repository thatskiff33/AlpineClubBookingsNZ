import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getIntegrationCredentialValue: vi.fn(),
  ensureGeneratedCredential: vi.fn(),
}));

vi.mock("@/lib/integration-credentials", () => ({
  getIntegrationCredentialValue: mocks.getIntegrationCredentialValue,
}));
vi.mock("@/lib/integration-credential-generate", () => ({
  ensureGeneratedCredential: mocks.ensureGeneratedCredential,
}));

import {
  XERO_REQUIRED_REPORT_OAUTH_SCOPES,
  detectLegacyProviderEnv,
  getOperationalXeroConfig,
  getOperationalXeroEncryptionKey,
  getOperationalXeroRedirectUri,
  getOperationalXeroWebhookKey,
} from "@/lib/xero-config";

const originalEnv = { ...process.env };

function restoreEnv() {
  process.env = { ...originalEnv };
}

describe("xero-config (DB-only resolution — #2079)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXTAUTH_URL = "https://club.example.com";
  });
  afterEach(() => {
    restoreEnv();
  });

  it("resolves client id/secret from the DB, not from env", async () => {
    process.env.XERO_CLIENT_ID = "env-should-be-ignored";
    mocks.getIntegrationCredentialValue.mockImplementation(
      async (_provider: string, key: string) =>
        key === "client_id"
          ? "db-client-id"
          : key === "client_secret"
            ? "db-client-secret"
            : null,
    );

    const config = await getOperationalXeroConfig();
    expect(config.clientId).toBe("db-client-id");
    expect(config.clientSecret).toBe("db-client-secret");
  });

  it("derives the redirect URI from NEXTAUTH_URL (no localhost fallback)", () => {
    process.env.NEXTAUTH_URL = "https://club.example.com/base";
    expect(getOperationalXeroRedirectUri()).toBe(
      "https://club.example.com/api/admin/xero/callback",
    );

    delete process.env.NEXTAUTH_URL;
    expect(getOperationalXeroRedirectUri()).toBe("");
  });

  it("returns empty strings when the DB has no credentials (constructs but cannot connect)", async () => {
    mocks.getIntegrationCredentialValue.mockResolvedValue(null);
    const config = await getOperationalXeroConfig();
    expect(config.clientId).toBe("");
    expect(config.clientSecret).toBe("");
    expect(config.redirectUris).toEqual([
      "https://club.example.com/api/admin/xero/callback",
    ]);
  });

  it("widens the xero-node OAuth HTTP timeout past the 3500ms library default", async () => {
    mocks.getIntegrationCredentialValue.mockResolvedValue(null);
    delete process.env.XERO_HTTP_TIMEOUT_MS;
    expect((await getOperationalXeroConfig()).httpTimeout).toBe(10_000);
  });

  it("honours XERO_HTTP_TIMEOUT_MS and ignores non-positive or malformed values", async () => {
    mocks.getIntegrationCredentialValue.mockResolvedValue(null);
    process.env.XERO_HTTP_TIMEOUT_MS = "20000";
    expect((await getOperationalXeroConfig()).httpTimeout).toBe(20_000);
    process.env.XERO_HTTP_TIMEOUT_MS = "0";
    expect((await getOperationalXeroConfig()).httpTimeout).toBe(10_000);
    process.env.XERO_HTTP_TIMEOUT_MS = "not-a-number";
    expect((await getOperationalXeroConfig()).httpTimeout).toBe(10_000);
  });

  it("includes only the granular report scopes finance sync uses", async () => {
    mocks.getIntegrationCredentialValue.mockResolvedValue(null);
    const scopes = (await getOperationalXeroConfig()).scopes;
    expect(scopes).toEqual(
      expect.arrayContaining([
        "openid",
        "profile",
        "email",
        "accounting.contacts",
        "accounting.invoices",
        "accounting.payments",
        "accounting.settings.read",
        "offline_access",
      ]),
    );
    expect(scopes).not.toContain("accounting.reports.read");
    expect(scopes).toEqual(
      expect.arrayContaining([...XERO_REQUIRED_REPORT_OAUTH_SCOPES]),
    );
    for (const forbiddenScope of [
      "accounting.attachments",
      "accounting.budgets.read",
      "accounting.journals.read",
      "accounting.reports.payroll.read",
      "assets",
      "files",
      "payroll.employees",
      "projects",
    ]) {
      expect(scopes).not.toContain(forbiddenScope);
    }
  });

  it("resolves the webhook key via the dedicated resolver", async () => {
    mocks.getIntegrationCredentialValue.mockImplementation(
      async (_provider: string, key: string) =>
        key === "webhook_key" ? "db-webhook-key" : null,
    );
    expect(await getOperationalXeroWebhookKey()).toBe("db-webhook-key");

    mocks.getIntegrationCredentialValue.mockResolvedValue(null);
    expect(await getOperationalXeroWebhookKey()).toBeUndefined();
  });

  it("returns the auto-generated token key when the gate permits, undefined when blocked", async () => {
    mocks.ensureGeneratedCredential.mockResolvedValue("deadbeef");
    expect(await getOperationalXeroEncryptionKey()).toBe("deadbeef");

    mocks.ensureGeneratedCredential.mockResolvedValue(null); // gate blocked
    expect(await getOperationalXeroEncryptionKey()).toBeUndefined();
  });

  describe("detectLegacyProviderEnv", () => {
    it("names the exact legacy Xero vars that are present", () => {
      const findings = detectLegacyProviderEnv({
        XERO_CLIENT_ID: "x",
        XERO_ENCRYPTION_KEY: "y",
        XERO_WEBHOOK_KEY: "",
      });
      expect(findings).toEqual([
        { provider: "xero", vars: ["XERO_CLIENT_ID", "XERO_ENCRYPTION_KEY"] },
      ]);
    });

    it("returns nothing when no legacy provider env is set", () => {
      expect(detectLegacyProviderEnv({})).toEqual([]);
    });
  });
});
