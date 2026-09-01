import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import { _testStore, rateLimiters } from "../rate-limit";
import {
  HUT_LEADER_PIN_SESSION_COOKIE,
  createLodgePinSessionWithVersion,
  getActiveLodgePinSessionForDate,
  renewLodgePinSession,
} from "../lodge-pin-session";
import {
  HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS,
  HUT_LEADER_PIN_SESSION_IDLE_MINUTES,
  HUT_LEADER_PIN_SESSION_IDLE_SECONDS,
} from "../lodge-pin-session-timing";

/**
 * #3228 — A HUT LEADER'S PIN MUST NOT LEAVE A SHARED SCREEN PRIVILEGED ALL DAY.
 *
 * A lodge wall tablet signs in as the lodge's own kiosk account and is an
 * ordinary viewer. A hut leader types their PIN on that same shared screen to
 * mark attendance or edit the roster. The cookie that grants it used to carry a
 * TWELVE-HOUR deadline and nothing in the tree could end it early, so one PIN
 * entry made the screen a hut leader's screen for the rest of the day, to
 * whoever walked up to it.
 *
 * It is now ten minutes of INACTIVITY, plus a Lock control. This file is the
 * server half of that, and its two load-bearing cases are:
 *
 *  (a) BACKGROUND TRAFFIC DOES NOT EXTEND THE SESSION. The kiosk refreshes
 *      itself every two minutes to keep the roster current. If any request
 *      slid the deadline forward, a tablet sitting alone on a bench would keep
 *      itself privileged indefinitely — the exact situation being closed. So
 *      the auth path is driven for half an hour here and the session still
 *      expires, and the census at the bottom proves no route other than the one
 *      renewal endpoint can write this cookie at all.
 *
 *  (b) THE DEADLINE IS THE SERVER'S. It lives inside the HMAC-signed payload,
 *      so a client that keeps an old cookie, edits one, or simply stops asking
 *      cannot hold the window open; and renewal mints a NEW cookie from the
 *      server's clock rather than accepting a claim about elapsed time.
 */

const CLUB_DAY = new Date("2026-04-13T00:00:00.000Z");
const IDLE_MS = HUT_LEADER_PIN_SESSION_IDLE_SECONDS * 1000;

