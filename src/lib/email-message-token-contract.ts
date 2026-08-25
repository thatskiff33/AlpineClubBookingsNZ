/**
 * #2268 — the guards over the shipped email default bodies.
 *
 * The guard these replace was circular. `email-message-registry.test.ts` ran
 * `validateEmailTemplateContent` over every default body, which looks like an
 * unknown-token check; but the per-template `allowedTokens` it validates
 * against is itself built by scraping tokens out of that same default body
 * (`extractTokensFromDefaults`). Any token you put in a default was allowed
 * *because* you put it there, so the check could never fail on a default. Its
 * only teeth were against admin-authored overrides.
 *
 * Everything below takes the registries it checks as ARGUMENTS rather than
 * reading module state, so the tests can run each guard against a deliberately
 * broken fixture and prove it actually bites.
 */

export interface EmailTemplateDefaults {
  defaultSubject: string;
  defaultBody: string;
}

export interface TemplateFinding {
  key: string;
  field: "defaultSubject" | "defaultBody";
  detail: string;
}

const TOKEN_PATTERN = /\{\{([^{}]+)\}\}/g;

/**
 * Tokens whose send site may legitimately supply an EMPTY value, per template.
 *
 * This is the honest half of the contract and it is maintained BY HAND: each
 * entry was read off the sender during #2268 (a `?? ""`, a nullable column, an
 * `amountCents: number | null`). Nothing derives it, and — be precise about
 * what that means — guard 4 (`findDanglingDefaultLines`) only exercises the
 * tokens DECLARED here: it renders each declared token empty and checks no
 * line dangles. An optional value a sender supplies but nobody declares is
 * rendered with its non-empty preview sample instead, so guard 4 CANNOT catch
 * an undeclared optional; only guard 5 keeps the declared names honest in the
 * other direction (declared but no longer in the body). The declaration
 * discipline is therefore: whenever a send site starts supplying a value that
 * can be empty (`?? ""`, nullable column, conditional composition), record it
 * here in the same change — this table is the single place that turns guard 4
 * on for that token.
 */
