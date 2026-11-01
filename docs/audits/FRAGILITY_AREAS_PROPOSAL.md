# Fragility review: business areas

Audience: Developer, Agent

This is the first half of Goal 1's first move ([GOALS.md](../GOALS.md#first-move-find-where-bugs-come-back)):
a list of business areas, with raw counts of "bugs that came back" per area.
**Nothing here is ranked.** The 15-area list is confirmed by the owner
([recorded on #4024](https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/4024#issuecomment-6113045008),
11 Oct 2026); the ranking, with each area's evidence pairs, is
[FRAGILITY_RANKING_2026-10.md](FRAGILITY_RANKING_2026-10.md).

## Owner decisions

The list under "The 15 areas" is confirmed. Its mapping rules live in `AREAS` in
`scripts/audit/fragility-areas.mjs`, so any later edit is a one-line edit
there.

1. **Area list.** Confirmed as is by the owner
   ([recorded on #4024](https://github.com/thatskiff33/AlpineClubBookingsNZ/pull/4024#issuecomment-6113045008)).
2. **Dates and club time.** Fixes for the NZ lodge-night boundary (for
   example the lodge kiosk using the tablet's clock) currently fall into
   whichever area the code sits in. Left spread: confirming the 15 areas
   as is means no 16th area.
3. **Lookback.** Counts cover the full history; the "since 8 Aug" column
   counts only pairs whose later fix landed after the 8 Aug audit
   (epics #2680, #2725). Answered in ALP-7's brief: rank on full history,
   with the since-8-Aug count beside each area.

## The 15 areas

| # | Area | What it covers |
| --: | --- | --- |
| 1 | Xero sync and accounting outbox | Outbox, retries, invoice and credit-note sync, repair passes |
| 2 | Payments, refunds and member credit | Stripe, internet banking, refunds, member credit, promo codes, finance figures |
| 3 | Booking edits and cancellations | Date, party and price changes; group cancel and settlement |
| 4 | Booking creation and pricing | The booking wizard, creating a booking, pricing, booking history |
| 5 | Booking requests and officer queues | Requests, school requests, policy exceptions, payment chasing |
| 6 | Capacity, beds, waitlist and lodge display | Bed allocation, waitlist, roster, the lodge display and kiosk |
| 7 | Email and notifications | Templates, the message registry, recipients |
| 8 | Membership lifecycle | Applications, subscriptions, family groups, deletion, merge |
| 9 | Member guests and adult-member hosting | `fix(hosting)` is adult-member hosting, not deployment |
| 10 | Admin and booking-officer screens | Admin pages, settings, view-only and permission-gated controls, config transfer |
| 11 | Public website and first-run setup | CMS pages, the setup gate, public routes and their CSP |
| 12 | Auth, security, privacy and audit log | Sign-in, sessions, tokens, two-factor, privacy, audit rows |
| 13 | Concurrency and locking | Advisory locks and lock topology |
| 14 | Deploy, CI, migrations, cron and diagnostics | Docker, CI, migrations, cron jobs, diagnostics |
| 15 | Test and E2E infrastructure | Flaky or wrong tests and fixtures |

## Raw counts per area (unranked)

Rows are in list order, not by size. Each row counts candidate pairs
(earlier fix → later fix, re-break or regression report). One pair can sit in
more than one area: a mapped pair sits in 2.3 areas on average (median 2).

| Area | Pairs | Since 8 Aug | refix | reopened | mention | revert | code-history |
| --- | --: | --: | --: | --: | --: | --: | --: |
| Xero sync and accounting outbox | 76 | 50 | 2 | 0 | 11 | 1 | 64 |
| Payments, refunds and member credit | 128 | 105 | 5 | 0 | 22 | 1 | 102 |
| Booking edits and cancellations | 46 | 33 | 1 | 0 | 4 | 0 | 44 |
| Booking creation and pricing | 64 | 42 | 2 | 0 | 16 | 1 | 49 |
| Booking requests and officer queues | 30 | 18 | 1 | 0 | 3 | 0 | 27 |
| Capacity, beds, waitlist and lodge display | 34 | 14 | 0 | 0 | 4 | 1 | 30 |
| Email and notifications | 28 | 17 | 0 | 0 | 6 | 0 | 22 |
| Membership lifecycle | 35 | 15 | 1 | 0 | 2 | 1 | 32 |
| Member guests and adult-member hosting | 35 | 24 | 0 | 0 | 7 | 1 | 30 |
| Admin and booking-officer screens | 72 | 44 | 3 | 0 | 8 | 1 | 61 |
| Public website and first-run setup | 6 | 1 | 1 | 0 | 1 | 0 | 5 |
| Auth, security, privacy and audit log | 44 | 28 | 2 | 0 | 13 | 1 | 31 |
| Concurrency and locking | 13 | 5 | 1 | 0 | 0 | 0 | 12 |
| Deploy, CI, migrations, cron and diagnostics | 43 | 31 | 5 | 0 | 9 | 0 | 31 |
| Test and E2E infrastructure | 7 | 5 | 0 | 0 | 3 | 0 | 4 |

**Coverage:** 285 of 344 candidate pairs (83%) map to at least one area. Most
of the 59 unmapped pairs are mentions whose later side is an epic or tracking
issue with no files of its own.

**Known artefacts in these counts.** A fix unit's scopes are the union of
every `fix(<scope>)` subject in its PR, so a wide PR puts each of its pairs
in every area those scopes name. The one revert shows it plainly: it undoes
a single `fix(bookings)` commit, but its PR (#2618, branch
`fix/issue-2597-hosting-queue-merge`) carries fix scopes for eight areas,
so the run above counted it in all eight. The mapper has since been
corrected for reverts (a revert pair now carries the reverted commit's own
scope and files, which puts this one in booking creation only). Revert
subjects are unwrapped through nested `Revert "…"` wrappers, ignoring a
trailing squash PR suffix (`(#N)`) at each wrapper. The mapper also
folds plural scopes
(`fix(beds)`, `fix(public-pages)`), matches only whole-word `lock` files to
concurrency, and lets the test-infrastructure area see test files. The
table is from the run before those corrections; the next run's counts will
differ. Pairs from other signals still inherit their PR's full scope list.

## How much to trust each signal

Spot checks on samples from this run. Read the counts with these alongside.

| Signal | Pairs | Spot-check precision | What goes wrong |
| --- | --: | --- | --- |
| code-history | 224 | about 6 in 10 | A later fix rewrote lines an earlier fix wrote, for an unrelated reason |
| mention | 105 | about 2–3 in 10 | 61 pairs match only on "still", which is nearly always incidental. Other wordings do better: #2356's problem "reintroduced" at runtime, #2677 → #2740 rooms from another lodge again |
| refix | 23 | low as a repeat signal | 19 of 23 land within a day of the first fix: one issue delivered over several PRs (#3635, #3372), not a re-break |
| revert | 1 | genuine | `aa6253d24` reverts a commit in PR #2618 |
| reopened | 0 | — | Not collected this run (see "How this was collected") |

The ranking task should weight or filter these, for example by dropping
"still"-only mentions and refixes under three days apart, before ordering
areas.

## How this was collected

Run against `main` at `e45e41bb5` on 9 Oct 2026, over the full history.
The collector now reads `origin/main` by default rather than the local
`main` branch (fetch first); `--ref <rev>` analyses another revision, for
example `--ref e45e41bb5` to reproduce this run:

```
pnpm run audit:fragility:collect
pnpm run audit:fragility:signals
pnpm run audit:fragility:areas
```

Output lands in `tmp/fragility/` (git-ignored); `areas.json` holds every
pair behind each count, with the rule that mapped it.

No `GITHUB_TOKEN` reaches Sekreton task containers, so the collector read
every issue (#1–#4022, 4,018 issues and PRs, 4,373 comments) through
Sekreton's integrations endpoint instead of the GitHub API. That source has
gaps, which the collector records in `github.json` under `gaps`:

- PR bodies and PR comments are not readable, so mentions and `Fixes #N` in
  PR text are missed; PR titles come from merge commits.
- `reopened` events are not readable, so that signal is empty.
- Issue creation times are estimated: the earlier of the first comment and the
  next-numbered PR's merge.
- Comments by authors outside the project's trusted roles are left out.
- Numbers it could not read, and numbers it gave up on after ten rate-limit
  waits, are listed by number. The run above predates that entry; it found
  four unreadable numbers (#964, #3594, #3613, #3749), deleted or
  transferred.

A run with a token (`GITHUB_TOKEN=… pnpm run audit:fragility:collect`) reads
the GitHub REST API instead, which has none of the first four gaps (deleted
or transferred numbers stay absent). It sees more text, so its counts will
differ from the table above.
