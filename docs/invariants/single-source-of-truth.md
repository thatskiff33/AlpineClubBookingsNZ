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
  `stripComments`, and it is not yet the only one.** Eighteen definitions exist
  in the tree and three files import the canonical one. **Use it; do not write a
  nineteenth.** The copies are not equivalent — `analytics-settings.test.ts` is
  a two-regex strip that drops newlines, where the canonical one is a
  mode-tracking scanner that preserves them — which is this very rule's failure
  mode, at scale, inside the tests meant to enforce it. Converging them is
  #3132; until it lands, treat a source-scanning test you did not write as
  measuring differently from yours until you have checked.
- When you add the second instrument to a guard, check what the first one
  normalises before writing the second, and say in the test which method both
  share. **Prefer the broader instrument for the second one**: over-reporting is
  visible and gets fixed, while a second instrument blind in the same place as
  the first is a rubber stamp that reads as corroboration.
