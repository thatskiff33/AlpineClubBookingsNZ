import { NextRequest, NextResponse } from "next/server";
import logger from "@/lib/logger";
import {
  auditMemberGuestSearch,
  loadMemberGuestFindGate,
  searchMemberGuestCandidatesByName,
} from "@/lib/member-guest-find-service";
import { MEMBER_GUEST_SEARCH_Q_MAX_CHARS } from "@/lib/member-guest-find";
import { applyMemberScopedRateLimit, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSession } from "@/lib/session-guards";
import { connectionJson } from "@/lib/mcp-connection-request";
import { MEMBER_GUEST_CANDIDATES_CONNECTION_SHAPE } from "@/lib/connection-shapes";

/**
 * `GET /api/members/guest-candidates/search?q=` — MG3's open name type-ahead
 * (epic #2305, #2308, owner decision MG3-D-b).
 *
 * **THIS ROUTE ONLY EXISTS WHEN A CLUB HAS DELIBERATELY TURNED IT ON.** Module
 * off, or `openMemberSearchEnabled` off, and it answers 404 exactly as any
 * unknown path would. Turning the setting off makes it disappear again
 * immediately — the gate is a settings read per request, not a build-time flag —
 * which is asserted by a test, because a privacy switch that needs a redeploy to
 * take effect is not a switch.
 *
 * **THE HONEST SECURITY MODEL, WHICH IS NOT SOFTENED ANYWHERE.** With open
 * member search ON, the club's member name list is **deliberately browsable** by
 * any member who can start a booking. A member can type "a", "b", "c" and page
 * through most of the roll. That is the owner's accepted trade (MG3-D-b), it is
 * a per-club choice, and it ships OFF. The remaining controls are:
 *
 *   1. the rate limit (a burst window and a real daily cap);
 *   2. the audit trail — every query is recorded against the member who typed
 *      it, so probing is detectable after the fact;
 *   3. the ten-row cap plus prefix-only matching, which makes bulk harvesting
 *      slow and noisy rather than one request;
 *   4. the minors exclusion, on by default.
 *
 * **No control makes the list unbrowsable; the setting's whole purpose is to
 * make it browsable.** The admin toggle says so in those words, and so does the
 * documentation.
 *
 * A GET is correct here where it was wrong for the email route: a name fragment
 * is not another member's contact detail, and the type-ahead needs the ordinary
 * request semantics.
 *
 * Also the AI app action `search_members_for_guest` (ALP-795), with the same
 * gate, limits (per member, shared with the browser; the address backstop
 * counts per connection) and audit row. A connection is sent
 * the candidate envelope's allow-listed fields only: never a contact detail
 * or a date of birth.
 */
export async function GET(request: NextRequest) {
  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const actorMemberId = guard.session.user.id;

  const gate = await loadMemberGuestFindGate({ requiresOpenSearch: true });
  if (!gate.ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Bounded before it is read anywhere: an unbounded query string would be
  // stored (truncated) on an audit row and matched against an index.
  const rawQ = (request.nextUrl.searchParams.get("q") ?? "").slice(
    0,
    MEMBER_GUEST_SEARCH_Q_MAX_CHARS,
  );

  const burst = await applyMemberScopedRateLimit(
    rateLimiters.memberGuestSearch,
    request,
    actorMemberId,
  );
  if (burst) {
    await auditMemberGuestSearch({
      request,
      actorMemberId,
      q: rawQ,
      resultCount: 0,
      truncated: false,
      outcome: "blocked",
    });
    return burst;
  }

  const daily = await applyMemberScopedRateLimit(
    rateLimiters.memberGuestSearchDaily,
    request,
    actorMemberId,
  );
  if (daily) {
    await auditMemberGuestSearch({
      request,
      actorMemberId,
      q: rawQ,
      resultCount: 0,
      truncated: false,
      outcome: "blocked",
    });
    return daily;
  }

  try {
    // The whole settings object goes through, not a flag read here: both
    // open-search decisions live in `loadMemberGuestFindGate`'s file, so this
    // route obeys and never decides. See that function's note.
    const result = await searchMemberGuestCandidatesByName({
      q: rawQ,
      settings: gate.settings,
    });

    // EVERY query is audited, including the under-minimum ones that never
    // touched the database. A run of one-character probes is precisely the shape
    // an admin would want to find later, and it would be invisible if only
    // queries that ran a SELECT were recorded.
    await auditMemberGuestSearch({
      request,
      actorMemberId,
      q: rawQ,
      resultCount: result.candidates.length,
      truncated: result.truncated === true,
    });

    return connectionJson(request, result, MEMBER_GUEST_CANDIDATES_CONNECTION_SHAPE);
  } catch (err) {
    logger.error({ err }, "Failed to search member-guest candidates by name");
    return NextResponse.json({ candidates: [], truncated: false });
  }
}
