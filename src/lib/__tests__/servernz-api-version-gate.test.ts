import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #49, `INV-INT-025`: the version gate lives INSIDE `resolveConnection`, so no
 * server-bound function in `servernz-api.ts` can reach the server past it, and
 * the only opt-out is the version call itself. This suite drives the REAL
 * module against a stubbed `fetch`, so "nothing was sent" means no fetch at
 * all, not a mocked gate that said so.
 */

const mocks = vi.hoisted(() => ({
  getOperationalServerNzApiKey: vi.fn(),
  loadServerNzSettings: vi.fn(),
  recordServerVersionCheck: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/servernz-config", () => ({
  getOperationalServerNzApiKey: mocks.getOperationalServerNzApiKey,
}));

vi.mock("@/lib/servernz-settings", () => ({
  loadServerNzSettings: mocks.loadServerNzSettings,
  recordServerVersionCheck: mocks.recordServerVersionCheck,
  validateCentralServerBaseUrl: (value: string) => ({ ok: true, value }),
}));

vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import {
  ServerNzVersionMismatchError,
  fetchServerVersion,
  fetchSharedPostImage,
  pullOtherLodges,
  pullSharedPostSync,
  refreshStoredServerVersion,
  registerPushTarget,
  shareClubPost,
  uploadOtherLodges,
  withdrawClubPost,
} from "@/lib/servernz-api";
import {
  SERVERNZ_EXPECTED_SERVER_VERSION,
  SERVER_VERSION_UNKNOWN,
} from "@/lib/servernz-api-version";

const fetchMock = vi.fn();

function settings(serverVersion: string | null) {
  mocks.loadServerNzSettings.mockResolvedValue({
    baseUrl: "https://central.test",
    serverVersion,
    serverVersionCheckedAt: null,
  });
}

