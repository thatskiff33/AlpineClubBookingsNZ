import { NextRequest, NextResponse } from "next/server";
import { parseJsonRequestBody } from "@/lib/api-json";
import logger from "@/lib/logger";
import {
  auditMemberGuestResolve,
  loadMemberGuestFindGate,
  resolveMemberGuestCandidatesByEmail,
} from "@/lib/member-guest-find-service";
import {
  equaliseMemberGuestRefusalTiming,
  startMemberGuestRefusalClock,
} from "@/lib/member-guest-probe-guard";
import { applyMemberScopedRateLimit, rateLimiters } from "@/lib/rate-limit";
import { requireActiveSession } from "@/lib/session-guards";
import { memberGuestResolveBodySchema } from "@/lib/member-guest-find";
import { connectionJson } from "@/lib/mcp-connection-request";
import { MEMBER_GUEST_CANDIDATES_CONNECTION_SHAPE } from "@/lib/connection-shapes";

/**
 * `POST /api/members/guest-candidates/resolve` — MG3's exact-email member
 * finder (epic #2305, #2308). The mode every club gets on day one.
 *
 * **POST, not GET, and the method is load-bearing.** A GET would put another
 * member's email address into the URL, and from there into the access log, the
 * browser history, the `Referer` header of anything the page later loads, and
 * any proxy in between. A POST body goes to none of those.
 *
 * **Module OFF ⇒ 404**, never 403 — see `loadMemberGuestFindGate`.
 *
 * **ALWAYS 200 WITH THE SAME SHAPE** when the module is on. Not found,
 * all-inactive and no-such-member all return `{ candidates: [] }`; the server
 * never sends a reason, and the UI renders one fixed sentence. Nothing about
 * eligibility is evaluated here — see `member-guest-find-service.ts` for why
 * that is the single most important property of the design.
 *
 * **THE RESPONSE FLOOR.** Every answer, including the empty one, is held to the
 * same minimum duration as a collapsed cross-family refusal. Without it the
 * empty answer would be reliably the fast one — one indexed query against the
 * several a populated answer runs downstream — and the uniform envelope would be
 * defeated by a stopwatch. It narrows the channel rather than closing it, and
 * says so where it is defined.
 *
 * Also the AI app action `find_member_by_email` (ALP-795), run as a read: it
 * changes no member's data, writing only its own audit row and its rate-limit
 * counters. The per-member limits are shared
 * with the member's browser, the address backstop counts per connection, and
 * a connection is sent the candidate fields only.
 */
export async function POST(request: NextRequest) {
  const startedAt = startMemberGuestRefusalClock();

  const guard = await requireActiveSession();
  if (!guard.ok) return guard.response;
  const actorMemberId = guard.session.user.id;

  const gate = await loadMemberGuestFindGate({ requiresOpenSearch: false });
  if (!gate.ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // L1 (privacy review): the body is read and the address extracted BEFORE the
  // rate-limit check, so a blocked resolve records what was being looked up.
  // Recording `email: ""` on the most suspicious rows in the table — the ones
  // where somebody burned a whole budget — was the opposite of what the audit
  // trail is for, and it contradicted this service's own docblock. The search
  // route already reads `q` first; this makes the two symmetric.
  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = memberGuestResolveBodySchema.safeParse(json.body);
  const attemptedEmail =
    typeof (json.body as { email?: unknown } | null)?.email === "string"
      ? ((json.body as { email: string }).email.trim().slice(0, 320))
      : "";

  const rateLimited =
    (await applyMemberScopedRateLimit(
      rateLimiters.memberGuestResolve,
      request,
      actorMemberId,
    )) ??
    // M3 (privacy review): a daily backstop. Without one, 20 per 15 minutes is
    // 1,920 lookups per member per day on the DEFAULT-ON mode — nearly five
    // times the budget of the opt-in browsable one.
    (await applyMemberScopedRateLimit(
      rateLimiters.memberGuestResolveDaily,
      request,
      actorMemberId,
    ));
  if (rateLimited) {
    // A member who hits the cap is exactly the signal the audit trail exists
    // for, so the rejection is recorded rather than dropped.
    await auditMemberGuestResolve({
      request,
      actorMemberId,
      email: attemptedEmail,
      candidates: [],
      outcome: "blocked",
    });
    return rateLimited;
  }

  if (!parsed.success) {
    // A malformed address is a client mistake, not a fact about any member, so
    // it may answer honestly — and it must not be an oracle either, which is
    // why it carries no candidate array at all.
    //
    // L2 (privacy review): still audited, with `outcome: "failure"`, as plan
    // §3.5 specifies. A run of malformed probes is a pattern an admin should be
    // able to find, and it was previously the one resolve outcome that left no
    // trace at all.
    await auditMemberGuestResolve({
      request,
      actorMemberId,
      email: attemptedEmail,
      candidates: [],
      outcome: "failure",
    });
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }

  try {
    const result = await resolveMemberGuestCandidatesByEmail({
      email: parsed.data.email,
    });

    await auditMemberGuestResolve({
      request,
      actorMemberId,
      email: parsed.data.email,
      candidates: result.candidates,
    });

    await equaliseMemberGuestRefusalTiming(startedAt);
    return connectionJson(request, result, MEMBER_GUEST_CANDIDATES_CONNECTION_SHAPE);
  } catch (err) {
    logger.error({ err }, "Failed to resolve member-guest candidates by email");
    // Even the failure keeps the envelope: a 500 on the "member exists" path and
    // a 200 on the "does not" path would be the crudest possible oracle.
    await equaliseMemberGuestRefusalTiming(startedAt);
    return NextResponse.json({ candidates: [] });
  }
}
