import type { AgeTier } from "@prisma/client";
import { createStructuredAuditLog, getAuditRequestContext } from "@/lib/audit";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import logger from "@/lib/logger";
import { MEMBER_GUEST_MODULE_KEY } from "@/lib/member-guest-consent";
import {
  MEMBER_GUEST_SEARCH_RESULT_CAP,
  capMemberGuestCandidates,
  memberGuestResolveAgeTiers,
  memberGuestSearchAgeTiers,
  normalizeMemberGuestEmail,
  parseMemberGuestSearchQuery,
  toMemberGuestCandidate,
  truncateSearchQueryForAudit,
  type MemberGuestCandidateResponse,
} from "@/lib/member-guest-find";
import {
  loadMemberGuestSettings,
  type MemberGuestSettingsValues,
} from "@/lib/member-guest-settings";
import { prisma } from "@/lib/prisma";
import {
  isDeletedAccountRecord,
  notDeletedAccountWhere,
} from "@/lib/deleted-account";

/**
 * The database half of MG3's member finder (#2308): the two resolution paths and
 * the audit rows they write.
 *
 * THE SINGLE MOST IMPORTANT PROPERTY IN THIS FILE, and the one a reviewer should
 * check first: **neither path evaluates eligibility.** No profile-completeness
 * gate, no subscription check, no person-night check, no "already in your party"
 * filter. That is deliberate and it is what stops the finder becoming an
 * eligibility oracle: it cannot leak whether a member could be booked, because it
 * never asks. Every refusal happens later, at add/quote/create time, collapsed
 * into D-8's one neutral sentence.
 *
 * The only filters either path applies are `active: true` and the age tier — both
 * static properties of the account rather than state that varies by date, so
 * neither can be probed for information. See
 * `MEMBER_GUEST_CANDIDATE_ADULT_TIERS` for why the age-exempt tier is excluded.
 *
 * THE ENVELOPE IS ALWAYS 200 AND ALWAYS THE SAME SHAPE. Not found, all-inactive,
 * no such member and a query below the minimum all return `{ candidates: [] }`.
 * The server never sends a reason string; the UI renders one fixed sentence from
 * the empty array. That is strictly stronger than the partner-link precedent's
 * 404/403/422 split, which this deliberately does not copy — and note that the
 * precedent is still there: `POST /api/members/partner-link`'s own email path
 * answers the same kind of question with more detail and only IP-keyed limiting.
 * The uniform envelope is a property of THIS surface, not of the application.
 *
 * ONE CONSEQUENCE OF "NEVER EVALUATE ELIGIBILITY", recorded because it is a real
 * divergence rather than an oversight (correctness review, LOW-5). The family
 * quick-add row on the guests step hides a family member whose profile is
 * incomplete (`canBeBooked === false`); the finder, resolving that same person by
 * their household address, offers them. So there are two routes to one person
 * that behave differently. That is the price of the rule above — a `canBeBooked`
 * check here would be exactly the client-side eligibility oracle the design
 * exists to avoid, and it would have to run for strangers too. It is recoverable
 * rather than a trap: the add is refused at quote time with the profile gate's
 * own detailed, actionable message, because the person IS in the booker's family
 * and D-8's collapse does not apply to them.
 */

/** What the module + settings gate decided for one request. */
export type MemberGuestFindGate =
  | { ok: true; settings: MemberGuestSettingsValues }
  /** The module is off, or open search is off on a search request: the route does not exist. */
  | { ok: false };

/**
 * Read the module flag and the policy singleton for a find request.
 *
 * MODULE OFF ⇒ THE ROUTE DOES NOT EXIST (404), never 403. A 403 confirms that
 * the club HAS the feature and merely disabled it for you, which is a fact about
 * the club that an unauthorised caller has no business learning; a 404 is the
 * same answer any unknown path gives. The same reasoning applies to the name
 * search when open search is off.
 */
export async function loadMemberGuestFindGate(params: {
  requiresOpenSearch: boolean;
}): Promise<MemberGuestFindGate> {
  if (!(await isEffectiveModuleEnabled(MEMBER_GUEST_MODULE_KEY))) {
    return { ok: false };
  }
  const settings = await loadMemberGuestSettings();
  if (params.requiresOpenSearch && !settings.openMemberSearchEnabled) {
    return { ok: false };
  }
  return { ok: true, settings };
}

/**
 * Resolve every ACTIVE member at one exact email address (owner decision D-9 as
 * ticked).
 *
 * D-9 was taken against the recommendation: any active member is resolvable,
 * login-holders and non-login members alike, minors included. Households
 * routinely share one address, so this legitimately returns several people and
 * the UI disambiguates. What it discloses is the composition of a household at
 * an address THE BOOKER ALREADY POSSESSED — it reveals nothing about anybody
 * else's address — and that is exactly the trade the owner accepted.
 *
 * The booker's own row and members already in their party are returned rather
 * than filtered out. Filtering server-side would leak "this person is already on
 * your booking" by ABSENCE; the client disables those rows instead, which is
 * harmless because the booker already knows their own party.
 */