function respond(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  mocks.getOperationalServerNzApiKey.mockResolvedValue("acs_key");
  mocks.recordServerVersionCheck.mockResolvedValue(undefined);
  settings(SERVERNZ_EXPECTED_SERVER_VERSION);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every server-bound function, called the way its caller calls it. */
const SERVER_BOUND: Array<[string, () => Promise<unknown>]> = [
  ["uploadOtherLodges", () => uploadOtherLodges([])],
  ["pullOtherLodges", () => pullOtherLodges(null)],
  [
    "shareClubPost",
    () =>
      shareClubPost({
        authorUserId: "m1",
        authorName: "Jo",
        content: "hi",
        bodyHtml: null,
        images: [],
      }),
  ],
  ["withdrawClubPost", () => withdrawClubPost("srv-1")],
  ["pullSharedPostSync", () => pullSharedPostSync({})],
  [
    "fetchSharedPostImage",
    () => fetchSharedPostImage(`https://central.test/api/images/posts/${"a".repeat(32)}`),
  ],
  ["registerPushTarget", () => registerPushTarget("https://club.test/hook")],
];

describe("the gate refuses every server-bound call on a stored mismatch", () => {
  it.each(SERVER_BOUND)("%s throws ServerNzVersionMismatchError and sends NOTHING", async (_name, call) => {
    settings("2.1");
    await expect(call()).rejects.toBeInstanceOf(ServerNzVersionMismatchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a stored 'unknown' (a 404 from a server before versioning) as a mismatch too", async () => {
    settings(SERVER_VERSION_UNKNOWN);
    const error = await uploadOtherLodges([]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerNzVersionMismatchError);
    expect((error as ServerNzVersionMismatchError).serverVersion).toBe(SERVER_VERSION_UNKNOWN);
    expect((error as ServerNzVersionMismatchError).expected).toBe(SERVERNZ_EXPECTED_SERVER_VERSION);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("carries only the two numbers - never the key or the address", async () => {
    settings("1.10");
    const error = (await pullOtherLodges(null).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain("acs_key");
    expect(error.message).not.toContain("central.test");
    expect(error.message).toContain("1.10");
  });

  it("is not fooled by the float trap: 1.10 stored against a 1.1 site would differ", () => {
    // The gate compares through compareServerVersions, which the version
    // module's own suite pins; this is the end-to-end reading of it.
    expect(
      new ServerNzVersionMismatchError("1.1", "1.10").message,
    ).toContain("1.10");
  });
});

describe("the one opt-out is the version call", () => {
  it("fetchServerVersion goes through under a stored mismatch, with this site's version in the header", async () => {
    settings("2.1");
    fetchMock.mockResolvedValue(respond(200, { version: "2.1", match: false }));

    await expect(fetchServerVersion()).resolves.toBe("2.1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://central.test/api/v1/version");
    expect(init.headers["X-Client-Api-Version"]).toBe(SERVERNZ_EXPECTED_SERVER_VERSION);
    expect(init.headers.Authorization).toBe("Bearer acs_key");
  });

  it("reads a 404 as 'unknown' - a server from before versioning is a mismatch, not an error", async () => {
    fetchMock.mockResolvedValue(respond(404, { error: "Not found" }));
    await expect(fetchServerVersion()).resolves.toBe(SERVER_VERSION_UNKNOWN);
  });

  it("throws on any other failure, and refuses a version the schema cannot hold", async () => {
    fetchMock.mockResolvedValue(respond(503, { error: "down" }));
    await expect(fetchServerVersion()).rejects.toThrow(/down/);

    fetchMock.mockResolvedValue(respond(200, { version: "x".repeat(17), match: null }));
    await expect(fetchServerVersion()).rejects.toThrow();
  });
});

describe("refreshStoredServerVersion: one path writes the column", () => {
  it("records what the server said, 'unknown' included", async () => {
    fetchMock.mockResolvedValue(respond(404));
    await expect(refreshStoredServerVersion()).resolves.toBe(SERVER_VERSION_UNKNOWN);
    expect(mocks.recordServerVersionCheck).toHaveBeenCalledWith(SERVER_VERSION_UNKNOWN);
  });

  it("records NOTHING and returns null when the call fails, so a blip cannot pause syncing", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    await expect(refreshStoredServerVersion()).resolves.toBeNull();
    expect(mocks.recordServerVersionCheck).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it("logs only the two numbers on a mismatch (INV-INT-005)", async () => {
    fetchMock.mockResolvedValue(respond(200, { version: "2.1", match: false }));
    await refreshStoredServerVersion();
    const [fields] = mocks.logger.info.mock.calls[0];
    expect(fields).toEqual({ expected: SERVERNZ_EXPECTED_SERVER_VERSION, serverVersion: "2.1" });
  });
});

describe("a never-asked row self-heals with ONE inline check (default 1)", () => {
  it("asks the version first, records it, then sends the real request when it matches", async () => {
    settings(null);
    fetchMock
      .mockResolvedValueOnce(respond(200, { version: SERVERNZ_EXPECTED_SERVER_VERSION, match: true }))
      .mockResolvedValueOnce(respond(200, { url: "https://club.test/hook", secretVersion: 1, secret: "s".repeat(40) }));

    await registerPushTarget("https://club.test/hook");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://central.test/api/v1/version");
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://central.test/api/v1/push-target");
    expect(mocks.recordServerVersionCheck).toHaveBeenCalledWith(SERVERNZ_EXPECTED_SERVER_VERSION);
  });

  it("refuses the real request when the inline answer differs, having sent only the version call", async () => {
    settings(null);
    fetchMock.mockResolvedValueOnce(respond(200, { version: "3.0", match: false }));

    await expect(uploadOtherLodges([])).rejects.toBeInstanceOf(ServerNzVersionMismatchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.recordServerVersionCheck).toHaveBeenCalledWith("3.0");
  });

  it("lets the request through when the inline check FAILS - a failed check never pauses", async () => {
    settings(null);
    fetchMock
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(respond(200, { lodges: [], cursor: null, count: 0 }));

    const result = await pullOtherLodges(null);

    expect(result.count).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.recordServerVersionCheck).not.toHaveBeenCalled();
  });
});

describe("every request names this site's version", () => {
  it("on JSON, multipart and image requests alike", async () => {
    fetchMock.mockResolvedValue(respond(200, { lodges: [], cursor: null, count: 0 }));
    await pullOtherLodges(null);
    expect(fetchMock.mock.calls[0][1].headers["X-Client-Api-Version"]).toBe(SERVERNZ_EXPECTED_SERVER_VERSION);

    fetchMock.mockResolvedValue(respond(200, { id: "srv-1" }));
    await shareClubPost({ authorUserId: "m", authorName: "Jo", content: "x", bodyHtml: null, images: [] });
    const multipart = fetchMock.mock.calls[1][1].headers;
    expect(multipart["X-Client-Api-Version"]).toBe(SERVERNZ_EXPECTED_SERVER_VERSION);
    expect(multipart["Content-Type"]).toBeUndefined();

    fetchMock.mockResolvedValue(respond(200));
    await fetchSharedPostImage(`https://central.test/api/images/posts/${"b".repeat(32)}.webp`);
    expect(fetchMock.mock.calls[2][1].headers["X-Client-Api-Version"]).toBe(SERVERNZ_EXPECTED_SERVER_VERSION);
  });
});
