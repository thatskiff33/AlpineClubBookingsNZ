import type { AgeTier } from "@prisma/client";
import { BOOKABLE_AGE_TIER_VALUES } from "@/lib/age-tier-schema";

/**
 * The pure half of MG3's "find a member to add as a guest" (epic #2305, #2308):
 * how a typed string is classified, how a name query is turned into a prefix
 * match, which age tiers are offered, and what a candidate row is allowed to
 * carry.
 *
 * DATABASE-FREE ON PURPOSE. Both find routes, the wizard's find panel and the
 * tests read these rules from one place, so the privacy envelope — what a
 * candidate row shows, and what it must never show — is a single reviewable
 * object rather than a shape reassembled at three call sites.
 *
 * The security model this file implements is stated in full, without softening,
 * in `docs/guides/bookings-setup.md` and in the PR that introduced it: with open
 * member search ON, the club's member name list is DELIBERATELY BROWSABLE by any
 * member who can start a booking. Nothing here makes it unbrowsable; the
 * setting's whole purpose is to make it browsable. What these rules do is make
 * bulk harvesting slow and noisy (prefix-only matching, a two-character floor, a
 * ten-row cap, no total count) rather than one request — and every query is
 * rate-limited and audited against the member who typed it.
 */

/** The only fields a candidate row may carry (owner decision D-19). */
export interface MemberGuestCandidate {
  memberId: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
}

/** The uniform envelope BOTH find routes answer with, in every outcome. */
export interface MemberGuestCandidateResponse {
  candidates: MemberGuestCandidate[];
  /**
   * Only ever `true` on the name search, and only ever a boolean: a COUNT here
   * would be a free membership-size oracle ("showing 10 of 47" tells every
   * member how many Smiths the club has). The UI renders a fixed sentence.
   */
  truncated?: boolean;
}

/** The empty answer. Not-found, all-inactive, under-min and no-such-member all return this. */
export const EMPTY_MEMBER_GUEST_CANDIDATES: MemberGuestCandidateResponse = Object.freeze({
  candidates: Object.freeze([]) as unknown as MemberGuestCandidate[],
});

/**
 * The shortest name fragment the search will run a query for.
 *
 * Mirrors `MIN_SEARCH_CHARS` in `src/components/address-autocomplete.tsx`. A
 * one-character query on a prefix match returns roughly a twenty-sixth of the
 * roll in one request, which is the difference between "browsable if you work at
 * it" and "downloadable".
 */
export const MEMBER_GUEST_SEARCH_MIN_CHARS = 2;

/** How many rows the name search will ever return. */
export const MEMBER_GUEST_SEARCH_RESULT_CAP = 10;

/** The longest `q` fragment stored on an audit row (see `member-guest-find` auditing). */
export const MEMBER_GUEST_SEARCH_AUDIT_Q_MAX_CHARS = 64;

/**
 * The tiers the club treats as under-18 for the open-search sub-setting (D-20).
 */
export const MEMBER_GUEST_CANDIDATE_MINOR_TIERS: readonly AgeTier[] = Object.freeze([
  "INFANT",
  "CHILD",
  "YOUTH",
]) as readonly AgeTier[];

/**
 * The age tiers a member-guest candidate may be offered in, before the minors
 * sub-setting is applied — derived from the repo's own definition of a bookable
 * tier so that a new tier added to the schema flows here automatically.
 *
 * DECLARED DEVIATION FROM THE FINAL v2 PLAN §3.2, and it is a correctness fix
 * rather than a preference. The plan said `NOT_APPLICABLE` "is not a minor and
 * stays in". But `bookableAgeTierEnum` already excludes it everywhere else, and
 * `resolveLinkedMemberRecords` (`booking-guests.ts`) refuses an age-exempt
 * account as a booking guest outright — "This account is age-exempt (N/A) and
 * cannot be added as a booking guest". Offering one here would hand the booker a
 * candidate that can NEVER be added.
 *
 * (This justification used to have a second half — that the refusal such a
 * candidate produces is a distinct 400 and so would be a new way to tell one
 * refusal from another. That was already false when it was written, because THIS
 * SAME RELEASE collapses that refusal for a beyond-family target,
 * `booking-guests.ts`'s `collapseForMemberIds`. Deleted rather than reworded:
 * the first ground stands on its own, and a stale justification is how somebody
 * later "restores" the plan's rule believing nothing depends on it.)
 *
 * Excluding the tier at the finder discloses nothing: age tier is a static
 * property of the ACCOUNT TYPE that the candidate row already shows, not a piece
 * of eligibility STATE, so it cannot be probed for information the way a
 * subscription or a booked night can. That is the whole reason it is safe to
 * filter on here while §3.1's "resolve never branches on eligibility" rule
 * stands.
 */
