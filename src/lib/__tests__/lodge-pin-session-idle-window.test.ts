import { createHmac } from "node:crypto";
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
  HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS,
} from "../lodge-pin-session-timing";
import { NO_STORE_HEADER_NAME, NO_STORE_HEADER_VALUE } from "../lodge-cache-headers";

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
  /*
    RETITLED DELIBERATELY. This case proves the old cookie EXPIRES on its own
    original schedule — it does not prove renewal invalidates it. Inside the
    window both values are valid at once, which is inherent to a stateless signed
    cookie and is what the absolute ceiling below exists to bound.
  */
  it("slides the window forward when a person interacts, and the old cookie still expires on its own original deadline", async () => {
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

/*
  A SIGNED PAYLOAD OF OUR OWN CHOOSING.

  The signing key is the auth secret this file sets, so the tests below can mint
  cookies the production code would never produce — a missing `iat`, a deadline
  of `Infinity` — and prove the reader refuses them. Anything arriving UNSIGNED is
  already refused by the signature check, so forging with the key is the only way
  to reach the payload validation at all.
*/
function signedCookie(payload: Record<string, unknown>): string {
  const part = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", process.env.AUTH_SECRET as string)
    .update(part)
    .digest("base64url");
  return `${part}.${signature}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * The two fields a forged payload needs for the TIER check to accept it.
 *
 * `decodePayload` does not look at either, so a case that only asserts refusal
 * can leave them out. A case asserting ACCEPTANCE cannot: the tier resolver
 * re-derives the PIN version from the live hash and the binding from the
 * signed-in account, and refuses a payload missing either. Derived here rather
 * than exported from the module under test, so a change to how they are derived
 * fails this file rather than being silently agreed with.
 */
function derivedPayloadFields(sessionUserId = LODGE_ACCOUNT_ID) {
  const secret = process.env.AUTH_SECRET as string;
  return {
    pinVersion: createHmac("sha256", secret).update(pinHash).digest("base64url"),
    sessionUserBinding: createHmac("sha256", secret)
      .update(`lodge-pin-session:${sessionUserId}`)
      .digest("base64url"),
  };
}

/** The fields a valid payload carries, so a case can vary exactly one of them. */
function validPayloadFields() {
  return {
    assignmentId: ASSIGNMENT_ID,
    memberId: HUT_LEADER_ID,
    exp: nowSeconds() + HUT_LEADER_PIN_SESSION_IDLE_SECONDS,
    iat: nowSeconds(),
  };
}

describe("hut-leader PIN session: the twelve-hour ceiling (#3228)", () => {
  /*
    WHY THE CEILING IS STILL HERE.

    The idle window is the control against an UNATTENDED tablet, and it is no
    control at all against a cookie somebody COPIED — a minute's work at the
    device, from the same devtools panel that holds the sign-in cookie. Renewal
    re-states the same authority with a later deadline and asks nothing else of
    the caller, so without a ceiling a thief renews it from their own laptop for
    as long as the assignment runs. Lock clears the cookie in the browser that
    asked and revokes nothing server-side, so a copy taken beforehand is
    untouched by it.

    Twelve hours from the PIN entry is exactly the deadline the idle window
    replaced, kept as a bound rather than dropped. It costs a genuine all-day
    shift one extra PIN entry, and it is the only bound the copied-cookie and
    injected-touch cases have at all.
  */
  it("cannot be renewed past twelve hours from the PIN entry, however busy the screen is", async () => {
    let current = issueSession().value;
    const minutes = HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS / 60;

    // Somebody using the kiosk once a minute, all day. Every renewal succeeds...
    let lastGoodMinute = 0;
    for (let minute = 1; minute <= minutes + 30; minute += 1) {
      atFrozenPlus(minute * 60_000);
      const renewed = renewLodgePinSession(current);
      if (renewed === null) break;
      current = renewed.value;
      lastGoodMinute = minute;
    }

    // ...until the ceiling, and not one minute past it.
    expect(lastGoodMinute).toBe(minutes - 1);
    atFrozenPlus(HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS * 1000);
    expect(renewLodgePinSession(current)).toBeNull();
    expect(await tierFor(current)).toBe("lodge");
  });

  it("clamps the cookie it issues to the ceiling, so `Max-Age` cannot outlast the session", () => {
    const signedInAt = nowSeconds();

    /*
      Five minutes short of the ceiling, holding a session that is still inside
      its idle window — which is what a hut leader who has been using the kiosk
      all day is holding. Forged rather than reached by renewing 719 times, so the
      case says what it is about; the sibling case above walks the whole day
      minute by minute and is the one that proves the ceiling itself.
    */
    atFrozenPlus((HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS - 300) * 1000);
    const nearCeiling = renewLodgePinSession(
      signedCookie({
        assignmentId: ASSIGNMENT_ID,
        memberId: HUT_LEADER_ID,
        iat: signedInAt,
        exp: nowSeconds() + HUT_LEADER_PIN_SESSION_IDLE_SECONDS,
      })
    );
    expect(nearCeiling).not.toBeNull();
    const clamped = nearCeiling as NonNullable<typeof nearCeiling>;

    expect(clamped.maxAge).toBeLessThanOrEqual(300);
    expect(clamped.expiresAt.getTime()).toBe(
      (signedInAt + HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS) * 1000
    );

    // ...and the control: an ordinary renewal well inside the ceiling still gets
    // a full window, so the clamp is not quietly shortening every session.
    atFrozenPlus(60_000);
    const ordinary = renewLodgePinSession(issueSession().value);
    expect((ordinary as NonNullable<typeof ordinary>).maxAge).toBe(
      HUT_LEADER_PIN_SESSION_IDLE_SECONDS
    );
  });

  it("refuses a session already past the ceiling even when its own deadline looks live", async () => {
    /*
      THE CASE THAT REACHES THE CEILING CHECK ITSELF, and it took a mutation probe
      to find that nothing did.

      Removing the ceiling comparison left every other case in this file green,
      because the clamp above already stops a NORMAL renewal chain: the last
      cookie issued carries `exp = iat + 12h`, so at the ceiling the ordinary
      `exp <= now` check refuses it. Redundancy is fine; an untested branch is
      not, and this one is the branch that holds when the clamp has not run —
      which is any cookie that did not come out of `renewLodgePinSession`.

      A second past the ceiling, with a deadline five minutes out. Only the
      ceiling comparison refuses this: `exp` is in the future, and it is inside
      the sanity bound (`iat + 12h + 10m`) as well.
    */
    const signedInAt = nowSeconds() - HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS - 1;
    const pastTheCeiling = signedCookie({
      assignmentId: ASSIGNMENT_ID,
      memberId: HUT_LEADER_ID,
      iat: signedInAt,
      exp: nowSeconds() + 300,
    });

    expect(await tierFor(pastTheCeiling)).toBe("lodge");
    expect(renewLodgePinSession(pastTheCeiling)).toBeNull();

    // ...and the control, one second the OTHER side of it: the same shape, still
    // inside twelve hours, is accepted. Without this the case above would pass
    // for a reader that refused everything.
    const insideTheCeiling = signedCookie({
      assignmentId: ASSIGNMENT_ID,
      memberId: HUT_LEADER_ID,
      iat: signedInAt + 3,
      exp: nowSeconds() + 300,
      ...derivedPayloadFields(),
    });
    expect(await tierFor(insideTheCeiling)).toBe("hut-leader");
    expect(renewLodgePinSession(insideTheCeiling)).not.toBeNull();
  });

  it("refuses a pre-#3228 cookie, which carried no `iat` and a twelve-hour deadline", async () => {
    // The deploy that lands the idle window must also END the long-lived
    // sessions already out there, rather than honouring them for the rest of
    // their twelve hours. A hut leader mid-shift re-enters their PIN once.
    const legacy = signedCookie({
      assignmentId: ASSIGNMENT_ID,
      memberId: HUT_LEADER_ID,
      exp: nowSeconds() + 12 * 60 * 60,
    });

    expect(await tierFor(legacy)).toBe("lodge");
    expect(renewLodgePinSession(legacy)).toBeNull();
  });

  it("refuses a deadline or a sign-in time that is not a real, reachable number", async () => {
    // `1e999` parses out of JSON as `Infinity`, which passes `typeof === "number"`
    // and never satisfies `exp <= now` — a deadline that can never pass. Not
    // reachable while only the server holds the key; refused anyway, because this
    // is a security boundary and the check costs nothing.
    const fields = validPayloadFields();
    const literalInfinite = signedCookie(
      JSON.parse(
        '{"assignmentId":"' +
          ASSIGNMENT_ID +
          '","memberId":"' +
          HUT_LEADER_ID +
          '","exp":1e999,"iat":' +
          String(fields.iat) +
          "}"
      ) as Record<string, unknown>
    );

    expect(await tierFor(literalInfinite)).toBe("lodge");
    expect(renewLodgePinSession(literalInfinite)).toBeNull();

    // A fractional deadline is not a whole second either.
    expect(
      renewLodgePinSession(signedCookie({ ...fields, exp: fields.exp + 0.5 }))
    ).toBeNull();
    // An `iat` in the future would push the ceiling out with it.
    expect(
      renewLodgePinSession(
        signedCookie({ ...fields, iat: fields.iat + 24 * 60 * 60 })
      )
    ).toBeNull();
    // A deadline further out than one idle window past the ceiling cannot have
    // come from either mint.
    expect(
      renewLodgePinSession(
        signedCookie({
          ...fields,
          exp:
            fields.iat +
            HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS +
            HUT_LEADER_PIN_SESSION_IDLE_SECONDS +
            1,
        })
      )
    ).toBeNull();
    // ...and the control: the same payload, untouched, is accepted.
    expect(renewLodgePinSession(signedCookie(fields))).not.toBeNull();
  });
});

describe("hut-leader PIN session: renewal cannot be starved from the network (#3228)", () => {
  it("is not refused because a shared address has spent a budget", async () => {
    /*
      THE LOCKOUT LEVER THIS REMOVED. `applyMemberScopedRateLimit` checks
      `ip:<addr>` first, at ten times the per-account budget. That key is
      reachable by any caller who gets past `checkLodgeAuth` with a tier — a
      guest staying the night, on the lodge's own wifi — so ten requests a second
      from a stranger's phone would answer the tablet's renewals with 429 until
      the window rolled, and time a working hut leader out mid-roster. The signed
      cookie plus the account key is the real control; the address key bought
      nothing on a route that reads nothing and reveals nothing.

      Driven by spending that exact key far past its limit and requiring the
      tablet's renewal to succeed anyway. It fails the moment an address-keyed
      check comes back.
    */
    const session = issueSession();
    const { POST } = await import("@/app/api/lodge/pin-session/route");
    const { NextRequest } = await import("next/server");

    _testStore.set(rateLimiters.lodgePinSession.id + ":ip:10.0.0.30", {
      count: rateLimiters.lodgePinSession.limit * 100,
      resetAt: Date.now() + 60_000,
    });

    const res = await POST(
      new NextRequest("http://localhost/api/lodge/pin-session", {
        method: "POST",
        headers: {
          "x-forwarded-for": "10.0.0.30",
          cookie: `${HUT_LEADER_PIN_SESSION_COOKIE}=${session.value}`,
        },
      })
    );

    expect(res.status).toBe(200);
    expect(pinCookieFrom(res)).toBeTruthy();
  });
});

describe("hut-leader PIN session: nothing the kiosk re-asks may be cached (#3228)", () => {
  /*
    The Lock guarantee is "end the session, then re-ask the same URLs and get an
    ordinary lodge answer". A cached privileged payload defeats it silently: the
    page has already dropped what it held, so it has nothing to compare against
    and no reason to ask again for two minutes.
  */
  it("sets no-store on the access response, unlocked and locked alike", async () => {
    const session = issueSession();
    const { GET } = await import("@/app/api/lodge/access/route");
    const { NextRequest } = await import("next/server");

    const ask = () =>
      GET(
        new NextRequest("http://localhost/api/lodge/access?date=2026-04-13", {
          headers: {
            cookie: `${HUT_LEADER_PIN_SESSION_COOKIE}=${session.value}`,
          },
        })
      );

    const unlocked = await ask();
    expect(unlocked.headers.get(NO_STORE_HEADER_NAME)).toBe(
      NO_STORE_HEADER_VALUE
    );

    atFrozenPlus(IDLE_MS + 1000);
    const locked = await ask();
    expect(locked.headers.get(NO_STORE_HEADER_NAME)).toBe(NO_STORE_HEADER_VALUE);
  });

  it("sets no-store on every pin-session answer, including the refusals", async () => {
    const session = issueSession();
    const { POST, DELETE } = await import("@/app/api/lodge/pin-session/route");
    const { NextRequest } = await import("next/server");

    const request = (method: string, ip: string, withCookie = true) =>
      new NextRequest("http://localhost/api/lodge/pin-session", {
        method,
        headers: {
          "x-forwarded-for": ip,
          ...(withCookie
            ? { cookie: `${HUT_LEADER_PIN_SESSION_COOKIE}=${session.value}` }
            : {}),
        },
      });

    const renewed = await POST(request("POST", "10.0.0.31"));
    const refused = await POST(request("POST", "10.0.0.32", false));
    const locked = await DELETE(request("DELETE", "10.0.0.33"));

    expect(renewed.status).toBe(200);
    expect(refused.status).toBe(403);
    for (const res of [renewed, refused, locked]) {
      expect(res.headers.get(NO_STORE_HEADER_NAME)).toBe(NO_STORE_HEADER_VALUE);
    }
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

  /*
    THE COOKIE-NAME CENSUS, and it is the one the helper census above does NOT
    give you.

    That census greps for CALLS of `setLodgePinSessionCookie` /
    `clearLodgePinSessionCookie`, which proves where the helpers are used and
    nothing more. A new route writing
    `response.cookies.set({ name: HUT_LEADER_PIN_SESSION_COOKIE, ... })` by hand
    matches neither pattern — and that is not a hypothetical shape, it is exactly
    what `pin-login/route.ts` did until this change moved the attributes into the
    session module. Naming the cookie is the real capability, so the cookie's
    NAME is what gets counted.
  */
  it("names this cookie in exactly one module, so nobody can write it by hand", () => {
    const namers = files
      .filter(({ contents }) =>
        /HUT_LEADER_PIN_SESSION_COOKIE|tac_hut_leader_pin_session/.test(contents)
      )
      .map(({ file }) => file)
      .sort();

    expect(namers).toEqual(["src/lib/lodge-pin-session.ts"]);
    /*
      And the count inside it, so a hand-written write ADDED to this file — past
      the attribute helper, and past the reader — is a change somebody has to
      explain rather than one that hides among the existing mentions.

      FIVE matches across FOUR lines: the declaration line names the constant AND
      the literal string, then the request reader, the attribute set, and the
      `cookies()` reader name it once each. Both figures are asserted because
      "five on four lines" is the fact that makes a sixth suspicious.
    */
    const own = files.find(
      ({ file }) => file === "src/lib/lodge-pin-session.ts"
    );
    expect(own).toBeDefined();
    const ownContents = (own as NonNullable<typeof own>).contents;
    expect(
      ownContents.match(/HUT_LEADER_PIN_SESSION_COOKIE|tac_hut_leader_pin_session/g)
    ).toHaveLength(5);
    expect(
      ownContents
        .split("\n")
        .filter((line) =>
          /HUT_LEADER_PIN_SESSION_COOKIE|tac_hut_leader_pin_session/.test(line)
        )
    ).toHaveLength(4);
  });

  it("lets only the sign-in route mint a fresh window", () => {
    // `createLodgePinSessionWithVersion` is exported and starts a NEW ten-minute
    // window from nothing, which is a bigger capability than renewal. A second
    // caller of it is a second door, so it is censused alongside the writers.
    const minters = files
      .filter(({ contents }) =>
        /\bcreateLodgePinSessionWithVersion\s*\(/.test(contents)
      )
      .map(({ file }) => file)
      .sort();

    expect(minters).toEqual([
      "src/app/api/lodge/pin-login/route.ts",
      "src/lib/lodge-pin-session.ts",
    ]);
  });

  it("refuses caching on every lodge route the kiosk and the wizard re-ask", () => {
    // The behavioural half is above (`access` and `pin-session`, including their
    // refusals). This is the coverage half: the routes those two pages poll must
    // all opt in, because the Lock guarantee is about re-asking THESE URLs.
    const mustNotCache = [
      "src/app/api/lodge/access/route.ts",
      "src/app/api/lodge/week/route.ts",
      "src/app/api/lodge/guests/[date]/route.ts",
      "src/app/api/lodge/roster/[date]/route.ts",
      "src/app/api/lodge/pin-login/route.ts",
      "src/app/api/lodge/pin-session/route.ts",
    ];

    for (const route of mustNotCache) {
      const entry = files.find(({ file }) => file === route);
      expect(entry, route).toBeDefined();
      expect(
        /\bnoStoreLodgeResponse\s*\(/.test(
          (entry as NonNullable<typeof entry>).contents
        ),
        route
      ).toBe(true);
    }
  });

  /*
    THE MOUNT POINT, censused because the tests that prove renewal WORKS cannot
    prove it is REACHED.

    Both the kiosk suite and the roster-wizard suite mount
    `LodgePinSessionProvider` themselves, which is what lets them drive the rule.
    Neither can tell you whether the application mounts it, and that is exactly
    the gap the first cut of #3228 fell into: renewal existed, worked, and was
    wired to one of the two pages that needed it. So two things are asserted from
    the tree instead.

    One: the lodge-area layout — the only ancestor both pages share — mounts the
    provider and reads the cookie to arm it. Two: the interaction event list is
    declared in exactly one module, which rules out the "fix it by copying the
    listener block into the other page" answer, and the second copy of the rule
    that comes with it (`INV-SSOT`).
  */
  it("mounts the renewal once, from the layout both lodge pages share", () => {
    const layout = files.find(
      ({ file }) => file === "src/app/(lodge)/layout.tsx"
    );
    expect(layout).toBeDefined();
    const contents = (layout as NonNullable<typeof layout>).contents;
    expect(contents).toMatch(/<LodgePinSessionProvider\b/);
    expect(contents).toMatch(/hasAnyActiveLodgePinSession\s*\(/);
  });

  it("declares what counts as a person being here in exactly one module", () => {
    const declarers = files
      .filter(({ contents }) =>
        /"pointerdown"[\s\S]{0,120}"touchstart"/.test(contents)
      )
      .map(({ file }) => file)
      .sort();

    expect(declarers).toEqual(["src/components/lodge-pin-session.tsx"]);
  });

  it("keeps the timing module free of imports, so a browser bundle can hold it", () => {
    const contents = readFileSync(
      path.join(SRC, "lib/lodge-pin-session-timing.ts"),
      "utf8"
    );
    // `/^\s*import\s/m` alone was too narrow: it misses `require(`, a dynamic
    // `import(`, and `export { x } from "./y"`, all of which pull a module graph
    // in just as effectively.
    expect(contents).not.toMatch(/^\s*import\s/m);
    expect(contents).not.toMatch(/\brequire\s*\(/);
    expect(contents).not.toMatch(/\bimport\s*\(/);
    expect(contents).not.toMatch(/^\s*export\s+[^;]*\bfrom\s/m);
  });

  it("states a whole number of minutes, so the on-screen copy cannot round a lie", () => {
    // `Math.round(seconds / 60)` used to derive the copy, which prints
    // "2 minutes" for a ninety-second window. The division is now exact, so the
    // window itself has to be whole minutes — and a future change to it has to
    // face the copy rather than silently mis-state it.
    expect(Number.isInteger(HUT_LEADER_PIN_SESSION_IDLE_MINUTES)).toBe(true);
    expect(HUT_LEADER_PIN_SESSION_IDLE_SECONDS % 60).toBe(0);
  });

  /*
    THE OPERATOR-FACING NUMBER, in the documents a person actually reads.

    The kiosk copy is derived from the constant, so it cannot drift. Hand-typed
    prose can and does: change the window to fifteen minutes and every sentence
    below would go on promising ten, with nothing failing. This does not check
    that the prose is GOOD — only that the number in it is still the number the
    server enforces, which is the half a test can hold.
  */
  it("keeps the guides and the attack-surface doc on the same number as the server", () => {
    const docs = [
      "docs/guides/lodge.md",
      "docs/guides/hut-leaders.md",
      "docs/SECURITY-ATTACK-SURFACE.md",
      "docs/UX_FLOW_MAP.md",
    ];
    const expected = `${HUT_LEADER_PIN_SESSION_IDLE_MINUTES} minutes`;
    const ceilingHours = HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS / 3600;

    for (const doc of docs) {
      const contents = readFileSync(path.join(process.cwd(), doc), "utf8");
      expect(contents, doc).toContain(expected);
    }

    // The ceiling is stated in only one of them, and it is the one a reviewer
    // goes to when asking "how long can this session possibly live?".
    const attackSurface = readFileSync(
      path.join(process.cwd(), "docs/SECURITY-ATTACK-SURFACE.md"),
      "utf8"
    );
    expect(attackSurface).toContain(`${ceilingHours} hours`);
  });
});
