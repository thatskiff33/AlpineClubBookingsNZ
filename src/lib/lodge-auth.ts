import type { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";
import { auth } from "./auth";
import {
  getKioskAccessTier,
  type KioskTier,
} from "./kiosk-access";
import { addDaysDateOnly, isDateOnlyString, parseDateOnly } from "./date-only";
import { clubTodayDateOnlyInstant } from "@/lib/club-time/server";
import { LODGE_VISIBLE_BOOKING_STATUSES } from "./lodge-date-scoping";
import { getActiveLodgePinSessionForRequest } from "./lodge-pin-session";
import { getDefaultLodgeId } from "./lodges";
import { AmbiguousKioskLodgeError, getStaffLodgeBinding } from "./lodge-access";
import { requireActiveSessionUser } from "./session-guards";
import { hasAdminAccess, hasLodgeAccess } from "@/lib/access-roles";
import { prisma } from "@/lib/prisma";

interface CheckLodgeAuthOptions {
  request?: Request;
  /**
   * Whether this route may serve an admin's per-account kiosk preview
   * (`?previewAccount=<memberId>`). Preview is READ-ONLY: only GET routes opt
   * in. Any route that leaves this false rejects a preview request with a 403
   * — so every mutation route (and any read route not yet considered) is
   * default-denied, and the preview flag can never authorise a write (issue #23).
   */
  allowPreview?: boolean;
}

/**
 * Details of an active kiosk preview: a full admin is viewing the kiosk exactly
 * as a specific kiosk (LODGE) account would see it. `actorMemberId` is the admin
 * driving the preview (for any incidental audit); `targetMemberId`/`targetEmail`
 * identify the previewed kiosk account.
 */
export interface KioskPreviewContext {
  actorMemberId: string;
  targetMemberId: string;
  targetEmail: string;
}

/**
 * Reads the `previewAccount` query parameter from a kiosk request, if any.
 * Returns null when there is no request or no parameter.
 */
function readPreviewAccountId(request: Request | undefined): string | null {
  if (!request) return null;
  try {
    const value = new URL(request.url).searchParams.get("previewAccount");
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function getLodgeAuthActorMemberId(authResult: {
  tier: KioskTier;
  session?: { user?: { id?: string } } | null;
  pinSession?: { memberId: string } | null;
}) {
  if (authResult.tier === "hut-leader" && authResult.pinSession) {
    return authResult.pinSession.memberId;
  }

  return authResult.session?.user?.id ?? null;
}

/**
 * Shared auth check for lodge API endpoints.
 * Allows ADMIN, LODGE, USER with kiosk access, or a valid hut leader PIN
 * session attached to an authenticated lodge/admin account.
 */
export async function checkLodgeAuth(
  dateStr?: string,
  options: CheckLodgeAuthOptions = {}
) {
  const session = await auth();

  if (dateStr && !isDateOnlyString(dateStr)) {
    return {
      session,
      tier: "none" as KioskTier,
      error: "Invalid date format" as const,
      status: 400 as const,
    };
  }

  const date = dateStr
    ? parseDateOnly(dateStr)
    : await clubTodayDateOnlyInstant();

  if (!session?.user) {
    return {
      session: null,
      tier: "none" as KioskTier,
      error: "Unauthorised" as const,
      status: 401 as const,
    };
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return {
      session: null,
      tier: "none" as KioskTier,
      error: "Account is deactivated" as const,
      status: 403 as const,
    };
  }

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      accessRoles: { select: { role: true } },
    },
  });

  if (!member) {
    return {
      session: null,
      tier: "none" as KioskTier,
      error: "Forbidden" as const,
      status: 403 as const,
    };
  }

  // Per-account kiosk preview (issue #23): a full admin can view the kiosk
  // exactly as a specific kiosk account would, so a kiosk can be verified per
  // lodge before its device is deployed. The parameter is honoured ONLY for a
  // full admin; a non-admin carrying it falls through to normal kiosk auth.
  const previewAccountId = readPreviewAccountId(options.request);
  if (previewAccountId && hasAdminAccess(member)) {
    // Read-only by construction: only GET routes pass allowPreview, so any
    // mutation route (or a read route not yet wired) denies preview here.
    if (!options.allowPreview) {
      return {
        session: null,
        tier: "none" as KioskTier,
        error: "Kiosk preview is read-only" as const,
        status: 403 as const,
      };
    }

    const target = await prisma.member.findUnique({
      where: { id: previewAccountId },
      select: { id: true, email: true, accessRoles: { select: { role: true } } },
    });

    // Only a genuine kiosk (LODGE) account can be previewed — never an
    // arbitrary member, which would leak a non-kiosk view.
    if (!target || !hasLodgeAccess(target)) {
      return {
        session: null,
        tier: "none" as KioskTier,
        error: "Kiosk account not found" as const,
        status: 404 as const,
      };
    }

    // Resolve tier/lodge as the target account would — getKioskAccessTier gives
    // "lodge" for a kiosk account, and downstream resolveKioskLodgeId reads
    // authResult.member (now the target), so its bound/unbound/ambiguous lodge
    // resolution is exactly the physical kiosk's.
    const previewTier = await getKioskAccessTier(target, date);
    return {
      session,
      tier: previewTier,
      error: null,
      status: null,
      member: target,
      preview: {
        actorMemberId: member.id,
        targetMemberId: target.id,
        targetEmail: target.email,
      } satisfies KioskPreviewContext,
    };
  }

  if (options.request && hasLodgeAccess(member)) {
    const pinSession = await getActiveLodgePinSessionForRequest(
      options.request,
      date,
      session.user.id
    );

    if (pinSession) {
      return {
        session,
        tier: "hut-leader" as KioskTier,
        error: null,
        status: null,
        member,
        pinSession,
      };
    }
  }

  const tier = await getKioskAccessTier(member, date);

  if (tier !== "none") {
    return { session, tier, error: null, status: null, member };
  }

  return {
    session: null,
    tier: "none" as KioskTier,
    error: "Forbidden" as const,
    status: 403 as const,
  };
}