export async function resolveMemberGuestCandidatesByEmail(params: {
  email: string;
}): Promise<MemberGuestCandidateResponse> {
  const email = normalizeMemberGuestEmail(params.email);

  const rows = await prisma.member.findMany({
    where: {
      email,
      active: true,
      AND: notDeletedAccountWhere(),
      ageTier: { in: memberGuestResolveAgeTiers() },
    },
    select: { id: true, firstName: true, lastName: true, ageTier: true,
      email: true,
      deletedAt: true, },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
  });

  return { candidates: rows.filter((row) => !isDeletedAccountRecord(row))
      .map(toMemberGuestCandidate), };
}

/**
 * The open name type-ahead (MG3-D-b), reachable only when a club has turned it
 * on.
 *
 * PREFIX-ONLY MATCHING, CAPPED AT TEN, NEVER A COUNT. See
 * `parseMemberGuestSearchQuery` for why `contains` is not an option here, and
 * `MemberGuestCandidateResponse.truncated` for why the overflow is a boolean.
 *
 * Ordering is `lastName, firstName, id` so the cap is deterministic: an unstable
 * order would let the same query return different tenths of the roll on repeat,
 * which is a slow way of paging past the cap.
 */
export type MemberGuestSearchAudience = "MEMBER" | "ADMIN";

export async function searchMemberGuestCandidatesByName(params: {
  q: string;
  /**
   * Who is searching, and therefore whether the club's minors switch applies.
   *
   * MG4 (#2309), owner decision D-20. Defaults to `"MEMBER"`, which is the
   * behaviour every caller had before MG4: the type-ahead shows children only
   * where a club has opted them in. `"ADMIN"` ignores the switch, because an
   * officer holding `membership:view` can already see every member including
   * minors from `/admin/members`, and a member-facing privacy setting is not an
   * access-control mechanism — pressing it into service as one would leave a
   * club that later turns name search ON with no way to say "browsable to
   * officers, not to members".
   *
   * THE AUDIENCE IS DECIDED HERE RATHER THAN BY THE ADMIN ROUTE, and that is the
   * whole reason this parameter exists instead of the route simply passing a
   * doctored settings object. This file is the ONE place either open-search
   * value becomes a decision about who is discoverable; a route that forced the
   * minors flag itself would be a second such place, which is exactly how two
   * surfaces come to disagree about whether the roll is browsable. A dedicated
   * census test asserts the property directly.
   */
  audience?: MemberGuestSearchAudience;
  /**
   * The whole settings object, NOT a pre-read `includeMinors` boolean.
   *
   * Taking the settings and reading the flag here keeps BOTH open-search
   * decisions — "does this route exist" and "are children in the list" — inside
   * this one file. A route that read `openMemberSearchIncludesMinors` itself
   * would be a second place that turns a stored privacy value into a decision
   * about who is discoverable, and two such places is how two surfaces come to
   * disagree about whether the roll is browsable. `member-guest-widening.test.ts`
   * asserts this directly.
   */
  settings: MemberGuestSettingsValues;
}): Promise<MemberGuestCandidateResponse> {
  const parsed = parseMemberGuestSearchQuery(params.q);
  if (!parsed.ok) {
    // Under the two-character floor: no query is issued at all. Still audited by
    // the caller — a run of one-character probes is exactly the shape the audit
    // trail exists to make visible.
    return { candidates: [], truncated: false };
  }

  const ageTiers: AgeTier[] = memberGuestSearchAgeTiers(
    params.audience === "ADMIN" ||
      params.settings.openMemberSearchIncludesMinors,
  );
  const insensitive = { mode: "insensitive" } as const;

  const nameFilter =
    parsed.terms.kind === "SINGLE"
      ? {
          OR: [
            { firstName: { startsWith: parsed.terms.prefix, ...insensitive } },
            { lastName: { startsWith: parsed.terms.prefix, ...insensitive } },
          ],
        }
      : {
          AND: [
            { firstName: { startsWith: parsed.terms.firstPrefix, ...insensitive,
              }, },
            { lastName: { startsWith: parsed.terms.lastPrefix, ...insensitive }, },
          ],
        };

  const rows = await prisma.member.findMany({
    where: { active: true, ageTier: { in: ageTiers },
      AND: notDeletedAccountWhere(), ...nameFilter, },
    select: { id: true, firstName: true, lastName: true, ageTier: true,
      email: true,
      deletedAt: true, },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
    // One row over the cap, so "there were more" is knowable without a COUNT.
    take: MEMBER_GUEST_SEARCH_RESULT_CAP + 1,
  });

  return capMemberGuestCandidates(rows.filter((row) => !isDeletedAccountRecord(row))
      .map(toMemberGuestCandidate),);
}