export const OPTIONAL_TEMPLATE_TOKENS: Record<string, readonly string[]> = {
  // #2267 (F1): the promo block and the split-parent sentence are both
  // pre-composed and both empty on an ordinary confirmation. The door-code
  // line (#2267) is composed whole by the sender and empty for a lodge with
  // no code recorded — declared here so guard 4 proves the default body
  // survives its absence (it was live-but-undeclared until the #2320 review).
  // #2328: {{creditNote}} is deliberately NOT listed HERE. It is optional in
  // exactly the same sense (empty for every booking that used no account
  // credit), but guard 5 requires a declared token to appear in the default body
  // it claims to describe, and this one does not: the shipped body carries the
  // credit lines inside {{paymentOutcome}}, which the sender composes. That is
  // precisely the shape EMPTYABLE_OVERRIDE_TOKENS below was added for, and it is
  // declared there instead.
  "booking-confirmed": [
    "promoSummary",
    "provisionalGuestsNote",
    "doorCodeNote",
    // Fork issue #35: the add-to-calendar block is a fail-open decoration —
    // empty only when the sender could not build the links (missing auth
    // secret), so guard 4 proves the default body survives without it.
    "ical",
  ],
  // The credit-restored sentence is composed whole by the sender and empty
  // when no applied credit was restored (#1164 D7) — declared for the same
  // reason as booking-confirmed's doorCodeNote above.
  "booking-cancelled": ["creditRestoredMessage"],
  "booking-modified": ["paymentNote"],
  // #2268 sweep. Each of these was an "[only when …]" annotated line.
  "checkin-reminder": ["choreListNote"],
  // #2350 adds a third: the outstanding-additional-payment sentence is composed
  // whole by the sender and empty whenever nothing is owed, which is the
  // ordinary case — declared here so guard 4 proves the body survives without
  // it (the declaration discipline described above).
  // #2621 ADDS {{checkoutChoreNote}} here — and here rather than in
  // EMPTYABLE_OVERRIDE_TOKENS, because it IS in the shipped default body, which
  // is the property that separates the two tables (guard 5 requires it, guard 6
  // forbids it). Owner decision D-M5's checkout-day chore sentence is composed
  // by `checkoutDayChoreNote` and is EMPTY for a club whose chores module is off
  // — which is the default and the ordinary case — so guard 4 has real work to
  // do here: it proves the shipped body still reads correctly with no chore
  // sentence at all.
  "pre-arrival-reminder": [
    "expectedArrivalNote",
    "checkoutChoreNote",
    "doorCodeNote",
    "outstandingAdditionalNote",
  ],
  // A roster only exists for chores that exist, so the chore block itself is
  // never empty; the completion link is (a roster can be sent without one).
  "chore-roster": ["choreLinkNote"],
  "membership-application-approved": ["committeeNote"],
  "membership-application-rejected": ["committeeNote"],
  "child-request-rejected": ["adminNoteLine"],
  "family-group-create-rejected": ["adminNoteLine"],
  "membership-cancellation-submitted": ["reasonNote"],
  "membership-cancellation-approved": [
    "reasonNote",
    "adminNoteLine",
    "rejoinProcessNote",
  ],
  "membership-cancellation-rejected": ["reasonNote", "adminNoteLine"],
  "admin-membership-cancellation-request": ["reasonNote"],
  "account-deletion-rejected": ["adminNoteLine"],
  "admin-account-deletion-requested": ["reasonNote"],
  "member-archive-approved": ["reviewNoteLine"],
  "member-archive-rejected": ["reviewNoteLine"],
  "admin-member-delete-approved": ["reviewNoteLine"],
  "admin-member-delete-rejected": ["reviewNoteLine"],
  "admin-new-booking": ["reviewReasonNote"],
  "admin-refund-request": ["requestedAmountNote"],
  "admin-booking-change-request": ["reasonNote"],
  "admin-xero-repeated-failure": [
    "localRecordNote",
    "latestErrorNote",
    "xeroLinksNote",
  ],
  "refund-request-approved": ["adminNotesLine"],
  "refund-request-declined": ["adminNotesLine"],
  "booking-request-declined": ["reasonNote"],
  "split-guest-portion-cancelled": ["bookingReferenceNote"],
  "booking-review-approved": ["adminNotesLine"],
  "booking-review-rejected": ["adminNotesLine"],
  "membership-payment-recorded": ["amountRecordedNote"],
};

/**
 * #2269 — tokens a send site can supply EMPTY that are no longer in the current
 * default body, so only a SAVED OVERRIDE can still be using them.
 *
 * OPTIONAL_TEMPLATE_TOKENS above cannot hold these: guard 5
 * (`findStaleOptionalTokens`) requires every name declared there to appear in
 * the default it describes, and by construction none of these do — they are the
 * legacy per-piece tokens the defaults stopped using when #2263/#2267 moved to
 * pre-composed blocks. The senders still supply them, precisely so an override
 * written against an older default keeps rendering.
 *
 * WHY THIS EXISTS AT ALL. #2269's migration strips the "[only when …]" notes
 * out of saved overrides. On three real shipped defaults those notes were
 * padded onto money lines:
 *
 *   Subtotal: {{subtotal}}                  [only when discountCents > 0]
 *   Discount ({{promoCode}}): -{{discount}} [only when promoCode exists]
 *   Discount: -{{discount}}                 [only when discount exists ...]
 *
 * The brackets were the only thing telling an admin those lines were
 * conditional. Once they are gone the row renders "Discount (): -" on an
 * ordinary booking and "Discount (PEAK): -" on a promo that RAISED the price —
 * the #2267 incident verbatim — and nothing would say a word. Declaring the
 * tokens here is what turns guard 4 on for them, so the editor names the exact
 * broken lines instead.
 *
 * Maintained BY HAND — but NOT unpoliced (#2269 review). GUARD 6
 * (`findUnsupportedEmptyableTokens`) below holds every entry to the three
 * properties that make the declaration meaningful: the key is a registered
 * template, the token is still SUPPLIED for that template (so it is in
 * EXTRA_TEMPLATE_TOKENS, which is also what keeps it approved and gives it a
 * preview sample), and the token is NOT in the current default body (a token
 * that comes back into a default belongs in OPTIONAL_TEMPLATE_TOKENS, under
 * guard 5). Every entry below was additionally read off its sender in
 * src/lib/email/booking.ts, and every one of them is a literal `""` or `?? ""`
 * on some branch — that last part is the half a guard cannot check, so it is
 * the half the discipline is for.
 *
 * ONE KNOWN IMPRECISION, recorded rather than hidden: guard 4 renders every
 * declared token empty AT ONCE, while {{totalPaid}} / {{totalDue}} are two
 * halves of one money story and no real send empties both. On an unpaid
 * confirmation {{totalPaid}} is empty; on a fully paid one {{totalDue}} is;
 * and on a PARTLY paid one (#2397) NEITHER is, because both are true. An
 * override that put both on one line is therefore reported as dangling when it
 * is not. The error only ever runs that way — it over-reports, never
 * under-reports — and the trade is deliberate: "Total Paid: {{totalPaid}}"
 * alone is the line the pre-#2263 default shipped and it really does render
 * "Total Paid:" on an unpaid booking, so leaving the pair undeclared would miss
 * a live defect to avoid a cosmetic one. The report is advisory and quotes the
 * exact rendered line, so an admin can see for themselves — and
 * docs/guides/email-messages.md says so in the same words, because the admin
 * reading the warning is the person who needs to know it can be over-eager.
 */
