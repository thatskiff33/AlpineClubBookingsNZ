# Single source of truth

Audience: Developer, Agent.

Prefix defined in this file: **`INV-SSOT`** — a fact is defined once and read
from that one place. What the repository already requires of documentation, and
enforces there with `pnpm run docs:indexcheck`, these rules require of code.

Read this file when you are about to add a constant, helper, formatter, type,
validation rule or configuration value; when you are writing a guard, a census
or a ratchet; or when two places in the tree need the same answer.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

The operational test an agent applies in the moment — search first, route to the
existing one, and prefer making the wrong thing unrepresentable over policing it
— is in [`AGENTS.md`](../../AGENTS.md) → "Change discipline" → "Single source of
truth". It is stated there rather than here because `AGENTS.md` is read on every
task and this file is routed. This file holds the citable rules; that section
holds the habit.

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused.

## INV-SSOT-001

- **One canonical definition per concept.** A constant, helper, formatter, type,
  validation rule or configuration value has exactly one home, which every
  other place imports. If two places need the same fact, move it to one module
  — never copy it.
- **The test is a change, not an appearance.** Similar lines are not a
  violation; two places that must both be edited to change one fact are, and
  the fix is the move, not the second edit.
- **A second FORM of one fact is not a second source of truth — a second
  DEFINITION is.** Callers needing one fact shaped differently get one
  definition with two derivations. A shared helper is the usual remedy, not a
  universal one: one contorted to serve two shapes is the same failure. Ask
  _where is this fact DEFINED_, not _how many functions mention it_.
- **A per-site exclusion list is itself a source of truth**: one list, in the
  module owning the fact it excludes. A shrinking list is a ratchet; publish
  what makes it shrink.
- **Prefer a structural remedy.** A required argument beats a lint rule; one
  exported symbol beats an allowlist; a deleted default parameter beats a
  counted ratchet. Use a guard only when no structural option exists, and say
  which one you rejected and why.
