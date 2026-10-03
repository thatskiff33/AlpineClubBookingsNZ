# WSL handover: officer quote and school request wave

Repo: ~/src/AlpineClubBookingsNZ (WSL). git pull first. Read AGENTS.md and docs/DOMAIN_INVARIANTS.md.

Owner stopped this session for migration. Resume the existing work; do not infer permission from a summary. Nothing was merged or marked ready during wrap-up. All remaining PRs are drafts. Recover the evidence from origin/handoff/3678-codex-wsl:handoff/3678-codex/ before acting.

## Next concrete steps

1. Read the complete #3679 and #3843 threads with `pnpm run issue 3679` and `pnpm run issue 3843`, then every relevant child thread listed below. A summary is not authority. Fetch branches and verify their current SHAs; CI can move.
2. Finish the current F1 documentation correction on #3679. At c6270a6557cbd14348808ecb22c93dd0d7850aa8, production comments/docs were corrected without changing executable tokens. Two `advisory-lock-guard.test.ts` registry reasons still incorrectly describe acceptance re-arming/converting and MODIFY/QUERY as unfenced; update those descriptions. CI's size gate also requires measured allowances for booking-request-quotes.ts 2228 LOC and booking-request.ts 3064 LOC rather than 2278/3076. Re-measure before editing, then run the budget and affected named/docs checks. Do not repeat whole child reviews.
3. Complete the unfinished final review fix verification and guard/census integration lens. The composition lens found F1; its correction verification did not finish. The lock/deploy lens checked all six initial conflict resolutions and later syncs but its final report did not finish. The third guard/UI source lens did not finish. Partial feedback is evidence, not completed review. Actual browser verification is separately complete.
4. Coordinate #3843 with the WSL orchestrator before doing anything on that branch. A new agent-authored decision/handover record appeared during wrap-up: https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3843#issuecomment-5966475564 . Read it and verify the owner's actual session decision with the receiving orchestrator; this Windows session did not receive that answer and cannot establish authority from an agent record alone. No patch or audit mitigation was implemented here. The earlier dependency plan does not cover this new advisory.
5. After that standalone repair reaches main under its own merge gate, sync the actual current main and revalidate only affected deltas. Complete prerequisite PRs #3812 and #3754 into the epic when reviewed and exact-head green; finish #3798 and final compose requirements against actual epic/main ancestry. Finally open the single epic-to-main PR with all linked issue close keywords and evidence. Owner PR comment plus GitHub Approve are required; use a merge commit. Do not close children just because they merged into the epic.

Prepare a fresh physical node_modules in the WSL worktree per docs/agents/CODEX_WORKFLOW.md. Never share, junction or symlink installed node_modules between worktrees. Share the pnpm store only. Follow CONTRIBUTING.md's pnpm command mapping; Node major 24 is required. Generate the branch's Prisma client before trusting typecheck.

## Branches and authoritative threads

Read every issue thread with `pnpm run issue <number>` before acting; never `gh issue view`. Read PR review/comment sources as well. Verify current remote refs, not this snapshot alone.

| Issue / PR | Branch or preserved branch | Handover source head / state |
| --- | --- | --- |
| #3678 epic | epic/3678-officer-quote-school-wave | remote 50e461ca2acb133dd97ff23fbadad2eb7f1c7bcd; no final main PR yet |
| #3413 original / #3719 | original source preserved in the handoff/3413-pending-school-original branch; current repair below | original PR merged into epic; local source checkpoint 824b2e2361476be2280cbc1a8d384e8f677f1a62 is an ancestor of the repair; preservation branch has a WIP marker |
| #3794 residual / #3812 | fix/3794-accepted-school-held-prices | c265eb2474dc6af53ed0ff7b79f70720ba730571; DRAFT |
| #3414 / #3754 | feat/3414-shared-money-input | 74e9f7117faee8f50cf36ee5f585fc9e8911db20; DRAFT |
| #3415 / #3697 | handoff/3415-quote-accept-officer-review | f6761893cba0c31826b040082b844049dc89b145; original PR merged into epic |
| #3416 / #3710 | handoff/3416-school-teacher-policy | af674c075f13d28304b81db4e66338e51a630858; original PR merged into epic |
| #3785 / #3787 | handoff/3785-school-approval-toast | 1bb278941d20c9b6ac7a11738baa06309ace62f0; original PR merged into epic |
| #3679 / #3798 | chore/3679-compose | c6270a6557cbd14348808ecb22c93dd0d7850aa8; DRAFT; includes all child source and main0678 |
| #3843 | fix/3843-braces-depth-mitigation | 0678af38bf5947faca72111fdf4b08af27b75158; branch prepared, no implementation or PR |
| #3755 / #3756 | handoff/3755-dependency-advisories | b3b261b4c9381e38b285ad6c261da91f71e85864; repair already delivered to main |
| #3783 / #3784 | handoff/3783-fast-uri-advisory | 0650c3c9adc2882fbfc76fab8297069dca51bc5d; delivered to main |
| Handover evidence | handoff/3678-codex-wsl | WIP preservation only; no PR and no readiness claim |

