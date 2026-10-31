import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #49, `INV-INT-027`: the version gate lives INSIDE `resolveConnection`, so no
 * server-bound function in `servernz-api.ts` can reach the server past it, and
 * the only opt-out is the version call itself. This suite drives the REAL
 * module against a stubbed `fetch`, so "nothing was sent" means no fetch at
 * all, not a mocked gate that said so.
 *
 * #4366: it also drives the REAL fenced recorder (`servernz-version-record.ts`)
 * against a stateful double of the stored connection - the settings row's
 * address and the API key's credential version - and a `$transaction` that
 * hands the recorder a client reading that state. A test can move the stored
 * connection while a response is held back, which is the race the fence exists
 * for, with no real HTTP and no database.
 */

const mocks = vi.hoisted(() => {
  /** The stored connection as the database would hold it right now. */
  const stored: {
    baseUrl: string | null;
    apiKey: string | undefined;
    credentialVersion: string | null;
  } = { baseUrl: "https://central.test", apiKey: "acs_key", credentialVersion: "cred-v1" };
  const order: string[] = [];
  return {
    stored,
    order,
    loadServerNzSettings: vi.fn(),
    recordServerVersionCheck: vi.fn(),
    invalidateProviderCredentialCache: vi.fn(),
    lockServerNzSettings: vi.fn(async () => {
      order.push("lock");
    }),
    readServerNzCredentialVersion: vi.fn(async () => {
      order.push("read credential version");
      return stored.credentialVersion;
    }),
    getOperationalServerNzCredential: vi.fn(async () =>
      stored.apiKey === undefined || stored.credentialVersion === null
        ? undefined
        : { apiKey: stored.apiKey, version: stored.credentialVersion },
    ),
    tx: {
      serverNzSettings: {
        findUnique: vi.fn(async () => {
          order.push("read address");
          return { baseUrl: stored.baseUrl };
        }),
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock("@/lib/servernz-config", () => ({
  SERVERNZ_PROVIDER: "servernz",
  withServerNzConnectionTransaction: async (work: (tx: unknown) => Promise<unknown>) => {
    await mocks.lockServerNzSettings();
    return work(mocks.tx);
  },
  getOperationalServerNzCredential: mocks.getOperationalServerNzCredential,
  readServerNzCredentialVersion: mocks.readServerNzCredentialVersion,
}));

vi.mock("@/lib/integration-credentials", () => ({
  invalidateProviderCredentialCache: mocks.invalidateProviderCredentialCache,
}));

vi.mock("@/lib/servernz-settings", () => ({
  SERVERNZ_SETTINGS_ID: "default",
  SERVERNZ_TRANSACTION_OPTIONS: { timeout: 150_000, maxWait: 10_000 },
  loadServerNzSettings: mocks.loadServerNzSettings,
  lockServerNzSettings: mocks.lockServerNzSettings,
  recordServerVersionCheck: mocks.recordServerVersionCheck,
  validateCentralServerBaseUrl: (value: string) => ({ ok: true, value }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(mocks.tx)),
  },
}));

vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import {
  ServerNzApiError,
  ServerNzNotConfiguredError,
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
import { prisma } from "@/lib/prisma";

const fetchMock = vi.fn();

function settings(serverVersion: string | null) {
  mocks.loadServerNzSettings.mockImplementation(async () => ({
    baseUrl: mocks.stored.baseUrl,
    serverVersion,
    serverVersionCheckedAt: null,
  }));
}

/** The version column was written with exactly this, inside the recorder's transaction. */
function expectRecorded(version: string) {
  expect(mocks.recordServerVersionCheck).toHaveBeenCalledWith(version, expect.any(Date), mocks.tx);
}

/** A response the test releases when it chooses, after moving the stored connection. */
function deferredResponse() {
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  fetchMock.mockReturnValueOnce(pending);
  return release;
}

async function untilSent(calls = 1) {
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(calls));
}

function respond(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  mocks.stored.baseUrl = "https://central.test";
  mocks.stored.apiKey = "acs_key";
  mocks.stored.credentialVersion = "cred-v1";
  mocks.order.length = 0;
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
    settings("2.7");
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

  it("refuses a stored 1.10 against this 2.6 site through the real comparison, not a string or float read", async () => {
    // Float-equal to 1.1 and string-unequal to 2.6 either way; what this pins
    // is that the GATE goes through compareServerVersions (the version module's
    // own suite pins the 1.10-vs-1.1 case) and reports the stored spelling.
    settings("1.10");
    const error = (await pullOtherLodges(null).catch((e: unknown) => e)) as ServerNzVersionMismatchError;
    expect(error).toBeInstanceOf(ServerNzVersionMismatchError);
    expect(error.serverVersion).toBe("1.10");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the one opt-out is the version call", () => {
  it("fetchServerVersion goes through under a stored mismatch, with this site's version in the header", async () => {
    settings("2.7");
    fetchMock.mockResolvedValue(respond(200, { version: "2.7", match: false }));

    await expect(fetchServerVersion()).resolves.toBe("2.7");

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

describe("the server's own 409 refusal (review item 1)", () => {
  const MISMATCH_409 = {
    error: "This server is on a different API version, so nothing is transferred until your site is upgraded.",
    code: "API_VERSION_MISMATCH",
    serverVersion: "2.7",
    clientVersion: "2.6",
  };

  it.each(SERVER_BOUND)("%s turns a 409 API_VERSION_MISMATCH into the version error and records the server's number", async (_name, call) => {
    fetchMock.mockResolvedValue(respond(409, MISMATCH_409));
    const error = await call().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerNzVersionMismatchError);
    expect((error as ServerNzVersionMismatchError).serverVersion).toBe("2.7");
    expectRecorded("2.7");
  });

  it("leaves a plain 409 (no code) as the ServerNzApiError it always was, recording nothing", async () => {
    fetchMock.mockResolvedValue(respond(409, { error: "Other Clubs sync is disabled" }));
    const error = await uploadOtherLodges([]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerNzApiError);
    expect((error as ServerNzApiError).status).toBe(409);
    expect(mocks.recordServerVersionCheck).not.toHaveBeenCalled();
  });

  it("is decided by the CODE, not by a serverVersion field happening to be present", async () => {
    // A 409 for some other reason that also names a version (a future server
    // echoing versions on every refusal) must not be read as the pause.
    fetchMock.mockResolvedValue(respond(409, { error: "Conflict", code: "SOME_OTHER_CONFLICT", serverVersion: "2.7" }));
    const error = await uploadOtherLodges([]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerNzApiError);
    expect(mocks.recordServerVersionCheck).not.toHaveBeenCalled();
  });

  it("ignores the code on any status but 409, and a serverVersion over the column bound", async () => {
    fetchMock.mockResolvedValue(respond(400, { ...MISMATCH_409 }));
    await expect(pullOtherLodges(null)).rejects.toBeInstanceOf(ServerNzApiError);
    fetchMock.mockResolvedValue(respond(409, { ...MISMATCH_409, serverVersion: "9".repeat(17) }));
    await expect(pullOtherLodges(null)).rejects.toBeInstanceOf(ServerNzApiError);
    expect(mocks.recordServerVersionCheck).not.toHaveBeenCalled();
  });

  it("stores a malformed serverVersion as the unknown marker, still a pause (item 3)", async () => {
    fetchMock.mockResolvedValue(respond(409, { ...MISMATCH_409, serverVersion: "2.6.1" }));
    const error = await withdrawClubPost("srv-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerNzVersionMismatchError);
    expect((error as ServerNzVersionMismatchError).serverVersion).toBe(SERVER_VERSION_UNKNOWN);
    expectRecorded(SERVER_VERSION_UNKNOWN);
  });

  it("still throws the version error, without recording, when the key changed while the request was in flight (item 4)", async () => {
    const release = deferredResponse();
    const call = registerPushTarget("https://club.test/hook").catch((e: unknown) => e);
    await untilSent();
    mocks.stored.apiKey = "acs_replacement";
    mocks.stored.credentialVersion = "cred-v2";
    release(respond(409, MISMATCH_409));
    expect(await call).toBeInstanceOf(ServerNzVersionMismatchError);
    expect(mocks.recordServerVersionCheck).not.toHaveBeenCalled();
  });

  it("records nothing from a refusal sent on key A when A was replaced and saved again meanwhile (A -> B -> A, #4366)", async () => {
    const release = deferredResponse();
    const call = withdrawClubPost("srv-1").catch((e: unknown) => e);
    await untilSent();
    // B, then A again: the same plaintext as the request's, on a new row.
    mocks.stored.apiKey = "acs_other";
    mocks.stored.credentialVersion = "cred-v2";
    mocks.stored.apiKey = "acs_key";
    mocks.stored.credentialVersion = "cred-v3";
    release(respond(409, MISMATCH_409));
    const error = await call;
    expect(error).toBeInstanceOf(ServerNzVersionMismatchError);
    // The caller still pauses on what the server said; only the record is refused.
    expect((error as ServerNzVersionMismatchError).serverVersion).toBe("2.7");
    expect(mocks.recordServerVersionCheck).not.toHaveBeenCalled();
    // The key it was sent with may be a stale cached copy: the next request re-resolves.
    expect(mocks.invalidateProviderCredentialCache).toHaveBeenCalledWith("servernz");
  });
});

describe("refreshStoredServerVersion: one path writes the column", () => {
  it("records what the server said, 'unknown' included", async () => {
    fetchMock.mockResolvedValue(respond(404));
    await expect(refreshStoredServerVersion()).resolves.toBe(SERVER_VERSION_UNKNOWN);
    expectRecorded(SERVER_VERSION_UNKNOWN);
    expect(mocks.invalidateProviderCredentialCache).not.toHaveBeenCalled();
  });

  it("records NOTHING and returns null when the call fails, so a blip cannot pause syncing", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    await expect(refreshStoredServerVersion()).resolves.toBeNull();
    expect(mocks.recordServerVersionCheck).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalled();
  });

  it("throws when a RECEIVED answer cannot be recorded, never reading it as could-not-check (item 2)", async () => {
    fetchMock.mockResolvedValue(respond(200, { version: "2.7", match: false }));
    mocks.recordServerVersionCheck.mockRejectedValue(new Error("database unavailable"));
    await expect(refreshStoredServerVersion()).rejects.toThrow(/database unavailable/);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it("stores a malformed wire version as the unknown marker (item 3)", async () => {
    fetchMock.mockResolvedValue(respond(200, { version: "v2", match: null }));
    await expect(refreshStoredServerVersion()).resolves.toBe(SERVER_VERSION_UNKNOWN);
    expectRecorded(SERVER_VERSION_UNKNOWN);
  });

  it("drops a late answer when the key was removed while the call was in flight (item 4)", async () => {
    const release = deferredResponse();
    const check = refreshStoredServerVersion();
    await untilSent();
    mocks.stored.apiKey = undefined;
    mocks.stored.credentialVersion = null;
    release(respond(200, { version: "2.7", match: false }));
    await expect(check).resolves.toBeNull();
    expect(mocks.recordServerVersionCheck).not.toHaveBeenCalled();
  });

  it("drops a late answer after key A -> B -> A, though the plaintext key matches again (#4366)", async () => {
    const release = deferredResponse();
    const check = refreshStoredServerVersion();
    await untilSent();
    mocks.stored.apiKey = "acs_other";
    mocks.stored.credentialVersion = "cred-v2";
    mocks.stored.apiKey = "acs_key";
    mocks.stored.credentialVersion = "cred-v3";
    release(respond(200, { version: "3.0", match: false }));
    await expect(check).resolves.toBeNull();
    expect(mocks.recordServerVersionCheck).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith(
      { expected: SERVERNZ_EXPECTED_SERVER_VERSION, serverVersion: "3.0" },
      expect.stringMatching(/connection changed/),
    );
  });

  it("drops a late answer after the server address moved, even with the same credential row (#4366)", async () => {
    const release = deferredResponse();
    const check = refreshStoredServerVersion();
    await untilSent();
    mocks.stored.baseUrl = "https://replacement.test";
    release(respond(200, { version: "3.0", match: false }));
    await expect(check).resolves.toBeNull();
    expect(mocks.recordServerVersionCheck).not.toHaveBeenCalled();
  });

  it("drops a late answer after the address moved and key A was entered again for it (#4366)", async () => {
    const release = deferredResponse();
    const check = refreshStoredServerVersion();
    await untilSent();
    // A new address removes the key; the admin then saves A for the new server.
    mocks.stored.baseUrl = "https://replacement.test";
    mocks.stored.apiKey = undefined;
    mocks.stored.credentialVersion = null;
    mocks.stored.apiKey = "acs_key";
    mocks.stored.credentialVersion = "cred-v2";
    release(respond(200, { version: "3.0", match: false }));
    await expect(check).resolves.toBeNull();
    expect(mocks.recordServerVersionCheck).not.toHaveBeenCalled();
  });

  it("records a current answer, comparing only after the settings row is locked (#4366)", async () => {
    fetchMock.mockResolvedValue(respond(200, { version: "3.0", match: false }));
    await expect(refreshStoredServerVersion()).resolves.toBe("3.0");
    expectRecorded("3.0");
    expect(mocks.order[0]).toBe("lock");
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 150_000, maxWait: 10_000 });
    expect(mocks.order).toEqual(["lock", "lock", "read address", "read credential version"]);
    // ...and the gate then enforces it: nothing else reaches the server.
    settings("3.0");
    fetchMock.mockClear();
    await expect(uploadOtherLodges([])).rejects.toBeInstanceOf(ServerNzVersionMismatchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rethrows not-configured quietly: no 'could not check' warning for a key without an address (item 9)", async () => {
    mocks.loadServerNzSettings.mockResolvedValue({ baseUrl: null, serverVersion: null, serverVersionCheckedAt: null });
    await expect(refreshStoredServerVersion()).rejects.toBeInstanceOf(ServerNzNotConfiguredError);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs only the two numbers on a mismatch (INV-INT-005)", async () => {
    fetchMock.mockResolvedValue(respond(200, { version: "2.7", match: false }));
    await refreshStoredServerVersion();
    const [fields] = mocks.logger.info.mock.calls[0];
    expect(fields).toEqual({ expected: SERVERNZ_EXPECTED_SERVER_VERSION, serverVersion: "2.7" });
  });
});

describe("a never-asked row self-heals with ONE inline check (default 1)", () => {
  it("asks the version first, records it, then sends the real request when it matches", async () => {
    settings(null);
    fetchMock
      .mockResolvedValueOnce(respond(200, { version: SERVERNZ_EXPECTED_SERVER_VERSION, match: true }))
      .mockResolvedValueOnce(respond(200, { url: "https://club.test/hook", secretVersion: 1, secret: "s".repeat(40) }));

    const registered = await registerPushTarget("https://club.test/hook");

    // #4470: the identity it was sent on comes back, for the fenced secret write.
    expect(registered.sentOn).toEqual({ baseUrl: "https://central.test", credentialVersion: expect.any(String) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://central.test/api/v1/version");
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://central.test/api/v1/push-target");
    expectRecorded(SERVERNZ_EXPECTED_SERVER_VERSION);
  });

  it("refuses the real request when the inline answer differs, having sent only the version call", async () => {
    settings(null);
    fetchMock.mockResolvedValueOnce(respond(200, { version: "3.0", match: false }));

    await expect(uploadOtherLodges([])).rejects.toBeInstanceOf(ServerNzVersionMismatchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectRecorded("3.0");
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

  it("re-resolves a stale cached credential and never sends a gated request after mismatching inline answers", async () => {
    settings(null);
    mocks.stored.credentialVersion = "cred-v2";
    mocks.getOperationalServerNzCredential.mockResolvedValueOnce({ apiKey: "stale-key-a", version: "cred-v1" });
    fetchMock.mockImplementation(async () => respond(200, { version: "3.0", match: false }));

    await expect(uploadOtherLodges([])).rejects.toBeInstanceOf(ServerNzVersionMismatchError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/api/v1/version"))).toBe(true);
    expect(mocks.getOperationalServerNzCredential).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateProviderCredentialCache).toHaveBeenCalledTimes(1);
    expect(mocks.recordServerVersionCheck).toHaveBeenCalledTimes(1);
    expectRecorded("3.0");
  });

  it("returns 503 without another HTTP call when a dropped inline answer follows a base URL change", async () => {
    settings(null);
    const release = deferredResponse();
    const pending = pullOtherLodges(null);
    const rejected = expect(pending).rejects.toMatchObject({ name: "ServerNzApiError", status: 503 });
    await untilSent();

    mocks.stored.baseUrl = "https://replacement.test";
    release(respond(200, { version: SERVERNZ_EXPECTED_SERVER_VERSION, match: true }));

    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://central.test/api/v1/version");
    expect(mocks.stored.apiKey).toBe("acs_key");
    expect(mocks.recordServerVersionCheck).not.toHaveBeenCalled();
  });

  it("re-runs the gate exactly once with the current key at the same base URL before sending a gated request", async () => {
    settings(null);
    mocks.stored.credentialVersion = "cred-v2";
    mocks.getOperationalServerNzCredential.mockResolvedValueOnce({ apiKey: "stale-key-a", version: "cred-v1" });
    fetchMock
      .mockResolvedValueOnce(respond(200, { version: "3.0", match: false }))
      .mockResolvedValueOnce(respond(200, { version: SERVERNZ_EXPECTED_SERVER_VERSION, match: true }))
      .mockResolvedValueOnce(respond(200, { lodges: [], cursor: null, count: 0 }));

    await expect(pullOtherLodges(null)).resolves.toMatchObject({ count: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/v1/version"))).toHaveLength(2);
    expect(fetchMock.mock.calls.every(([url]) => new URL(String(url)).origin === "https://central.test")).toBe(true);
    expect(mocks.getOperationalServerNzCredential).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer stale-key-a");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer acs_key");
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe("Bearer acs_key");
    expectRecorded(SERVERNZ_EXPECTED_SERVER_VERSION);
  });

  it("throws a retryable error after a second dropped inline answer, without sending a gated request", async () => {
    settings(null);
    mocks.readServerNzCredentialVersion.mockResolvedValueOnce("cred-v2").mockResolvedValueOnce("cred-v3");
    fetchMock.mockImplementation(async () => respond(200, { version: "3.0", match: false }));

    await expect(uploadOtherLodges([])).rejects.toMatchObject({ name: "ServerNzApiError", status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/api/v1/version"))).toBe(true);
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


describe("request connection fence (#4436)", () => {
  it("reads both halves through the transaction client before any HTTP", async () => {
    fetchMock.mockImplementation(async () => {
      expect(mocks.loadServerNzSettings).toHaveBeenCalledWith(mocks.tx);
      expect(mocks.getOperationalServerNzCredential).toHaveBeenCalledWith(mocks.tx);
      expect(mocks.order[0]).toBe("lock");
      return respond(200, { lodges: [], cursor: null, count: 0 });
    });
    await pullOtherLodges();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