type ResolveLodgeDb = Pick<
  PrismaClient,
  "hutLeaderAssignment" | "lodge" | "booking" | "memberLodgeAccess"
>;

interface ResolveKioskLodgeIdAuthResult {
  tier: KioskTier;
  member?: { id: string } | null;
  pinSession?: { assignmentId: string; memberId: string } | null;
}

/**
 * Resolve which lodge a kiosk request should be scoped to, given the
 * checkLodgeAuth() result for that request (phase 5 of
 * docs/multi-lodge/implementation-plan.md).
 *
 * - hut-leader: the PIN session's HutLeaderAssignment carries its own
 *   (nullable) lodgeId; null falls back to the club's default lodge.
 * - lodge / admin: a STAFF MemberLodgeAccess grant binds the kiosk account
 *   to a lodge; no grant falls back to the default lodge. Admin kiosk
 *   devices may also be bound, so the same lookup applies. A grant at more
 *   than one lodge is ambiguous and throws AmbiguousKioskLodgeError (deny)
 *   rather than serving the default lodge's data on the wrong property.
 * - staying-guest: resolved from the member's active booking for "today"
 *   (the same query shape as getKioskAccessTier's staying-guest branch),
 *   using the booking's lodgeId, defaulting if null.
 * - none: callers must never reach here without a resolved tier.
 */
export async function resolveKioskLodgeId(
  authResult: ResolveKioskLodgeIdAuthResult,
  db: ResolveLodgeDb
): Promise<string> {
  switch (authResult.tier) {
    case "hut-leader": {
      const assignmentId = authResult.pinSession?.assignmentId;
      if (assignmentId) {
        const assignment = await db.hutLeaderAssignment.findUnique({
          where: { id: assignmentId },
          select: { lodgeId: true },
        });
        return assignment?.lodgeId ?? (await getDefaultLodgeId(db));
      }
      // A hut leader signed in with their own account (no PIN session) still
      // reaches this tier via getKioskAccessTier; resolve their lodge from
      // the assignment covering today instead of throwing.
      const memberId = authResult.member?.id;
      if (!memberId) {
        throw new Error(
          "resolveKioskLodgeId: hut-leader tier requires a member or pinSession"
        );
      }
      const today = await clubTodayDateOnlyInstant();
      const ownAssignment = await db.hutLeaderAssignment.findFirst({
        where: {
          memberId,
          startDate: { lte: addDaysDateOnly(today, 1) },
          endDate: { gte: today },
        },
        orderBy: [{ startDate: "asc" }, { id: "asc" }],
        select: { lodgeId: true },
      });
      return ownAssignment?.lodgeId ?? (await getDefaultLodgeId(db));
    }
    case "lodge":
    case "admin": {
      const memberId = authResult.member?.id;
      if (!memberId) {
        throw new Error(
          `resolveKioskLodgeId: ${authResult.tier} tier requires a resolved member`
        );
      }
      const binding = await getStaffLodgeBinding(db, memberId);
      if (binding.kind === "ambiguous") {
        // A kiosk account granted STAFF at more than one lodge cannot be
        // resolved to a single property: serving the default lodge would
        // leak the wrong lodge's guest list/roster on a shared screen (M5).
        throw new AmbiguousKioskLodgeError();
      }
      return binding.kind === "bound"
        ? binding.lodgeId
        : await getDefaultLodgeId(db);
    }
    case "staying-guest": {
      const memberId = authResult.member?.id;
      if (!memberId) {
        throw new Error(
          "resolveKioskLodgeId: staying-guest tier requires a resolved member"
        );
      }
      const today = await clubTodayDateOnlyInstant();
      const nextDay = addDaysDateOnly(today, 1);
      const booking = await db.booking.findFirst({
        where: {
          status: { in: [...LODGE_VISIBLE_BOOKING_STATUSES] },
          OR: [
            { memberId },
            {
              guests: {
                some: {
                  memberId,
                  stayStart: { lte: nextDay },
                  stayEnd: { gte: today },
                },
              },
            },
          ],
          checkIn: { lte: nextDay },
          checkOut: { gte: today },
        },
        select: { lodgeId: true },
      });
      // Defensive fallback: the tier was already granted by getKioskAccessTier
      // using this same query shape, so a booking should always be found.
      return booking?.lodgeId ?? (await getDefaultLodgeId(db));
    }
    case "none":
    default:
      throw new Error(
        `resolveKioskLodgeId: cannot resolve a lodge for tier "${authResult.tier}"`
      );
  }
}

/**
 * Maps a caught kiosk lodge-resolution error to an HTTP response, or null when
 * the caller should handle it (rethrow / fall through to its own 500). A kiosk
 * account granted STAFF at two or more lodges (a one-click admin
 * misconfiguration) makes resolveKioskLodgeId throw AmbiguousKioskLodgeError;
 * every kiosk route denies it with a clean 403 rather than a 500, so a
 * misconfigured account produces no Sentry noise on each kiosk request (M5).
 */
export function kioskLodgeAuthErrorResponse(
  error: unknown
): NextResponse | null {
  if (error instanceof AmbiguousKioskLodgeError) {
    return NextResponse.json(
      { error: error.message },
      { status: error.status }
    );
  }
  return null;
}
