<!-- The pull-request description that `.github/workflows/epic-branch-sync.yml`
     writes when it opens a `main` -> `epic/**` sync pull request.

     IT LIVES IN A FILE RATHER THAN IN THE WORKFLOW'S SHELL for one reason: it
     has to satisfy the `## Concurrency And Lock Impact` gate, whose field
     labels are matched EXACTLY, and a template nobody can run through that gate
     offline is a template whose next typo surfaces as a red pull request from a
     06:20 UTC scheduled job that nobody is awake to read.
     `scripts/ci/render-epic-sync-pr-body.test.mjs` runs this file
     through the real gates, and through the real field list in
     `.github/pull_request_template.md`, so a mistyped label fails `npm test`
     instead.

     Substituted by the workflow, with no escaping and no other placeholders:
       __BRANCH__   the epic branch being synced, e.g. epic/2943-group-trip-hosting
       __RUN_URL__  the workflow run that opened or refreshed this pull request -->

Automated daily sync of `main` into this epic's integration branch (#3002).

It exists so the eventual `__BRANCH__` → `main` merge is a series of small reconciles rather than one large one. This repository has twice shipped a **wrong value** out of a hand-resolved long-lived conflict — #2979's file-size ceiling, and the `CHANGELOG.md` churn #2452 ended — so the cost of letting this sit is not merely inconvenience.

**If it is green, it merges itself.** Auto-merge is armed.

**If it conflicts,** resolve it on `__BRANCH__` by hand: `git merge origin/main`, resolve, commit, push. Do not force-push a shared integration branch, and do not let a merge tool pick a side unread. Classify each conflict: where the two sides differ only in a NUMBER, that number is usually measured and must be RE-measured after the merge rather than picked; where they differ in words, both edits usually belong.

Run: __RUN_URL__

## Concurrency And Lock Impact

**The sync workflow wrote this section; no person examined the diff to produce it, and it must not be read as though one had.** It is here because the gate that requires it is the first step of `verify`, so without it the job fails in under half a minute and every later step — lint, typecheck, knip, the suite, the build — is skipped. That is precisely backwards: proving `main` and this epic branch still work together is the entire point of the sync, and the missing section was stopping the proof from ever running (#3142).

The answers below are true structurally, not because anything was inspected. **This pull request's head IS `main`.** It therefore introduces no commit that has not already merged to `main` under its own declaration and its own nine required checks — nothing in the range is being reviewed here for the first time, and no writer, key or acquisition order anywhere is added, removed or reordered by merging `main` into a branch.

`N/A` is deliberately not ticked. The range does carry concurrency-sensitive paths — `prisma/schema.prisma` and `prisma/migrations/` among them — so ticking it would assert something untrue about the diff even though it is true about the merge.

- [ ] N/A
- Writer class(es), canonical lock key(s), and acquisition order: None new, structurally — see above. Every writer and lock key in this range landed on `main` on its own pull request, under its own declaration.
- Immutable pre-lock key source and mutable under-lock re-read: Unchanged. No lock-taking code is written by this merge, so no key source and no under-lock re-read moves.
- Status-guarded claim and proof that a lost claim runs no side effect: Unchanged. No status-guarded claim is added or altered, and merging already-merged commits onto an integration branch runs no side effect of its own.
- Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence: #3002 is the integration-branch model this sync serves and #3142 is why this section exists. The evidence that matters is not a list of pull request numbers: it is the nine required checks running on **this** pull request, over `main` and `__BRANCH__` merged together. Whether the two sides' writers actually compose is measured there, which is the whole reason the sync opens as a pull request instead of pushing.
- Provider calls inside a transaction (write `None`, or justify the bounded exception from `docs/CONCURRENCY_AND_LOCKING.md`): None.

**Where the real lock question gets asked.** A merge can compose two writers that were each declared correctly and still disagree — `main` taking lock A then B while this epic takes B then A. Nothing above rules that out, and nothing above claims to. That question belongs to `__BRANCH__`'s own pull request into `main`, which is an ordinary gated pull request with a real author writing a real declaration over the epic's real diff.

## Changelog Entry

- changelog: none — a sync introduces no source change of its own. Every entry for the commits in this range is already a `changelog.d/` fragment written by the pull request that landed it on `main`, and it compiles at release from there; writing a second entry here would double-count it.