export const EMPTYABLE_OVERRIDE_TOKENS: Record<string, readonly string[]> = {
  // sendBookingConfirmedEmail: subtotal/promoAdjustment are "" when no promo
  // applied, discount is "" unless the adjustment is a price CUT, promoCode is
  // `?? ""`, and totalPaid/totalDue are the two halves of one story — exactly
  // one of them is "" on every send.
  //
  // #2328 adds {{creditNote}}, which belongs here rather than in
  // OPTIONAL_TEMPLATE_TOKENS for exactly the reason this table exists: it is
  // supplied on every send, is "" for the great majority of bookings (which use
  // no account credit), and is NOT in the current default body — the shipped
  // body carries the credit lines inside {{paymentOutcome}}, which the sender
  // composes. Only a hand-built override can put the bare token on a line, and
  // a label typed in front of it ("Credit: {{creditNote}}") sends a bare
  // "Credit:" to everyone who paid without credit. Declaring it is what turns
  // guard 4 on for that line.
  //
  // #2444 adds {{paymentDueNote}} on the same three grounds. #2263 supplied it
  // without declaring it here: the sender emits it only when the confirmation
  // is CONFIRMED-BUT-UNPAID and `""` on every paid, partly-paid and
  // credit-covered send (src/lib/email/booking.ts), it is listed in
  // EXTRA_TEMPLATE_TOKENS rather than written into the default body (which
  // carries it inside {{paymentOutcome}}), and an override that labels it
  // ("Payment: {{paymentDueNote}}") therefore ships a bare "Payment:" to
  // everyone who has already paid. #2444 is what makes the token carry the
  // club's payment instructions, so the warning is worth having now.
  "booking-confirmed": [
    "subtotal",
    "discount",
    "promoCode",
    "promoAdjustment",
    "totalPaid",
    "totalDue",
    "creditNote",
    "paymentDueNote",
  ],
  // sendBookingModifiedEmail: each of these is `?? ""` when the change did not
  // involve an additional payment.
  "booking-modified": [
    "additionalPaymentMethod",
    "paymentReference",
    "xeroInvoiceNumber",
  ],
  // #2307: {{guestLastName}} is supplied DELIBERATELY EMPTY (surnames on their
  // own cannot be shown truthfully), so any override line built around it alone
  // renders a bare label.
  "checkin-reminder": ["guestLastName"],
};

export function extractTokens(value: string): string[] {
  return Array.from(value.matchAll(TOKEN_PATTERN), (match) =>
    match[1].trim(),
  ).filter(Boolean);
}

/**
 * GUARD 1 — no authoring annotation may survive in a shipped default.
 *
 * The admin editor pre-fills its textarea with `defaultBody` and stores what it
 * is given verbatim, so anything in square brackets reaches a real inbox the
 * first time a club saves that template. Cheap, and permanent.
 */
