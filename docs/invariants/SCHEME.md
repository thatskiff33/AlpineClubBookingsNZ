# The `INV-*` invariant scheme

Audience: Developer, Agent.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) · imperfections
found during the restructure and deliberately not fixed in it:
[`_FOLLOW_UPS.md`](_FOLLOW_UPS.md).

This is the standing authority on `INV-*` identifiers: what one is, what gets
one, how to allocate the next one, what may never be done to one, and what CI
enforces. **The rules below are in force.** If you are about to write
the next free `INV-CAP` number into a file, §1.3 and §7 are the two sections you
need; if you are about to move, split, supersede or retire a rule, §1.4 and §3
are.

The rules themselves live in one file per domain in this directory. This file
governs their identifiers; it states no domain rule of its own and carries no id.

---

## 1. What an `INV-*` ID is

An ID is a **permanent public identifier for one rule**, in the same sense that a
database primary key is permanent. It is cited from places this repository
cannot rewrite: merged commit messages, closed issues, PR bodies, lint failure
strings shipped in a release, test names in a fork, and a club's own operating
notes. Treat it accordingly.

### 1.1 Form

```
INV-<PREFIX>-<NNN>
```

- `<PREFIX>` — uppercase letters and digits, starting with a letter. Names a
  durable area of the system.
- `<NNN>` — exactly **three digits, zero-padded**, from `001`.

Examples: `INV-DATE-001`, `INV-CAP-029`.

**Three digits, not two.** The two-digit shape was considered and rejected:

```
INV-<PREFIX>-01   INV-<PREFIX>-07   INV-<PREFIX>-03   <- rejected, never used
```

Two digits caps a prefix at 99 rules for all time, and because IDs are never
renumbered the width could never be widened later without either breaking every
existing citation or leaving two IDs that differ only by a leading zero. Three
digits costs one character and removes the problem permanently.

### 1.2 A prefix names a durable area, not a feature

Renaming a prefix renumbers everything under it, which is forbidden, so a
prefix is as permanent as the numbers beneath it. Choose one you could still
justify if the feature it currently holds were deleted tomorrow. When in doubt,
choose the **coarser** prefix: a coarse prefix can be narrowed later by giving a
new area its own prefix and leaving existing IDs exactly where they are, whereas
a prefix that turns out to be wrong can never be fixed.

Two consequences worth stating plainly:

- `INV-LOCK` is not used for subscription lockout, because this codebase's
  "lock" means an advisory row lock. Ambiguity in a permanent key is a defect.
  Lockout rules take `INV-LOCKOUT`.
- An ID's prefix is a **key, not a description**. Over time some rules will sit
  under a prefix that no longer describes them perfectly. That is correct and
  expected; the index, not the prefix, is authoritative for what a rule covers
  and where it lives.

### 1.2.1 The `INV-` namespace is shared — reserved prefixes

This repository already writes `INV-…` strings, in quantity: they are **Xero
invoice numbers** in test fixtures. A scan of every tracked file found 68
distinct `INV-` tokens, and four of them match the invariant citation shape
exactly:

```
INV-IB-001   INV-SETTLE-001   INV-SETTLE-002   INV-SUP-001
```

`INV-XERO`, `INV-FAM`, `INV-LEGACY`, `INV-PM`, `INV-SUB-2026-001` and about
sixty others are close enough to matter for the future even though they do not
match today.

The `INV-` namespace is kept anyway, with three load-bearing consequences:

1. **These prefixes are reserved and must never be used as invariant prefixes:**
   `IB`, `SETTLE`, `SUP` (the three that collide today), plus `SUB`, `XERO`,
   `FAM`, `LEGACY`, `PM`, `JOR`, `REB` (the near-misses). The enforcement check
   carries this list explicitly — see §8.
2. **`INV-XERO` is therefore not used** for the Xero member-grouping rules; they
   take `INV-INT` alongside the rest of Integrations. A prefix that a Xero test
   fixture could plausibly write tomorrow is not a safe permanent key.
3. **The failure mode is loud, not silent**, which is why `INV-` is used rather
   than a fresh, collision-proof namespace such as `ACB-CAP-007`. If someone
   later writes a fixture invoice under a real invariant prefix, the check
   reports an unresolved invariant citation and the author renames the fixture
   or adds it to the reserved list. It cannot silently mis-resolve.

### 1.3 Allocation

1. A new invariant takes `max(existing number in that prefix) + 1` — read the
   maximum off that prefix's tables in the index — and is **placed in the file
   wherever it belongs to a reader**, which will usually not be at the end.
   Number order and file order diverged the moment the first invariant was added
   after the restructure, and they diverge further with every one since. That is
   intended, not a defect to be tidied.

   **A repo-wide `grep` for the prefix is not how to find that maximum**, which
   this rule now says out loud because saying only what to do left the thing
   people actually do unwarned. A `grep` returns more than definitions: it
   returns illustrative IDs from prose and from fenced examples — including this
   file's own — and the deliberately unresolvable fixtures in the enforcement
   check's tests. It also orders as text rather than as numbers, so `INV-CAP-07`
   sorts *after* `INV-CAP-032`. That is not hypothetical: in #2889 a fenced
   example in §1.4 read as the maximum and a branch took `042` for an `INV-CAP`
   rule when the next free number was `033`. The index's tables contain
   definitions and nothing else, which is exactly why they are what you read.

   Those two numbers are written bare rather than as IDs on purpose: an invented
   ID outside a fence is caught already, as a citation that resolves to nothing,
   so a fence is the only place one can hide.
