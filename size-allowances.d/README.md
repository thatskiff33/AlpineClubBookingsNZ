# File-size allowances

**Audience: developer.**

A pull request that has to make an already-over-budget source file longer says
so here, as **its own file**, and the file-size gate honours it.

This exists because the alternative is worse in both directions. Without it, the
283 production files that are already over budget — most of the modules people
work in every day — could never gain a single line, with no way to say "yes, I
mean it". With a shared list, every pull request edits the same lines and every
merge re-conflicts, which is the exact problem
[#2979](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2979) deleted
`scripts/quality/file-size-baseline.txt` to end. So this follows the pattern
this repository already used to solve the identical problem for `CHANGELOG.md`:
**one new file per pull request**, at a path no other pull request touches. Two
branches cannot conflict over files they do not share.

That is not a local trick, it is a rule: **an artifact every lane adds an entry
to is a directory of per-lane fragments, never one shared file.** It lives in
`AGENTS.md` -> "Change Discipline", and
[`changelog.d/README.md`](../changelog.d/README.md) - the original of the
pattern - carries the full statement, the other instances, and when
`merge=union` is the right remedy instead. This directory being one *instance*
of that rule rather than a special case is the point of
[#3111](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3111): while
the two directories read as unrelated one-offs, the next artifact of the same
shape got a shared file, and four lanes appended to it before anyone noticed.

**Splitting the file is still the better answer wherever it is available.** An
allowance is for the case where the split is genuinely worse — where the rule
and its exception belong in one place, or where the seam does not exist yet and
inventing one for this change would make the code harder to follow. Reach for it
knowingly, not to get past a red check.

## Writing one

1. Create `size-allowances.d/<pr-number>-<short-slug>.md`, for example
   `size-allowances.d/2980-membership-type-policy.md`. The name must not be
   `README.md`, and the file must end in `.md`.
2. Give it one entry per file, each three fields on their own lines. Anything
   else in the file — a heading, a paragraph, blank lines — is prose the gate
   ignores, so write for the reviewer as well as the tool.
3. Commit it with the rest of the pull request.

```markdown
# File-size allowances for #2980

file: src/lib/membership-type-policy.ts
lines: 1509
reason: the school-teacher discriminator has to sit beside the policy it
  guards; splitting it would put the rule and its exception in different
  files, which is how the last two exceptions drifted apart.

file: src/lib/booking-modify-plan.ts
lines: 1042
reason: the new sparse-night branch is four lines of policy inside an
  existing decision tree, and lifting that tree out is a refactor of its own.
```

- `file:` — the repo-relative path, with forward slashes. It must be a
  production source file the policy covers (tracked, under `src/`, not a test
  path). One entry per file **in your allowance file**; two entries for one
  file there is an error, and so is one change carrying two allowance files
  that name the same path. A file named by an allowance that has ALREADY
  MERGED does not count — that allowance is inert, so declaring a fresh one
  for the same path in a later change is exactly what you should do.
- `lines:` — the length the file really is after this change. Not a ceiling, not
  a guess: the gate fails if it does not match, which is what stops an allowance
  drifting away from the tree the way the old ledger did.
- `reason:` — why splitting is worse here, in at least twenty characters. Wrap
  it across indented continuation lines as above. A reviewer weighs this, so a
  bare "needed" is refused.

## What an allowance may and may not do

It may let a file that was **already over its budget** on the base ref grow.

It may **not**:

- let a **new** file skip its budget;
- let a file **renamed into** the budgeted scope — from `prisma/`, `scripts/`,
  or a `__tests__/` path — inherit a ceiling from outside it;
- carry a file **over its budget for the first time**. A module still inside its
  budget has the cheapest split available to it, so it should take it.

Each of those is refused by name, with the reason, rather than ignored. They are
the bypasses [#2987](https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/2987)
closed, and an escape hatch that quietly reopened one would be worse than no
escape hatch at all.

## They cannot rot, and they are disposable

An allowance is **one-shot**. Once the pull request merges, the grown length
*is* the length on `origin/main`, so the same file needs no allowance next time.
Two rules keep that true:

- an allowance only has effect on the change that **introduces** it — the
  allowance file itself has to be part of that change's diff. After merge it is
  inert, and cannot be reached for by a later pull request;
- an allowance this change did not need **fails the check**, so one cannot be
  left lying around to be re-used. If you split the file after writing the
  allowance, delete the entry.

Merged files can therefore be swept from this directory in bulk at any time,
the same way compiled changelog fragments are. Nothing depends on them.

One consequence worth knowing: after merging `main` into a long-lived branch,
an allowance that came in with `main` may report as unused if your branch also
shrank the file it named. Deleting it is the right fix and is safe.

## Where the rules live

[`docs/MAINTENANCE.md`](../docs/MAINTENANCE.md) → "File-size budget ratchet" is
the canonical description of the gate, its budgets and this escape.
