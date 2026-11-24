# Changelog fragments

Every pull request that changes application source writes its changelog entry
here, as **its own file**, instead of editing the top of `CHANGELOG.md`.

The reason is mechanical: when every branch edits the same few lines at the top
of `## Unreleased`, concurrent lanes conflict on that file every single day
(`AGENTS.md` §5, "Housekeeping that bites parallel lanes"). A new file per pull
request never conflicts. At release time the fragments are compiled into a real
version section and deleted.

The `CHANGELOG.md merge=union` declaration in `.gitattributes` (#2451) stays as
belt-and-braces through the transition, so the pull requests that still edit
`CHANGELOG.md` directly keep merging without a manual resolve.

## The general rule, of which this is one instance

**An artifact every lane adds an entry to is a directory of per-lane fragments,
never one shared file** - a lane adds a file rather than editing a shared list,
so two lanes cannot collide. That rule lives in `AGENTS.md` -> "Change
Discipline", and the row in its routing table points back here for the detail.

There are six instances, and until [#3111](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3111)
they read as four unrelated special cases rather than as one rule - which is how
a fifth artifact came to be appended to by four lanes at once before anyone
recognised what it was:

| Artifact | Remedy | Why it is in the class |
|---|---|---|
| `changelog.d/` | fragment directory | Every code-bearing pull request adds one entry (#2452) |
| `size-allowances.d/` | fragment directory | Every lane that grows an over-budget file adds one allowance |
| `dependency-mitigations.d/` | fragment directory | Each owner-approved, expiring dependency-audit mitigation is one record (#3843) |
| `CHANGELOG.md` | `merge=union` (#2451) | A flat list of released lines, none of which refers to another |
| `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` | `merge=union` (#3111) | One row per migration, hand-appended by every schema lane |
| `scripts/audit/audit-write-sites.ts` | `merge=union` (#5211) | One GENERATED line per audit write site; every lane that adds a writer regenerates it |

**The fragment directory is the default; `merge=union` is the exception.** Union
keeps both sides' added lines, which is precisely the resolution a human would
make for a flat list of unrelated lines. It is the wrong answer for a document
with sections: it interleaves blocks in arbitrary order and can duplicate
headings, and it does so **silently**, where a conflict is loud. So a narrative
document several lanes co-edit stays an ordinary file and takes the conflicts.
#3111 measured `docs/CLUB_TIME_KERNEL.md` and found it is that shape - a
seven-section topical reference each lane revises in place - rather than a
ledger, which is why it was left alone.

`src/lib/__tests__/additive-artifact-fragments.test.ts` checks the six artifacts
above have not regressed, and fails a new top-level `*.d/` directory that nobody
registered. It cannot recognise a newly invented shared **file** that should have
been a fragment directory - no offline check can, and #3111 records the two
measurements that killed the attempt. That gap is what the stated rule and its
routing row are for.

## Adding a fragment

1. Create `changelog.d/<pr-number>-<short-slug>.md`, for example
   `changelog.d/2448-booking-request-tolerant-reads.md`. Any name works — the
   PR number simply keeps the release section in a sensible order — but the
   name must not be `README.md`, and the file must end in `.md`.
2. Write the entry exactly as it should appear in `CHANGELOG.md`: one or more
   top-level `- ` bullets in the house style below. Nothing else — no headings,
   no version number, no date.
3. Commit it with the rest of the pull request. The `verify` job checks that a
   code-bearing pull request carries one.

### Linking a doc from a fragment

Write a relative link the way it works from this directory, so it is correct
where you write it: `[the guide](../docs/guides/club-time.md)`. When the
compiler copies the fragment into `CHANGELOG.md` at the repository root, it
rewrites each relative link to resolve from there instead
(`docs/guides/club-time.md`), so `docs:linkcheck` passes both before and after
a release (#5214). That covers a link whose text wraps onto the next line,
both targets of an image used as a link (`[![alt](../img.png)](../docs/A.md)`)
or of a link inside an image's alt text, and reference definitions, including
`[ref]: <../docs/a file.md>`. Absolute URLs, `#anchor` links and links shown
inside code are left alone. A link that climbs out of the repository
(`../../x.md`) has no root-relative form; `changelog-fragment-shape` refuses
it, and so does the compiler.

## Patch or minor: the `.feature.md` suffix

The fragment's filename is the only type it carries, and it decides the next
version number (#4465). Name the fragment `<pr-number>-<short-slug>.feature.md`
when the change gives clubs something new — a capability, a setting, a screen —
or changes behaviour an operator has to learn or act on. Every other fragment
keeps the plain `.md` name and counts as a fix.

`pnpm run release:cut prepare` makes the release **minor** (`0.13.2` →
`0.14.0`) when any fragment in it ends in `.feature.md`, and a **patch**
(`0.13.2` → `0.13.3`) otherwise. It prints that suggestion with the fragments
that caused it, and `--bump patch|minor|major` overrides it — the maintainer's
call for a release whose fragments predate the suffix, and the only way to a
major release. The suffix changes nothing else: the compiler releases a
`.feature.md` fragment exactly like any other.

## The house entry style

An entry is written for a club administrator reading a release note, not for a
developer reading a diff. It opens with a **bold plain-English headline that
ends with the issue number in brackets**, then explains in ordinary sentences
what changed, what an operator will notice, and anything they must decide or do.
Continuation paragraphs are indented two spaces so they stay part of the bullet.

A worked example — `changelog.d/2448-booking-request-tolerant-reads.md`:

```markdown
- **A booking request no longer fails when the club's calendar is slow to
  answer (#2448).** Submitting a request used to give up the moment the
  availability lookup took longer than usual, and the member saw a generic
  error even though nothing was wrong with their request.

  The lookup is now retried briefly before the request is refused, and the
  message a member sees when it genuinely cannot be answered says so plainly
  and keeps what they had typed.

  Nothing about how availability is calculated changed — only how patiently
  the request waits for the answer.
```

Match the length to the change: a small fix is two or three sentences, a
behaviour change that operators must understand gets the fuller treatment above.
Read the last release section of `CHANGELOG.md` for the tone.

## When no entry is needed

Some code changes genuinely have nothing to tell a reader — a pure internal
refactor, a comment-only change, a test-seam tweak. Say so explicitly in the
pull request body by putting this marker on its own line:

```text
changelog: none — <one-line reason>
```

That is the same escape a docs-only pull request gets for free: pull requests
that touch nothing under `src/` or `prisma/` (outside test files) are never
asked for an entry at all.

The marker is deliberately **not** pre-filled into
`.github/pull_request_template.md`. A marker present in every pull request body
would switch the gate off for everyone.

## What the gate treats as "code-bearing" (a recorded decision)

`scripts/ci/check-pr-changelog-fragment.mjs` asks for an entry when a pull
request changes a non-test file under **`src/`** or **`prisma/`** — nothing
else. That definition is deliberately **identical to the one the concurrency
gate uses** (`scripts/ci/check-pr-concurrency-declaration.mjs`), so "this PR
carries application code" means exactly one thing across both gates, and a
future change to one has to be made to the other on purpose.

The cost of that choice is real and accepted: a change that only touches
`next.config.ts`, `sentry.*.config.ts`, `deploy/`, `scripts/`, `e2e/`,
`.github/workflows/`, `middleware.ts` or `package.json` can be user-visible —
a changed security header, a new deploy step, a dependency bump an operator
must know about — and the gate will **not** ask for an entry. Write the fragment
anyway when the change has something to tell a reader; the gate is a floor, not
the standard. Widening the definition instead would fail a large class of PRs
that genuinely need no entry (every workflow tweak, every test-harness change),
and the noise would train everyone to reach for the no-entry marker, which is
the one outcome that switches the gate off in practice.

## After-deploy steps: the `.deploy.md` suffix

A change that needs someone to act once its release is deployed — run a
report, map a setting, check a page — writes that step as its own fragment,
`changelog.d/<pr-number>-<short-slug>.deploy.md` (#5379, owner decisions D1 and
D4, 22 Nov 2026). **The pull request's author, human or agent, adds it in the
same pull request.** Before, such steps lived only in pull request
descriptions, and a release's checklist had to be collected from them by hand
(#5378). A pull request with two steps writes two fragments.

The file is exactly three headings, once each, in this order, with nothing
above the first and no other heading:

```markdown
## Who

operator

## What to do

Before or during the deploy, check that your Stripe webhook endpoint sends the
four `charge.dispute.*` events, as `DEPLOYMENT.md` lists them.

## How to check it worked

The endpoint's event list in the Stripe dashboard includes all four.
```

- **Who** is one line naming one role: `owner` (the club's owner, for a
  production action only they may take), `operator` (whoever runs the
  servers and the release) or `officer` (a lodge officer with admin access,
  for a check in the app).
- **What to do** and **How to check it worked** each open with a sentence,
  not a list, quote, table or code block; more paragraphs, lists or code may
  follow. Say "before or during the deploy" in What to do when the step cannot
  wait until after: the filed list tells the reader to do such a step before
  deploying.
- Every link, Markdown or HTML (`<a href>`, `<img src>`), is an absolute
  `https://` URL or a `mailto:` address; write a repository path in backticks
  instead. A step is copied into the upgrade guide, the notes page and a
  GitHub issue, where a relative or same-page link points somewhere different
  in each, so a relative link, or any other scheme, is refused.
- The name is lower-case letters, digits and hyphens. It normally opens with
  the pull request's number, which the checklist links; a lane that names its
  files before the pull request exists may use its lane name and rename it
  once the number is known.

`scripts/lib/deploy-fragments.mjs` is the one definition of the format. A
`.deploy.md` file is not a changelog entry: the compiler never puts it in
`CHANGELOG.md`, and it does not satisfy the changelog gate, so a code-bearing
pull request still writes its ordinary fragment too.

What happens to it:

- **`verify` and `pnpm run pr:check`** fail a pull request whose "Manual Checks
  Required" or "Migration Or Deployment Impact" answer names a time after
  the deploy or the release ("after deploy", "after the next deploy",
  "post-deploy", "after release", "after the new release", "post-release",
  "after this release's deploy", "after the new colour", "after upgrading",
  "after the upgrade", "after cutover", "once this ships", "once deployed",
  "once it is live", "once the new release is serving", "once released") or
  says "the owner runs" or "should run", in any case and even wrapped onto
  the next line, while its diff adds or changes no
  `.deploy.md` fragment, and fail any `.deploy.md` it adds or changes that is
  malformed (`scripts/ci/check-pr-deploy-fragment.mjs`).
  A pull request with no such step answers "None. No after-deploy step." The
  gate reads a negated answer as no step: "no", "none" or "nothing" before
  the time, with only words such as "step", "is", "needed" or "to do"
  between ("None after deploy.", "Nothing to do after release."), or the time
  then "nothing" or "none" ("After deploy: nothing"). Only those words are
  set aside: the rest of the sentence is read as usual, so "None. After
  deploy, run the census." and "After deploy nothing breaks, and the owner
  should run the census." fail. A negation may wrap onto the next line only
  where that line finishes it ("None. No" then "after-deploy step."), not
  where it opens with a capital (a new sentence) or goes on to a step ("None"
  then "after deploy run the census." fails). A negation whose clause goes on
  with "unless", "if", "but" or "except" is no negation: "No step is needed
  after deploy unless SMTP is set." and "After deploy, nothing changes for
  members, but run the backfill." both fail. A clause ends at a full stop, a
  semicolon or the line's end.

  There is no escape marker or phrase (owner decision, 25 Nov 2026, #5379):
  a sentence that only describes behaviour after the deploy trips the gate
  too, and its author rewords it to name no time after the deploy. For
  example, "Just after deploy one extra alert can go out" becomes "One extra
  alert can go out while the two releases overlap."

  The release-prep pull request, which deletes the fragments it files and
  changes nothing but the files `release:cut prepare` writes, is exempt.
- **`pnpm run release:cut prepare`** refuses to cut, changing nothing, while any
  `.deploy.md` is malformed. Otherwise it files every step, one checkbox each,
  under "After deploying this release" at the end of the release's section of
  `docs/UPGRADING.md` and in its notes page `docs/releases/v<version>.md`, and
  deletes the fragments with the others. `--amend` adds late steps to both.
  `compile-changelog.mjs` run on its own validates them but leaves them in
  place.
- **`pnpm run release:cut publish`** opens a "v<version> post-deploy checklist"
  issue from the notes page's steps, labelled `post-deploy-checklist`, and links
  it from the GitHub release. It is assigned to the repository's owner (owner
  decision D2 on #5379), or to `--checklist-assignee <login>` when given; when
  an organisation owns the repository, or GitHub cannot say, it is assigned to
  whoever publishes (`@me`) and the plan says why. A re-run finds the issue by
  its label and reuses it. If it cannot be opened, the release is still
  published, linking the notes page instead, and the exact `gh` commands are
  printed. A release with no steps opens no issue.

## Compiling a release

`pnpm run release:cut prepare --execute` runs the compiler for you on a new
release-prep branch, with the version it worked out (see `docs/MAINTENANCE.md`,
"Public Reference Release Checklist"). To run the compiler on its own:

```bash
node scripts/release/compile-changelog.mjs 0.14.0 --dry-run   # show the plan
node scripts/release/compile-changelog.mjs 0.14.0             # do it
```

The compiler adds `## <version> - <date>` above the existing releases, filled
with every fragment in filename order (numeric parts compared as numbers, so
`999-…` sorts before `2448-…`), folds in any entries still written directly
under `## Unreleased`, deletes the fragments it consumed, retires committed and
clean `size-allowances.d/*.md` fragments already made inert by their merge to
main, and prints what it did. The allowance directory's `README.md`, untracked
drafts, branch-only commits and locally edited files are preserved; a locally
edited merged allowance stops the compile before any write. A refreshed
`origin/main` must be an ancestor of the release-prep checkout. Nothing is
retired if there is no changelog release to compile. The date defaults to today
in the release cutter's own time zone, or in `RELEASE_TIME_ZONE` when that is
set (#4571); pass one as the second argument to override it. Historical
sections are never rewritten. A failed removal restores the original changelog
and fragments for a safe retry; if restoration itself fails, stop and inspect
the files named by the error. The compiler cannot prove an unfetched remote
update does not exist, so refresh `origin/main` before running it.

Straight after a release, this directory and `size-allowances.d/` hold only
their `README.md`. That is their normal state, so a check that reads either
directory must pass when it is empty: assert that it read the right directory,
never that it found a fragment. `changelog-fragment-shape` tests this itself:
its rules pass on a directory holding only a `README.md` and still flag a bad
fragment in a populated one. These other checks read either directory from
disk and must pass when it is empty: `late-capture-decision-provenance`,
`cli-server-only-reach-census`, `additive-artifact-fragments`,
`agent-workflow-contract`, and the two censuses that scan
`live-doc-surfaces` (`audit-writer-census`, `view-only-banner-contract`).

A version that already has a section is refused — except with `--append`,
which adds the fragments (and any direct `## Unreleased` entries) to the end of
that existing section and keeps its heading and date. It refuses any section
but the newest, so it cannot rewrite a released version's notes. That is only for a
release prepared but not yet tagged, when fragments merged while its
release-prep pull request was open; `pnpm run release:cut prepare --amend` runs
it on a `release/v<version>-late` branch.

Two things under `## Unreleased` are **not** entries, and the compiler tells
them apart by marker rather than by position:

- The pointer note ("entries live in `changelog.d/`") is wrapped in
  `<!-- changelog-pointer-note:start -->` / `<!-- changelog-pointer-note:end -->`.
  Leave those comments in place. They exist because `CHANGELOG.md` is
  `merge=union`: a branch still writing its entry directly under
  `## Unreleased` can land that entry *above* the note, and a compiler that
  guessed by position would then publish the note inside a release section and
  delete it from `## Unreleased` for good. Anchored, the note is recognised
  wherever it sits and is rewritten directly under the heading every time.
- Anything else that is neither the note nor a `- ` bullet is left exactly where
  it is and reported with a loud `WARNING: unrecognised content left under
  "## Unreleased"`. Nothing is released and nothing is deleted — read the
  warning and either move the text into a fragment or wrap it in the sentinels.