2. Numbers were assigned once, at the restructure, in source-document order
   within each prefix, starting at `001` with no gaps. That was the only moment
   at which number order and document order agreed, and it will not recur.
3. **A number is mutable only until it first merges to `main`.** Two lanes may
   independently pick the same next number. Once the check is evaluated against
   a base containing one of them, the other fails on the duplicate definition
   and renumbers — it is renumbering an ID nothing has cited yet, which is free.
   The check does not make an older green result current: branch protection does
   not require status checks to be strict today, so GitHub need not rerun a
   second independently green PR merely because the first merged. The repository
   merge procedure therefore rechecks current `main`, conflict state, the exact
   head SHA and every required check immediately before merge. That procedure,
   not a claim that GitHub necessarily reruns CI, closes the race. After merge,
   never renumber.
4. **A prefix's numbers are dense, and CI enforces it** (§8). They
   run from `001` to that prefix's highest with no holes, which is what makes
   "take the next number" mechanical rather than a matter of looking carefully:
   every number below the maximum is taken, and no ID may be defined twice
   so `max + 1` is the only number a new invariant *can* have.
   Anything else is either a duplicate or a hole, and both fail the PR — the hole
   naming the prefix and the numbers it skipped. A gap is never allowlisted: an
   ID is never deleted (§1.4), so the only two ways to make one are a wrong
   number and a forbidden deletion, and each is a thing to fix. If a prefix ever
   wants a reserved range, that is a new prefix (§1.2), not a hole in this one.

   Density is a current-tree property, so it cannot see the highest number being
   deleted or a whole prefix disappearing. CI therefore also compares the
   current definitions with the base revision and requires every already-merged
   ID to remain. The two checks are complementary: density makes allocation
   mechanical; the revision comparison makes permanence append-only.

### 1.4 The no-renumber rule

> **An `INV-*` ID, once merged to `main`, is never renumbered, never reused, and
> never deleted.**

- **Never renumbered.** Not to close a gap, not to restore document order, not
  to make a file read better. A renumber silently re-points every existing
  citation at a *different rule* — in code comments, test names, lint messages,
  closed issues and other forks. That is the same class of failure this
  restructure exists to prevent: a rule that is written down correctly and still
  does not hold, because the pointer to it went stale.
- **Never reused.** A retired number is burnt. Reuse makes an old citation
  resolve, wrongly, to an unrelated rule — worse than failing to resolve.
