import { afterEach, describe, expect, it } from "vitest";
import {
  getFinanceXeroConfig,
  getFinanceXeroConfigIssues,
  getOperationalXeroConfig,
  hasFinanceXeroConfig,
} from "@/lib/xero-config";

const originalEnv = { ...process.env };

function restoreEnv() {
  process.env = { ...originalEnv };
}

describe("xero-config", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("keeps operational Xero config on the existing env names", () => {
    process.env.XERO_CLIENT_ID = "operational-client";
    process.env.XERO_CLIENT_SECRET = "operational-secret";
    process.env.XERO_REDIRECT_URI = "https://example.com/api/admin/xero/callback";

    expect(getOperationalXeroConfig()).toMatchObject({
      clientId: "operational-client",
      clientSecret: "operational-secret",
      redirectUris: ["https://example.com/api/admin/xero/callback"],
    });
  });

  it("loads finance Xero config from finance-only env names", () => {
    process.env.XERO_CLIENT_ID = "operational-client";
    process.env.XERO_CLIENT_SECRET = "operational-secret";
    process.env.XERO_REDIRECT_URI = "https://example.com/api/admin/xero/callback";
    process.env.FINANCE_XERO_CLIENT_ID = "finance-client";
    process.env.FINANCE_XERO_CLIENT_SECRET = "finance-secret";
    process.env.FINANCE_XERO_REDIRECT_URI =
      "https://example.com/api/finance/xero/callback";

    expect(getFinanceXeroConfig()).toMatchObject({
      clientId: "finance-client",
      clientSecret: "finance-secret",
      redirectUris: ["https://example.com/api/finance/xero/callback"],
    });
  });

  it("does not fall back to operational Xero credentials for finance config", () => {
    process.env.XERO_CLIENT_ID = "operational-client";
    process.env.XERO_CLIENT_SECRET = "operational-secret";
    process.env.XERO_REDIRECT_URI = "https://example.com/api/admin/xero/callback";
    delete process.env.FINANCE_XERO_CLIENT_ID;
    delete process.env.FINANCE_XERO_CLIENT_SECRET;
    delete process.env.FINANCE_XERO_REDIRECT_URI;

    expect(getFinanceXeroConfig()).toMatchObject({
      clientId: "",
      clientSecret: "",
      redirectUris: ["http://localhost:3000/api/finance/xero/callback"],
    });
    expect(getFinanceXeroConfigIssues()).toEqual([
      "FINANCE_XERO_CLIENT_ID is required",
      "FINANCE_XERO_CLIENT_SECRET is required",
    ]);
    expect(hasFinanceXeroConfig()).toBe(false);
  });

  it("flags an invalid finance redirect URI", () => {
    process.env.FINANCE_XERO_CLIENT_ID = "finance-client";
    process.env.FINANCE_XERO_CLIENT_SECRET = "finance-secret";
    process.env.FINANCE_XERO_REDIRECT_URI = "not-a-url";

    expect(getFinanceXeroConfigIssues()).toEqual([
      "FINANCE_XERO_REDIRECT_URI must be a valid http(s) URL",
    ]);
  });

  it("reports finance config as present when finance credentials are configured", () => {
    process.env.FINANCE_XERO_CLIENT_ID = "finance-client";
    process.env.FINANCE_XERO_CLIENT_SECRET = "finance-secret";
    delete process.env.FINANCE_XERO_REDIRECT_URI;

    expect(hasFinanceXeroConfig()).toBe(true);
  });
});
