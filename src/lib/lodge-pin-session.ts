import bcrypt from "bcryptjs";
import { createHmac, randomInt, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { prisma } from "./prisma";
import { addDaysDateOnly, formatDateOnly } from "./date-only";
import { clubToday, dateOnlyInstantOf } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { getAuthSecret } from "./runtime-config";
import {
  HUT_LEADER_PIN_SESSION_IDLE_SECONDS,
  HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS,
} from "./lodge-pin-session-timing";

export const HUT_LEADER_PIN_SESSION_COOKIE = "tac_hut_leader_pin_session";

const HUT_LEADER_PIN_BCRYPT_ROUNDS = 12;
const PIN_LOCKOUT_THRESHOLD = 10;
const PIN_LOCKOUT_SECONDS = 15 * 60;
const PIN_FAILURE_RESET_MS = 15 * 60 * 1000;

interface PinSessionPayload {
  assignmentId: string;
  memberId: string;
  /** The idle deadline, in whole seconds since the epoch. Moves on renewal. */
  exp: number;
  /**
   * When the PIN was typed, in whole seconds since the epoch. **Never moves.**
   *
   * This is what makes {@link HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS} an
   * absolute ceiling rather than a sliding one: renewal carries it through
   * verbatim, so no number of renewals extends the session past twelve hours
   * from the moment somebody actually authenticated.
   *
   * REQUIRED, not optional, and that is a deliberate one-way door. A cookie
   * minted before #3228 carries no `iat` and a twelve-hour `exp`; refusing it
   * outright means the deploy that lands the idle window also ends every
   * long-lived session already out there, rather than honouring them for the
   * rest of their twelve hours. A hut leader mid-shift re-enters their PIN once.
   */
  iat: number;
  pinVersion?: string;
  sessionUserBinding?: string;
}

interface PinFailureEntry {
  count: number;
  lastFailedAt: number;
  lockedUntil: number | null;
}

const failureStore = new Map<string, PinFailureEntry>();

function getPinSessionSecret(): string {
  const secret = getAuthSecret();
  if (!secret) {
    throw new Error("AUTH_SECRET or NEXTAUTH_SECRET is required for lodge PIN sessions");
  }
  return secret;
}

function signPayload(payloadPart: string): string {
  return createHmac("sha256", getPinSessionSecret())
    .update(payloadPart)
    .digest("base64url");
}

function encodePayload(payload: PinSessionPayload): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadPart}.${signPayload(payloadPart)}`;
}

function derivePinSessionVersion(pinHash: string) {
  return createHmac("sha256", getPinSessionSecret())
    .update(pinHash)
    .digest("base64url");
}

function deriveSessionUserBinding(sessionUserId: string) {
  return createHmac("sha256", getPinSessionSecret())
    .update(`lodge-pin-session:${sessionUserId}`)
    .digest("base64url");
}

function isTimingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function decodePayload(rawValue: string): PinSessionPayload | null {
  const [payloadPart, signaturePart] = rawValue.split(".");
  if (!payloadPart || !signaturePart) {
    return null;
  }

  const expectedSignature = signPayload(payloadPart);
  const signatureBuffer = Buffer.from(signaturePart, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8")
    ) as Partial<PinSessionPayload>;

    if (
      typeof payload.assignmentId !== "string" ||
      typeof payload.memberId !== "string" ||
      // `Number.isSafeInteger` as well as `typeof`, and the second half is the
      // one that matters. Only the server holds the signing key and both mints
      // floor a finite value, so nothing can reach here with a bad one today —
      // but this is a security boundary, and `typeof` alone admits `NaN` and
      // `Infinity`. `1e999` parses from JSON as `Infinity`, and
      // `Infinity <= now` is false, so `typeof` on its own would wave through a
      // deadline that can never pass. (The `typeof` line is still needed:
      // `Number.isSafeInteger` returns a boolean and narrows nothing.)
      typeof payload.exp !== "number" ||
      typeof payload.iat !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      !Number.isSafeInteger(payload.iat) ||
      (payload.pinVersion !== undefined && typeof payload.pinVersion !== "string") ||
      (payload.sessionUserBinding !== undefined &&
        typeof payload.sessionUserBinding !== "string")
    ) {
      return null;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const { exp, iat } = payload;

    if (exp <= nowSeconds) {
      return null;
    }

    /*
      THE ABSOLUTE CEILING, enforced here so BOTH readers get it (#3228).

      This function is the one gate every use of the cookie passes — the tier
      resolver and the renewal endpoint alike — so putting the ceiling here means
      a session past twelve hours from its PIN entry cannot be read OR renewed,
      rather than merely refusing to slide forward while the last-minted cookie
      lives out its final idle window.

      `iat` never moves (renewal carries it verbatim), so no amount of activity
      buys more than the ceiling. The two bounds either side of it are defence in
      depth, for a payload that is signed and still nonsense: an `iat` in the
      future would push the ceiling out with it, and a deadline further out than
      one idle window past the ceiling cannot have come from either mint. One
      idle window is used as the future tolerance because it is the largest gap
      either mint can put between "now" and the deadline it writes — big enough
      to absorb a clock correction, small enough that it cannot hide a session.
    */
    if (
      iat <= 0 ||
      iat > nowSeconds + HUT_LEADER_PIN_SESSION_IDLE_SECONDS ||
      nowSeconds >= iat + HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS ||
      exp >
        iat +
          HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS +
          HUT_LEADER_PIN_SESSION_IDLE_SECONDS
    ) {
      return null;
    }

    return {
      assignmentId: payload.assignmentId,
      memberId: payload.memberId,
      exp,
      iat,
      pinVersion: payload.pinVersion,
      sessionUserBinding: payload.sessionUserBinding,
    };
  } catch {
    return null;
  }
}

function getCookieValueFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === HUT_LEADER_PIN_SESSION_COOKIE) {
      return valueParts.join("=") || null;
    }
  }

  return null;
}

function getAssignmentRange(assignment: {
  startDate: Date;
  endDate: Date;
}) {
  return {
    minDate: formatDateOnly(addDaysDateOnly(assignment.startDate, -1)),
    maxDate: formatDateOnly(assignment.endDate),
  };
}

export function generateHutLeaderPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function hashHutLeaderPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, HUT_LEADER_PIN_BCRYPT_ROUNDS);
}

/**
 * Find the hut-leader assignment a kiosk PIN currently unlocks.
 *
 * `date` is REQUIRED (#3123) and is the day the credential window is judged
 * against (`startDate <= date + 1`, `endDate >= date`). It used to default to
 * the ENVIRONMENT's day, which is a security decision taken from the wrong
 * clock: a club configured behind its container's zone either admitted a PIN
 * whose assignment had ended or locked out a hut leader whose assignment had
 * begun. Two things made the default worse than usual here — the caller reached
 * past it POSITIONALLY (`findActiveHutLeaderAssignmentByPin(pin, undefined,
 * kioskLodgeId)`) purely to supply the lodge, so the environment's day was being
 * chosen by accident rather than on purpose; and this module is reachable from
 * `src/instrumentation.node.ts`, so it cannot import the `server-only` binding
 * and could not have resolved the club's zone here even if that were wanted.
 * The caller resolves the club's day and passes it in.
 */
export async function findActiveHutLeaderAssignmentByPin(
  pin: string,
  date: Date,
  kioskLodgeId?: string
) {
  const nextDay = addDaysDateOnly(date, 1);
  const assignments = await prisma.hutLeaderAssignment.findMany({
    where: {
      hutLeaderPin: { not: null },
      startDate: { lte: nextDay },
      endDate: { gte: date },
      // A hut leader serves one lodge (ADR-001 resolved question 5): a PIN
      // only works on that lodge's kiosk. lodgeId is NOT NULL, so scope the
      // PIN lookup strictly to the kiosk's lodge when one is supplied.
      ...(kioskLodgeId ? { lodgeId: kioskLodgeId } : {}),
    },
    include: {
      member: {
        select: {
          id: true,
          active: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  });

  for (const assignment of assignments) {
    if (!assignment.hutLeaderPin || !assignment.member.active) {
      continue;
    }

    if (await bcrypt.compare(pin, assignment.hutLeaderPin)) {
      return assignment;
    }
  }

  return null;
}

/**
 * Verify a hut leader's PIN against ONE specific assignment (by id), for the
 * remote pre-arrival instructions view (#1642). Unlike the kiosk PIN login,
 * this needs no prior session: the assignment id (a non-enumerable cuid, sent
 * in the assignment email link) disambiguates which lodge the PIN belongs to —
 * hut-leader PINs are not globally unique — and confines a brute-force attempt
 * to this single assignment's PIN (the caller layers IP lockout + rate limiting
 * on top). Access is granted for a **current or upcoming** assignment
 * (endDate >= today), matching the login-gated instructions rule, so a hut
 * leader can read the instructions BEFORE their stay. Returns the matched
 * assignment (carrying lodgeId) or null; never reveals whether the id or the
 * PIN was the mismatch.
 *
 * `date` is REQUIRED (#3123), for the same reason as
 * {@link findActiveHutLeaderAssignmentByPin}: it decides a credential window,
 * and defaulting it read the environment's day rather than the club's persisted
 * one. `endDate` is a stored `@db.Date` calendar day and takes no zone at all;
 * this is the other side of that comparison and must arrive on the same
 * UTC-midnight frame (`INV-DATE-026`).
 */
export async function verifyHutLeaderPinForAssignment(
  assignmentId: string,
  pin: string,
  date: Date
) {
  const assignment = await prisma.hutLeaderAssignment.findFirst({
    where: {
      id: assignmentId,
      hutLeaderPin: { not: null },
      // Current or upcoming only: an assignment whose stay has already ended
      // no longer grants instructions access.
      endDate: { gte: date },
    },
    include: {
      member: { select: { id: true, active: true } },
    },
  });

  if (!assignment || !assignment.hutLeaderPin || !assignment.member.active) {
    return null;
  }
  if (!(await bcrypt.compare(pin, assignment.hutLeaderPin))) {
    return null;
  }
  return assignment;
}

/**
 * A hut-leader PIN session cookie, ready to be written to a response.
 *
 * `expiresAt` is the moment the cookie stops being accepted, and it is also
 * inside the SIGNED payload as `exp` — which is what makes the idle window
 * server-authoritative (#3228). A browser that keeps or re-sends an old cookie
 * value gains nothing: `decodePayload` verifies the signature and then refuses
 * a payload whose own `exp` has passed, so the deadline cannot be edited,
 * replayed past, or extended by anything the client says.
 */
export interface LodgePinSessionCookie {
  value: string;
  expiresAt: Date;
  maxAge: number;
}

/**
 * The one place the idle deadline is computed. Sign-in and renewal both come
 * here, so a change to the window cannot land on one path and miss the other.
 */
function nextIdleDeadline(): Date {
  return new Date(Date.now() + HUT_LEADER_PIN_SESSION_IDLE_SECONDS * 1000);
}

export function createLodgePinSessionWithVersion(
  assignmentId: string,
  memberId: string,
  pinHash?: string | null,
  sessionUserId?: string | null
): LodgePinSessionCookie {
  const expiresAt = nextIdleDeadline();

  return {
    value: encodePayload({
      assignmentId,
      memberId,
      exp: Math.floor(expiresAt.getTime() / 1000),
      // The moment the PIN was typed, stamped once and carried through every
      // renewal, which is what bounds the session absolutely (#3228).
      iat: Math.floor(Date.now() / 1000),
      pinVersion: pinHash ? derivePinSessionVersion(pinHash) : undefined,
      sessionUserBinding: sessionUserId
        ? deriveSessionUserBinding(sessionUserId)
        : undefined,
    }),
    expiresAt,
    maxAge: HUT_LEADER_PIN_SESSION_IDLE_SECONDS,
  };
}

/**
 * Slide the idle window forward on a session that is ALREADY valid (#3228).
 *
 * Called from one route and one route only — `POST /api/lodge/pin-session`,
 * which the kiosk calls when a person touches the screen. Nothing else in the
 * tree re-issues this cookie, and that is the whole of the "background
 * refreshes do not extend the session" guarantee: the routes a wall tablet
 * polls have no code path that reaches here, so an unattended device cannot
 * keep itself privileged by talking to the server.
 *
 * It **cannot resurrect an expired session**. `decodePayload` refuses a payload
 * whose `exp` has passed, so once the window has closed the only way back is
 * the PIN. It also cannot change who the session is: `assignmentId`,
 * `memberId`, `pinVersion` and `sessionUserBinding` are carried through
 * verbatim from the payload the server itself signed, so a renewal re-states
 * exactly the same authority with a later deadline and needs no database read
 * to do it. Every one of those fields is re-verified against live state on the
 * next request by {@link getActiveLodgePinSessionForDate}, so a PIN reset, a
 * deactivated member or an assignment that has ended still ends the session
 * whether or not it was renewed a second earlier.
 *
 * It also **cannot outlast the absolute ceiling**
 * ({@link HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS}). `iat` is carried through
 * unchanged, `decodePayload` refuses a payload past `iat` plus the ceiling, and
 * the deadline written here is clamped to it — so the cookie's own `Max-Age`
 * stops lying about a session the server will not accept, and a renewal loop
 * cannot turn a copied cookie into an indefinite credential.
 */
export function renewLodgePinSession(
  rawCookieValue: string | null
): LodgePinSessionCookie | null {
  if (!rawCookieValue) {
    return null;
  }

  const payload = decodePayload(rawCookieValue);
  if (!payload) {
    return null;
  }

  const now = Date.now();
  const ceiling = new Date(
    (payload.iat + HUT_LEADER_PIN_SESSION_MAX_TOTAL_SECONDS) * 1000
  );
  const idleDeadline = nextIdleDeadline();
  const expiresAt = idleDeadline < ceiling ? idleDeadline : ceiling;
  // `decodePayload` already refused everything at or past the ceiling, so this
  // is strictly positive.
  const maxAge = Math.ceil((expiresAt.getTime() - now) / 1000);

  return {
    value: encodePayload({
      ...payload,
      exp: Math.floor(expiresAt.getTime() / 1000),
    }),
    expiresAt,
    maxAge,
  };
}

/** {@link renewLodgePinSession}, reading the cookie off an incoming request. */
export function renewLodgePinSessionForRequest(
  request: Request
): LodgePinSessionCookie | null {
  return renewLodgePinSession(getCookieValueFromRequest(request));
}

/**
 * The cookie attributes, in one place, for every route that writes this cookie.
 *
 * A structural `cookies` parameter rather than a `NextResponse`: this module is
 * reachable from `src/instrumentation.node.ts` (see
 * {@link hasAnyActiveLodgePinSession}), so it stays free of `next/server`.
 */
interface LodgePinSessionCookieWriter {
  set(options: {
    name: string;
    value: string;
    httpOnly: boolean;
    sameSite: "lax";
    secure: boolean;
    expires: Date;
    maxAge: number;
    path: string;
  }): unknown;
}

function lodgePinSessionCookieAttributes() {
  return {
    name: HUT_LEADER_PIN_SESSION_COOKIE,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

/** Write an issued or renewed PIN session to a response. */
export function setLodgePinSessionCookie(
  cookies: LodgePinSessionCookieWriter,
  session: LodgePinSessionCookie
): void {
  cookies.set({
    ...lodgePinSessionCookieAttributes(),
    value: session.value,
    expires: session.expiresAt,
    maxAge: session.maxAge,
  });
}

/**
 * End the PIN session now — the kiosk's **Lock** control (#3228).
 *
 * Deliberately the same name, path and attributes as the setter above, because
 * a clearing cookie that differs in any of them leaves the real one in place
 * and a lock that silently does nothing is worse than no lock at all.
 */
export function clearLodgePinSessionCookie(
  cookies: LodgePinSessionCookieWriter
): void {
  cookies.set({
    ...lodgePinSessionCookieAttributes(),
    value: "",
    expires: new Date(0),
    maxAge: 0,
  });
}

// test seam
export async function getActiveLodgePinSessionForDate(
  date: Date,
  rawCookieValue: string | null,
  sessionUserId?: string | null
) {
  if (!rawCookieValue) {
    return null;
  }

  const payload = decodePayload(rawCookieValue);
  if (!payload) {
    return null;
  }

  if (sessionUserId) {
    const expectedBinding = deriveSessionUserBinding(sessionUserId);
    if (
      !payload.sessionUserBinding ||
      !isTimingSafeStringEqual(payload.sessionUserBinding, expectedBinding)
    ) {
      return null;
    }
  }

  const assignment = await prisma.hutLeaderAssignment.findUnique({
    where: { id: payload.assignmentId },
    include: {
      member: {
        select: {
          id: true,
          active: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  });

  if (
    !assignment ||
    assignment.memberId !== payload.memberId ||
    !assignment.member.active ||
    !assignment.hutLeaderPin
  ) {
    return null;
  }

  if (
    !payload.pinVersion ||
    payload.pinVersion !== derivePinSessionVersion(assignment.hutLeaderPin)
  ) {
    return null;
  }

  const rangeStart = addDaysDateOnly(assignment.startDate, -1);
  if (date < rangeStart || date > assignment.endDate) {
    return null;
  }

  return {
    assignmentId: assignment.id,
    memberId: assignment.memberId,
    member: assignment.member,
    dateRange: getAssignmentRange(assignment),
  };
}

export async function getActiveLodgePinSessionForRequest(
  request: Request,
  date: Date,
  sessionUserId: string
) {
  return getActiveLodgePinSessionForDate(
    date,
    getCookieValueFromRequest(request),
    sessionUserId
  );
}

export async function hasAnyActiveLodgePinSession(
  sessionUserId?: string | null
): Promise<boolean> {
  const cookieStore = await cookies();
  const rawCookieValue = cookieStore.get(HUT_LEADER_PIN_SESSION_COOKIE)?.value ?? null;
  // The club's own day decides whether a PIN session is still inside its
  // assignment window, so it must come from the club's persisted zone rather
  // than the container's (#3123). The runtime reader, not the request-scoped
  // binding: this module is reachable from `src/instrumentation.node.ts`
  // through general-cron-runner -> cron-quote-expiry-reminders ->
  // booking-request-quotes -> school-booking-request, and
  // `@/lib/club-time/server` is `server-only`, which throws on that graph.
  const session = await getActiveLodgePinSessionForDate(
    dateOnlyInstantOf(clubToday(await readClubTimeZoneOutsideRequest())),
    rawCookieValue,
    sessionUserId
  );
  return Boolean(session);
}

function getFailureEntry(ip: string): PinFailureEntry | null {
  const entry = failureStore.get(ip);
  if (!entry) {
    return null;
  }

  const now = Date.now();

  if (entry.lockedUntil && entry.lockedUntil <= now) {
    failureStore.delete(ip);
    return null;
  }

  if (!entry.lockedUntil && now - entry.lastFailedAt > PIN_FAILURE_RESET_MS) {
    failureStore.delete(ip);
    return null;
  }

  return entry;
}

export function getLodgePinLockout(ip: string) {
  const entry = getFailureEntry(ip);
  const now = Date.now();

  if (!entry || !entry.lockedUntil || entry.lockedUntil <= now) {
    return { locked: false, retryAfter: 0 };
  }

  return {
    locked: true,
    retryAfter: Math.ceil((entry.lockedUntil - now) / 1000),
  };
}

export function recordLodgePinFailure(ip: string) {
  const now = Date.now();
  const existing = getFailureEntry(ip);
  const nextCount = (existing?.count ?? 0) + 1;

  const lockedUntil =
    nextCount >= PIN_LOCKOUT_THRESHOLD
      ? now + PIN_LOCKOUT_SECONDS * 1000
      : null;

  failureStore.set(ip, {
    count: nextCount,
    lastFailedAt: now,
    lockedUntil,
  });

  return {
    count: nextCount,
    locked: Boolean(lockedUntil),
    retryAfter: lockedUntil
      ? Math.ceil((lockedUntil - now) / 1000)
      : 0,
  };
}

export function clearLodgePinFailures(ip: string) {
  failureStore.delete(ip);
}

// test seam
export { failureStore as _testLodgePinFailureStore };
