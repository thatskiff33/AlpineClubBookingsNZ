import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #4610 (INV-AUTH-006): the shared breached-password screen. The range service
// is always a stub here: tests never reach the real one.

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { loginSecuritySetting: { findUnique: mocks.findUnique } },
}));
vi.mock("@/lib/logger", () => ({
  default: { warn: mocks.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  BREACHED_PASSWORD_CODE,
  BREACHED_PASSWORD_MESSAGE,
  BREACHED_PASSWORD_RANGE_URL,
  BREACHED_PASSWORD_TIMEOUT_MS,
  lookupBreachedPassword,
  screenChosenPassword,
} from "@/lib/breached-password";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import {
  sha1Upper,
  stubBreachedPasswordService,
} from "@/lib/__tests__/helpers/breached-password-service";
import {
  SEED_PASSWORD_SCREEN_POLICY,
  seedPasswordBreachedMessage,
} from "../../../prisma/seed-data";
import { readFileSync } from "node:fs";
import path from "node:path";

const BREACHED = "Password1234";
const CLEAN = "a quiet ridge at first light 4610";

beforeEach(() => {
  mocks.findUnique.mockReset();
  mocks.warn.mockReset();
  // An absent row: the code default, which has the check on.
  mocks.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("screenChosenPassword", () => {
  it("refuses a password the service lists, with a plain message", async () => {
    stubBreachedPasswordService([BREACHED]);
    await expect(screenChosenPassword(BREACHED)).resolves.toEqual({
      ok: false,
      error: BREACHED_PASSWORD_MESSAGE,
      code: BREACHED_PASSWORD_CODE,
    });
  });

  it("accepts a password the service does not list", async () => {
    const fetchMock = stubBreachedPasswordService([BREACHED]);
    await expect(screenChosenPassword(CLEAN)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a zero-count (padding) line for the suffix as not listed", async () => {
    const hash = sha1Upper(CLEAN);
    const fetchMock = vi.fn(async () =>
      new Response(`${hash.slice(5)}:0\r\n${"A".repeat(35)}:3`, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(lookupBreachedPassword(CLEAN)).resolves.toBe("not_breached");
  });

  it("makes no request at all when the club has switched the check off", async () => {
    const fetchMock = stubBreachedPasswordService([BREACHED]);
    await expect(
      screenChosenPassword(BREACHED, { breachedPasswordCheck: false }),
    ).resolves.toEqual({ ok: true });

    mocks.findUnique.mockResolvedValue({ breachedPasswordCheck: false });
    await expect(screenChosenPassword(BREACHED)).resolves.toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the club setting when the caller passes no policy (absent row = on)", async () => {
    const fetchMock = stubBreachedPasswordService([BREACHED]);
    await expect(screenChosenPassword(BREACHED)).resolves.toMatchObject({ ok: false });
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("what leaves the server", () => {
  it("sends only the 5-character uppercase SHA-1 prefix: no password, no full hash, no body", async () => {
    const fetchMock = stubBreachedPasswordService([]);
    await screenChosenPassword(BREACHED, { breachedPasswordCheck: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0];
    const url = String(input);
    const hash = sha1Upper(BREACHED);
    expect(url).toBe(`${BREACHED_PASSWORD_RANGE_URL}${hash.slice(0, 5)}`);
    const sent = url.slice(BREACHED_PASSWORD_RANGE_URL.length);
    expect(sent).toMatch(/^[0-9A-F]{5}$/);
    expect(url).not.toContain(BREACHED);
    expect(url.toUpperCase()).not.toContain(hash.slice(5));
    expect(url.toLowerCase()).not.toContain(hash.toLowerCase());

    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    // The only header is the padding request; nothing names the member or club.
    expect(init?.headers).toEqual({ "Add-Padding": "true" });
    const serialisedInit = JSON.stringify({ ...init, signal: undefined });
    expect(serialisedInit).not.toContain(BREACHED);
    expect(serialisedInit.toUpperCase()).not.toContain(hash.slice(5));
  });
});

describe("fails open", () => {
  afterEach(() => {
    // Hand the timers back; the root beforeEach re-freezes Date for the next test.
    vi.useRealTimers();
  });

  it("accepts the password after the 3-second timeout, and logs without the prefix", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(frozenTestNow());
    let aborted = false;
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    let settled: unknown = "pending";
    const pending = screenChosenPassword(BREACHED, { breachedPasswordCheck: true }).then(
      (result) => {
        settled = result;
        return result;
      },
    );

    await vi.advanceTimersByTimeAsync(BREACHED_PASSWORD_TIMEOUT_MS - 1);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(aborted).toBe(true);

    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const [fields] = mocks.warn.mock.calls[0];
    expect(fields).toEqual({ reason: "timeout" });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(sha1Upper(BREACHED).slice(0, 5));
  });

  it("still fails open when the fetch ignores the abort signal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(frozenTestNow());
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));

    const pending = lookupBreachedPassword(BREACHED);
    await vi.advanceTimersByTimeAsync(BREACHED_PASSWORD_TIMEOUT_MS);
    await expect(pending).resolves.toBe("unavailable");
  });

  it("accepts the password on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`fetch failed for ${BREACHED_PASSWORD_RANGE_URL}${sha1Upper(BREACHED).slice(0, 5)}`);
      }),
    );
    await expect(
      screenChosenPassword(BREACHED, { breachedPasswordCheck: true }),
    ).resolves.toEqual({ ok: true });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0][0]).toEqual({ reason: "network_error" });
    // The raw error (which here carries the prefix in its message) is never logged.
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(sha1Upper(BREACHED).slice(0, 5));
  });

  it("accepts the password on an HTTP error status, logging only the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 })));
    await expect(lookupBreachedPassword(BREACHED)).resolves.toBe("unavailable");
    expect(mocks.warn.mock.calls[0][0]).toEqual({ reason: "http_status", status: 503 });
  });

  it("accepts the password on a malformed or empty answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>oops</html>", { status: 200 })));
    await expect(lookupBreachedPassword(BREACHED)).resolves.toBe("unavailable");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    await expect(lookupBreachedPassword(BREACHED)).resolves.toBe("unavailable");
    expect(mocks.warn.mock.calls.map(([fields]) => fields)).toEqual([
      { reason: "malformed" },
      { reason: "malformed" },
    ]);
  });
});

