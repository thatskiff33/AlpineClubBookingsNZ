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

import { Prisma } from "@prisma/client";
import {
  SERVERNZ_SETTINGS_ID,
  clearOtherLodgesOwnedNames,
  clearServerVersionCheck,
  forgetServerConnectionAnswers,
  loadServerNzSettings,
  normalizeBaseUrl,
  recordOtherLodgesDownload,
  recordServerVersionCheck,
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
      otherLodgesOwnedNames: null,
      otherLodgesOwnedNamesAt: null,
      otherLodgesOwnedNamesUnreadable: false,
      serverVersion: null,
      serverVersionCheckedAt: null,
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

describe("the server's reported API version (#49)", () => {
  it("reads the stored answer and when it was asked", async () => {
    mocks.findUnique.mockResolvedValue({
      otherLodgesEnabled: false,
      serverVersion: "2.1",
      serverVersionCheckedAt: new Date("2026-06-30T15:00:00.000Z"),
    });
    const settings = await loadServerNzSettings();
    expect(settings.serverVersion).toBe("2.1");
    expect(settings.serverVersionCheckedAt).toBe("2026-06-30T15:00:00.000Z");
  });

  it("records an answer with its instant and touches nothing else on the row", async () => {
    const at = new Date("2026-07-01T00:00:00.000Z");
    await recordServerVersionCheck("unknown", at);
    const [args] = mocks.upsert.mock.calls[0];
    expect(args.where).toEqual({ id: SERVERNZ_SETTINGS_ID });
    expect(args.update).toEqual({ serverVersion: "unknown", serverVersionCheckedAt: at });
    expect(args.create).toEqual({
      id: SERVERNZ_SETTINGS_ID,
      serverVersion: "unknown",
      serverVersionCheckedAt: at,
    });
  });

  it("forgets the answer back to NULL (never asked), not to a mismatch", async () => {
    await clearServerVersionCheck();
    const [args] = mocks.upsert.mock.calls[0];
    expect(args.update).toEqual({ serverVersion: null, serverVersionCheckedAt: null });
  });

  it("forgets the owned list AND the version in ONE write when the connection ends", async () => {
    await forgetServerConnectionAnswers();
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const [args] = mocks.upsert.mock.calls[0];
    expect(args.where).toEqual({ id: SERVERNZ_SETTINGS_ID });
    expect(args.update).toEqual({
      otherLodgesOwnedNames: Prisma.DbNull,
      otherLodgesOwnedNamesAt: null,
      serverVersion: null,
      serverVersionCheckedAt: null,
    });
  });
});

describe("the owned lodge list (#52)", () => {
  it("reads a stored list back, and its timestamp", async () => {
    mocks.findUnique.mockResolvedValue({
      id: SERVERNZ_SETTINGS_ID,
      baseUrl: "https://central.test",
      otherLodgesEnabled: true,
      otherLodgesLastUploadAt: null,
      otherLodgesLastDownloadAt: null,
      otherLodgesCursor: null,
      otherLodgesOwnedNames: ["Aorangi Ski Club"],
      otherLodgesOwnedNamesAt: new Date("2026-06-20T10:00:00.000Z"),
    });
    const settings = await loadServerNzSettings();
    expect(settings.otherLodgesOwnedNames).toEqual(["Aorangi Ski Club"]);
    expect(settings.otherLodgesOwnedNamesAt).toBe("2026-06-20T10:00:00.000Z");
  });

  it("reads an empty stored list as empty, not as unknown", async () => {
    mocks.findUnique.mockResolvedValue({ otherLodgesOwnedNames: [], otherLodgesEnabled: false });
    expect((await loadServerNzSettings()).otherLodgesOwnedNames).toEqual([]);
  });

  it.each([
    ["a string", "Aorangi Ski Club"],
    ["an object", { name: "Aorangi Ski Club" }],
    ["a list with a non-string", ["Aorangi Ski Club", 7]],
    ["a list with an over-long name", ["x".repeat(121)]],
  ])("reads a stored value that is %s as UNKNOWN, the fail-closed state", async (_label, stored) => {
    // Junk in the column must not become a lodge name (editable, uploaded) and
    // must not read as "owns nothing" either: both would be the column lying.
    mocks.findUnique.mockResolvedValue({ otherLodgesOwnedNames: stored, otherLodgesEnabled: false });
    const settings = await loadServerNzSettings();
    expect(settings.otherLodgesOwnedNames).toBeNull();
    // ...and FLAGGED, so the writers with a permissive fallback on null (the
    // upload, the committee sync) can fail closed instead.
    expect(settings.otherLodgesOwnedNamesUnreadable).toBe(true);
  });

  it("does not flag a never-told (NULL) or a well-formed stored list as unreadable", async () => {
    mocks.findUnique.mockResolvedValue({ otherLodgesOwnedNames: null, otherLodgesEnabled: false });
    expect((await loadServerNzSettings()).otherLodgesOwnedNamesUnreadable).toBe(false);
    mocks.findUnique.mockResolvedValue({ otherLodgesOwnedNames: ["A"], otherLodgesEnabled: false });
    expect((await loadServerNzSettings()).otherLodgesOwnedNamesUnreadable).toBe(false);
  });

  it("forgets the list with a database NULL, never a JSON null, and clears its timestamp", async () => {
    await clearOtherLodgesOwnedNames();
    const [args] = mocks.upsert.mock.calls[0];
    expect(args.where).toEqual({ id: SERVERNZ_SETTINGS_ID });
    // DbNull reads back as "never told"; a JSON null would read as unreadable.
    expect(args.update.otherLodgesOwnedNames).toBe(Prisma.DbNull);
    expect(args.update.otherLodgesOwnedNamesAt).toBeNull();
    // Nothing else on the row is touched.
    expect(Object.keys(args.update).sort()).toEqual([
      "otherLodgesOwnedNames",
      "otherLodgesOwnedNamesAt",
    ]);
  });

  it("stores the list and its timestamp when the download carried one", async () => {
    await recordOtherLodgesDownload("c-900", ["Aorangi Ski Club"]);
    const [args] = mocks.upsert.mock.calls[0];
    expect(args.update.otherLodgesOwnedNames).toEqual(["Aorangi Ski Club"]);
    expect(args.update.otherLodgesOwnedNamesAt).toBeInstanceOf(Date);
    expect(args.create.otherLodgesOwnedNames).toEqual(["Aorangi Ski Club"]);
  });

  it("stores an empty list, the server's answer that the club owns nothing", async () => {
    await recordOtherLodgesDownload("c-900", []);
    const [args] = mocks.upsert.mock.calls[0];
    expect(args.update.otherLodgesOwnedNames).toEqual([]);
  });

  it("leaves the stored list and its timestamp untouched when the download carried none", async () => {
    // An older server that does not send the list must not clear what a newer
    // one recorded.
    await recordOtherLodgesDownload("c-900");
    const [args] = mocks.upsert.mock.calls[0];
    expect(args.update).not.toHaveProperty("otherLodgesOwnedNames");
    expect(args.update).not.toHaveProperty("otherLodgesOwnedNamesAt");
    expect(args.create).not.toHaveProperty("otherLodgesOwnedNames");
  });
});
