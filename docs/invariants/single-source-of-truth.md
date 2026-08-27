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
  defaults from `src/lib/date-only.ts`. A defect that had needed an 81-entry
  counted census, lowered by hand in the same commit as every migration, became
  a compile error. Every part of that census existed because the default did.
- A duplicated age rule that still carried a bug its canonical copy had been
  fixed for is the shape this rule exists to prevent; #3123 measured it.
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
- **The mechanically-guarded class is a default that reads the environment**: a
  parameter, options-object property or destructuring default whose value is
  `process.env.*`, or one of the `@/config/operational` exports that names an
  authority with a competing persisted source — today `APP_TIME_ZONE` and
  `APP_LOCALE`, whose real authority is the `ClubTimeSettings` row
  (`INV-CONFIG-002`). The arm lives in `eslint.config.mjs` on
  `ALWAYS_RESTRICTED_IN_SRC`, so every block picks it up, and its failure message
  names this ID.
- **What is out of scope is part of the rule, and is stated rather than
  discovered.** `APP_CURRENCY` and `APP_STRIPE_CURRENCY` are not banned: this
  product has no persisted club-currency setting, so `@/config/operational` is
  the single source and a boundary module reading it is obeying this rule rather
  than breaking it. Pushing that read out to five money call sites would spread
  the import and make single source of truth worse. **The day a persisted
  club-currency setting exists, those two names join the banned list.** Also out
  of scope, with population zero: a default that calls a club authority resolver
  (`= await clubTimeZone()`), which returns the club's own answer and is not this
  defect. A `??` fallback in a function body is the same hazard written
  differently and is a known limit of the syntactic arm, not a permitted shape —
  the census beside it is the second instrument.
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
  source therefore misfires worst on the files that were cleaned most. #3123
  measured four cases: two false greens — an exemption kept alive by a docblock,
  and an entire exemption block invisible to a staleness leg — and two false
  reds, from comments containing `prisma.$transaction` and
  `pg_advisory_xact_lock(1)`.
- **`stripComments` lives once**, at
  `src/lib/__tests__/support/strip-comments.ts`. A source-scanning test uses it;
  it does not carry its own copy, which would be a violation of `INV-SSOT-001`
  in the very test that enforces it.
- When you add the second instrument to a guard, check what the first one
  normalises before writing the second, and say in the test which method both
  share.