export function findBracketAnnotations(
  defaults: Record<string, EmailTemplateDefaults>,
): TemplateFinding[] {
  const findings: TemplateFinding[] = [];
  for (const [key, entry] of Object.entries(defaults)) {
    for (const field of ["defaultSubject", "defaultBody"] as const) {
      // Token braces are the only legitimate markup; anything bracketed is an
      // authoring note, because the render path has no syntax of its own.
      const matches = entry[field].match(/\[[^\]]*\]/g);
      if (matches) {
        findings.push({ key, field, detail: matches.join(" | ") });
      }
    }
  }
  return findings;
}

/**
 * #2269 (F3) — the EXACT authoring annotations this project ever SHIPPED
 * inside a default subject or body.
 *
 * Guard 1 above treats ANY square-bracketed span as an authoring note, which is
 * the right rule for a save-time refusal and for a "your row still carries
 * junk" banner: the admin is told, and the admin decides. It is the WRONG rule
 * for a migration that rewrites club-authored content without asking. A club
 * that typed "[see the noticeboard]" into its own wording wrote that on
 * purpose; deleting it silently is the "forced reset destroys legitimate
 * customisation" failure mode #2269 exists to avoid.
 *
 * WHY LITERAL STRINGS AND NOT A PREFIX FAMILY (owner decision, #2269 review).
 * The first cut of this matched a prefix family — anything opening "[only when",
 * "[when", "[heading becomes" or "[falls back to". Three reviewers reproduced
 * real club prose being destroyed by it, and a word boundary only fixed two of
 * the three:
 *
 *   "Ring the bell [whenever you arrive after 8pm]."          prefix match
 *   "the hut sits on [whenua administered by the rūnanga]"    prefix match
 *   "Ring the lodge [when you are 30 minutes away]."          SURVIVES a
 *                                                            boundary fix
 *
 * The last one is ordinary New Zealand alpine-club wording that a boundary can
 * never tell apart from "[when dates did not change]", because it genuinely is
 * the same shape. What decides it is that the damage is NOT RECOVERABLE in the
 * product: the editor refuses to save square brackets (#2320), so a club whose
 * wording we delete by mistake cannot paste it back — only a DBA reading the
 * audit row can. A rule that can be wrong must not be the one that writes.
 *
 * So the migration strips only the exact strings we ourselves shipped. The list
 * below is the complete set, recovered by replaying EVERY historical revision
 * of `email-message-registry.ts`, `email-message-audit-defaults.ts` and
 * `email-message-notes.ts` across every ref, extracting every bracketed span
 * that appears on a non-comment line, and un-escaping the TypeScript string
 * literals. 38 distinct spans, all four families, none containing a `]` or a
 * newline. Guard 1 above fails the registry test if an annotation is ever put
 * back into a shipped default, so the list cannot fall behind the code.
 *
 * THE ACCEPTED COST, stated plainly because it is a real one: a club that
 * reflowed the whitespace INSIDE a shipped annotation, or retyped it with a
 * different word, keeps it. That row is not healed by this migration. It is not
 * abandoned either — #2320's bracket banner and #2269's per-template indicator
 * both still name it, and an admin resolves it deliberately. That is the same
 * choice made everywhere else in this change: an ambiguous case goes to a
 * person, never to a script.
 */
