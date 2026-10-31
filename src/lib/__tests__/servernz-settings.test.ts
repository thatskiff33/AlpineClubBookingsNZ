import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    serverNzSettings: { findUnique: mocks.findUnique, upsert: mocks.upsert },
    $executeRaw: mocks.executeRaw,
  },
}));

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  SERVERNZ_SETTINGS_ID,
  clearOtherLodgesOwnedNames,
  clearServerVersionCheck,
  forgetServerConnectionAnswers,
  loadServerNzSettings,
  normalizeBaseUrl,
  loadOwnedOtherLodges,
  readOwnedOtherLodges,
  recordOtherLodgesDownload,
  recordOtherLodgesUpload,
  recordServerVersionCheck,
  validateCentralServerBaseUrl,
  type ServerNzAnswerTx,
  type ServerNzConnectionTx,
} from "@/lib/servernz-settings";

// The mocked global client standing in for the answer fence's transaction:
// only `withCurrentServerNzConnection` mints the type in production (#4470).
const answerTx = prisma as unknown as ServerNzAnswerTx;

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
      otherLodgesOwnedLodges: null,
      otherLodgesOwnedLodgesUnreadable: false,
      otherLodgesKeyedAt: null,
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

it("propagates a fenced settings read failure instead of reporting defaults (#4436)", async () => {
  const db = { serverNzSettings: { findUnique: vi.fn().mockRejectedValue(new Error("database unavailable")) } };
  await expect(loadServerNzSettings(db as never)).rejects.toThrow("database unavailable");
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

describe("the answer recorders take only the answer fence's client (#4470)", () => {
  it("refuses the global client, a plain transaction and the connection fence's client at compile time", () => {
    // Type-level: each line below fails typecheck if the brand stops refusing
    // it, because the directive above it is then unused.
    // @ts-expect-error the global client never compared the connection
    const global: Parameters<typeof recordOtherLodgesDownload>[2]["db"] = prisma;
    // @ts-expect-error nor did a transaction that never took the answer fence
    const plain: ServerNzAnswerTx = {} as Prisma.TransactionClient;
    // @ts-expect-error the connection-change fence is a different fence
    const connection: ServerNzAnswerTx = {} as ServerNzConnectionTx;
    // @ts-expect-error the upload watermark is an answer too
    const upload: Parameters<typeof recordOtherLodgesUpload>[1] = prisma;
    // @ts-expect-error and so is the server's version
    const version: Parameters<typeof recordServerVersionCheck>[2] = prisma;
    expect([global, plain, connection, upload, version]).toHaveLength(5);
  });
});

describe("recordOtherLodgesDownload", () => {
  it("never overwrites a stored cursor with a null one", async () => {
    // A server that omits the cursor must not silently reset the club to a full
    // re-fetch of the entire registry.
    await recordOtherLodgesDownload(null, undefined, { db: answerTx });
    const [args] = mocks.upsert.mock.calls[0];
    expect(args.where).toEqual({ id: SERVERNZ_SETTINGS_ID });
    expect(args.update).not.toHaveProperty("otherLodgesCursor");
  });

  it("persists a cursor the server did return", async () => {
    await recordOtherLodgesDownload("c-900", undefined, { db: answerTx });
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
    await recordServerVersionCheck("unknown", at, { serverNzSettings: { upsert: mocks.upsert } } as never);
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

  it("forgets the owned list, transfer cursors AND the version in ONE write when the connection ends", async () => {
    // The writer's own write, on the mocked client. Only the connection fence
    // mints this type in production (#4436); `servernz-config.test.ts` covers it.
    const unfencedClientForUnitTest = prisma as unknown as ServerNzConnectionTx;
    await forgetServerConnectionAnswers(unfencedClientForUnitTest);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const [args] = mocks.upsert.mock.calls[0];
    expect(args.where).toEqual({ id: SERVERNZ_SETTINGS_ID });
    expect(args.update).toEqual({
      otherLodgesOwnedNames: Prisma.DbNull,
      otherLodgesOwnedNamesAt: null,
      otherLodgesOwnedLodges: Prisma.DbNull,
      otherLodgesLastUploadAt: null,
      otherLodgesLastDownloadAt: null,
      otherLodgesCursor: null,
      commsCursorSince: null,
      commsCursorSinceId: null,
      commsLastSyncAt: null,
      commsPoisonChangeId: null,
      commsPoisonCount: 0,
      // A new connection keys the registry again with a whole download (#64).
      otherLodgesKeyedAt: null,
      serverVersion: null,
      serverVersionCheckedAt: null,
    });
  });
});

describe("the owned lodge list, by central id (#52, #62, #69)", () => {
  const AORANGI = [{ id: "ol_a", name: "Aorangi Ski Club" }];

  it("reads a stored list back", async () => {
    mocks.findUnique.mockResolvedValue({
      id: SERVERNZ_SETTINGS_ID,
      baseUrl: "https://central.test",
      otherLodgesEnabled: true,
      otherLodgesOwnedLodges: AORANGI,
    });
    const settings = await loadServerNzSettings();
    expect(settings.otherLodgesOwnedLodges).toEqual(AORANGI);
    expect(settings.otherLodgesOwnedLodgesUnreadable).toBe(false);
  });

  it("reads an empty stored list as empty, not as unknown", async () => {
    mocks.findUnique.mockResolvedValue({ otherLodgesOwnedLodges: [], otherLodgesEnabled: false });
    expect((await loadServerNzSettings()).otherLodgesOwnedLodges).toEqual([]);
  });

  it("ignores the name-only list stored by API 2.4 and earlier (#69)", async () => {
    mocks.findUnique.mockResolvedValue({
      otherLodgesOwnedNames: ["Aorangi Ski Club"],
      otherLodgesEnabled: false,
    });
    const settings = await loadServerNzSettings();
    expect(settings.otherLodgesOwnedLodges).toBeNull();
    expect(settings.otherLodgesOwnedLodgesUnreadable).toBe(false);
  });

  it.each([
    ["a string", "Aorangi Ski Club"],
    ["a list of names", ["Aorangi Ski Club"]],
    ["an empty id", [{ id: "", name: "x" }]],
    ["the same id twice", [{ id: "a", name: "x" }, { id: "a", name: "y" }]],
    ["an over-long name", [{ id: "a", name: "x".repeat(121) }]],
  ])("reads a stored value that is %s as UNKNOWN, the fail-closed state", async (_label, stored) => {
    // Junk in the column must not become a lodge (editable, uploaded) and must
    // not read as "owns nothing" either: both would be the column lying.
    mocks.findUnique.mockResolvedValue({ otherLodgesOwnedLodges: stored, otherLodgesEnabled: false });
    const settings = await loadServerNzSettings();
    expect(settings.otherLodgesOwnedLodges).toBeNull();
    // ...and FLAGGED, so the writers with a permissive fallback on null (the
    // upload, the committee sync) can fail closed instead.
    expect(settings.otherLodgesOwnedLodgesUnreadable).toBe(true);
    expect(readOwnedOtherLodges(stored)).toEqual({ lodges: null, unreadable: true });
  });

  it("does not flag a never-told (NULL) list as unreadable", () => {
    expect(readOwnedOtherLodges(null)).toEqual({ lodges: null, unreadable: false });
    expect(readOwnedOtherLodges(undefined)).toEqual({ lodges: null, unreadable: false });
  });

  it("reads the list through the caller's client for a writer inside a transaction", async () => {
    const findUnique = vi.fn().mockResolvedValue({ otherLodgesOwnedLodges: AORANGI });
    const owned = await loadOwnedOtherLodges({ serverNzSettings: { findUnique } } as never);
    expect(owned).toEqual({ lodges: AORANGI, unreadable: false });
    expect(findUnique.mock.calls[0][0]).toEqual({
      where: { id: SERVERNZ_SETTINGS_ID },
      select: { otherLodgesOwnedLodges: true },
    });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("forgets the list with a database NULL, never a JSON null, and clears its timestamp", async () => {
    await clearOtherLodgesOwnedNames();
    const [args] = mocks.upsert.mock.calls[0];
    expect(args.where).toEqual({ id: SERVERNZ_SETTINGS_ID });
    // DbNull reads back as "never told"; a JSON null would read as unreadable.
    expect(args.update.otherLodgesOwnedLodges).toBe(Prisma.DbNull);
    expect(args.update.otherLodgesOwnedNames).toBe(Prisma.DbNull);
    expect(args.update.otherLodgesOwnedNamesAt).toBeNull();
    // Nothing else on the row is touched.
    expect(Object.keys(args.update).sort()).toEqual([
      "otherLodgesOwnedLodges",
      "otherLodgesOwnedNames",
      "otherLodgesOwnedNamesAt",
    ]);
  });

  it("stores the list the download carried with its timestamp, and leaves the old name-only list alone", async () => {
    await recordOtherLodgesDownload("c-900", AORANGI, { db: answerTx });
    const [args] = mocks.upsert.mock.calls[0];
    expect(args.update.otherLodgesOwnedLodges).toEqual(AORANGI);
    expect(args.update.otherLodgesOwnedNamesAt).toBeInstanceOf(Date);
    // The draining colour of a blue/green deploy still reads it (#69).
    expect(args.update).not.toHaveProperty("otherLodgesOwnedNames");
    expect(args.create.otherLodgesOwnedLodges).toEqual(AORANGI);
  });

  it("stores an empty list, the server's answer that the club owns nothing", async () => {
    await recordOtherLodgesDownload("c-900", [], { db: answerTx });
    expect(mocks.upsert.mock.calls[0][0].update.otherLodgesOwnedLodges).toEqual([]);
  });

  it("leaves the stored list and its timestamp untouched when the download carried none", async () => {
    // A list refused for its bounds, or not sent, must not clear what is stored.
    await recordOtherLodgesDownload("c-900", undefined, { db: answerTx });
    const [args] = mocks.upsert.mock.calls[0];
    for (const key of ["otherLodgesOwnedLodges", "otherLodgesOwnedNames", "otherLodgesOwnedNamesAt"]) {
      expect(args.update).not.toHaveProperty(key);
      expect(args.create).not.toHaveProperty(key);
    }
  });
});

describe("the version column has one writer (#4366)", () => {
  it("is called only by the fenced recorder, which passes its transaction", () => {
    // `recordServerVersionCheck` takes no default client, and since #4470 only
    // the answer fence's client satisfies its type; this census still pins
    // its one caller, so a second writer of the column is a reviewed change.
    const srcRoot = resolve(__dirname, "../..");
    const callers = (readdirSync(srcRoot, { recursive: true }) as string[])
      .filter((file) => /\.tsx?$/.test(file) && !/__tests__|\.test\.tsx?$/.test(file))
      .filter((file) => /\brecordServerVersionCheck\(/.test(readFileSync(join(srcRoot, file), "utf8")))
      .map((file) => file.split("\\").join("/"))
      .sort();
    expect(callers).toEqual(["lib/servernz-settings.ts", "lib/servernz-version-record.ts"]);
  });
});
describe("recordOtherLodgesDownload: the keyed marker (#64)", () => {
  it("sets otherLodgesKeyedAt only when told the whole registry merged", async () => {
    await recordOtherLodgesDownload("c-1", undefined, { keyed: true, db: answerTx });
    expect(mocks.upsert.mock.calls[0][0].update.otherLodgesKeyedAt).toBeInstanceOf(Date);
    await recordOtherLodgesDownload("c-2", undefined, { db: answerTx });
    expect(mocks.upsert.mock.calls[1][0].update).not.toHaveProperty("otherLodgesKeyedAt");
  });

  it("writes through the caller's transaction client when given one", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    await recordOtherLodgesDownload("c-3", undefined, {
      db: { serverNzSettings: { upsert } } as never,
    });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("reads the marker back", async () => {
    mocks.findUnique.mockResolvedValue({
      id: SERVERNZ_SETTINGS_ID,
      otherLodgesKeyedAt: new Date("2026-10-14T00:00:00.000Z"),
    });
    expect((await loadServerNzSettings()).otherLodgesKeyedAt).toBe("2026-10-14T00:00:00.000Z");
  });
});

describe("recordOtherLodgesUpload", () => {
  it("records the accepted watermark through the caller's transaction", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const at = new Date("2026-06-01T00:00:00.000Z");
    await recordOtherLodgesUpload(at, { serverNzSettings: { upsert } } as never);
    expect(upsert).toHaveBeenCalledWith({
      where: { id: SERVERNZ_SETTINGS_ID },
      create: { id: SERVERNZ_SETTINGS_ID, otherLodgesLastUploadAt: at },
      update: { otherLodgesLastUploadAt: at },
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
