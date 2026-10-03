# #3794 implementation checkpoint

Branch: fix/3794-accepted-school-held-prices; baseline 824b2e236. Owner approval source issuecomment5939947674; approved blueprint in 3413-naming-repair-blueprint.md.

Implemented immutable accepted ordinal/identity/date-envelope mapping through a single planner. Existing naming transaction keeps global -> lodge locks, validates before CAS, then aligns provisional held guest/night/headline cents to selected accepted terms; no settlement/provider/ledger/identity/bed changes. Preserves P2 canonical seasonal member-rate collision protection.

Focused run: 4 files / 38 tests passed (school pending resolution unit + real DB, money writer census, guest-night source census). Actual send -> second option / requoted reused hold -> partial/full naming -> approval covered. Unequal cents / shifted children, malformed identity/ordinal/sum/held nights/pending nights/partial state, real DB lost claim and repricing rollback covered. Non-member matching contact preceding login-disabled MEMBER_RATE cannot mask refusal.

Final gates and commit pending. No install, full suite, push or GitHub mutation performed.
Committed implementation: 571c2b05c. Final full typecheck passed. Lint passed (0 errors, 52 existing warnings). Prisma generation passed with explicit synthetic loopback DATABASE_URL after first invocation correctly refused absent DATABASE_URL. Docs index/linkcheck, quality budget and git diff --check passed. Five related guards passed 51 tests; INV-MONEY-029 census initially found unregistered new site, explicit no-promotion inventory added, rerun passed all 7. Total verified targeted cases 96 (38 focused + 51 related + 7 adjustment census). Fixture type union was narrowed after initial typecheck diagnostic; final typecheck is green. No full suite, build, push or GitHub writes; root owns independent review, remaining orchestration gates and PR.