export const MEMBER_GUEST_CANDIDATE_ADULT_TIERS: readonly AgeTier[] = Object.freeze(
  BOOKABLE_AGE_TIER_VALUES.filter(
    (tier) => !MEMBER_GUEST_CANDIDATE_MINOR_TIERS.includes(tier),
  ),
) as readonly AgeTier[];

/**
 * Which age tiers the OPEN NAME SEARCH may return.
 *
 * D-20 as decided: the minors sub-toggle gates the type-ahead ONLY. A minor
 * stays directly resolvable by their household email address in the email mode,
 * which is the consequence the owner accepted when D-9 made any active member
 * resolvable by email.
 */
export function memberGuestSearchAgeTiers(includeMinors: boolean): AgeTier[] {
  return includeMinors
    ? [...MEMBER_GUEST_CANDIDATE_ADULT_TIERS, ...MEMBER_GUEST_CANDIDATE_MINOR_TIERS]
    : [...MEMBER_GUEST_CANDIDATE_ADULT_TIERS];
}

/**
 * Which age tiers the EMAIL RESOLVE may return: every bookable tier, minors
 * included, whatever the sub-setting says (D-20).
 */
export function memberGuestResolveAgeTiers(): AgeTier[] {
  return [
    ...MEMBER_GUEST_CANDIDATE_ADULT_TIERS,
    ...MEMBER_GUEST_CANDIDATE_MINOR_TIERS,
  ];
}

/**
 * What the booker typed, classified into which path answers it.
 *
 * Owner sign-off answer 2 (31 Jul 2026): ONE box that takes either. If the text
 * parses as an email address it is resolved exactly by the email path;
 * otherwise it searches names. There is no mode switch in the UI.
 *
 * THE CLASSIFIER IS "CONTAINS AN @", not "is a valid email address", and the
 * difference matters. A booker who types `sam.whittaker@exampl` has plainly
 * typed half an address, and searching NAMES for it would return nothing with
 * no explanation of why — the trap the owner explicitly asked not to ship. So a
 * string containing `@` is always an email intent; if it is not a well-formed
 * address the caller renders the same fixed "no bookable member found" sentence
 * WITHOUT a server call, which is neither a new oracle (it says nothing about
 * any member) nor a new privacy surface.
 */
export type MemberGuestFindIntent =
  | { kind: "EMAIL"; email: string; wellFormed: boolean }
  | { kind: "NAME"; q: string }
  | { kind: "EMPTY" };

// Deliberately permissive and deliberately NOT a validation authority: the
// route re-parses with zod's own email rule. This exists to answer "did the
// member mean an address?", which is a UX question, not a security one.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function classifyMemberGuestFindInput(raw: string): MemberGuestFindIntent {
  const text = raw.trim();
  if (!text) return { kind: "EMPTY" };
  if (text.includes("@")) {
    return {
      kind: "EMAIL",
      email: normalizeMemberGuestEmail(text),
      wellFormed: EMAIL_SHAPE.test(text),
    };
  }
  return { kind: "NAME", q: text };
}

/**
 * The email normalisation, character for character the same as
 * `member-partner-link.ts`'s exact-email resolve.
 *
 * Sharing the rule matters more than sharing the code here: two normalisers
 * that disagree by a `.toLowerCase()` would make the same address resolve on
 * one surface and not the other, and the member would have no way to tell why.
 */
export function normalizeMemberGuestEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A name query, split into the prefix terms the search matches on.
 *
 * PREFIX-ONLY, NEVER `contains`. A two-character `contains` query would return
 * most of the roll in one request — "an" matches Alexander, Duncan, Hannah,
 * Sandra and Joanna — which turns the ten-row cap into a decoration and the
 * daily cap into the only control. Prefixes make harvesting proportional to the
 * alphabet rather than to two keystrokes.
 *
 * A space splits the query into "first name starts with A **and** last name
 * starts with B", so "sam whitt" narrows to one person rather than returning
 * everyone called Sam plus everyone called Whittaker.
 *
 * THE FIRST AND LAST TOKENS, not "before and after the first space" (correctness
 * review, LOW-4). Splitting on the first space made "anna maria smith" mean
 * `lastName startsWith "maria smith"`, which matches nobody at all — including
 * Anna Maria Smith, the person being typed. Taking the first token as the
 * first-name prefix and the LAST as the last-name prefix handles middle names
 * without weakening anything: it is still prefix-only, still two terms, still
 * never `contains`.
 */