export const SHIPPED_ANNOTATIONS: readonly string[] = [
  "[falls back to \"your school group's stay\" when no school name is recorded]",
  "[heading becomes \"Reminder: Confirm Your Attendee List\" on reminders]",
  "[only when a door code is set]",
  "[only when additional payment is due]",
  "[only when adminNote exists]",
  "[only when adminNotes exists]",
  "[only when adminNotes is non-empty]",
  "[only when changeFeeCents > 0]",
  "[only when choreLink exists]",
  "[only when chores exist]",
  "[only when dates changed]",
  "[only when discount exists without promoCode]",
  "[only when discountCents > 0]",
  "[only when familyMemberCount > 0]",
  "[only when guest count changed]",
  "[only when localUrl exists]",
  "[only when non-member guests are held provisionally as a split linked booking]",
  "[only when payment is still owing - states the amount owing and the internet-banking reference {{paymentReference}}]",
  "[only when promoCode exists]",
  "[only when provided]",
  "[only when reason exists]",
  "[only when rejoinProcessText exists]",
  "[only when requestedAmountCents is truthy]",
  "[only when reviewNote exists]",
  "[only when reviewReason exists]",
  "[only when the booking is already paid]",
  "[only when the booking is confirmed but payment is still owing]",
  "[only when the club has a recorded fee amount for this season]",
  "[only when total changed]",
  "[only when xeroObjectUrl exists]",
  "[only when your own linked booking reference is available]",
  "[when dates did not change]",
  "[when guest count did not change]",
  "[when the automatic refund could not complete inline: the refund could not complete and a durable recovery operation is queued — the payment recovery cron will retry it with backoff; watch the recovery queue and confirm the refund lands. Failure detail: {{errorMessage}}]",
  "[when the member's own linked booking is also unpaid: no payment link is sent and a human must chase payment for the whole booking, because the guest portion must not settle ahead of the member's own place]",
  "[when the member's own linked booking is not settled: the member's own linked booking is not settled either (it may be unpaid or already cancelled), so review the whole booking]",
  "[when total did not change]",
  "[when your own linked booking is not settled: your own linked booking has not been changed by this cancellation]",
];

/** Escape a literal so it matches itself in both JS and PostgreSQL ARE. */
function escapeForBothRegexEngines(value: string): string {
  // Punctuation only. Backslash before an ALPHANUMERIC is an error in ARE, so
  // this must never touch letters or digits.
  return value.replace(/[\\^$.|?*+()[\]{}]/g, (character) => `\\${character}`);
}

/**
 * One shipped authoring annotation, as an alternation of the exact strings
 * above — e.g. "[only when a door code is set]".
 *
 * Case-sensitive and whitespace-exact on purpose: this matches the text this
 * project shipped, not an approximation of it. There are no wildcards at all,
 * so it cannot reach a club's own bracketed wording however similar it looks.
 *
 * Sorted longest-first. No entry is a prefix of another (the test asserts it),
 * so leftmost-first alternation in JavaScript and PostgreSQL ARE's preference
 * for the longest match cannot disagree; the ordering makes that independent of
 * the assertion rather than reliant on it. Ties break by CODE POINT, not
 * `localeCompare`, because this exact byte sequence is also written into the
 * migration SQL and a locale-dependent order would make that parity depend on
 * the machine the generator ran on.
 */
export const SHIPPED_ANNOTATION_PATTERN = `(?:${[...SHIPPED_ANNOTATIONS]
  .sort(
    (left, right) =>
      right.length - left.length ||
      (left < right ? -1 : left > right ? 1 : 0),
  )
  .map(escapeForBothRegexEngines)
  .join("|")})`;

/**
 * The strip, as an ORDERED list of regex sources, each applied globally with an
 * EMPTY replacement.
 *
 * This exact list is what the #2269 migration runs: the migration defines the
 * annotation alternation once, builds these six pass patterns from it, and
 * `email-message-annotation-strip.test.ts` reads the SQL file back, rebuilds
 * the patterns the SQL will actually use, proves they equal this list, and runs
 * the fixture corpus through the ones lifted OUT OF THE SQL. Every construct
 * used here means the same thing in PostgreSQL's ARE engine and in
 * JavaScript's — verified against postgres:16:
 *
 *   `(?=\n|$)`        lookahead; `$` is end-of-STRING in both (no n/m flag)
 *   `(?<=\n)`         fixed-width lookbehind
 *   `(?:…)+`          non-capturing group with a greedy repeat
 *   `^`               start-of-STRING in both (no n/m flag)
 *
 * Deliberately NOT used: `\b` / `\y`, which do not mean the same thing in
 * the two engines and so cannot live in a shared pattern string.
 *
 * Why six passes rather than one:
 *
 *   1. a run of whole-line annotations sitting between two BLANK lines takes
 *      one of the blank lines with it, or the paragraph break either side would
 *      add up to a stray empty line in the delivered email;
 *   2. the same, for a run at the very start of the value;
 *   3. any remaining annotation that occupies a whole line takes the line with
 *      it, so a stripped body does not grow a blank line where a note sat;
 *   4. the same, for an annotation on the very first line;
 *   5. an annotation with content before it on the line takes the whitespace
 *      that separated it — the defaults padded them into a column
 *      ("Subtotal: {{subtotal}}          [only when discountCents > 0]"), and
 *      leaving that padding behind would be its own trailing-whitespace defect;
 *   6. whatever is left is an annotation at the start of a line with content
 *      after it, which takes the whitespace that follows instead.
 *
 * Order matters twice: 1 before 3 and 2 before 4 (the blank-line-aware forms
 * are strictly more specific), and 5 before 6, or a padded end-of-line
 * annotation would be removed by 6 and leave its padding as trailing
 * whitespace.
 */