- **Never deleted.** A rule that is superseded keeps its heading and gains a
  status line directly beneath it:

  ```
  ### INV-<PREFIX>-<NNN>

  **Superseded by INV-<PREFIX>-<MMM> (PR #NNNN).** <original text kept below, verbatim>
  ```

  That example carries placeholders rather than two real numbers, and the reason
  is worth knowing. It used to name `INV-CAP` numbers, and the old enforcement
  check ignored every fence while `grep` still saw it — so its higher number
  read as that prefix's maximum, and the next branch to allocate one skipped
  nine (#2889). The check now rejects every numeric token under a live prefix in
  this file's literal blocks, whether or not that ID resolves, while leaving
  placeholders, reserved invoice numbers and custom fixture prefixes alone.
  **An illustrative invariant ID in this file therefore uses either the
  bracketed placeholder form or a custom non-live prefix. It never spells a
  live prefix/number pair.**

  A rule that is genuinely obsolete keeps its heading and gains
  `**Retired (PR #NNNN): <one-line reason>.**` in place of its body. Either way
  the ID still resolves, so the enforcement check still passes for old citations,
  and a reader who follows a stale pointer is told what happened instead of
  landing on nothing.

**Moving and splitting.**

- A rule that **moves to another file keeps its ID and its prefix.** Files are a
  presentation layer; the index is authoritative for ID → file. A move is a
  one-line index edit.
- A rule that is **split** keeps its ID for the part that retains the original
  meaning; the new part takes a fresh number. Never `INV-CAP-013a`, never
  `INV-CAP-013.1`.
- A rule that is **merged** into another keeps both IDs: the absorbed one becomes
  a `Superseded by` stub pointing at the survivor.

### 1.5 Prefix ↔ file

> **A prefix normally lives in one file, and a file may host more than one
> prefix. The index, never the prefix, is authoritative for ID → file.**

One-to-many in that direction only. `INV-DATE` and `INV-CAP` share
[`booking-dates-and-capacity.md`](booking-dates-and-capacity.md) because their
rules refer to each other positionally ("the stay-boundary invariant above"), and
splitting them would require editing navigational prose (§4). A prefix is never
*deliberately* split across two files, because the whole point of a prefix is
that "load `INV-CAP`" is a single file read.

**A re-home outranks that, and cannot be tidied away.** A rule that moves file
keeps its number *and* its prefix (§1.4), so re-homing one ID out of its
prefix's file leaves that prefix spanning two files, and the no-renumber rule
leaves no way back. #2706 re-homed `INV-LIFE-062` into
[`booking-dates-and-capacity.md`](booking-dates-and-capacity.md), so `INV-LIFE`
spans two files today. That is the rules working rather than a defect to undo:
a prefix is a key, not a description (§1.2), and the index names the file for
every ID, so "where does this one live?" is still a single lookup.

---

## 2. What gets an ID: the block rule

An ID names a **block**, not a sentence. Reading a file top to bottom, a new
block starts at:

- a **top-level list item** (`- ` at column 0), taking with it every nested item
  and every continuation paragraph indented beneath it, up to the next
  column-0 list item or the next heading; **except** that
- a **paragraph ending in a colon that introduces a list** binds that whole list
  into one block with it (the bullets are grammatically a continuation of the
  sentence — "Google Analytics must not load unless ALL of the following hold:"
  means nothing split from its four conditions); and
- a **paragraph, table, blockquote or fenced block at column 0** that is not part
  of the preceding block.

Headings and blank lines start no block; they are structure.

**Blocks are never split mid-bullet — inside a transcription.** A 149-line
bullet gets one ID. Splitting it would mean inserting a heading inside a list
item, which breaks the list, re-indents the prose, and forces every line to be
re-wrapped — precisely the churn that hides a changed word. Where a block is
uncomfortably large, that is recorded as a candidate for a *later, separate*
issue, which can split it into new IDs without renumbering anything (§1.4). That
issue was #2706, which split the ten coarse blocks the restructure left; the
three splits it declined, because they could not be made without re-wrapping, are
named in [`_FOLLOW_UPS.md`](_FOLLOW_UPS.md) §1.

### 2.1 Normative versus non-normative

A block is **normative** if it contains at least one sentence that:

- **(a)** says what the system must, must not, always or never do; or
- **(b)** states, in the present tense, a property the code, schema or data
  currently guarantees and which a change could break — "Capacity is per lodge",
  "A booking belongs to exactly one lodge"; or
- **(c)** constrains a *future change* rather than the system — "do not add a
  hard block without a fresh owner decision", "never a side effect of work in
  this area", "fold restatements you find into references"; or
- **(d)** names the single source of truth or the chokepoint for a rule — "the
  implementation source of truth is `capacityHoldingBookingFilter()`".

A block is **non-normative** only if *every* sentence in it is (i) rationale for
why a normative rule exists that adds no obligation of its own, (ii) a worked
example or incident history whose removal changes no obligation, or (iii)
navigation text.

**The tie-break is deliberately asymmetric: if you cannot decide, it is
normative.** A non-normative block wrongly given an ID costs one index line. A
normative block wrongly left without one is the failure this scheme exists to
prevent.

### 2.2 Nothing is classified away

Classification is the weakest link in any migration like this, so the scheme is
built so that **classification cannot lose anything**:

> **Every block gets an ID, normative or not, and every block moves. Nothing is
> classified away.**

Non-normative rationale travels with its block, under its block's ID. The only
text that does *not* sit inside an ID'd block is a file's own front matter, the
`##`/`###` headings, and blank lines.

That converts the hardest question in a restructure ("is this normative?") into
line accounting ("is every line present?"), which is checkable. §3 makes it
mechanical, and it is why 360 IDs cover every line of the pre-split document.

---

## 3. The transcription discipline: the only three edits

A **transcription** is a change that moves rule text without changing what it
says: the original split, and any later move, re-home or file split. Inside a
transcription this list is exhaustive. Anything not on it is a rewrite, and a
rewrite belongs in its own reviewable change against the file that holds the
rule — never folded into a move, because a diff that both moves and edits is
unreviewable.

1. **Insert an ID heading line** (plus one blank line either side) before a
   block.
2. **Append a bracketed ID pointer** immediately after a positional
   cross-reference whose target has left the file — ` [INV-CAP-004]`. Nothing is
   deleted and no existing word is changed; a pointer is *added* beside the word
   that no longer navigates. Every such insertion is registered in the PR body
   (§4.2).
3. **Change the path half of a relative Markdown link** when the link's target
   moved relative to the new file — `](TESTING.md)` → `](../TESTING.md)`. The
   fragment is never touched.

Heading *levels* change (a source `###` becomes a `##` in its own file) but
heading *text* never does.

### 3.1 The reconstruction check

Because that list is exhaustive, the destination is mechanically reducible to
the source. Run this before reviewing any transcription:

> Take the destination files. Drop the front-matter block above the first `##`.
> Drop every line matching the ID-definition regex. Undo the `../` path edits and
> the ` [INV-*]` pointer insertions listed in the register. Restore heading
> levels. Concatenate in index order. **Every non-blank line must be
> byte-identical to the source, in order, and the word count must match exactly.**

Blank-line runs are the one permitted difference, because an ID heading needs a
blank line either side and prose runs consecutive bullets with none.

A passing run looks like this (the figures are from
[`booking-dates-and-capacity.md`](booking-dates-and-capacity.md), the first file
transcribed):

```
non-blank lines: source 851  destination 851
BYTE-IDENTICAL (non-blank lines)
source words 8686  destination words 8686
```

A reviewer's reading time is then spent only on what the check cannot see —
whether the *right* text landed under the *right* ID, and whether a block was
dropped wholesale rather than altered.

---

## 4. Cross-references and inbound links

### 4.1 Inbound links from other documents

The index stays at `docs/DOMAIN_INVARIANTS.md` (§6) and keeps the ten `##`
domain headings of the pre-split document with byte-identical text, so **every
anchor written before the split still resolves.** That is now a checked
contract rather than an intention: `npm run docs:indexcheck` fails a rename,
re-casing or removal of any of the ten (`STABLE_INDEX_HEADINGS` in
`scripts/ci/check-doc-index-integrity.mjs`, #2720). Adding a NEW `##` section is
free — a section that did not exist before the split carries no pre-split
anchors — so the list is an allowlist of survivors, not a census of the index.

Resolving is not the same as landing on the rule, and the two are now
distinguished:

| A link that means… | Points at |
| --- | --- |
| a specific rule | the domain file, at its ID anchor — `[INV-CAP-021](invariants/booking-dates-and-capacity.md#inv-cap-021)` |
| the rules of a domain | that domain's file — `invariants/payment-and-settlement.md` |
| "find me the right rule" — routing, or the catalogue of what exists | the index, `docs/DOMAIN_INVARIANTS.md` |

A bare `DOMAIN_INVARIANTS.md` reference with no anchor still resolves, to the
index; check that the index is what the sentence around it means. A
`DOMAIN_INVARIANTS.md#<domain>` deep link resolves too, but delivers a table of
one-line summaries — if the sentence promised the rules, re-point it at the
domain file. `npm run docs:linkcheck` cannot tell these apart, because all of
them resolve.

No redirect stubs are left behind. A stub is a second place a reader can land
and find nothing, which is the failure mode this scheme exists to fix.

### 4.2 Positional cross-references inside a file

Rule text navigates itself with "above", "below", "the invariant above", "its
own section below" and "this subsection". Rules, in order:

1. **If the target stays in the same file, in the same relative position, leave
   the sentence alone.** This covers the large majority, and is the main reason
   the file boundaries follow the pre-split document's own heading zones (§5.1).
2. **Where a pointer would cross a file boundary, prefer moving the boundary** —
   keep the two parts in one file — over touching the sentence.
3. **Only where (2) is impossible**, append the bracketed ID pointer of edit
   type 2:

   In `additional-payment-chasing.md`, where "rule (b) above" names a rule that
   now lives in `booking-dates-and-capacity.md`:

   `INV-EXAMPLE` is a non-live stand-in. Illustrative fences in this scheme never
   spell a real prefix/number pair, because a repository grep cannot distinguish
   teaching text from the live catalogue.

   ```
   before:  moves AWAITING_REVIEW → PENDING, which keeps holding via rule (b) above, so an
            accepted-but-unpaid quote does not lose its bed before payment.

   after:   moves AWAITING_REVIEW → PENDING, which keeps holding via rule (b) above [INV-EXAMPLE-004], so an
            accepted-but-unpaid quote does not lose its bed before payment.
   ```

   The example this section used to give — the custodian bed hold's "its own
   section below [INV-LIFE-062]" — is no longer one, and is worth knowing about
   as a trap. #2706 re-homed `INV-LIFE-062` into the same file as the sentence
   that points at it, so that case is now governed by rule 1 above and a pointer
   there would be the edit rule 1 forbids. A re-home can turn a rule-3 pointer
   into a rule-1 sentence; it does not license removing a pointer already merged
   (nothing is deleted inside a transcription, §3), but do not add a fresh one
   without re-checking which file the target is in today.

4. **Every insertion is registered.** The PR body carries a table of
   `reference → inserted pointer`, and nothing else in the diff may add text.

A reference that names its target by **section title** rather than by position
needs no pointer: a title resolves through the index whatever file it lives in.

The restructure's own sweep is closed — eight boundary-crossing references were
found and all eight carry a pointer, though only seven still cross a boundary:
#2706's re-home of `INV-LIFE-062` brought the eighth target into the same file
as its sentence. See [`_FOLLOW_UPS.md`](_FOLLOW_UPS.md) §8 for the classes
deliberately left unpointered, so a later reader does not repeat the sweep.

---

## 5. The files

One file per domain in this directory, plus this scheme and
[`_FOLLOW_UPS.md`](_FOLLOW_UPS.md) — around fifteen files carrying roughly five
hundred IDs. The counts here are deliberately approximate, and the prefix count
is gone altogether: it read sixteen until `INV-LOCK` arrived mid-review and made
it seventeen. A figure written by hand is wrong within the week, and
`npm run docs:indexcheck` prints the live ID and prefix totals plus the number
of tracked files it scanned on every run. The invariant-file count remains an
approximation here rather than being mistaken for that tracked-file total.

**The index is authoritative for prefix → file and ID → file**, and it is the
only place that mapping is written down. It is deliberately not repeated here: a
second copy is a second thing to rot, and `npm run docs:indexcheck` verifies the
index against the files on every PR (§8) while it could not verify a prose copy.
Start from the routing table in
[`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md).

### 5.1 Why the files are shaped the way they are

**The files follow the pre-split document's own headings, and nothing was
re-domained.** Re-filing rules into their "true" domains is a semantic
reorganisation with real risk of loss, it invalidates dozens of positional
cross-references at once, and it cannot be reviewed in the same diff as a move.
Two consequences a reader will notice:

- **The domains are wildly uneven, and three of them were catch-alls.** About
  2,150 of the 3,069 lines under `## Booking Modifications` were not about
  modifying a booking — they were hosting policy, subscription-lockout pricing,
  notification policy, account deletion, Xero reconciliation, booking requests
  and admin queues that had accreted under the nearest heading. Each of those
  bodies now has its own file and prefix, but they are all still listed under
  that one `##` heading in the index, which is what keeps the pre-split anchors
  resolving.
- **Two section headings stopped describing their content partway through**, and
  moved verbatim anyway, because heading text never changes inside a
  transcription (§3). Each file's front matter and prefix already described what
  was actually in the file; #2707 widened the two headings to match, in its own
  reviewable change.

Both are recorded in [`_FOLLOW_UPS.md`](_FOLLOW_UPS.md) (§5, §6), where they are
now closed. Re-homing a block later costs nothing and breaks no citation, because
IDs are location-independent (§1.4).

The two largest files — `membership-lifecycle.md` (82 IDs) and
`subscription-lockout-pricing.md` (68) — are kept whole. Splitting either would
require inventing headings the source does not have and would break internal
positional pointers. Neither is a filed split candidate:
[`_FOLLOW_UPS.md`](_FOLLOW_UPS.md) §1 registers over-coarse *blocks*, not
over-large files, and splitting a file is a decision on the record (§9) rather
than an outstanding item.

### 5.2 Size, and why the split exists at all

| | ≈tokens |
| --- | ---: |
| The pre-split `docs/DOMAIN_INVARIANTS.md`, mandatory read #6 of nine | **108k** |
| The index today — routing table plus the full ID catalogue | ~11k |
| Largest single domain file (`membership-lifecycle.md`) | ~24k |
| Typical domain file | 1–9k |

`AGENTS.md` → "Read First" holds the agent-neutral always-read core to two
documents, of which the index is one; every other invariant file is **routed** —
opened at the moment its row matches what you are changing. Agent-interface
adapters import or point to that authority instead of joining the mandatory
core. That budget is the reason the index's one-line descriptions are capped at
**12 words** each. The cap is load-bearing: relax it and the index stops fitting
the core.

If the index ever outgrows the budget, the cheapest lever is to move the full ID
catalogue into a separate `docs/invariants/ID-INDEX.md`, leaving the routing
table in `docs/DOMAIN_INVARIANTS.md` as the always-read part. Keeping both in one
file is preferred while it fits, because it satisfies "find the right file
without opening more than one other file".

---

## 6. The index

**The index is `docs/DOMAIN_INVARIANTS.md`.** It is not in this directory, and
there is deliberately no `docs/invariants/README.md`: entry-point docs, guides,
source files and agent helper scripts already point at that path in quantity.
Moving it would turn a free migration into widespread edits and a permanent
fork-compatibility break, and would gain nothing a reader can feel.
`npm run docs:indexcheck` treats `docs/DOMAIN_INVARIANTS.md` as the root of the
invariants tree.

This section used to add that "many inbound anchors" target the headings the
index keeps verbatim. That claim could not be reconciled with the repository and
is withdrawn: measured on 17 Aug 2026, **no tracked file links to an index
anchor at all** — every reference is to the bare path. The promise in §4.1 is
therefore about anchors held somewhere this repository cannot see: a fork, a
merged commit, a closed issue, a shipped release. Unmeasurable is not the same
as absent, and it is the stronger reason to pin the headings mechanically rather
than to count the links: a heading rename would break them silently and
permanently, and the pin is what makes the breakage loud at the moment of the
edit instead.

### 6.1 What the index contains

- The **routing table**: one row per file, its prefixes, and a "read it when you
  are changing…" line.
- **How IDs work**: the operative rules from this file in about twenty lines,
  with a link here for the rest.
- The **ten domain `##` headings** of the pre-split document, byte-identical, so
  every pre-split anchor still resolves — pinned by the docs-integrity check
  (§4.1). Under each: one sentence of what it covers, the file(s) it lives in
  with their prefixes, and a table of every ID with a one-line (**≤ 12 words**)
  description. Sections added since the split sit alongside them and are not
  part of that promise.

A domain whose content is split across several files lists each file under the
same `##` heading, so the inbound anchor still lands on something that routes
correctly.

---

## 7. Where a new invariant goes

Answerable from the index alone, in four steps:

1. Read the routing table; pick the domain whose "read it when you are
   changing…" line matches your change.
2. Read that domain's file list; pick the file. If two fit, pick the one whose
   prefix your rule will be cited alongside.
3. Take the next number: `max` of that prefix's numbers in the index, plus one.
4. Put the block where a reader would look for it in the file — **not** at the
   end — and add its row to the index in file order.

Then cite it: a guard, test or comment that enforces a rule should name the ID in
its failure message, so whoever trips it is handed the rule instead of having to
go find it.

### 7.1 Worked example, and the one live merge hazard

The `fix/issues-2681-2682-capacity-and-today` branch (PR #2696) predates the
split. It adds one top-level bullet to `docs/DOMAIN_INVARIANTS.md` inside
`### Date handling rules`, between the `@db.Date` comparison rule and the
client-side `yyyy-MM-dd` rule, stating that a server asking for "today" asks the
club's calendar, with two exact boundaries and one reverse case.

Resolved against this scheme. The fenced transcript uses the non-live
`INV-EXAMPLE` stand-in so it cannot masquerade as the live prefix maximum:

```
File:      docs/invariants/booking-dates-and-capacity.md
Section:   ## Date handling rules
Position:  immediately after INV-EXAMPLE-013, immediately before INV-EXAMPLE-014
ID:        INV-EXAMPLE-019          <- next free in the prefix, NOT 013.5 and NOT 014
Index row: | `INV-EXAMPLE-019` | Ask the club's calendar for "today", never the UTC clock |
```

Note the ID would be `019` while the block sits fourth in its section. That is
the allocation rule working, not a mistake (§1.3). Its internal phrase "see the
next invariant" still points at `INV-DATE-014`, which is still physically next,
so no pointer repair is needed.

**This is also the answer to the merge hazard**, and the same answer applies to
any other branch still editing the pre-split document. Git presents such a branch
with a conflict against a file that no longer holds the section, and the wrong
resolution — accepting the deletion — silently drops an invariant. The resolution
is: take the added lines, drop them into the domain file at the position shown,
under a fresh ID heading, add the index row, and discard the conflict on
`docs/DOMAIN_INVARIANTS.md`.

---

## 8. Enforcement

`scripts/ci/check-doc-index-integrity.mjs`, run by `npm run docs:indexcheck` and
by the `verify` job on every PR. It needs no network, no build and no Prisma
client — it is a single `node` script over the tracked tree and its git base
revision.

Current-tree scans plus one fail-closed revision comparison. Pull-request CI
uses the event's exact base SHA, main-push CI uses the event's exact pre-push
SHA, and local feature work uses its merge-base with `origin/main` (or `main`).
That is an exact statement about what one evaluation checks, not a promise that
an old green evaluation stays current after another PR merges. Evaluated against
the current base, a duplicate or deletion is rejected. Before merge, the house
procedure refreshes current `main` and verifies no conflict plus every required
check on the exact current head; an independently green stale-base result is not
merge evidence. Changing branch protection's strict-status setting is a separate
owner action, not part of this checker.
An explicit or event ref that is absent from the checkout fails the gate; it
never drifts to the current branch tip or falls back to `HEAD^1`, which may be a
feature commit made after an ID was deleted. Event identity is authoritative:
`GITHUB_EVENT_NAME` chooses the pull-request or main-push contract before any
payload field is interpreted. In particular, a pull-request `synchronize`
payload's top-level `before` value is the previous PR head, not evidence of a
second push event; the pull request still uses only `PR_BASE_SHA`. With no event
identity, conflicting PR and push SHA fields fail rather than being guessed. An
inherited `DOC_INDEX_BASE_REF` at process, workflow, job or step scope makes
an event run fail rather than overriding `PR_BASE_SHA` or `PUSH_BASE_SHA`. The
diagnostic override is local-only. The workflow contract pins both immutable
environment mappings and the exact unprefixed
`node scripts/ci/check-doc-index-integrity.mjs` command, so an inline assignment
cannot replace either event identity with `HEAD`. Definitions and ordinary
citations are read **outside Markdown literal blocks**. One bounded CommonMark
block pass classifies fenced code inside blockquote and list containers,
indented code, raw HTML, paragraphs, and ATX/Setext headings. A type-7 HTML tag
cannot interrupt an active paragraph; a literal fence marker inside `<pre>` or
another HTML block cannot change how the following headings are classified. The
shape audit covers both sides of a literal region, including a fence opener's
info string: any numeric token under a prefix this repository really declares
has exactly three digits, and a well-formed one must resolve. Placeholders
(`INV-<PREFIX>-<NNN>`), reserved invoice numbers and custom fixture prefixes
remain legal examples. This scheme adds a stronger source-trap rule: its own
illustrative literal blocks contain no live prefix/number pair, even one that
resolves, because a repository grep cannot tell an example from the catalogue.

Both sides come from that one bounded block classifier. It remembers a fence's
blockquote/list containers, whether the opener used backticks or tildes, and how
long that marker run was. Only the same marker with at least that length closes
the block; a triple-backtick line inside a four-backtick fence, or a tilde run
inside a backtick fence, stays content and cannot invert which audits see the
following lines. Four-space indented code is literal when it begins outside a
paragraph. A type-1 raw HTML block ends only at the closing tag matching its
opener (`<pre>` at `</pre>`, never `</script>`); standard block tags stay literal
until the terminating blank line, while a syntactically valid
type-7 tag starts that form only when no paragraph is active, including a
container paragraph continuing lazily without its quote/list marker. A newly
opened blockquote or list interrupts the prior paragraph, so type-7 HTML and
indented code may start inside that fresh container. An ordered list can
interrupt an active paragraph only when it starts at one. A markerless lazy
line retains its original container for the next marked continuation; five
spaces after a list marker are one padding space plus four-space indented code,
not ordinary prose. Tabs are expanded at four-column stops for the same choice,
then container prefixes consume virtual-column slices rather than whole tab
characters. Thus two tabs after a bullet, or a tab plus two spaces after either
a bullet or blockquote marker, retain at least four code-indentation columns.
An empty list marker also establishes the default one-column padding used to
classify its following indented code. A blank line retains an open list's
container widths, so an indented continuation remains list-owned rather than
being misclassified as top-level code. A fresh list sibling is recognised by
its nesting, list kind and delimiter rather than by the previous item's padding:
`9.` followed by `10.`, or two items with different padding, still starts a
fresh list paragraph. A changed `.`/`)` delimiter is a different list, and the
rule that `2.` cannot interrupt an unrelated paragraph still holds. An unmarked
thematic break ends the container paragraph, and a spaced top-level `- - -` or
`* * *` takes thematic-break precedence over the list marker its first
character resembles. Within the same marked container, a dash or equals
underline keeps Setext-heading precedence. A markerless equals underline stays
lazy paragraph text rather than becoming a Setext heading.

**Definition** — collected only from `docs/invariants/**/*.md`:

```js
/^#{2,4} (INV-[A-Z][A-Z0-9]*-\d{3})\s*$/
```

A definition is a top-level heading whose entire text is the ID. A citation is
never a whole heading line, so there are no false positives in either direction.
The level range `2–4` exists because an ID heading always sits exactly one level
below its nearest structural heading, and a file with no subsections has one
level less.

Every unfenced Markdown heading under `docs/invariants/` that contains a numeric
invariant-shaped token is checked against that exact shape. Numeric tokens in
headings are reserved for definitions: a legitimate narrative heading names the
topic and puts any invariant citation in its body. This catches a lower-cased,
backticked, wrongly levelled, wrongly padded, decorated, container-owned, Setext
or identifier-suffixed heading (`INV-<PREFIX>-002a`,
`INV-<PREFIX>-002_extra`, `INV-<PREFIX>-002-extra`, or the forbidden dotted
sub-ID `INV-<PREFIX>-002.1`) that would otherwise be invisible as a definition
or pass merely because an embedded ID resolved as a citation. Inline emphasis,
strong emphasis, code, strike-through, inline HTML, GFM inline/reference link
labels and numeric
character references cannot split the visible token around that sentinel: a
heading such as `INV-**<PREFIX>**-002`, `INV-[<PREFIX>](https://example.invalid)-002`
or `INV-M&#79;NEY-002` is rejected as decorated rather than disappearing from the
definition census. The sentinel uses a bounded visible-text normaliser rather
than a second Markdown renderer; canonical definition parsing remains exact.
The same four
identifier continuations are rejected in ordinary prose, source code, literal
blocks and fence opener info strings rather than being truncated to the
valid-looking numeric prefix. A full stop used as punctuation remains legal;
only a dot immediately followed by a digit is a dotted sub-ID.

**Citation** — collected from every nonempty tracked text file. The loader asks
Git for its tracked working tree and uses Git's own binary/text classification;
it does not maintain an extension allowlist. That includes TypeScript's `.mts`
and `.cts` forms, shell scripts, TOML, JSON-with-comments, plain text, HTML and
extensionless text files without traversing anything outside the tracked tree,
such as dependency or generated directories. Empty files have no line, token,
byte-order mark or encoding sequence to audit. CommonMark block classification
applies only to `*.md`; every other
format is scanned linewise so indentation or JSX/HTML syntax cannot disguise a
citation as a Markdown code or raw-HTML block:

```js
/\bINV-[A-Z][A-Z0-9]*-\d{3}\b/g
```

**Shape guard** — built from the prefixes the definitions actually declared, so
a near-miss under a real prefix is reported rather than being invisible:

```js
new RegExp(`\\bINV-(?:${[...prefixes].join("|")})-[0-9]+\\b(?!-[A-Za-z0-9_])`, "g")
```

Every match of it must have exactly three digits. Without this,
`INV-CAP-1` and `INV-CAP-0011` slip past the strict citation regex and resolve
to nothing while being reported as nothing. A separate identifier-continuation
audit owns letter, underscore, hyphen and dotted-numeric suffixes, so the numeric
matcher does not also report the numeric prefix of a malformed ID. It is scoped to
declared prefixes rather than to `INV-[A-Za-z]…` generally, because a generic
shape guard flags every Xero invoice fixture in the test suite (§1.2.1).

**The check asserts, in this order:**

1. Every unfenced invariant-document heading containing a numeric invariant
   token is exactly a canonical definition heading: correct case, level, digit
   width, no identifier suffix and no decoration.
2. No duplicate definition of any ID, across all files.
3. Every ordinary citation whose prefix is a **declared invariant prefix**
   resolves to a definition.
4. Every numeric token inside a literal block or fence opener whose prefix is
   declared has exactly three digits, and every such well-formed ID resolves;
   placeholders, reserved invoice numbers and custom fixture prefixes are not
   treated as live IDs there. Illustrative literal blocks in this file are
   stricter and contain no live prefix/number pair at all.
5. Every ordinary citation whose prefix is **not** declared is either on the
   reserved list — `IB`, `SETTLE`, `SUP`, `SUB`, `XERO`, `FAM`, `LEGACY`, `PM`,
   `JOR`, `REB`, documented in the script as Xero invoice-number fixtures — or
   the check fails with "unrecognised `INV-` prefix: add it to the invariant
   index or to the reserved list". This is what catches a typo'd prefix — a
   misspelling of a real prefix — which a whitelist alone would silently ignore.
6. Every ordinary (unfenced) shape-guard match has exactly three digits, and in
   either ordinary or literal source a declared-prefix ID has no letter,
   underscore, hyphen or dotted-numeric identifier continuation after those
   digits.
7. Every file under `docs/invariants/` is linked from
   `docs/DOMAIN_INVARIANTS.md`, and every file linked from it exists.
8. Every defined ID appears exactly once in the index. A valid GFM table row may
   carry zero to three leading spaces; all four forms count for both presence and
   duplicate detection.
9. The `AGENTS.md` routing table resolves in both directions: every family it
   routes is declared, every declared family has a row, and every document it
   links to is a tracked file.
10. Nothing cites an invariants document by **line number**. No allowlist and no
   grandfather register: that pointer goes stale silently, which is the habit the
   IDs exist to replace.
11. Every page under `docs/` is reachable from a documentation front door.
12. No tracked text file carries a byte-order mark or double-encoded text, and
    none carries a **raw control character** — every C0 byte except TAB, LF and
    CR, plus DEL. No allowlist, including inside a comment: where the character
    is wanted as data the escape sequence denotes the identical value, so
    spelling it out costs nothing. Its sibling check catches the one byte that
    could evade it: a NUL early in a file makes Git call the file binary, which
    would hide it from every check on this list. So a tracked file that drops
    out of Git's text scan fails **unless `.gitattributes` declares it a binary
    asset** — a declaration of what the file is, not an exemption from the rule
    above. Asked the other way round, keyed on the `text` pins, it was vacuous
    for the 43 tracked text files in classes nobody had pinned (#3072).
13. Every prefix's numbers are **dense from `001`** — no gap between its lowest
    and its highest (§1.3.4).
14. Every ID defined in the base revision is still defined in the current tree.
    This catches deletion of a prefix's highest ID and deletion of a whole
    prefix, which no snapshot-only density check can observe.

The catalogue assertion is what stops the index rotting, which is the thing most
likely to rot. Density makes §1.3's allocation rule mechanical rather than
advisory; base-revision retention separately enforces §1.4's append-only rule.
Neither is a substitute for the other.

Inline code spans are **not** skipped. Most real citations in prose are written
as `` `INV-CAP-021` ``, and skipping backticks would make the check blind to
them. Fences are skipped by the broad scans and inspected by the narrow
live-prefix resolution pass described above. This file is exempt from the shape
guard alone — never from citation resolution — because it quotes malformed forms
on purpose, in prose, to explain what the guard catches.

Anchor-style citations (`…#inv-cap-021`) are deliberately **not** handled here —
`npm run docs:linkcheck` already validates fragments against real headings, so
that half is covered and duplicating it would give two places to disagree.

---

## 9. Decisions on the record

Seven questions were put to the owner before the restructure. All are settled;
they are stated above as the rules they became, and are collected here so nobody
has to relitigate one from memory.

| Decision | Outcome | Where it is stated |
| --- | --- | --- |
| Number width | **Three digits.** Two digits caps a prefix at 99 for all time and the width can never be widened afterwards. | §1.1 |
| Namespace | **`INV-` is kept**, despite the Xero invoice-number fixtures, with a reserved-prefix list carried by the check. A fresh namespace was the alternative and was not taken. | §1.2.1, §8 |
| Where the index lives | **`docs/DOMAIN_INVARIANTS.md`**, unchanged. Not `docs/invariants/README.md`. | §6 |
| Granularity | **One ID per block, not per sentence.** Per-sentence IDs require re-wrapping prose, which is how a word changes unnoticed. | §2 |
| Domaining | **Files follow the source's headings; nothing was re-domained.** The known mis-filing is filed, not fixed in the move. | §5.1 |
| The two largest files | **Kept whole.** Splitting either needs invented headings and breaks internal pointers. | §5.1 |
| The ` [INV-*]` pointer | **A permitted edit.** It is the only mechanism by which a transcription adds a word to rule text, it deletes and rewords nothing, and every use is registered in the PR body. | §3, §4.2 |

The first two are irreversible in practice: every merged citation would break.
Changing either now means superseding IDs one at a time under §1.4, not a
rename.

---

## 10. Known imperfections

The restructure found defects in the rule text itself — coarse blocks, a
citation to an identifier defined nowhere, a navigation pointer that points the
wrong way, near-duplicate rules, blocks in the wrong file, and passages the text
itself does not consider settled. **None were fixed in the move, and all were
filed as issues**; [`_FOLLOW_UPS.md`](_FOLLOW_UPS.md) records which are now
closed and which are still outstanding.

They are listed in [`_FOLLOW_UPS.md`](_FOLLOW_UPS.md), which is a register of
filed work rather than a rule: nothing in it is normative and nothing in it has
an ID.
