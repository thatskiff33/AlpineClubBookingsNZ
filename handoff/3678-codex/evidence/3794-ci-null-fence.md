# #3794 CI NULL night-price fence

Starting HEAD: e66667fab349a0a19a38986f7a0e29f1422cf1be, clean dedicated #3413 worktree. Root confirmed own physical pnpm dependencies installed and exclusive writer; db:generate passed in this task. No install or external write.

Source issue #3794 read live. INV-MOD-028 and INV-MOD-036 confirm NULL means unknown money and can only be filled by an officer supplying every amount. Existing accepted planner reads only night id/date, so it cannot prove prices are present. CI census failure reproduced locally: stored-night-price-repair-census reports lib/school-pending-adult-resolution.ts as the sole unexpected writer.

Added actual PostgreSQL no-effects regressions for NULL held nights at naming and approval. Red run is active at session35473, selecting unpriced held night. No production fix written before terminal reproduction.

Approved bounded repair: select required nullable held-night cents into the canonical accepted-party planner and refuse NULL before claims; retain exact priced-row grouping with an updateMany not-null predicate and affected-count rollback. Narrow census exception admits only the sole direct updateMany with both immutable proved IDs and explicit not-null guard plus full-count throw. Add source mutations and actual PG mutation evidence; preserve locks, provider behavior, accepted terms and timeout.

Red proof completed: both new PostgreSQL cases failed because naming and approval resolved successfully instead of refusing NULL; same source census reported only the new school writer. Repair now selects required nullable cents for both caller reads, refuses NULL in the canonical planner before claims, and updateMany excludes NULL while retaining full affected-count rollback. Narrow census checks the only direct write's exact ID/not-null shape and count throw, with four in-memory escape mutations.

Green evidence: five focused files / 166 tests passed, including all 33 PostgreSQL cases, naming unit suite, school approval, price-source census and repair census. Focused lint, docs index/link checks, budget and diffcheck passed. Full typecheck was session5040; terminal result follows. Actual source/PG mutation planned after all normal validation processes complete, restoring exact UTF8 bytes in finally.

Actual-source mutation completed: disabled the canonical NULL refusal and updateMany not-null filter together. All three selected PostgreSQL tests failed by resolving instead of rejecting (naming, approval, and post-claim NULL rollback); the census rejected the school writer and its positive exception control failed. PG exit1, census exit1. The mutation script finally restored both production files byte for byte and verified SHA256 equality. Normal full typecheck session5040 had passed. Final restored-tree gates now follow.
## Complete local result

Commit: 96e291eae285f468b3316d2fabaeb5ac1bb4b1dc (parent e66667fab349a0a19a38986f7a0e29f1422cf1be). Dedicated 3413 branch is clean. Seven files, 77 insertions / 7 deletions. No install, push, GitHub write, provider call, full suite, timeout increase, migration/schema change or other-worktree edit.

Final restored-tree commands, all exit0:
- pnpm exec vitest run src/lib/__tests__/school-pending-adult-resolution.realdb.test.ts src/lib/__tests__/school-pending-adult-resolution.test.ts src/lib/__tests__/stored-night-price-repair-census.test.ts src/lib/__tests__/booking-guest-night-price-source-census.test.ts src/lib/__tests__/school-booking-request.test.ts -- 5 files, 167 tests, 33.92s. This includes all 34 tests in the realdb file (33 database cases plus the CI database-proof requirement). DATABASE_URL and DATA_MIGRATION_VERIFICATION_DATABASE_URL use only authorized loopback55413.
- NODE_OPTIONS=--max-old-space-size=8192 pnpm run typecheck -- Next route generation plus tsconfig.json, tsconfig.test.json and tsconfig.e2e.json, exit0.
- pnpm exec eslint src/lib/school-pending-adult-price-plan.ts src/lib/school-pending-adult-resolution.ts src/lib/school-booking-request.ts src/lib/__tests__/school-pending-adult-resolution.test.ts src/lib/__tests__/school-pending-adult-resolution.realdb.test.ts src/lib/__tests__/stored-night-price-repair-census.test.ts -- exit0, no output errors/warnings.
- pnpm run docs:indexcheck -- 678 ids, 19 prefixes, tracked-text/docs budgets and reachability pass.
- pnpm run docs:linkcheck -- 860 Markdown files, all relative links and anchors pass.
- pnpm run quality:budget -- pass, existing allowance lengths unchanged (school3048/panel2727/sharedbooking3076).
- git diff --check -- pass.
- git status --short after commit -- empty.

The original source defect was reproduced before repair: naming/approval resolved instead of rejecting NULL. The after-claim trigger witness additionally proves explicit not-null UPDATE filtering plus affected-count rollback; it cannot be satisfied solely by the earlier planner check. Narrow census mutation checks remove the not-null predicate, exact IDs or count rollback, and add an extra writer; each is rejected. Actual production-source mutation removing planner+query fences caused 3/3 selected PG tests and the census to fail; both files were restored byte for byte before the final green run.

Known output: PostgreSQL harness emitted a pg client concurrent-query deprecation warning (also present on prior runs) and expected invalid-held-contact conversion fixture warnings. No test or lint failure remains. Root owns scoped delta review, PR3812 update/push, CI and merge.
## Review documentation reconciliation

Root assigned the verified stale sole-in-place-writer claim in INV-MOD-036 and the repair census explanatory docblock. Parent/base is 96e291eae285f468b3316d2fabaeb5ac1bb4b1dc. Read source invariant, docs style, SCHEME section8.1 and WORD_BUDGETS rules. Canonical --words measured INV-MOD-036 at298 before edit,247 after, under300 without an allowance or ratchet change.

Commit b0f6f11e72a9cba818e13d340d8738d9c6b72ba0: two files, documentation/comment only,23 insertions/24 deletions. INV-MOD-036 retains absolute person-only NULL fill and all four review-repair conditions, explicitly protects stored0 and forbids existing-price repair writes. It now states #3794's bounded accepted SCHOOL naming reconciliation: proved already-priced held-night IDs only, NULL refusal, exact affected-count rollback. Census docblock cites that rule and describes the same bounded exception; census logic and production code remain unchanged. Deterministic diff check asserted every changed census line is inside its explanatory comment.

Final gates, all exit0:
- node scripts/ci/check-doc-index-integrity.mjs --words | rg INV-MOD-036 --247words.
- pnpm run docs:indexcheck --678ids/19prefixes, all budgets/index/citations/reachability/encoding pass.
- pnpm run docs:linkcheck --860Markdown files, links/anchors pass.
- pnpm exec vitest run src/lib/__tests__/stored-night-price-repair-census.test.ts --16tests/1file passed,2.24s.
- git diff --check --pass.
- git status --short after commit --empty.

No logic/code change, no push/GitHub/install/full suite, no other-worktree edit. Root owns propagation and CI. No remaining documentation finding in this bounded assignment.