export const SHIPPED_ANNOTATION_STRIP_PATTERNS: readonly string[] = [
  `(?<=\\n)(?:\\n[ \\t]*${SHIPPED_ANNOTATION_PATTERN}[ \\t\\r]*)+\\n(?=\\n)`,
  `^(?:[ \\t]*${SHIPPED_ANNOTATION_PATTERN}[ \\t\\r]*\\n)+\\n`,
  `\\n[ \\t]*${SHIPPED_ANNOTATION_PATTERN}[ \\t\\r]*(?=\\n|$)`,
  `^[ \\t]*${SHIPPED_ANNOTATION_PATTERN}[ \\t\\r]*\\n`,
  `(?<=[^ \\t\\r\\n])[ \\t]*${SHIPPED_ANNOTATION_PATTERN}`,
  `${SHIPPED_ANNOTATION_PATTERN}[ \\t]*`,
];


/** Every shipped annotation present in a value, in the order they appear. */
export function findShippedAnnotations(value: string): string[] {
  return Array.from(
    value.matchAll(new RegExp(SHIPPED_ANNOTATION_PATTERN, "g")),
    (match) => match[0],
  );
}

/**
 * Remove every shipped authoring annotation from a stored template value.
 *
 * Idempotent by construction: the output contains no span matching
 * SHIPPED_ANNOTATION_PATTERN, so a second run matches nothing and returns its
 * input unchanged. A value with no shipped annotation is returned as-is
 * (identity), which is what lets the migration write an audit row only for rows
 * it genuinely changed.
 */
export function stripShippedAnnotations(value: string): string {
  return SHIPPED_ANNOTATION_STRIP_PATTERNS.reduce(
    (current, pattern) => current.replace(new RegExp(pattern, "g"), ""),
    value,
  );
}

/**
 * #2269 (second review) — the lines a shipped annotation was MARKING, read off
 * the value as it stood BEFORE the strip.
 *
 * Guard 4 cannot see these. It renders tokens and inspects the result, so a
 * conditional line with NO token in it is structurally invisible to it, and
 * `findDanglingDefaultLines` additionally exempts anything ending in `:` as a
 * heading. Replaying every historical revision of the default modules turns up
 * ten such lines, and they are not marginal:
 *
 *   "Payment has been processed successfully."   [only when the booking is already paid]
 *   "Your arrival day chores:"                   [only when chores exist]
 *   "This only affects your guests' provisional place — your own booking is
 *    unaffected and remains confirmed."          [when your own linked booking is not settled: …]
 *
 * The first of those, rendered on a booking that still owes money, reads
 * "Payment has been processed successfully." immediately above "Please pay
 * $240.00 using reference ACB-1234". Before the migration the bracket itself
 * made the editor say something ("bracket_annotation"); after it, nothing did.
 *
 * So the signal is derived from what the migration REMOVED rather than from
 * re-detecting a marker we deleted: the migration records the previous wording
 * per row in its audit metadata, and this function turns that wording back into
 * the exact lines that are now unconditional.
 *
 * A line whose annotation occupied the WHOLE line is not reported — the strip
 * takes the line with it, so nothing new is sent. Only a line that keeps
 * content after the strip is a line that now goes out every time.
 *
 * Applied per line on purpose: the multi-line passes (1-4) delete whole lines
 * and would shift the line numbering, and what an admin needs to read is what
 * THIS line became. Passes 5 and 6 are the only ones that can fire on a lone
 * line with content, which is exactly the case being reported.
 */