const { mockPrisma, mockAuth } = vi.hoisted(() => ({
  mockPrisma: {
    hutLeaderAssignment: { findUnique: vi.fn(), findMany: vi.fn() },
    member: { findUnique: vi.fn() },
    booking: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    memberLodgeAccess: { findMany: vi.fn() },
    lodge: { findFirst: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    auditLog: { create: vi.fn() },
  },
  mockAuth: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
}));
// The club's own day, supplied rather than resolved: `INV-CONFIG-002` is not
// what this file is about, and `lodge-auth` reads it on every call.
vi.mock("@/lib/club-time/server", () => ({
  clubTodayDateOnlyInstant: async () => CLUB_DAY,
  clubTimeZone: async () => "Pacific/Auckland",
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const LODGE_ACCOUNT_ID = "lodge-1";
const ASSIGNMENT_ID = "assign-1";
const HUT_LEADER_ID = "member-1";

let pinHash = "";

function signedInAsKioskAccount(id = LODGE_ACCOUNT_ID) {
  mockAuth.mockResolvedValue({
    user: {
      id,
      role: "LODGE",
      accessRoles: [{ role: "LODGE" }],
      email: `${id}@example.org`,
    },
  });
  mockPrisma.member.findUnique.mockResolvedValue({
    id,
    accessRoles: [{ role: "LODGE" }],
  });
}

function assignmentCoversTheClubDay(hash = pinHash) {
  mockPrisma.hutLeaderAssignment.findUnique.mockResolvedValue({
    id: ASSIGNMENT_ID,
    memberId: HUT_LEADER_ID,
    lodgeId: "default-lodge",
    startDate: new Date("2026-04-13T00:00:00.000Z"),
    endDate: new Date("2026-04-16T00:00:00.000Z"),
    hutLeaderPin: hash,
    member: {
      id: HUT_LEADER_ID,
      active: true,
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
    },
  });
}

/** A PIN session as `pin-login` mints one. */
function issueSession(sessionUserId = LODGE_ACCOUNT_ID) {
  return createLodgePinSessionWithVersion(
    ASSIGNMENT_ID,
    HUT_LEADER_ID,
    pinHash,
    sessionUserId
  );
}

function requestWithCookie(value: string | null, url = "http://localhost/api/lodge/access") {
  return new Request(url, {
    headers: {
      "x-forwarded-for": "10.0.0.7",
      ...(value ? { cookie: `${HUT_LEADER_PIN_SESSION_COOKIE}=${value}` } : {}),
    },
  });
}

/** Move the frozen clock forward by `ms` from the default frozen instant. */
function atFrozenPlus(ms: number) {
  vi.setSystemTime(new Date(frozenTestNow().getTime() + ms));
}

/** The PIN-session cookie a response sets, if any. */
function pinCookieFrom(res: Response): string | null {
  const header = res.headers.get("set-cookie");
  if (!header) return null;
  return header.includes(`${HUT_LEADER_PIN_SESSION_COOKIE}=`) ? header : null;
}

async function tierFor(cookieValue: string | null) {
  const { checkLodgeAuth } = await import("@/lib/lodge-auth");
  const result = await checkLodgeAuth(undefined, {
    request: requestWithCookie(cookieValue),
  });
  return result.tier;
}

beforeEach(async () => {
  vi.clearAllMocks();
  _testStore.clear();
  // The default frozen instant, restored by hand: the root re-freeze only ever
  // converts a REAL clock back to a frozen one, so a case that moved the clock
  // would otherwise leave the next case wherever it stopped.
  vi.setSystemTime(frozenTestNow());
  process.env.AUTH_SECRET = "test-auth-secret";
  process.env.NEXTAUTH_SECRET = "test-auth-secret";
  pinHash = await bcrypt.hash("123456", 4);
  signedInAsKioskAccount();
  assignmentCoversTheClubDay();
  mockPrisma.memberLodgeAccess.findMany.mockResolvedValue([]);
  mockPrisma.lodge.findFirst.mockResolvedValue({ id: "default-lodge" });
  mockPrisma.lodge.count.mockResolvedValue(1);
  mockPrisma.lodge.findUnique.mockResolvedValue({
    id: "default-lodge",
    active: true,
    name: "Default Lodge",
  });
  mockPrisma.booking.count.mockResolvedValue(0);
  mockPrisma.booking.findMany.mockResolvedValue([]);
  mockPrisma.hutLeaderAssignment.findMany.mockResolvedValue([]);
});

describe("hut-leader PIN session: the ten-minute idle window (#3228)", () => {
  it("mints a session that lives for the idle window, not for a shift", () => {
    const session = issueSession();

    expect(session.maxAge).toBe(HUT_LEADER_PIN_SESSION_IDLE_SECONDS);
    expect(HUT_LEADER_PIN_SESSION_IDLE_SECONDS).toBe(600);
    expect(session.expiresAt.getTime() - frozenTestNow().getTime()).toBe(IDLE_MS);
    // The number the kiosk puts on screen is derived from the same constant, so
    // the copy cannot promise a window the server does not enforce.
    expect(HUT_LEADER_PIN_SESSION_IDLE_MINUTES).toBe(10);
  });

  it("keeps the session one second before the window closes and drops it one second after", async () => {
    const session = issueSession();

    atFrozenPlus(IDLE_MS - 1000);
    await expect(
      getActiveLodgePinSessionForDate(CLUB_DAY, session.value, LODGE_ACCOUNT_ID)
    ).resolves.toMatchObject({ assignmentId: ASSIGNMENT_ID });

    atFrozenPlus(IDLE_MS + 1000);
    await expect(
      getActiveLodgePinSessionForDate(CLUB_DAY, session.value, LODGE_ACCOUNT_ID)
    ).resolves.toBeNull();
  });

  it("falls back to the ordinary lodge tier once the window has closed, never up", async () => {
    const session = issueSession();

    expect(await tierFor(session.value)).toBe("hut-leader");

    atFrozenPlus(IDLE_MS + 1000);
    expect(await tierFor(session.value)).toBe("lodge");
  });

  it("drops to the ordinary tier on an unparseable or tampered cookie", async () => {
    const session = issueSession();
    const [payload] = session.value.split(".");

    expect(await tierFor("not-a-session")).toBe("lodge");
    expect(await tierFor(`${payload}.forged-signature`)).toBe("lodge");
    // A payload re-encoded with a deadline of its own, unsigned: the client
    // does not get to choose the deadline.
    const forged = Buffer.from(
      JSON.stringify({
        assignmentId: ASSIGNMENT_ID,
        memberId: HUT_LEADER_ID,
        exp: Math.floor((frozenTestNow().getTime() + 12 * 60 * 60 * 1000) / 1000),
      }),
      "utf8"
    ).toString("base64url");
    expect(await tierFor(`${forged}.${payload}`)).toBe("lodge");
  });
});

describe("hut-leader PIN session: background traffic does not extend it (#3228)", () => {
  it("expires after half an hour of nothing but the kiosk's own polling", async () => {
    const session = issueSession();
    const { GET } = await import("@/app/api/lodge/access/route");
    const { NextRequest } = await import("next/server");

    // The kiosk refreshes every two minutes. Fifteen refreshes is half an hour
    // — three times the idle window — with nobody in the room.
    const pinCookies: string[] = [];
    for (let refresh = 0; refresh < 15; refresh += 1) {
      atFrozenPlus(refresh * 120_000);
      const res = await GET(
        new NextRequest(
          "http://localhost/api/lodge/access?date=2026-04-13",
          { headers: { cookie: `${HUT_LEADER_PIN_SESSION_COOKIE}=${session.value}` } }
        )
      );
      expect(res.status).toBe(200);
      const cookie = pinCookieFrom(res);
      if (cookie) pinCookies.push(`refresh ${refresh}: ${cookie}`);
    }

    // NOT ONE of those responses re-issued the session. This is the assertion
    // the whole fix rests on: renewal happens on human interaction, and a data
    // refresh is not one.
    expect(pinCookies).toEqual([]);

    // And the session really is over, not merely un-renewed.
    atFrozenPlus(15 * 120_000);
    expect(await tierFor(session.value)).toBe("lodge");
    await expect(
      getActiveLodgePinSessionForDate(CLUB_DAY, session.value, LODGE_ACCOUNT_ID)
    ).resolves.toBeNull();
  });

  it("serves an access payload with nothing privileged in it once the window has closed", async () => {
    const session = issueSession();
    const { GET } = await import("@/app/api/lodge/access/route");
    const { NextRequest } = await import("next/server");

    const ask = async () =>
      GET(
        new NextRequest("http://localhost/api/lodge/access?date=2026-04-13", {
          headers: {
            cookie: `${HUT_LEADER_PIN_SESSION_COOKIE}=${session.value}`,
          },
        })
      );

    const unlocked = await (await ask()).json();
    expect(unlocked).toMatchObject({
      tier: "hut-leader",
      pinSessionActive: true,
      canManageRoster: true,
    });

    atFrozenPlus(IDLE_MS + 1000);
    const locked = await (await ask()).json();

    // Asserted on the SERIALIZED body, not on a field at a time: this is a
    // Next.js application, and anything that reaches a client component is
    // readable in the browser whether it is rendered or not. So the privileged
    // answers must be ABSENT from the bytes, not merely false somewhere in them.
    const body = JSON.stringify(locked);
    expect(locked.tier).toBe("lodge");
    expect(body).not.toContain("hut-leader");
    expect(body).not.toContain("pinSessionActive");
    expect(locked.canManageRoster).toBe(false);
    // The hut leader's assignment window is theirs, and it goes with the
    // session: an unlocked device reveals which nights that leader covers.
    expect(locked.dateRange).toBeNull();
    expect(body).not.toContain("2026-04-16");
  });

  it("still expires when the auth path itself is driven every minute", async () => {
    const session = issueSession();

    // Every polled lodge route calls `checkLodgeAuth`. Calling it thirty times
    // across half an hour must not be a way to stay privileged.
    for (let minute = 0; minute <= 30; minute += 1) {
      atFrozenPlus(minute * 60_000);
      const tier = await tierFor(session.value);
      expect(tier).toBe(minute * 60_000 < IDLE_MS ? "hut-leader" : "lodge");
    }
  });
});

describe("hut-leader PIN session: renewal is the server's decision (#3228)", () => {
  it("slides the window forward when a person interacts, and the old cookie dies with it", async () => {
    const session = issueSession();
    const { POST } = await import("@/app/api/lodge/pin-session/route");
    const { NextRequest } = await import("next/server");

    // Nine minutes in — still live, and somebody taps the screen.
    atFrozenPlus(9 * 60_000);
    const res = await POST(
      new NextRequest("http://localhost/api/lodge/pin-session", {
        method: "POST",
        headers: {
          "x-forwarded-for": "10.0.0.7",
          cookie: `${HUT_LEADER_PIN_SESSION_COOKIE}=${session.value}`,
        },
      })
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ renewed: true });
    const header = pinCookieFrom(res);
    expect(header).toBeTruthy();
    // The cookie itself must stay unreadable to page scripts and scoped to the
    // whole app, or a renewal quietly weakens what sign-in set up.
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Path=/");
    expect(header).toMatch(/SameSite=[Ll]ax/);

    const renewedValue = decodeURIComponent(
      /tac_hut_leader_pin_session=([^;]+)/.exec(header as string)?.[1] ?? ""
    );
    expect(renewedValue).not.toBe(session.value);

    // Eighteen minutes after sign-in: well past the original deadline, well
    // inside the renewed one.
    atFrozenPlus(18 * 60_000);
    expect(await tierFor(renewedValue)).toBe("hut-leader");
    expect(await tierFor(session.value)).toBe("lodge");
  });

  it("keeps a busy hut leader signed in indefinitely", async () => {
    let current = issueSession().value;

    // Six hours of somebody using the kiosk, renewing once a minute the way the
    // page's throttle does. Nobody is interrupted mid-roster.
    for (let minute = 1; minute <= 360; minute += 1) {
      atFrozenPlus(minute * 60_000);
      const renewed = renewLodgePinSession(current);
      expect(renewed, `minute ${minute}`).not.toBeNull();
      current = (renewed as NonNullable<typeof renewed>).value;
    }

    atFrozenPlus(360 * 60_000);
    expect(await tierFor(current)).toBe("hut-leader");
  });

  it("cannot bring an expired session back: the PIN is the only way in", async () => {
    const session = issueSession();
    const { POST } = await import("@/app/api/lodge/pin-session/route");
    const { NextRequest } = await import("next/server");

    atFrozenPlus(IDLE_MS + 1000);

    expect(renewLodgePinSession(session.value)).toBeNull();

    const res = await POST(
      new NextRequest("http://localhost/api/lodge/pin-session", {
        method: "POST",
        headers: {
          "x-forwarded-for": "10.0.0.8",
          cookie: `${HUT_LEADER_PIN_SESSION_COOKIE}=${session.value}`,
        },
      })
    );

    expect(res.status).toBe(403);
    expect(pinCookieFrom(res)).toBeNull();
    expect(await tierFor(session.value)).toBe("lodge");
  });

  it("refuses to renew for a device with no PIN session at all", async () => {
    const { POST } = await import("@/app/api/lodge/pin-session/route");
    const { NextRequest } = await import("next/server");

    const res = await POST(
      new NextRequest("http://localhost/api/lodge/pin-session", {
        method: "POST",
        headers: { "x-forwarded-for": "10.0.0.9" },
      })
    );

    expect(res.status).toBe(403);
    expect(pinCookieFrom(res)).toBeNull();
  });

  it("refuses to renew for an unauthenticated caller", async () => {
    const session = issueSession();
    mockAuth.mockResolvedValue(null);
    const { POST } = await import("@/app/api/lodge/pin-session/route");
    const { NextRequest } = await import("next/server");

    const res = await POST(
      new NextRequest("http://localhost/api/lodge/pin-session", {
        method: "POST",
        headers: {
          "x-forwarded-for": "10.0.0.10",
          cookie: `${HUT_LEADER_PIN_SESSION_COOKIE}=${session.value}`,
        },
      })
    );

    expect(res.status).toBe(401);
    expect(pinCookieFrom(res)).toBeNull();
  });

  it("bounds a renewal storm, and a refusal shortens nothing", async () => {
    const session = issueSession();
    const { POST } = await import("@/app/api/lodge/pin-session/route");
    const { NextRequest } = await import("next/server");

    const renew = (ip: string) =>
      POST(
        new NextRequest("http://localhost/api/lodge/pin-session", {
          method: "POST",
          headers: {
            "x-forwarded-for": ip,
            cookie: `${HUT_LEADER_PIN_SESSION_COOKIE}=${session.value}`,
          },
        })
      );

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 62; attempt += 1) {
      statuses.push((await renew("10.0.0.20")).status);
    }

    // The kiosk sends one a minute, so sixty in one minute is already far past
    // anything a device does.
    expect(statuses.filter((status) => status === 200)).toHaveLength(
      rateLimiters.lodgePinSession.limit
    );
    expect(statuses.at(-1)).toBe(429);

    // Keyed on the ACCOUNT, so moving address does not buy a fresh budget...
    expect((await renew("203.0.113.9")).status).toBe(429);
    // ...and a refusal never ends the session it was asked to extend. A hut
    // leader loses at most the rest of the current window, and the next tap
    // renews.
    expect(await tierFor(session.value)).toBe("hut-leader");
  });

  it("changes the deadline and nothing else about who the session is", async () => {
    const session = issueSession();
    atFrozenPlus(60_000);
    const renewed = renewLodgePinSession(session.value);
    expect(renewed).not.toBeNull();
    const renewedValue = (renewed as NonNullable<typeof renewed>).value;

    // Still the same assignment and member...
    await expect(
      getActiveLodgePinSessionForDate(CLUB_DAY, renewedValue, LODGE_ACCOUNT_ID)
    ).resolves.toMatchObject({
      assignmentId: ASSIGNMENT_ID,
      memberId: HUT_LEADER_ID,
    });

    // ...still bound to the account it was issued to, so a renewal is not a way
    // to move a PIN session onto another kiosk account.
    signedInAsKioskAccount("lodge-2");
    expect(await tierFor(renewedValue)).toBe("lodge");

    // ...and still dead the moment the PIN is reset, renewed or not.
    signedInAsKioskAccount();
    assignmentCoversTheClubDay(await bcrypt.hash("999999", 4));
    expect(await tierFor(renewedValue)).toBe("lodge");
  });
});

describe("hut-leader PIN session: the Lock control (#3228)", () => {
  it("clears the cookie immediately, with the same name, path and attributes", async () => {
    const session = issueSession();
    const { DELETE } = await import("@/app/api/lodge/pin-session/route");
    const { NextRequest } = await import("next/server");

    const res = await DELETE(
      new NextRequest("http://localhost/api/lodge/pin-session", {
        method: "DELETE",
        headers: {
          "x-forwarded-for": "10.0.0.11",
          cookie: `${HUT_LEADER_PIN_SESSION_COOKIE}=${session.value}`,
        },
      })
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ locked: true });

    const header = pinCookieFrom(res);
    expect(header).toBeTruthy();
    // A clearing cookie that differs in name, path or attributes leaves the
    // real one in place, and a Lock button that silently does nothing is worse
    // than none at all.
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("Path=/");
    expect(header).toContain("HttpOnly");
    expect(header).toContain(`${HUT_LEADER_PIN_SESSION_COOKIE}=;`);

    // What the browser is left holding grants nothing.
    expect(await tierFor("")).toBe("lodge");
  });

  it("succeeds when there is nothing to lock, so it can never fail open", async () => {
    const { DELETE } = await import("@/app/api/lodge/pin-session/route");
    const { NextRequest } = await import("next/server");
    mockAuth.mockResolvedValue(null);

    const res = await DELETE(
      new NextRequest("http://localhost/api/lodge/pin-session", {
        method: "DELETE",
        headers: { "x-forwarded-for": "10.0.0.12" },
      })
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ locked: true });
    expect(pinCookieFrom(res)).toContain("Max-Age=0");
  });
});