// ---------------------------------------------------------------------------
// Auditing — every query, in both modes, including the empty and blocked ones
// ---------------------------------------------------------------------------

/**
 * AWAITED, NOT FIRE-AND-FORGET (privacy re-review of MG3 #2308, LOW-4).
 *
 * Both writers below used to be `void createStructuredAuditLog(...)`, which
 * returns before the row exists. On a runtime that can freeze or recycle the
 * worker once the response is flushed, a detached insert is not a guarantee of
 * anything — and with open member search ON, this audit trail is one of only
 * FOUR controls standing between a deliberately browsable membership roll and a
 * quiet harvest. A control that silently drops rows under load is worse than one
 * that is honestly absent, because nobody goes looking.
 *
 * Still FAIL-OPEN: the promise's rejection is caught and logged here, so a
 * failed audit write can never turn into a failed lookup — the same rule
 * `recordMemberGuestAddRefusal` follows, and that one is awaited too.
 */

export const MEMBER_GUEST_RESOLVE_AUDIT_ACTION = "member_guest.resolve_email";
export const MEMBER_GUEST_SEARCH_AUDIT_ACTION = "member_guest.search";

/**
 * Record an email resolve.
 *
 * THE FULL ADDRESS IS STORED, DELIBERATELY, and this is a disclosure the PR body
 * and the admin guide both state plainly: **an admin reading the audit log will
 * see the email addresses members typed into the finder.** The
 * `getAuditEmailDomain` reduction used elsewhere is not enough here, because the
 * whole purpose of this row is to answer "who looked up which address" — a
 * domain cannot distinguish probing one household from probing forty.
 *
 * `subject.memberId` is set only when exactly ONE candidate came back. On a
 * household hit the row records the lookup without naming any of the people at
 * that address: writing one row per candidate would turn a single lookup into a
 * permanent list of who lives together, which is more than the lookup itself
 * disclosed.
 */
export async function auditMemberGuestResolve(params: {
  request: Request;
  actorMemberId: string;
  email: string;
  candidates: readonly { memberId: string }[];
  outcome?: "success" | "blocked" | "failure";
}): Promise<void> {
  const { request, actorMemberId, email, candidates } = params;
  await createStructuredAuditLog({
    action: MEMBER_GUEST_RESOLVE_AUDIT_ACTION,
    actor: { memberId: actorMemberId },
    subject: {
      memberId: candidates.length === 1 ? candidates[0]!.memberId : null,
    },
    category: "privacy",
    severity: "info",
    outcome: params.outcome ?? "success",
    summary: "A member looked up another member by email address to add as a guest",
    metadata: {
      email: normalizeMemberGuestEmail(email),
      resultCount: candidates.length,
    },
    request: getAuditRequestContext(request),
    retentionClass: "sensitive_access",
  }).catch((err) => {
    logger.error({ err }, "Failed to audit a member-guest email resolve");
  });
}

/**
 * Record a type-ahead query — EVERY query, including under-minimum ones, empty
 * results and rate-limited rejections.
 *
 * `diagnostic_high_volume` retention (ninety days) is the right class and exists
 * for exactly this: with a 300 ms debounce, a two-character floor and the daily
 * cap, the worst case is a few hundred short-lived rows per member per day. The
 * fragment is truncated to 64 characters — enough to see what was being hunted,
 * short enough not to become a text store.
 *
 * No `subject.memberId` is written even on a single hit: a search that returned
 * one person was still a SEARCH, and recording it as a lookup of that person
 * would misrepresent what happened to whoever reads the log later.
 */
export async function auditMemberGuestSearch(params: {
  request: Request;
  actorMemberId: string;
  q: string;
  resultCount: number;
  truncated: boolean;
  outcome?: "success" | "blocked" | "failure";
}): Promise<void> {
  const { request, actorMemberId, q, resultCount, truncated } = params;
  await createStructuredAuditLog({
    action: MEMBER_GUEST_SEARCH_AUDIT_ACTION,
    actor: { memberId: actorMemberId },
    category: "privacy",
    severity: "info",
    outcome: params.outcome ?? "success",
    summary: "A member searched the membership by name to add a guest",
    metadata: {
      q: truncateSearchQueryForAudit(q),
      resultCount,
      truncated,
    },
    request: getAuditRequestContext(request),
    retentionClass: "diagnostic_high_volume",
  }).catch((err) => {
    logger.error({ err }, "Failed to audit a member-guest name search");
  });
}