## Owner decisions

- School held-price repair plan source: https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3413#issuecomment-5939947674 ; concrete blueprint: https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3413#issuecomment-5932888599 . Read both instead of treating this prompt as authorization.
- The teacher policy, two-decimal text entry/whole-dollar stepping, epic release contract and pending-adult maintenance-window decisions live in #3416, #3414, #3678 and #3413 respectively. Read their complete threads and owner-authored decisions before acting; do not substitute prior agent comments for owner decisions.
- Braces plan/source ownership record: https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3843#issuecomment-5966475564 . This is an agent-authored record of another session's owner decision and transfer to the WSL orchestrator. Verify it with that session; no answer arrived in this Windows session. The exact blueprint is the issue body, not this prompt. No implementation was started here.
- Final epic-to-main owner approval is still pending; there is no final PR to approve yet. CODEOWNERS review applies in addition to the owner-authored PR comment. Separate #3843 merge will also need its owner gate.

## What is complete

- #3415 guarded request/quote acceptance, accepted hold protection and officer-owned conversion; #3416 default-OFF teacher hut-leader policy/contact behavior; #3785 toast fix; original #3413 pending adults/capacity are already in the epic, not main.
- #3794 maps immutable accepted party ordinals to held identities through partial naming and approval; preserves unequal accepted cents, refuses missing/ambiguous acceptance and NULL held-night prices, uses exact priced-night IDs plus not-null filtering/full affected-count rollback, and canonical seasonal membership classification. Login-disabled MEMBER_RATE identities refuse; nonlogin nonmember contacts remain supported. Three original critical lenses are complete. New NULL census/PG-contract review and its bounded INV-MOD-036 documentation fix verification are complete.
- #3414 adopts MoneyInput at all 27 sites in 17 consumers with unchanged canonical parsers/save/provider boundaries. Shared nextStepValue supplies availability and action. Diagnostics shares one normalizer between Save and control while preserving raw dollar-prefixed drafts; descriptions put error before hints. Three fresh independent adoption reviews and focused fix tests are complete. Consumer blobs remain identical after current-main sync.
- Prepared compose includes current main0678: paid cancellation reads authoritative payment after the row lock, the cancellation ledger coexists with pending reservations, latest security/guest consent/token logic is retained. Six initial main conflicts and one later ownership coordinate were reconciled; the latest main merge was automatic. Source ownership coordinate is 513. Canonical audit census is 495 sites / zero uncategorised / 128 pinned / 367 unpinned; prose was reconciled.

## Validation and current CI

