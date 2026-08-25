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

There are four instances, and until [#3111](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3111)
they read as four unrelated special cases rather than as one rule - which is how
a fifth artifact came to be appended to by four lanes at once before anyone
recognised what it was:

| Artifact | Remedy | Why it is in the class |
|---|---|---|
| `changelog.d/` | fragment directory | Every code-bearing pull request adds one entry (#2452) |
| `size-allowances.d/` | fragment directory | Every lane that grows an over-budget file adds one allowance |
| `CHANGELOG.md` | `merge=union` (#2451) | A flat list of released lines, none of which refers to another |
| `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` | `merge=union` (#3111) | One row per migration, hand-appended by every schema lane |

**The fragment directory is the default; `merge=union` is the exception.** Union
keeps both sides' added lines, which is precisely the resolution a human would
make for a flat list of unrelated lines. It is the wrong answer for a document
with sections: it interleaves blocks in arbitrary order and can duplicate
headings, and it does so **silently**, where a conflict is loud. So a narrative
document several lanes co-edit stays an ordinary file and takes the conflicts.
#3111 measured `docs/CLUB_TIME_KERNEL.md` and found it is that shape - a
seven-section topical reference each lane revises in place - rather than a
ledger, which is why it was left alone.

`src/lib/__tests__/additive-artifact-fragments.test.ts` checks the four artifacts
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

## Compiling a release

From the release-prep branch (see `docs/MAINTENANCE.md`, "Public Reference
Release Checklist"):

```bash
node scripts/release/compile-changelog.mjs 0.14.0 --dry-run   # show the plan
node scripts/release/compile-changelog.mjs 0.14.0             # do it
```

The compiler adds `## <version> - <date>` above the existing releases, filled
with every fragment in filename order (numeric parts compared as numbers, so
`999-…` sorts before `2448-…`), folds in any entries still written directly
under `## Unreleased`, deletes the fragments it consumed, and prints what it
did. The date defaults to today in New Zealand; pass one as the second argument
to override it. Historical sections are never rewritten.

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