// prisma/seed.ts stores SEED_ADMIN_PASSWORD and SEED_LODGE_PASSWORD, which an
// operator chose, so it screens them with the same helper before hashing.
describe("the seed screens its operator-chosen passwords", () => {
  const seedSource = readFileSync(path.resolve(__dirname, "../../../prisma/seed.ts"), "utf8");

  it("stops on a listed password, naming the variable, without reading the club setting", async () => {
    stubBreachedPasswordService([BREACHED]);
    await expect(screenChosenPassword(BREACHED, SEED_PASSWORD_SCREEN_POLICY)).resolves.toMatchObject({ ok: false });
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(seedPasswordBreachedMessage("SEED_LODGE_PASSWORD")).toMatch(/^SEED_LODGE_PASSWORD has appeared in a public data breach/);
  });

  it("accepts a clean password, and fails open when the service is unreachable", async () => {
    stubBreachedPasswordService([BREACHED]);
    await expect(screenChosenPassword(CLEAN, SEED_PASSWORD_SCREEN_POLICY)).resolves.toEqual({ ok: true });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(screenChosenPassword(BREACHED, SEED_PASSWORD_SCREEN_POLICY)).resolves.toEqual({ ok: true });
  });

  // #4740 review: both are screened before the seed's first write, so a
  // breached second password cannot leave the first account half-seeded.
  const mainAt = seedSource.indexOf("async function main() {");
  const firstWriteAt = seedSource
    .slice(mainAt)
    .search(/await prisma\.\w+\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw/);

  it.each([
    ["SEED_ADMIN_PASSWORD", "seedAdminPassword", "adminScreen", "existingAdmin"],
    ["SEED_LODGE_PASSWORD", "lodgePassword", "lodgeScreen", "lodgePassword === null"],
  ])("screens %s before the first write, and throws on a refusal", (name, variable, screen, skipWhen) => {
    const screenAt = seedSource.indexOf(
      `const ${screen} = ${skipWhen}\n    ? { ok: true as const }\n    : await screenChosenPassword(${variable}, SEED_PASSWORD_SCREEN_POLICY);`,
    );
    const refuseAt = seedSource.indexOf(
      `if (!${screen}.ok) throw new Error(seedPasswordBreachedMessage("${name}"));`,
    );
    const hashAt = seedSource.indexOf(`await bcrypt.hash(${variable}, PASSWORD_BCRYPT_COST)`);
    expect(mainAt).toBeGreaterThan(-1);
    expect(firstWriteAt).toBeGreaterThan(0);
    expect(screenAt).toBeGreaterThan(mainAt);
    expect(refuseAt).toBeGreaterThan(screenAt);
    expect(refuseAt).toBeLessThan(mainAt + firstWriteAt);
    expect(hashAt).toBeGreaterThan(refuseAt);
  });

  it("reads and screens the kiosk password only when the kiosk account is missing", () => {
    expect(seedSource).toContain(
      'const lodgePassword = existingLodge ? null : requireSeedEnv("SEED_LODGE_PASSWORD");',
    );
    expect(seedSource.match(/requireSeedEnv\("SEED_LODGE_PASSWORD"\)/g)).toHaveLength(1);
  });
});