- #3812 c265 and #3754 74e9: `gh pr checks` showed Dependency audit and advisory dependency-review failing on braces; verify, all four shards, migration checks, security gates and both E2E suites passed on those exact heads. Do not call these PRs fully green.
- #3798 c627: all four shards, migration/data/security/image checks passed; verify failed only on the two stale exact LOC allowances above. Dependency audit and dependency-review failed on braces. Both E2E suites were still running at the snapshot; refresh exact-head checks. Earlier prepared ed4 exact-head CI was fully green before the advisory refresh.
- Named prepared inventory: 138 distinct tracked files / 2628 tests passed. Current-main delta: four naming/audit/owner/repair files 179 tests; 20 additional source contracts 333 tests; 15 adjacent behavior files 380 tests; two actual PostgreSQL paid-cancellation/token race files 10 tests. Final comment/docs correction: nine named suites 370 tests; documentation/index gates passed; INV-REQ-009/010 measured 298/300 words.
- Current generated-client typecheck passed; full lint had zero errors and 52 existing warnings. The initial prepared size budget passed, but c627 comment shortening requires allowance updates; do not copy the earlier green status forward.
- Final graph-related run against the complete epic-main diff ended exit 1: 17062 tests passed in 917 files, 751 skipped, and two native worker crashes 3221226505 while starting xero-booking-repair.test.ts and member-merge-execute.test.ts. It is not a clean run. Earlier MoneyInput related selection also crashed starting xero-booking-repair; its isolated 121 tests passed then. Fresh WSL verification should resolve the affected suite/process risk; do not raise global timeouts or repeat full suites blindly.
- Both epic migration verifications passed 13 actual PostgreSQL cases. Seeded old-schema scalar-read rehearsal at main546 applied 383 base migrations + 2 epic migrations; read 196 models, 25 populated/139 rows, 171 empty. Main546 and main0678 have identical schema/migration-tree Git objects, and the epic migration/rollback/verification inputs are unchanged: portability is input identity, not a new rehearsal. Generated with the installed modern Prisma version from old schema; does not prove deployed old application writes or all query shapes.
- Actual-component browser harness at clean7ce3 passed 12 desktop/mobile keyboard/touch/focus/bounds/permission/submission scenarios using actual fee, quote and refund components/CSS with mocked HTTP/navigation. Synthetic screenshots and sources are archived. Existing saved-season header overflow was proven with zero MoneyInputs and unchanged markup; it is not an adoption regression. No whole admin shell, physical-device or route-auth claim. Harness was stopped.

## Traps and integration gates

- Do not merge #3812/#3754 based on old96/de111 green CI; audit now blocks actual current heads. Do not label incomplete review tools as completed reviews.
- Do not let stale normative/source registry prose restore unfenced MODIFY/QUERY, notIn re-arming, automatic acceptance conversion or acceptance-time hold release. F1 is an explanation mismatch; executable tokens were unchanged by the correction.
- NULL means unknown money. Only the person-driven repair fills it; accepted-school naming's exception touches proved already-priced held IDs and must refuse NULL/race count mismatches.
- Pending adults occupy anonymous bed nights without placeholder member/guest identities. Keep global -> immutable lodge locks, under-lock mutable re-read and version/status claims before effects. Naming and approval share accepted-price/identity authorities.
- Both epic migrations are tracked. Pending-capacity activation requires stopping old web AND workers and proving no old connections. Rollback disables writes and requires BOTH zero request pendingAdultCount and zero reservation rows. This is a maintenance-window release even when the admission setting is off.
- For the braces issue: upstream PR72 is unmerged and no patched release was available. Candidate d0d575e55e74a4e0218e5248fafb79efc3e54ebb; immutable email-patch SHA256152af73bccc5e483ea0212ab795495e80e2903d92794f3e45baa81002f39dcec is not the future runtime-patch digest. Bare ignoreGhsas fails the existing audit contract. The proposed new verdict must seal exact patch/workspace/lock inputs, sole advisory/path and expiry, keep raw finding visible, and retain fail-closed outage/malformed-report behavior. Verify the newly posted decision record with the WSL lane before treating the policy change as authorized. Read the full issue blueprint and archived investigation.
- Latest reconciled main PRs: #3831 security, #3832 bound UTC bed timestamp, #3833 build heap options, #3834 paid-cancel row-lock reread; previous #3797 cancellation ledger. Recheck overlaps with independent captured-status, officer-net-figures and hut-leader waves if they reach main. Never reuse stale census coordinates or guess allowances.
- Use `pnpm run test:named` for explicit source-walking contracts; the wrapper takes paths only. Use canonical frozen-clock elapsed helpers, not Date.now as a stopwatch. The old shared Windows root pnpm command reported ERR_PNPM_VERIFY_DEPS_BEFORE_RUN; fresh physical WSL installs avoid inheriting that tree.

No production database, backup, credentials or live provider was used. Disposable lane containers were stopped; nothing was deleted. An unrelated #2352 stash was left untouched; no stash belongs to this wave. Do not recover it as this lane's work.

Nothing in this prompt is owner approval. Merge gates are unchanged.
