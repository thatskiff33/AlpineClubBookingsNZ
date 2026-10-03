# 3679 F1 quote contract correction

Base: `7ce3bb1eaa65e45e32185cefc7af93400ab2d763`.
Commit: `c6270a6557cbd14348808ecb22c93dd0d7850aa8`.
Worktree: `[dedicated worktree]`, branch `chore/3679-compose`.

Root authorized editing after the UI bundle captured the base; root separately
included the contradictory locking-table row and adjacent decline comments.
No executable tokens, tests, dependencies, schema, settings or provider behavior
changed. No GitHub writes, push, installs, generation or full suite performed.

Changed paths:

- `src/lib/booking-request-quotes.ts`: response comments describe global
  serialization, live SENT/QUOTE_SENT claims, retained AWAITING_REVIEW hold,
  atomic ACCEPTED and read-only accepted retries. Historical resurrection and
  stale-price rationale remains explicitly historical.
- `src/lib/booking-request.ts`: decline comments distinguish requester
  acceptance from officer conversion and explain DECLINED-before-release.
- `docs/STATE_MACHINES.md`: reconciled Public Quote prose, response and decline
  races, seven declinable versus six correctable states and approval ownership.
- `docs/invariants/booking-requests.md`: INV-REQ-009 reconciles all four quote
  writers; INV-REQ-010 distinguishes hold-status guard from ACCEPTED request
  protection. Index descriptions still correctly describe their subjects.
- `docs/CONCURRENCY_AND_LOCKING.md`: replaced contradictory current table row
  and its superseded addendum with the implemented response/hold contract.

Validation:

- PASS compiler-parsed TypeScript leaf token kind and exact text equality for
  both source modules versus base, excluding trivia but retaining all strings
  and template tokens. Both parse without diagnostics. Initial standalone
  scanner was unsuitable because it did not perform parser template rescans;
  its apparent mismatch was resolved with compiler-parsed token equality.
- PASS `pnpm run docs:indexcheck`: 679 IDs, 19 prefixes, index budgets and
  reachability/encoding gates passed.
- PASS canonical `node scripts/ci/check-doc-index-integrity.mjs --words`:
  INV-REQ-009 298 words; INV-REQ-010 300 words. No allowance or ratchet edits.
  Earlier drafts at 305/312 and 298/303 were compacted and checked again.
- PASS `pnpm run docs:linkcheck`: 869 Markdown files, links and anchors resolve.
- PASS `pnpm run test:named` quote, corrections, version-fence-contracts,
  booking-request, advisory-lock-guard, admin-release-hold-route and
  cron-quote-expiry-reminders suites: 7 files, 274 tests.
- PASS named booking-cancel and booking-cancel-split suites: 2 files, 96 tests.
- PASS `git diff --check`; clean worktree after local commit.

Root owns final validation, independent delta review and external footprint.
No independent-review approval is asserted by this implementor checkpoint.