- **An accepted exception lasts only while its reason is alive; retiring one
  needs a measurement, not an argument.** A convergence onto one home changes
  an identity, which is proved rather than reasoned about: pins against the
  separate copies come FIRST (#3218).
- Recorded homes: `promo-stored-guest-targets.ts` (#3131), `stable-digest.ts`
  (#3218), `hasIssuedPrimaryXeroInvoice` (#3200) — no bookings API route reads
  `Payment.xeroInvoiceId` directly
  (`issued-primary-xero-invoice-one-home.test.ts`).
- **Known exceptions.** The admin promo-codes client reads the guest-scope
  default inline twice (recorded in `promo-guest-scope.ts`, pending
  #2850/#2851). `getPromoTargetBookingGuestIds` repeats the stored-guest
  index-to-id mapping through another key (#3163): two definitions, not two
  FORMS, cross-referenced as mitigation, not a fix. That agent-taken default
  stands until the owner overturns it; unifying them needs no further
  permission than that.
- **No canonical-homes registry** (owner, 26 Aug 2026): a second copy of a
  helper or constant is not caught mechanically and stays on human review,
  narrowed by `INV-SSOT-003` and the review lens in
  [`SUBAGENT_GUIDE.md`](../agents/SUBAGENT_GUIDE.md).

History, measurements and rejected alternatives: #3126 (and #3123, #3131,
#3163, #3218, #3200).

## INV-SSOT-002

- **Both sides of a comparison are produced by the same helper.** Where two
  values are compared, ordered, keyed or matched, one function derives both. Two
  helpers that "agree" are a coincidence maintained by hand.
- Measured, in `src/lib/promo.ts` (#3123): a check-in key projected through a
  timezone was compared against promo-window keys read zone-free. For any club
  behind Greenwich the promotion's first valid day was refused and its excluded
  last day was honoured — two sources of truth for "what day is this", inside
  one `if`.
- This applies to a value and its own encoding as much as to two values: a
  writer and a reader of the same column, a key minted in one place and parsed
  in another, a formatter and the parser that has to accept what it produced.

## INV-SSOT-003

- **An authority-bearing parameter carries no default.** A parameter whose value
  resolves a global, environment or configuration authority must be supplied by
  its caller. Deleting the default is what makes the compiler enumerate the call
  sites instead of leaving them to a census.
- **The mechanically-guarded class is narrower than the rule, deliberately, and
  the gap is stated rather than left to be discovered.** The arm bans a
  parameter, options-object property or destructuring default whose value reads
  a **club presentation authority**: `APP_TIME_ZONE`, `APP_LOCALE`,
  `APP_CURRENCY`, `APP_STRIPE_CURRENCY`, or the `TZ` / `CURRENCY` / `LOCALE`
  environment variables behind them (with their `NEXT_PUBLIC_` twins) in any
  spelling — including a namespace-import or computed member access, and
  including the `= process.env.TZ ?? "…"` and ternary forms, which are what
  somebody reaches for the moment a bare read looks unsafe. It lives in
  `eslint.config.mjs` on `ALWAYS_RESTRICTED_IN_SRC`, so every block picks it up
  including `scripts/` and `prisma/`, and its failure message names this ID.
- **Every name on the list now has a competing persisted source**, which #3563
  changed: the zone is `ClubTimeSettings` (`INV-CONFIG-002`), the currency and
  locale are `ClubFormatSettings` (`INV-CONFIG-006`). `APP_LOCALE` was listed
  _ahead of_ its second source, on the grounds that listing a club-facing
  authority with no live defaults costs nothing and saves a migration; that bet
  paid. **Currency is now single-sourced** (#3567): cards are charged in the
  stored currency, and both former offenders are fixed — the `"nzd"`
  `PaymentRefund.currency` default and `normalizeRefundCurrency`'s fallback.
- **The exclusions are judged, the two kinds of reason are not interchangeable,
  and one of them has now expired.**
  - `APP_CURRENCY` and `APP_STRIPE_CURRENCY` **used to be** excluded on
    **cost**, not kind, and that exclusion carried its own trigger: *the day a
    persisted club-currency setting exists, both names join the list.* #3563
    created `ClubFormatSettings` and paid it in the same change (D5), deleting
    `src/lib/stripe.ts`'s two defaults and making its six call sites state the
    currency. **Read it as the worked example of an exclusion written WITH a
    trigger** — the only kind that does not rot into a hole. The original
    reasoning survives in `eslint.config.mjs` and in
    `ssot-authority-default-guard.test.ts`, whose control inverted.
  - The rest of `process.env.*` is excluded on **measurement**. **Seven** live
    parameter defaults read it: `cron-auth.ts` (`CRON_SECRET`), plus six
    whole-environment injection seams (`admin-cron-health.ts` twice,
    `email-delivery.ts`, `environment-role-declaration.ts`,
    `ignored-email-env.ts`, `xero-config.ts`). All seven are test seams or
    secrets, so a broad ban would have been seven false positives out of seven
    matches — and #3126's own risk note names an over-broad arm as this work's
    one live hazard. One is not perfectly clean: `environment-role-declaration.ts`
    is governed by `INV-CONFIG-003`, under which the database may force the safer
    role — a second source by this file's own definition. Widen the arm only on a
    fresh measurement, recorded here.
- **The arm has two halves: the environment names above, and a NAMED LIST of
  ambient-state resolvers** (#3133). A default that calls a **synchronous
  accessor over a module-level cache with a shipped fallback** is the same defect
  written through a function name — unseeded, it answers with the product default
  and the call site reads as though it stated the fact. The measured instance is
  #3116: a season label defaulting to `getFinancialYearEndMonth()`, a cache no
  outbox worker seeds, put the wrong season on a Xero **invoice line** for a club
  whose financial year does not end in March. **A default supplying ambient
  process-global state breaks this rule whether or not the arm reports it.**
  - The four qualifying clauses, the banned names, and why a named list rather
    than a pattern — most call-valued defaults in this tree are legitimate, and
    the measurement saying so is recorded with the list — live once, in
    `eslint.config.mjs` above `NO_AMBIENT_AUTHORITY_RESOLVER_DEFAULT`. No figure
    is restated here; a number repeated in prose is a number that drifts.
  - A resolver returning the **club's own** answer on every call
    (`await clubTimeZone()`, `await readClubTimeZoneOutsideRequest()`) is not
    this defect and is not on the list.
  - **`getFinancialYearEndMonth` is PENDING, not exempt**, and the difference is
    structural: an exemption is a file the arm stops applying to and shelters
    whatever that file grows later, which is exactly how a `= APP_TIME_ZONE`
    default survived for months inside a lift written for a READ.
    `AUTHORITY_DEFAULT_RESTRICTIONS` still carries **zero** exemptions and
    `ssot-authority-default-guard.test.ts` asserts it. A pending name is one
    identifier the arm declines to fire on, with its live population **pinned**
    in that suite — so the deferral cannot grow, and the moment the last default
    goes the pin fails and hands the reader the promotion step. That is a ratchet
    with a mechanical trigger rather than a list that rots.
  - Its remaining defaults are held by **cost, not doubt**, and each needs a
    decision rather than more threading. `seasonSelectLabel`'s callers are
    display sites, most of them in browser bundles that the `server-only` seeder
    can never reach, so the year-end has to arrive as data the way the club's
    zone already does. `seasonYearOfCalendarDate` cascades through two optional
    pass-throughs into most of the booking, waitlist, membership and Xero tree,
    where the change actually written at each site would be
    `getFinancialYearEndMonth()` **at** the call site — compliant with this
    rule's letter while reading the same cold cache, and one ambient read spread
    across every one of those modules. That is the `APP_STRIPE_CURRENCY`
    argument above, which #3563 then paid — a cost a later change can settle,
    not a permanent answer. The figures live with the pending entry in `eslint.config.mjs`,
    beside the pin that keeps them true.
- **What no syntactic arm here reaches**, stated plainly rather than left as a
  discovered gap: a default that calls a **club-time** resolver
  (`= await clubTimeZone()`), which returns the club's own answer and is not
  this defect — note this is a narrower statement than
  "resolver calls are fine", which the bullet above refutes; an import alias
  (`import { APP_TIME_ZONE as ZONE }`) or a named local, which a selector cannot
  resolve and which the census closes instead; and a `??` fallback in a function **body**
  (`const tz = opts.tz ?? APP_TIME_ZONE`), which is the same hazard written
  differently and is a known limit, not a permitted shape. The census beside the
  arm is the second instrument, and per `INV-SSOT-004` it is deliberately
  **broader** than the arm — it cannot tell a parameter default from a
  module-level binding; since #3567 deleted the one it found, it expects none. Broader is the safe direction of error for a second instrument.
- Why the guard exists at all when `INV-SSOT-001` prefers the structural remedy:
  the structural remedy IS the fix, and this arm's job is to stop the default
  being written back in once it has been deleted.

## INV-SSOT-004

- **Two instruments that claim independence must measure the same way, or they
  are one instrument and a rubber stamp.** A guard and a census, or a lint arm
  and a contract test, that cross-check each other normalise their input
  identically, and the test says which method both share. Adding the second,
  check what the first normalises and **prefer the broader instrument**:
  over-reporting is visible; a shared blind spot reads as corroboration.
- **Here the hazard is comments**: defects are documented where they were
  removed, so a scanner reading RAW source misfires worst on the cleanest
  files. The record is in `club-time-boundary-guard.test.ts` and the
  stripper's docblock; cite it, not a tally.
- **A population measured by NAME is not the population.** Key a sweep on what
  code DOES, and classify its matches rather than converging every hit.
- **`src/lib/__tests__/support/strip-comments.ts` is the canonical
  `stripComments`. Use it; do not write a second.**
  169 test files, six test helpers and one CI script import it.
  `ssot-comment-stripper-guard.test.ts` requires that sentence and the module's
  docblock to state the count it measures by IMPORT SPECIFIER, not path text.
  **Measure it; never increment it.**
- **`ssot/no-local-comment-stripper`** (`eslint.config.mjs`) reports any
  function naming a JavaScript block-comment delimiter or comparing characters
  against a slash and a star — and, at module scope, code naming BOTH block
  delimiters. Its failure message states what it cannot catch; measured
  false-positive classes stay as fixtures. `COMMENT_STRIPPER_ALLOWLIST` is
  permanent, for different concepts (SQL comments, a comment extractor, the
  guard suite's own fixtures — the suite proves the listing silences them);
  `UNCONVERGED_COMMENT_SCANNERS` is a ratchet, kept though empty and pinned at
  zero by equality, so it cannot grow.
- **The module holds five FORMS**, the choice stated once in its docblock, with
  the scanner's known gaps; each form's docblock points there. `stripComments`
  keeps strings; `stripCommentsAndStrings` blanks their contents too;
  `stripCssComments` serves CSS, not allowlist entries; `blankLiterals`
  preserves length; `blankLiteralsWithSpans` also reports the blanked runs,
  only for a caller hunting what blanking removes. A restore policy stays at
  the caller. A claim about a whole list must hold for every entry.
- **Hosting coverage, one home per fact (#3039).**
  `adult-member-hosting-coverage-lock.ts` mints both lock families through one
  blocking and one fail-fast statement (`lockCoverageKeys`,
  `tryLockCoverageKeys`), parameterised only on namespace and decode-failure
  label; `acquireHostingCoverageGroupKey` is the ONLY per-trip key acquisition
  (`adult-member-hosting-coverage-lock.test.ts` censuses its shape and that no
  other site exists); `coverageBookingSetFingerprint` is the one
  plan-versus-verify comparison for every bounded coverage set,
  order-sensitive over one shared `orderBy`; `loadHostingSiblingIds` delegates
  to `loadHostingCoverageSplitSiblingIds`, so `hostingSiblingWhere` has one
  reader; every `CoverageOwnerFacts` read
  spreads `COVERAGE_OWNER_FACTS_BASE_SELECT`; `hosting-fake-booking-store.ts`
  is the one booking double (each suite keeps its `makeStore`);
  `race-db-url.ts` is the one race-database safety guard; suites that still
  restate it are unconverged (#3039 converged its own caller only).

History, measurements and rejected alternatives: #3126 (and #3039, #3132,
#3164, #3180, #3191, #3196).

## INV-SSOT-005

Who owns a booking is answered by `bookingOwner()` in
`src/lib/booking-owner.ts`, nowhere else. #2912 stage 3 (#3368); reasoning in
that module's docblock.

- **One accessor, and a census that keeps it one.** Stage 4 (#3369) makes the
  member link optional, so the owner is no longer certainly a person nor
  certainly present. `booking-owner-census.test.ts` reads `src/` and `scripts/`
  from disk, fails on a direct read, and states its blind spots; the accessor is
  the single exemption.
- **While the column was still required the accessor was the IDENTITY**, which
  is what made a sweep this wide checkable.
- **A comparison against a signed-in actor stays a comparison against a member,
  and keeps failing closed.** An organisation never signs in, so "is this my
  booking?" is correctly "no" for one. The refusal a school liaison meets is a
  product question this programme does not answer (#3369).
- **The credit ledger stays a MEMBER ledger.** A booking with no member has none
  to lock and no balance to read, so stage 4 branches at each member-keyed call
  site rather than passing an empty key, which degenerates to a shared advisory
  key (`INV-LOCK`).
- **Selecting the member WITHOUT the organisation is a defect this census cannot
  see.** The projection needs both relations, so such a query hands a school
  booking's member back as `null`, with no read to find. The compiler catches
  every spelling but an optional chain, which the census enumerates as its third
  family.
- **A `where` filtering THROUGH the relation is not covered either.**
  `member: { is: … }` on a nullable to-one drops every organisation-owned
  booking from a page, its window and its count, with no read and no type error.
  A reviewer's job; no guard claims otherwise.
- **Measure all three site lists by running the census** — one restated by hand
  has already drifted (`INV-SSOT-004`).

## INV-SSOT-006
Every Prisma `startsWith` or `contains` whose operand carries an id or text a
person typed uses `exactPrefix(prefix)` or `exactContains(value)` from
`src/lib/prisma-exact-prefix.ts`, never a bare filter. Case-insensitive searches
use `exactContains(value, "insensitive")`. URL/path reference checks use the
case-sensitive default. #4146, #4165, #4190.

- **Why one helper.** Prisma sends these filters as SQL `LIKE`/`ILIKE` without
  escaping their operands: `_` matches one character, `%` any run, and `\`
  escapes the next character. A recovery-key prefix could take another
  booking's row; a search for `john_smith` could find `johnXsmith`; a URL could
  falsely appear referenced. Both helpers share one escape function.
- **The premise is pinned.** `prisma-exact-prefix.realdb.test.ts` checks literal
  matches and decoys, including case-insensitive searches and all three
  metacharacters. Contrast cases fail if Prisma starts escaping on its own,
  which would double-escape these helpers.
- **A census keeps it one.** `prisma-exact-prefix-census.test.ts` reads `src/`
  and rejects dynamic bare `startsWith:` and `contains:` operands unless an
  allow-list entry explains why the value carries no id or input. It rejects
  shorthand and computed properties and checks for stale exceptions. Bare
  string literals and UPPER_SNAKE constants pass: the census judges spelling,
  not value, so reviewers must check they need no escaping.
- **Visibility uses it too.** Audit category filters use exact helpers even
  for fixed fragments. `audit-legacy-filter-exact-prefix.test.ts` replays known
  actions to prove category and member-timeline compatibility.
- **Scope the query as well where an indexed column allows.** An exact prefix
  still matches a longer id beginning with the same id and delimiter; the
  duplicate-capture lookup also scopes by `bookingId`.