export type MemberGuestSearchTerms =
  | { kind: "SINGLE"; prefix: string }
  | { kind: "FIRST_AND_LAST"; firstPrefix: string; lastPrefix: string };

export function parseMemberGuestSearchQuery(
  raw: string,
): { ok: true; terms: MemberGuestSearchTerms; normalized: string } | { ok: false } {
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (normalized.length < MEMBER_GUEST_SEARCH_MIN_CHARS) {
    return { ok: false };
  }

  // "sam " (a trailing space) is one term, not a term plus an empty one — an
  // empty prefix matches EVERYONE, which is the whole roll in one request.
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length <= 1) {
    return {
      ok: true,
      terms: { kind: "SINGLE", prefix: tokens[0] ?? normalized },
      normalized,
    };
  }

  return {
    ok: true,
    terms: {
      kind: "FIRST_AND_LAST",
      firstPrefix: tokens[0],
      lastPrefix: tokens[tokens.length - 1],
    },
    normalized,
  };
}

/**
 * Trim a search fragment for storage on an audit row.
 *
 * The audit trail records what a member typed, because probe detection needs it
 * (R2 in the plan). It does NOT need an unbounded string: 64 characters is more
 * than any real name and short enough that the high-volume retention class stays
 * cheap.
 */
export function truncateSearchQueryForAudit(q: string): string {
  return q.slice(0, MEMBER_GUEST_SEARCH_AUDIT_Q_MAX_CHARS);
}

/**
 * Apply the ten-row cap to a page that was deliberately fetched one row over.
 *
 * Fetching `cap + 1` and reporting a boolean is the only way to know there was
 * more without asking the database for a COUNT — and a COUNT is the number this
 * design refuses to produce.
 */
export function capMemberGuestCandidates(
  rows: readonly MemberGuestCandidate[],
  cap: number = MEMBER_GUEST_SEARCH_RESULT_CAP,
): MemberGuestCandidateResponse {
  const truncated = rows.length > cap;
  return { candidates: rows.slice(0, cap).map(toMemberGuestCandidate), truncated };
}

/**
 * Narrow a member row to the four fields a candidate may carry.
 *
 * Written as an explicit projection rather than a `select` alone so that a
 * future `select` that grows a field cannot leak it: the row is re-shaped on the
 * way out, and this function is what the tests assert against.
 */
export function toMemberGuestCandidate(row: {
  id?: string;
  memberId?: string;
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
}): MemberGuestCandidate {
  return {
    memberId: row.memberId ?? row.id ?? "",
    firstName: row.firstName,
    lastName: row.lastName,
    ageTier: row.ageTier,
  };
}

/**
 * Should the client select this result without the booker clicking?
 *
 * The owner's "auto resolves in the dropdown": exactly one candidate AND nothing
 * hidden behind the cap. Auto-selecting out of a truncated set would silently
 * pick one of many.
 */
export function shouldAutoResolveMemberGuestCandidate(
  response: MemberGuestCandidateResponse,
): boolean {
  return response.candidates.length === 1 && response.truncated !== true;
}

/** Two candidates a booker cannot tell apart from the fields they are shown. */
export function hasIndistinguishableMemberGuestCandidates(
  candidates: readonly MemberGuestCandidate[],
): boolean {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.firstName.toLowerCase()}\u0000${candidate.lastName.toLowerCase()}\u0000${candidate.ageTier}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

// ---------------------------------------------------------------------------
// The member-facing copy, in one place so a test can pin it
// ---------------------------------------------------------------------------

/**
 * Every sentence the find panel can show, exactly as the signed-off mockup
 * (`docs/member-guests/mockups/find-and-add.html`) writes it.
 *
 * Pinned by a test, because three of these are load-bearing privacy copy: the
 * empty-result sentence must stay the SAME sentence whatever the real reason,
 * the truncation sentence must never grow a count, and the same-name hint must
 * keep pointing at the email address rather than offering a distinguishing
 * field the booker never had.
 */