/*
  THE CENSUS. The behaviour above proves the polled routes do not renew today;
  this proves they CANNOT, because the ability to write this cookie exists in
  exactly three places. That is the difference between a fix and a fix somebody
  can undo by copying a pattern from the next file along.

  It reads the tree from disk, so `npm run test:related` cannot select it from a
  diff — which is exactly why the sites it names are also asserted behaviourally
  above.
*/
const SRC = path.resolve(process.cwd(), "src");

function everySourceFile(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : everySourceFile(full);
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (/\.test\.tsx?$/.test(entry.name)) return [];
    return statSync(full).isFile() ? [full] : [];
  });
}

function relative(file: string) {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

describe("hut-leader PIN session: only one place can extend it (#3228)", () => {
  const files = everySourceFile(SRC).map((file) => ({
    file: relative(file),
    contents: readFileSync(file, "utf8"),
  }));

  it("actually scanned the tree, so a broken walk cannot read as a clean census", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.map((f) => f.file)).toContain(
      "src/app/api/lodge/pin-session/route.ts"
    );
  });

  it("lets only the sign-in and pin-session routes write the session cookie", () => {
    const writers = files
      .filter(({ contents }) =>
        /\b(setLodgePinSessionCookie|clearLodgePinSessionCookie)\s*\(/.test(
          contents
        )
      )
      .map(({ file }) => file)
      .sort();

    expect(writers).toEqual([
      "src/app/api/lodge/pin-login/route.ts",
      "src/app/api/lodge/pin-session/route.ts",
      // The definitions themselves.
      "src/lib/lodge-pin-session.ts",
    ]);
  });

  it("lets only the pin-session route slide the deadline forward", () => {
    const renewers = files
      .filter(({ contents }) => /\brenewLodgePinSession\w*\s*\(/.test(contents))
      .map(({ file }) => file)
      .sort();

    expect(renewers).toEqual([
      "src/app/api/lodge/pin-session/route.ts",
      "src/lib/lodge-pin-session.ts",
    ]);
  });

  it("keeps the renewal interval far smaller than the window it renews", () => {
    // A renewal interval anywhere near the window would log a working hut
    // leader out; one larger than it could never renew at all.
    expect(HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS * 4).toBeLessThanOrEqual(
      IDLE_MS
    );
    expect(HUT_LEADER_PIN_INTERACTION_RENEW_INTERVAL_MS).toBeGreaterThan(0);
  });

  it("keeps the timing module free of imports, so a browser bundle can hold it", () => {
    const contents = readFileSync(
      path.join(SRC, "lib/lodge-pin-session-timing.ts"),
      "utf8"
    );
    expect(contents).not.toMatch(/^\s*import\s/m);
  });
});
