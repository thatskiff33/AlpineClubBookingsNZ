# Single source of truth

Audience: Developer, Agent.

Prefix defined in this file: **`INV-SSOT`** — a fact is defined once and read
from that one place. What the repository already requires of documentation, and
enforces there with `npm run docs:indexcheck`, these rules require of code.

Read this file when you are about to add a constant, helper, formatter, type,
validation rule or configuration value; when you are writing a guard, a census
or a ratchet; or when two places in the tree need the same answer.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

The operational test an agent applies in the moment — search first, route to the
existing one, and prefer making the wrong thing unrepresentable over policing it
— is in [`AGENTS.md`](../../AGENTS.md) → "Change Discipline" → "Single source of
truth". It is stated there rather than here because `AGENTS.md` is read on every
task and this file is routed. This file holds the citable rules; that section
holds the habit.

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused.

## INV-SSOT-001

- **One canonical definition per concept.** A constant, helper, formatter, type,
  validation rule or configuration value has exactly one home, and every other
  place that needs it imports from that home. If two places now need the same
  fact, move it to one module and import it — never copy it.
- **The test is a change, not an appearance.** Two functions that happen to
  contain similar lines are not a violation; two places that must both be edited
  to change one fact are. If you are changing a fact and cannot change it in one
  place, that is the defect, and the fix is the move rather than the second edit.
- **A second FORM of one fact is not a second source of truth — a second
  DEFINITION is.** Where two callers legitimately need the same fact shaped
  differently, the answer is one definition with two derivations from it, not a
  forced single output that neither caller wanted. Routing everything through
  one shared helper is the usual remedy and not a universal one: a helper
  contorted to serve two shapes becomes the thing nobody may change, which is
  the same failure at one remove. The question to ask is *where is this fact
  DEFINED*, not *how many functions mention it*.
- **A per-site exclusion list is itself a source of truth, and it lives with the
  fact it excludes** — one list, in the module that owns the fact, not a copy in
  each guard that consults it. An exclusion list that shrinks is a ratchet;
  publish what makes it shrink, so the next lane can tell a live exclusion from
  a stale one.
- **The preferred remedy is structural, not procedural.** A required argument
  beats a lint rule; one exported symbol beats an allowlist; a deleted default
  parameter beats a counted ratchet. Reach for a guard when the structural
  option is genuinely unavailable, and say which one you rejected and why.
- Worked example, in this codebase: #3123 deleted the six `= APP_TIME_ZONE`
  defaults from `src/lib/date-only.ts`. A defect that had needed a counted
  census, lowered by hand in the same commit as every migration, became a
  compile error. Every part of that census existed because the default did. The
  figures live once, in `club-time-escape-hatch-census.test.ts`, and are not
  restated here — a number repeated in prose is a number that drifts.
- A duplicated age rule that still carried a bug its canonical copy had been
  fixed for is the shape this rule exists to prevent; #3123 measured it.
- Second worked example, and the one that shows the drift happening rather than
  its consequence: #3131 found the rule deciding which guests a promotional code
  covers on an existing booking written out **five** times across the
  booking-modification and guest-removal paths, and one of the five had already
  diverged in shape. It is now `src/lib/promo-stored-guest-targets.ts`, reading
  the field it turns on through the one definition of that field's meaning in
  `promo-guest-scope.ts`. Two details worth carrying forward: the issue was filed
  saying "four" after a grep of three `src/lib` files plus one route, so the
  missed copy was the member-facing one; and no census guards against a sixth,
  because the remedy is structural and because that module's docblock quotes the
  old spelling to explain what replaced it — which a raw-source scanner would
  report as the defect itself (`INV-SSOT-004`). The convergence covers every
  server-side scope decision; the admin promo-codes client still reads the same
  default inline twice, which is recorded in `promo-guest-scope.ts` rather than
  left silent, and waits on the server/client boundary work in #2850/#2851.