export function findUnconditionalLines(value: string): string[] {
  const lines: string[] = [];
  for (const line of value.split("\n")) {
    if (findShippedAnnotations(line).length === 0) continue;
    const stripped = stripShippedAnnotations(line).trimEnd();
    if (stripped.trim() === "") continue;
    if (!lines.includes(stripped)) lines.push(stripped);
  }
  return lines;
}

/**
 * GUARD 2 — every token in a shipped default must be in the APPROVED registry.
 *
 * Not circular: the approved set is a hand-maintained list in
 * `email-message-registry.ts`, not something scraped back out of the defaults.
 * A default that introduces a token nobody approved fails here, and would
 * otherwise be a token the admin editor rejects on the very body it shipped.
 */
export function findUnapprovedDefaultTokens(
  defaults: Record<string, EmailTemplateDefaults>,
  approvedTokens: ReadonlySet<string>,
): TemplateFinding[] {
  const findings: TemplateFinding[] = [];
  for (const [key, entry] of Object.entries(defaults)) {
    for (const field of ["defaultSubject", "defaultBody"] as const) {
      const unapproved = extractTokens(entry[field]).filter(
        (token) => !approvedTokens.has(token),
      );
      if (unapproved.length > 0) {
        findings.push({ key, field, detail: unapproved.sort().join(", ") });
      }
    }
  }
  return findings;
}

/**
 * GUARD 3 — every token a send site supplies for override use must be APPROVED.
 *
 * This is exactly the state `{{promoAdjustment}}` was in before #2267: the
 * value was computed correctly and passed to the renderer, the registry allowed
 * it for that template, and the editor still rejected it as an unknown token,
 * so no admin could ever use it. Runs over the extra-token map, which is where
 * a supplied-but-not-in-the-body token is declared.
 */
export function findUnapprovedSuppliedTokens(
  extraTokens: Partial<Record<string, readonly string[]>>,
  approvedTokens: ReadonlySet<string>,
): TemplateFinding[] {
  const findings: TemplateFinding[] = [];
  for (const [key, tokens] of Object.entries(extraTokens)) {
    const unapproved = (tokens ?? []).filter(
      (token) => !approvedTokens.has(token),
    );
    if (unapproved.length > 0) {
      findings.push({
        key,
        field: "defaultBody",
        detail: unapproved.sort().join(", "),
      });
    }
  }
  return findings;
}

/**
 * GUARD 4 — no default body may leave a dangling line when an OPTIONAL token
 * renders empty.
 *
 * This is the invariant the bracket annotations were standing in for, and the
 * one that actually matters to a member: `Door code: {{doorCode}}` on a lodge
 * with no door code, or `Requested: {{requestedAmount}}` on an appeal that
 * named no figure, renders a label with nothing after it. Every default is
 * rendered here with its optional tokens EMPTY and everything else filled from
 * the editor's own preview samples, then every line is checked.
 */
export function findDanglingDefaultLines(
  defaults: Record<string, EmailTemplateDefaults>,
  optionalTokens: Record<string, readonly string[]>,
  sampleFor: (token: string) => string,
): TemplateFinding[] {
  const findings: TemplateFinding[] = [];
  for (const [key, entry] of Object.entries(defaults)) {
    const optional = new Set(optionalTokens[key] ?? []);
    const render = (value: string) =>
      value.replace(TOKEN_PATTERN, (_match, rawToken: string) => {
        const token = rawToken.trim();
        return optional.has(token) ? "" : sampleFor(token);
      });

    for (const field of ["defaultSubject", "defaultBody"] as const) {
      const bad: string[] = [];
      // Compared line by line against the template, because a line that ENDS
      // in a colon in the template is a heading for the block beneath it
      // ("Guest list:", "Reason:") and is perfectly fine. What is never fine
      // is a line that had content after the label in the template and lost it
      // in the render — "Door code: {{doorCode}}" becoming "Door code:".
      for (const templateLine of entry[field].split("\n")) {
        const renderedLine = render(templateLine).trimEnd();
        const labelPattern = /[-:–—]$/;
        if (
          labelPattern.test(renderedLine) &&
          !labelPattern.test(templateLine.trimEnd())
        ) {
          bad.push(renderedLine);
          continue;
        }
        // A possessive left without its noun ("'s stay at …" when no school
        // name is recorded).
        if (/(^|\s)'s\b/.test(renderedLine)) {
          bad.push(renderedLine);
        }
      }
      if (bad.length > 0) {
        findings.push({
          key,
          field,
          detail: bad.map((line) => JSON.stringify(line)).join(" | "),
        });
      }
    }
  }
  return findings;
}