export const MEMBER_GUEST_FIND_COPY = Object.freeze({
  emailLabel: "Find a member by email address",
  eitherLabel: "Find a member by name or email address",
  emailHint:
    "You need the address they use for the club. We don't list members here — if you don't have it, ask them for it.",
  eitherHint:
    "Type a name to search, or paste their email address to go straight to them.",
  noEmailMatch: "No bookable member found for that email.",
  noEmailMatchHelp: "Check the spelling, or ask them which address the club has for them.",
  noNameMatch: "No members match that name.",
  truncated: "Keep typing to narrow this down.",
  sameName: "Two members match that name — use their email address to be sure.",
  /**
   * The same-name hint for the EMAIL mode, where the mockup's sentence would be
   * circular: the booker has just typed the address it tells them to use (UX
   * review, finding F8). Two people at one address with the same name and age
   * group genuinely cannot be told apart from what a row may show (D-19), so
   * this points at the only person who can tell them apart.
   */
  sameNameEmail:
    "Two members at that address have the same name — ask them or the club which one to add.",
  rateLimited: "Too many searches — try again shortly.",
  networkError: "That didn't work. Try again in a moment.",
  minChars: "Type at least two letters.",
  /**
   * What a name typed into the DEFAULT (email-only) box gets told (UX review,
   * finding F7). Before this, typing a name with open search off did literally
   * nothing — no request, no message, an inert Enter key — which is the exact
   * trap the owner's sign-off answer 2 was chosen to avoid, in the mode every
   * club gets on day one.
   */
  nameSearchOff:
    "This club doesn't list members by name. Enter their email address to find them.",
  searching: "Searching…",
  /**
   * The honest next step under D-8's neutral refusal — the mockup's panel-13
   * sentence, which was drawn and signed off but never shipped (UX review,
   * finding F9). It says the only two true things available: the club will not
   * say why, and there are two people who can.
   */
  refusalHelp: "If you think that's wrong, ask them directly, or contact the club.",
  /** Why "Add to booking" is disabled on a chip, so it is never silently dead. */
  alreadyAdded: "Already on this booking",
  atCapacity: "This booking is already full",
} as const);

/**
 * "Three members use that address. Which one are you adding?" — the mockup's
 * panel-5 sentence.
 *
 * This is the ONE place a count is allowed, and the exception proves the rule
 * elsewhere: the number counts rows the booker is looking at, at an address the
 * booker already typed. It reveals nothing they are not about to read. The name
 * search's truncation sentence carries no count for exactly the opposite reason —
 * there the number would describe rows the booker is NOT being shown.
 */
const CANDIDATE_COUNT_WORDS = [
  "No",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
] as const;

export function describeHouseholdCandidatePrompt(count: number): string {
  const word =
    count >= 0 && count < CANDIDATE_COUNT_WORDS.length
      ? CANDIDATE_COUNT_WORDS[count]
      : String(count);
  return `${word} members use that address. Which one are you adding?`;
}

/**
 * May THIS reader search members by NAME on a booking's guest surface?
 *
 * MG4 (#2309). ONE FUNCTION FOR BOTH READERS, because the bug it exists to
 * close was two answers to one question. The booking page decided the flag from
 * `bookings:VIEW` while the edit panel decided which routes to call from
 * `bookings:EDIT`, and a real, shipped persona sits between them — a read-only
 * bookings viewer:
 *
 *  - holding `membership:view`, they were handed the name type-ahead while the
 *    panel sent them down the MEMBER routes, where the name search 404s unless
 *    the club turned open search on. A search box that silently fails.
 *  - without it, they lost the name search on a club that had deliberately
 *    turned it on for every member — including them.
 *
 * So the caller passes ONE `actingAsAdmin`, the same value that chooses the
 * routes, and whoever is not in admin mode is a member for this purpose and
 * gets exactly the club's member-facing answer.
 *
 * DECORATION ONLY, on both branches. This decides which box is DRAWN; the
 * routes re-read the module, the setting and the permission themselves, so a
 * browser that flips this in its own memory gets a 404 rather than a directory.
 * That is why it takes three plain booleans rather than the settings object:
 * this is not the place either open-search value becomes a decision about who
 * is discoverable — `loadMemberGuestFindGate` and
 * `searchMemberGuestCandidatesByName` still are, and a census test enforces it.
 */
export function resolveMemberGuestNameSearchAccess(params: {
  /** Is this viewer in admin mode — i.e. does the panel call the ADMIN routes? */
  actingAsAdmin: boolean;
  /** `membership:view`. D-20 rider (a): the #1376 officer falls back to exact email. */
  hasMembershipView: boolean;
  /** The club's member-facing "members may search by name" setting. */
  clubNameSearchEnabled: boolean;
}): boolean {
  return params.actingAsAdmin
    ? params.hasMembershipView
    : params.clubNameSearchEnabled;
}