- **The sixth instance, and the decision to keep it.** #3163 found the same
  index-to-id mapping a sixth time, on the booking-**create** path
  (`getPromoTargetBookingGuestIds` in `booking-create-promo.ts`). The two bodies
  are the same algorithm and differ in exactly one thing: which key the index is
  read through — `BookingGuest.id` on the create path,
  `guestNightRates[].bookingGuestId` on the modification path. The call was to
  **keep both and cross-reference them**, over two alternatives.

  *Unifying through a key accessor* was rejected as the contortion this rule
  warns about: a helper reshaped to serve two callers becomes the thing nobody
  may change. *Normalising the input at the call site* — mapping
  `BookingGuest[]` into `{ bookingGuestId }` rows, an idiom already used at
  `waitlist.ts` and `booking-batch-modification-service.ts` — is **not** a
  contortion and was not rejected as one. It was judged not worth the churn: it
  costs an allocation and a shape-shim on the booking-create money path, and it
  moves the difference between the two rather than removing it. That is a
  weaker reason than the first, and it is recorded as the weaker reason it is.

  **This is a deliberate exception, not the general rule, and not the carve-out
  two bullets above.** That carve-out permits one definition with two
  derivations from it. Here there is no single definition either function
  derives from — there are two definitions of one fact, which is the very shape
  `INV-SSOT-001` names as the failure ("two places that must both be edited to
  change one fact"). The duplication survives and a cross-reference is a
  reminder rather than a structure, which this repository normally rejects. The
  two sites point at each other so a future editor of one meets the other; that
  is mitigation, not a fix.

  **On the provenance of this decision:** it was the recommended default, taken
  by an orchestrator session under the owner's 30 Aug 2026 instruction to
  proceed autonomously and record decisions for later review. There is no owner
  comment on #3163 to read at source. It stands until the owner overturns it,
  and anyone wanting to unify these later needs no further permission than that.
- **Deliberately not enforced by a registry.** A canonical-homes registry
  (concept → owning module, checked by a census test) was considered and
  **declined by the owner on 26 Aug 2026**: too much ongoing maintenance for the
  value, and every future pull request adding a shared concept would carry one
  more file to update. The cost of that choice is stated plainly — a second copy
  of a helper or a constant is **not** caught mechanically and stays on human
  review, which is what `INV-SSOT-003` and the standing review lens in
  [`SUBAGENT_GUIDE.md`](../agents/SUBAGENT_GUIDE.md) narrow rather than close.

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
  the **club's civil-time authority**: `APP_TIME_ZONE`, `APP_LOCALE`, or
  `process.env.TZ` / `NEXT_PUBLIC_TZ` in any spelling — including a
  namespace-import or computed member access, and including the
  `= process.env.TZ ?? "…"` and ternary forms, which are what somebody reaches
  for the moment a bare read looks unsafe. It lives in `eslint.config.mjs` on
  `ALWAYS_RESTRICTED_IN_SRC`, so every block picks it up including `scripts/`
  and `prisma/`, and its failure message names this ID.
- **Only `APP_TIME_ZONE` and the `TZ` reads have a competing persisted source**
  — the `ClubTimeSettings` row (`INV-CONFIG-002`) — and that is the measured
  defect: dozens of call sites could silently take a club-facing answer from the
  container, and the counts are in the census test rather than here.
  `APP_LOCALE` is banned on a **forward-looking** argument instead, and it
  should be read as such: no persisted club locale exists, so `APP_LOCALE` is
  listed *ahead of* its second source, on the grounds that it is a club-facing
  presentation authority of the same kind whose live default population is zero
  — listing it costs nothing now and saves the migration later. Note that
  "nothing competes with it" would be too strong even so: fifteen non-test files
  hardcode `"en-NZ"` outright, which is a separate pre-existing defect this arm
  does not address.
- **The exclusions are judged, and the two kinds of reason are not
  interchangeable.**
  - `APP_CURRENCY` and `APP_STRIPE_CURRENCY` are excluded on **cost**, not on
    kind. `src/lib/stripe.ts` has two live `currency = APP_STRIPE_CURRENCY`
    defaults, and all **eight** production call sites in eight modules rely on
    them. No persisted club-currency SETTING competes with them, and pushing the
    read out would spread the `@/config/operational` import into eight more
    modules — worse for single source of truth, not better. Two caveats, because
    the weaker claim is the true one: `finance-fees-sections.tsx` and
    `joining-fee-preview.tsx` hardcode `"NZD"` outright and `schema.prisma`
    defaults a `currency` column to `"nzd"`, so currency is **not** in fact
    single-sourced today — those are a separate pre-existing defect this arm
    does not address. And say "cost", not "a different kind of value", because
    `APP_LOCALE` has no competing setting either and is banned. **The day a
    persisted club-currency setting exists, both names join the list.**
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
    across every one of those modules. That is the `APP_STRIPE_CURRENCY` argument
    above, again. The figures live with the pending entry in `eslint.config.mjs`,
    beside the pin that keeps them true.
- **What no syntactic arm here reaches**, stated plainly rather than left as a
  discovered gap: a default that calls a **club-time** resolver
  (`= await clubTimeZone()`), which returns the club's own answer and is not
  this defect, population zero — note this is a narrower statement than
  "resolver calls are fine", which the bullet above refutes; an import alias
  (`import { APP_TIME_ZONE as ZONE }`) or a named local, which a selector cannot
  resolve and which the census closes instead; and a `??` fallback in a function **body**
  (`const tz = opts.tz ?? APP_TIME_ZONE`), which is the same hazard written
  differently and is a known limit, not a permitted shape. The census beside the
  arm is the second instrument, and per `INV-SSOT-004` it is deliberately
  **broader** than the arm — it cannot tell a parameter default from a
  module-level binding, so it names `src/config/operational.ts` as its one
  expected hit. Broader is the safe direction of error for a second instrument.
- Why the guard exists at all when `INV-SSOT-001` prefers the structural remedy:
  the structural remedy IS the fix, and this arm's job is to stop the default
  being written back in once it has been deleted.

## INV-SSOT-004

- **Two instruments that claim independence must measure the same way, or they
  are one instrument and a rubber stamp.** Where a guard and a census, or a lint
  arm and a contract test, are described as cross-checking each other, they must
  normalise their input identically. A pair that reads the same tree by two
  different methods agrees where both are blind.
- **In this repository the specific hazard is comments**, because the house style
  documents each defect at the site where it was removed. A scanner reading RAW
  source therefore misfires worst on the files that were cleaned most. The
  corroborated instance is the `member-guest-delegate-page.ts` false green,
  recorded where it was found — `club-time-boundary-guard.test.ts` and the
  docblock of `support/strip-comments.ts`. An earlier draft of this entry
  claimed "four measured cases" with a two-green/two-red breakdown; only one is
  evidenced in the tree, so the count is not restated here. Cite the record, not
  the tally.
- **`src/lib/__tests__/support/strip-comments.ts` is the canonical
  `stripComments`, and since #3164 a lint rule enforces it.** 56 test files and
  one CI script import it, and `ssot/no-local-comment-stripper` in
  `eslint.config.mjs` reports a second scanner as it is written rather than
  twelve minutes later in CI. **Use it; do not write a second.** The figure was
  published as 48 while the module's own docblock said 53 and the tree said 53,
  which is this ID applied to its own entry: two statements of one fact, and
  nothing comparing them. Re-measured at #3180, after three conversions took it
  to 56, and again at #3196, whose one conversion took it to 57.
- **A population measured by NAME is not the population**, and the count above
  is the evidence. #3132 converged the copies spelled `stripComments` and closed;
  seven more were alive that day under the name `withoutComments`, and #3164
  found twenty-one more again with no name at all — an inline `.replace()` chain
  inside a census, which no symbol sweep can see. That is why the rule keys on
  what a function DOES: it names a JavaScript block-comment delimiter, or
  compares characters against a slash and a star. Two of those seven were not
  JavaScript strippers at all (one SQL, one dotenv), and converging either would
  have BROKEN its census — so a behaviour sweep has to classify, not just match.
- **The lists that say what is not a copy live in `eslint.config.mjs`, and there
  are two of them on purpose.** `COMMENT_STRIPPER_ALLOWLIST` is permanent: a
  different concept the canonical helper cannot express — SQL comments, a comment
  EXTRACTOR, and the guard's own fixture file. `UNCONVERGED_COMMENT_SCANNERS` is
  a **ratchet**, whose length is pinned in
  `ssot-comment-stripper-guard.test.ts`, so the list can shrink and cannot grow.
  It held five, then four, then one, and since #3196 holds **none**. An empty
  ratchet is not a dead list: it is what makes "there is no second scanner" a
  checked fact rather than a claim, and the pin is now an equality, so the next
  file that would need an entry cannot get one.
- **The canonical module holds five FORMS, and a claim made about a whole list
  has to be true of every entry on it.** `stripComments` removes comments and
  keeps strings; `stripCommentsAndStrings` also blanks string CONTENTS, which is
  what a rule needs when its own subject is discussed in prose; `stripCssComments`
  handles the one other language sharing the block delimiter; `blankLiterals`
  (#3180) returns text of the **same length**, so a caller that reports a line
  number, slices by index, or compares one match's position against another's
  still points at what it named; and `blankLiteralsWithSpans` (#3196) is that
  same blanking with the runs it blanked reported back. #3164 moved the
  second form out of `xero-provider-date-boundary-census.test.ts`, where the
  #2869 review had written it — one of two instruments reading the same tree by
  different methods is exactly this ID, and a second form no other file could
  import is why a ratchet entry could not converge onto it.

  **The fifth form was a cost taken knowingly (#3196), and what pays for it is a
  docblock.** A module whose value is that there is one obvious choice per job
  gets worse with every export, so the five-way choice is stated **once**, in the
  module's own docblock, one sentence each, and a form's own docblock says what
  it is and points there rather than restating the other four. Reach for
  `blankLiteralsWithSpans` only when some of what blanking removes is the very
  thing you are hunting: `advisory-lock-guard.test.ts` hunts raw SQL, which lives
  inside string literals, while the prose it must ignore lives inside string
  literals too. **The restore stays at the caller.** A `SELECT`-shaped carve-out
  is one census's policy about SQL, not a fact about JavaScript, and a helper
  reshaped to carry another caller's policy is the contortion `INV-SSOT-001`
  names — so the module gained a capability and not a rule.
- **The ratchet's preamble claimed a property two of its five entries did not
  have, and that is the correction worth recording.** It said none produced
  reduced text and all reported original-text offsets. Measured, that was false
  twice: `family-group-role-retirement.test.ts`'s `codeOnly` really did reduce,
  and has been converged onto the second form with **no change to what its
  census reports** — `member-merge.ts` comes back without `maxFamilyRole` either
  way, and the canonical form is the stricter of the two, since it keeps
  `obj["maxFamilyRole"]` as the property read it is where the local one erased
  it. `advisory-lock-guard.test.ts`'s works a line at a time and reduces too; it
  stays, for its own accurate reason — a `SELECT` carve-out, because the raw SQL
  it hunts for lives inside the double-quoted literals it otherwise blanks.
  Three of the remaining four shared the offset-preserving property; the fourth
  was named as the exception rather than covered by the sentence. #3180 wrote
  the blanker and converged those three, leaving the named exception alone.
- **Converging the three walkers found a live blind spot, and that is the
  argument for converging at all.** Two of the three re-measured **byte-identical**
  — every span, line number and derived population unchanged. The third did not.
  None of the three private copies recognised a **regex literal**, so
  `xero-contacts.ts`'s `.replace(/\//g, "")` was read as a line comment,
  desynchronised `xero-object-url-write-guard.test.ts` for the rest of that file,
  and hid a real `prisma.xeroSyncOperation.update(...)` from a census whose whole
  job is to see every direct write to that model. The write-site population went
  from **58 to 59** on conversion. The recovered site carries no `xeroObjectUrl`
  today, so the guard was passing rather than wrong — **live but latent**, one
  added property from being otherwise. That is the same shape #3155 removed from
  the shared scanner, still alive in copies nobody had reason to re-read.
- **What the guard cannot catch is stated in its own failure message**, which is
  the honest form for an inexact rule: a stripper that handles only line
  comments (indistinguishable from the URL patterns this tree is full of), one
  whose delimiters are computed at runtime, one written for another language,
  and — at module top level only — one that names a single block delimiter
  rather than the pair. Three false-positive classes were measured and closed on
  the way in — a quantifier before an escaped slash (`/<br\s*\/?>/`, two
  HTML-to-text converters), a single slash/star pair (a glob compiler, and
  `endsWith("/*")`, whose margin is one character comparison and is pinned as a
  fixture for that reason), and `diagnostics/tools/define.ts`'s module-level SQL
  banlist. All are kept as fixtures so a later widening reopens them loudly.
- **CSS is the one other language sharing JavaScript's block delimiter, and its
  strip is a second FORM in the canonical module rather than three allowlist
  entries.** `placeholder-styling-contract`, `app-theme-layout-contract` and
  `print-light-palette-contract` each wrote the identical one-line `replaceAll`
  at five call sites between them; since #3164 they import `stripCssComments`.
  The reason CSS cannot simply use `stripComments` was also wrong where it was
  first written, and the correction matters because the old one is not
  reproducible: the JavaScript scanner does **not** read the slash in
  `url(a/b)` as opening a regex and eat the line — a regex literal is copied
  through verbatim, and `url(a/b.png)` and `url(/images/hero.png)` both come back
  byte for byte. What it really eats is the LINE delimiter that CSS does not
  have: `url(https://cdn.example/x.png)` unquoted loses everything from the
  double slash onward. No stylesheet here writes one today, so the hazard is
  **latent, not live** — the first unquoted absolute URL would silently shrink
  whichever contract read that file.
- **The rule reads the module body as well as every function, and the bar out
  there is higher.** Its first form recorded evidence only against a literal's
  enclosing function, so a stripper written beside a census's imports was
  invisible while the identical chain one scope further in was reported — an
  accidental limit, and an undeclared one. It now reads module scope too,
  requiring BOTH block delimiters rather than either, because one escaped opener
  at module level is the `define.ts` banlist entry above and a guard that is
  wrong when it fires teaches its reader to switch it off. That reach is what put
  `ssot-comment-stripper-guard.test.ts` on the allowlist: its fixtures are
  module-level constants, and the suite proves the LISTING is what silences it,
  by linting the file's own text at a fixture path and requiring a report.
- **What converging measured is the argument for the rule, not a footnote.** The
  sixteen copies #3132 removed fell into five behaviour classes, and they
  disagreed where it mattered: six tracked no string literals at all, so a `//`
  inside `"https://x"` opened a comment and ate the rest of the line; one was the
  two-regex strip that drops newlines. Worse, the canonical itself read `.replace(/\//g, "_")` — two
  adjacent slashes inside a regex literal — as a line comment and deleted real
  code in a dozen files, a defect the #2869 review had already found and fixed in
  `xero-provider-date-boundary-census.test.ts` **alone**. One of two instruments
  repaired is this rule stated as a defect; the predicate now lives with the
  scanner and that census imports it. Where the remaining gaps are, and why
  neither the scanner nor a full TypeScript parse dominates the other, is in the
  canonical module's docblock rather than restated here.
- **#3164 re-measured that argument against the copies #3132 left behind, and it
  is larger than the original.** Across `src/`, the two-regex strip with a
  line-start guard deletes 100,390 characters of real code that the canonical
  scanner keeps, in 58 files; the colon-guarded variant 104,254 in 157 files; the
  space-blanking variant 205,978 in 671 files. The worst single case is not the
  escaped slash at all: `rooms-beds-manager.tsx` contains a LINE comment quoting
  the glob `/api/admin/bed-allocation/*`, whose block-comment opener runs 464
  lines to the next closer and takes 23% of the file with it. None of the
  converged censuses' own patterns lived in the deleted regions, so no census
  result moved — the defect was live and latent, which is the state a guard is
  for and an incident is not.
- When you add the second instrument to a guard, check what the first one
  normalises before writing the second, and say in the test which method both
  share. **Prefer the broader instrument for the second one**: over-reporting is
  visible and gets fixed, while a second instrument blind in the same place as
  the first is a rubber stamp that reads as corroboration.