/**
 * GUARD 5 — an optional-token declaration must name tokens that are actually in
 * the default it claims to describe, so the contract cannot rot into a list of
 * names that no longer appear anywhere.
 */
export function findStaleOptionalTokens(
  defaults: Record<string, EmailTemplateDefaults>,
  optionalTokens: Record<string, readonly string[]>,
): TemplateFinding[] {
  const findings: TemplateFinding[] = [];
  for (const [key, tokens] of Object.entries(optionalTokens)) {
    const entry = defaults[key];
    if (!entry) {
      findings.push({
        key,
        field: "defaultBody",
        detail: "no such registered template",
      });
      continue;
    }
    const present = new Set([
      ...extractTokens(entry.defaultSubject),
      ...extractTokens(entry.defaultBody),
    ]);
    const stale = tokens.filter((token) => !present.has(token));
    if (stale.length > 0) {
      findings.push({ key, field: "defaultBody", detail: stale.join(", ") });
    }
  }
  return findings;
}

/**
 * GUARD 6 — EMPTYABLE_OVERRIDE_TOKENS must stay a description of reality.
 *
 * #2269 added a SECOND hand-maintained token table, and the whole reason #2268
 * built this module is that hand-maintained token tables rot. Guard 5 polices
 * OPTIONAL_TEMPLATE_TOKENS; nothing policed this one, so its own comment's
 * claim to be kept "under the same discipline" was not true (#2269 second
 * review). This is that discipline.
 *
 * Three properties, each of them checkable, and each of them a way the table
 * has a live consequence — the admin editor runs guard 4 over a SAVED override
 * with every name declared here rendered empty:
 *
 *   1. the key names a REGISTERED template, or the declaration describes
 *      nothing at all;
 *   2. the token is still SUPPLIED for that template, which for a token that is
 *      by construction absent from the default body means it is listed in
 *      EXTRA_TEMPLATE_TOKENS. That listing is also what keeps the token in
 *      `allowedTokens` (so an override using it stays re-savable) and what
 *      gives it a preview sample. A name that falls out of there is a name the
 *      sender has stopped supplying, and guard 4 would then be reporting a line
 *      as conditionally-empty when it is unconditionally empty — a different,
 *      worse fault that `retired_token` already covers;
 *   3. the token is NOT in the current default subject or body. If a later
 *      release puts it back, the declaration belongs in
 *      OPTIONAL_TEMPLATE_TOKENS, where guard 5 keeps it honest and where the
 *      shipped default itself is held to rendering cleanly without it.
 *
 * What no guard can check is the honest half — that the sender really can emit
 * the value EMPTY. That stays a reading of the send site, recorded in the
 * table's comment, and it is why the table is prose-documented per entry.
 */
export function findUnsupportedEmptyableTokens(
  defaults: Record<string, EmailTemplateDefaults>,
  extraTokens: Partial<Record<string, readonly string[]>>,
  emptyableTokens: Record<string, readonly string[]>,
): TemplateFinding[] {
  const findings: TemplateFinding[] = [];
  for (const [key, tokens] of Object.entries(emptyableTokens)) {
    const entry = defaults[key];
    if (!entry) {
      findings.push({
        key,
        field: "defaultBody",
        detail: "no such registered template",
      });
      continue;
    }
    const supplied = new Set(extraTokens[key] ?? []);
    const inDefault = new Set([
      ...extractTokens(entry.defaultSubject),
      ...extractTokens(entry.defaultBody),
    ]);
    const detail: string[] = [];
    for (const token of tokens) {
      if (!supplied.has(token)) {
        detail.push(`${token} is not supplied by this template any more`);
      }
      if (inDefault.has(token)) {
        detail.push(
          `${token} is back in the default body — declare it in OPTIONAL_TEMPLATE_TOKENS instead`,
        );
      }
    }
    if (detail.length > 0) {
      findings.push({ key, field: "defaultBody", detail: detail.join(", ") });
    }
  }
  return findings;
}
