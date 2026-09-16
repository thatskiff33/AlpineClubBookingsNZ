import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    serverNzSettings: { findUnique: mocks.findUnique, upsert: mocks.upsert },
  },
}));

import {
  SERVERNZ_SETTINGS_ID,
  loadServerNzSettings,
  normalizeBaseUrl,
  recordOtherLodgesDownload,
  validateCentralServerBaseUrl,
} from "@/lib/servernz-settings";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upsert.mockResolvedValue({});
});

describe("loadServerNzSettings", () => {
  it("falls back to safe defaults when the row is missing", async () => {
    mocks.findUnique.mockResolvedValue(null);
    await expect(loadServerNzSettings()).resolves.toEqual({
      baseUrl: null,
      otherLodgesEnabled: false,
      otherLodgesLastUploadAt: null,
      otherLodgesLastDownloadAt: null,
      otherLodgesCursor: null,
    });
  });

  it("falls back to safe defaults when the query throws, so setup still renders", async () => {
    mocks.findUnique.mockRejectedValue(new Error("database unavailable"));
    const settings = await loadServerNzSettings();
    // Defaults are OFF, so a read failure can never read as "sharing enabled".
    expect(settings.otherLodgesEnabled).toBe(false);
    expect(settings.baseUrl).toBeNull();
  });
});

describe("normalizeBaseUrl", () => {
  it("trims, drops trailing slashes, and treats blank as unset", () => {
    expect(normalizeBaseUrl("  https://central.test/  ")).toBe("https://central.test");
    expect(normalizeBaseUrl("https://central.test///")).toBe("https://central.test");
    expect(normalizeBaseUrl("   ")).toBeNull();
    expect(normalizeBaseUrl(undefined)).toBeNull();
  });
});

describe("validateCentralServerBaseUrl", () => {
  it("accepts an ordinary public https URL", () => {
    const result = validateCentralServerBaseUrl("https://central.alpineclub.nz");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("https://central.alpineclub.nz");
  });

  it("refuses http, because the API key travels to it as a bearer token", () => {
    const result = validateCentralServerBaseUrl("http://central.alpineclub.nz");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/https/i);
  });

  it.each([
    ["cloud metadata", "https://169.254.169.254/latest/meta-data/"],
    ["loopback v4", "https://127.0.0.1:8443"],
    ["loopback by name", "https://localhost:8443"],
    ["loopback v6", "https://[::1]:8443"],
    ["RFC1918 10/8", "https://10.0.0.5"],
    ["RFC1918 172.16/12", "https://172.20.1.1"],
    ["RFC1918 192.168/16", "https://192.168.1.1"],
    ["CGNAT", "https://100.64.0.1"],
    ["mDNS .local", "https://nas.local"],
    ["private zone .internal", "https://metadata.internal"],
    ["unspecified", "https://0.0.0.0"],
  ])("refuses a %s destination", (_label, url) => {
    // The first request-input-driven outbound fetch in the codebase: every other
    // provider pins its endpoint in code, so this is the first place an
    // admin-supplied string decides where a credential is sent.
    const result = validateCentralServerBaseUrl(url);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/private, loopback or link-local/i);
  });

  it.each([
    ["loopback by name", "https://localhost."],
    ["loopback by name, twice over", "https://localhost.."],
    ["cloud metadata by name", "https://metadata.google.internal."],
    ["mDNS", "https://nas.local."],
  ])("refuses %s wearing the DNS root label", (_label, url) => {
    // THE SHARPER OF THE TWO CONSUMERS. This base URL is fetched server-side
    // with the stored API key in an `Authorization` header on every sync, so a
    // private-zone name that gets past this rule is an authenticated request to
    // an internal address — the exact thing the rule exists to refuse. A
    // trailing dot is the DNS root label: resolvers accept it, the URL parser
    // preserves it verbatim on a name, and before it was stripped every
    // name-based rule below was one keystroke from being bypassed.
    const result = validateCentralServerBaseUrl(url);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/private, loopback or link-local/i);
  });

  it("refuses credentials embedded in the URL", () => {
    const result = validateCentralServerBaseUrl("https://user:pass@central.test");
    expect(result.ok).toBe(false);
  });

  it("refuses a blank or unparseable value", () => {
    expect(validateCentralServerBaseUrl("").ok).toBe(false);
    expect(validateCentralServerBaseUrl("https://").ok).toBe(false);
  });
});

describe("recordOtherLodgesDownload", () => {
  it("never overwrites a stored cursor with a null one", async () => {
    // A server that omits the cursor must not silently reset the club to a full
    // re-fetch of the entire registry.
    await recordOtherLodgesDownload(null);
    const [args] = mocks.upsert.mock.calls[0];
    expect(args.where).toEqual({ id: SERVERNZ_SETTINGS_ID });
    expect(args.update).not.toHaveProperty("otherLodgesCursor");
  });

  it("persists a cursor the server did return", async () => {
    await recordOtherLodgesDownload("c-900");
    const [args] = mocks.upsert.mock.calls[0];
    expect(args.update.otherLodgesCursor).toBe("c-900");
  });
});
