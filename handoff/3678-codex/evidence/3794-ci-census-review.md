# #3794 CI NULL-price fence: independent scoped contracts review

Reviewed source: `96e291eae285f468b3316d2fabaeb5ac1bb4b1dc`, against full parent `e66667fab349a0a19a38986f7a0e29f1422cf1be`, in worktree3413. HEAD remained pinned and clean during the review. This is the requested narrow review of the CI repair, not another original whole-change review or a merge approval.

## Confirmed finding

**P2 — the invariant still prohibits the priced-only writer the new census permits.** At the reviewed SHA, `docs/invariants/booking-modifications.md:1283-1284` (INV-MOD-036) states that `stored-night-price-repair-store.ts` is the one module permitted to update an existing night row's price in place. The new exception at `src/lib/__tests__/stored-night-price-repair-census.test.ts:220` permits `school-pending-adult-resolution.ts`, whose actual update is at `src/lib/school-pending-adult-resolution.ts:183-187`. A maintainer following the invariant would reject the very accepted-school reconciliation this change intentionally admits; the guard now passes behavior the invariant still expressly forbids. The census's introductory explanation at lines26-33 likewise still describes exactly one existing-row writer.

Refutation checked: the concurrency guide's pending-school-adults section explicitly describes both the reconciliation and the new NULL refusal, but there is no school exception anywhere in the invariant file. The prohibition is specifically about any existing-row price update, not only filling a NULL. The person-only NULL rule itself remains correctly enforced. Correct the absolute writer sentence and census explanation with a narrow exception for the proved, already-priced held-school reconciliation; preserve the absolute person-only NULL repair contract.

## Source checks and refuted concerns

- The new nullable price is a required field in the shared planner input (`school-pending-adult-price-plan.ts:51`), selected by both actual callers. The planner rejects a NULL held night before either request claim. Missing or duplicate night sets are still refused by its existing date/count proof. No fallback price for a blank was introduced.
- Naming updates only the exact IDs produced by that proof, with `priceCents: { not: null }`, and throws inside the transaction unless the affected count equals the complete group length. A late NULL cannot silently disappear from the update: it produces a short count and rolls back the request and prior guest-price updates.
- The census continues to use the canonical `stripCommentsAndStrings`. The exception is restricted to one literal module path and one direct write, with the exact-ID/non-NULL query shape and full-count throw. Its positive control reads the actual file; four mutations remove the non-NULL filter, replace the exact-ID filter, remove the count test, or add another direct writer. Each has a rejecting assertion. The replacements occur in the live normalized writer rather than prose.
- The two preexisting-NULL PostgreSQL cases at `school-pending-adult-resolution.realdb.test.ts:401` execute the real naming/approval functions against migrated disposable loopback PostgreSQL. Approval first names both adults, so it reaches the intended boundary. They assert refusal and retained complete held/request state, reservations, member/contact counts and absence of payment effects.
- The third case at line440 invalidates a real held night in an AFTER UPDATE request trigger, after the planner proof. Thus preflight alone cannot satisfy it. It asserts 409 and rollback of both the injected NULL and persisted held/request/reservation changes. Trigger cleanup is in finally. The relevant production money, planner and transaction functions are not mocked.

## Evidence and limits

Reopened AGENTS/core and applicable INV-MOD-028/036, SSOT normalizer, testing mutation/census, and concurrency contracts. Read the requested issue-thread cache, the live issue body/finding comment during the preceding portion of this same review, the complete seven-file delta and relevant surrounding planner/caller/test code. Read root's source-check checkpoint and implementor's `3794-ci-null-fence.md`.

The implementor checkpoint records initial red naming/approval proof; an actual production mutation removing planner and write-query NULL fences causing all three PG cases plus the census to fail; byte-identical restoration; and a restored final 167-test/34-realdb-file-case pass with typecheck/lint/docs/budget gates. These are recorded execution evidence, not commands independently rerun by this reviewer. The combined mutation does not independently isolate every fence, but the post-claim trigger case and the four guard mutations cover the relevant separate failure shapes.

Independently ran read-only source/status checks and `git diff --check e66667fab 96e291ea` (clean). No runtime tests, mutation edits, installs, full suite, GitHub operations, production/provider operations or code edits were performed. The regex census checks declared source shapes; it is not an exhaustive detector for arbitrary aliasing, raw SQL or control-flow rewrites. No additional production or test-contract defect was confirmed within this scope. Owner/main-integration gate remains binding.

## Fix verification at b0f6f11e72a9cba818e13d340d8738d9c6b72ba0

Independently read the complete delta from `96e291eae285f468b3316d2fabaeb5ac1bb4b1dc` to `b0f6f11e72a9cba818e13d340d8738d9c6b72ba0`. It changes only INV-MOD-036 documentation and the census explanatory comment. Production code and census logic are unchanged. HEAD is exact and worktree status is clean; delta diffcheck passes.

**P2 resolved.** The invariant now reserves NULL filling exclusively for the repair store and expressly permits the bounded accepted SCHOOL naming reconciliation of already-priced, proved held-night IDs, with NULL refusal and exact affected-count rollback. The census explanation states the same exception. All four NULL-repair conditions remain intact: officer types every amount without derivation; figures reconcile and the strand total is re-based atomically; existing prices including stored0 remain protected by NULL/previous-total fences; and the act receives its own money audit entry.

Read the appended implementor evidence recording 247 invariant words, passing docs index/link checks, 16 census tests and clean diff/status at this exact commit. These gates were not independently rerun. No whole-change rereview, runtime execution, GitHub operation or source edit was performed. No remaining confirmed finding in this bounded review; the original scope limitations and owner/main-integration gate remain unchanged.

