import { NextRequest, NextResponse } from "next/server";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import {
  adminMemberGuestEmailBodySchema,
  adminMemberGuestNameQuerySchema,
} from "@/lib/admin-bookings-schemas/bookings";
import { parseJsonRequestBody } from "@/lib/api-json";
import {
  ADMIN_MEMBER_GUEST_EMAIL_CANDIDATES_CONNECTION_SHAPE,
  ADMIN_MEMBER_GUEST_NAME_CANDIDATES_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/bookings-bookings";
import { connectionJson } from "@/lib/mcp-connection-request";
import logger from "@/lib/logger";
import {
  auditMemberGuestResolve,
  auditMemberGuestSearch,
  loadMemberGuestFindGate,
  resolveMemberGuestCandidatesByEmail,
  searchMemberGuestCandidatesByName,
} from "@/lib/member-guest-find-service";
import {
  MEMBER_GUEST_SEARCH_Q_MAX_CHARS,
  normalizeMemberGuestEmail,
} from "@/lib/member-guest-find";
import { requireAdmin } from "@/lib/session-guards";

/**
 * The ADMIN member-pick surface for "+ Add Member Guest" (epic #2305, MG4
 * #2309, owner decisions D-20 and O-4).
 *
 * ONE ROUTE, BOTH MODES, because that is what the shared find panel sends: it
 * classifies what the officer typed and asks for either an exact email or a name
 * fragment. Splitting them would mean two admin routes with one audience and one
 * gate between them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO METHODS, AND WHICH ONE EACH MODE USES IS LOAD-BEARING
 *
 * The email mode is a **POST**, exactly like its member-facing twin
 * `POST /api/members/guest-candidates/resolve`, and for the reason that route's
 * own docblock states without hedging: a GET puts another member's email address
 * into the request URL, and from there into the access log, the browser history,
 * the `Referer` header of anything the page subsequently loads, and every proxy
 * in between. None of that is less true because an officer typed it — if
 * anything it is worse, since an officer types many addresses in a session and
 * an admin browser is likelier to be shared. It shipped as a GET here and the
 * privacy review caught it; the method is now the same on both paths.
 *
 * The name mode stays a **GET**. A name fragment is not a contact detail, and
 * the member-facing search route is a GET for the same reason.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS RATHER THAN REUSING THE MEMBER ROUTES
 *
 * The member finder is gated on the club's two privacy settings: name search is
 * off unless a club turns it on, and minors are excluded unless a club opts them
 * in. Owner decision D-20 says the ADMIN picker is bound by neither, and the
 * reasoning is worth stating because the opposite looks safer and is not: an
 * admin holding `membership:view` can already browse the entire membership,
 * minors included, from `/admin/members`. Gating their booking-side picker on a
 * MEMBER-FACING privacy switch protects nobody — it only makes an officer leave
 * the booking, look the member up on another page, come back and paste an
 * address. The setting exists to decide what MEMBERS can see. It is not an
 * access-control mechanism and must not be pressed into service as one, because
 * a club that later turns name search ON would then have no way to say
 * "browsable to officers, not to members" — the two would be one switch.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO RIDERS, AND THEY ARE NOT OPTIONAL
 *
 * (a) NAME SEARCH IS GATED ON `membership:view`, NOT ON `bookings:edit`. #1376
 *     exists for one persona: a Booking Officer whose role deliberately does NOT
 *     carry membership access, so they can run bookings without the club's
 *     member directory. Handing that person a name type-ahead over the whole
 *     roll from inside a booking would undo #1376 completely, through a door
 *     nobody thought to look at. So a `membership:view`-less officer gets a 404
 *     on the name mode — the same answer the member route gives when open search
 *     is off — and the shared panel falls back to exact-email resolve, which is
 *     precisely what they have always had through `eligible-family`'s sibling
 *     surfaces. They lose a convenience, not a capability.
 *
 * (b) EVERY RESOLVE IS AUDITED, IDENTICALLY TO THE MEMBER PATH. "Admins can see
 *     everything" is not "admin lookups need no record". The same two audit
 *     writers the member routes use are called here with the same retention
 *     classes, so one query on `member_guest.search` returns members and
 *     officers together rather than officers being invisible in the trail that
 *     exists to make browsing detectable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY NOT COPIED FROM THE MEMBER ROUTES
 *
 * No rate limit and no timing floor. Both exist to make a MEMBER's probing slow
 * and noisy against a surface that is otherwise a stranger-lookup oracle. An
 * officer with `membership:view` is not probing for something they are denied —
 * they hold the directory — so a limiter here would throttle legitimate work to
 * mitigate a risk that does not apply, and the audit trail is the control that
 * does. The email mode is available to any booking officer and is bounded by the
 * same thing that has always bounded it: you must already know the address.
 *
 * MODULE OFF ⇒ 404, never 403, for the same reason as the member routes: a 403
 * confirms the club has the feature and has switched it off, which is a fact
 * about the club an unauthorised caller has no business learning.
 */
/**
 * The EMAIL mode — an exact address, in the body (see the method note above).
 *
 * Available to any booking officer, `membership:view` or not: it is the #1376
 * fallback, and it is bounded by the same thing that has always bounded it — you
 * must already know the address. Also the AI app action
 * `find_member_guest_by_email` (ALP-719).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Path-derived, and a POST under `/api/admin/bookings/...` resolves to
  // bookings:EDIT rather than the GET's bookings:view. That is the right floor
  // and not an accident of the method change: the picker is only ever offered
  // to a viewer the booking page has already put in admin mode, which is itself
  // `bookings:edit` (`bookingManagementAuthorizationRole`). A read-only
  // bookings viewer gets the MEMBER routes and the club's own search setting.
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const actorMemberId = guard.session.user.id;
  await params;

  const gate = await loadMemberGuestFindGate({ requiresOpenSearch: false });
  if (!gate.ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  // No string `email` reads as an empty address: the audited miss, never a 400.
  const body = adminMemberGuestEmailBodySchema.safeParse(json.body);
  const rawEmail = body.success ? body.data.email.slice(0, 320) : "";
  const email = normalizeMemberGuestEmail(rawEmail);

  if (!email) {
    // D-20 RIDER (b): AUDITED, not silently dropped. This is the same answer a
    // genuine miss gets — a malformed address says nothing about any member, so
    // it must not get its own distinguishable response — but "indistinguishable
    // to the caller" is not "invisible to the club". The member route records
    // this case as `outcome: "failure"` for exactly this reason (a run of
    // malformed probes is a pattern an admin should be able to find), and rider
    // (b) says an admin resolve is audited identically to the member path. It
    // was the one outcome here that left no trace at all.
    await auditMemberGuestResolve({
      request,
      actorMemberId,
      email: rawEmail.trim(),
      candidates: [],
      outcome: "failure",
    });
    return connectionJson(request, { candidates: [] }, ADMIN_MEMBER_GUEST_EMAIL_CANDIDATES_CONNECTION_SHAPE);
  }

  try {
    const result = await resolveMemberGuestCandidatesByEmail({ email });
    await auditMemberGuestResolve({
      request,
      actorMemberId,
      email,
      candidates: result.candidates.map((candidate) => ({
        memberId: candidate.memberId,
      })),
    });
    return connectionJson(request, result, ADMIN_MEMBER_GUEST_EMAIL_CANDIDATES_CONNECTION_SHAPE);
  } catch (err) {
    logger.error({ err }, "Failed to resolve member-guest candidates for an admin");
    // AUDITED BEFORE RETURNING, for the same rider. A lookup that blew up is
    // still a lookup that was attempted, and the envelope hides the failure from
    // the caller — so without this row the trail would show nothing at all for
    // the one class of request most worth being able to find later.
    await auditMemberGuestResolve({
      request,
      actorMemberId,
      email,
      candidates: [],
      outcome: "failure",
    });
    return connectionJson(request, { candidates: [] }, ADMIN_MEMBER_GUEST_EMAIL_CANDIDATES_CONNECTION_SHAPE);
  }
}

/**
 * The NAME mode — a fragment, in the query string, gated on `membership:view`.
 * Also the AI app action `search_member_guest_candidates` (ALP-719).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Path-derived: `/api/admin/bookings/...` on a GET resolves to bookings:view,
  // which is the floor for looking at anything on a booking at all. The name
  // mode then asks for more, below.
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const actorMemberId = guard.session.user.id;
  await params;

  const gate = await loadMemberGuestFindGate({ requiresOpenSearch: false });
  if (!gate.ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Rider (a). The name mode — and only the name mode — needs the directory.
  if (
    !hasAdminAreaAccess(guard.session.user, {
      area: "membership",
      level: "view",
    })
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Every `q` parses (an optional string); a missing one is the empty fragment.
  const query = adminMemberGuestNameQuerySchema.safeParse({
    q: request.nextUrl.searchParams.get("q") ?? undefined,
  });
  const rawQ = ((query.success ? query.data.q : undefined) ?? "").slice(
    0,
    MEMBER_GUEST_SEARCH_Q_MAX_CHARS,
  );

  try {
    const result = await searchMemberGuestCandidatesByName({
      q: rawQ,
      settings: gate.settings,
      // D-20: an officer's search is not bound by the club's member-facing
      // minors switch. This route says WHO is asking; the find service decides
      // what that means for discoverability, so this file never turns a privacy
      // setting into an age-tier filter of its own.
      audience: "ADMIN",
    });
    await auditMemberGuestSearch({
      request,
      actorMemberId,
      q: rawQ,
      resultCount: result.candidates.length,
      truncated: result.truncated === true,
    });
    return connectionJson(request, result, ADMIN_MEMBER_GUEST_NAME_CANDIDATES_CONNECTION_SHAPE);
  } catch (err) {
    logger.error({ err }, "Failed to search member-guest candidates for an admin");
    const empty = { candidates: [], truncated: false };
    return connectionJson(request, empty, ADMIN_MEMBER_GUEST_NAME_CANDIDATES_CONNECTION_SHAPE);
  }
}
