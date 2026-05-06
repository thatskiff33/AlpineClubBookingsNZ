# Production Re-Review — Prompt Queue

> **Workflow.** This is a *self-popping* FIFO queue. The phase header directly below this preamble is the next to run; the agent removes its own prompt from this file when it finishes.
>
> 1. `cd /home/ubuntu/TACBookings && git pull --ff-only origin main` to refresh the queue.
> 2. Open a fresh Claude Code session in the repo root.
> 3. Run the `/model` command shown for the phase at the top of this file.
> 4. Copy the prompt block (between the triple-backticks) and paste it as the first message — exactly, no edits.
> 5. The phase agent runs to completion, then self-pops: it edits this file to delete its own section, commits to `main`, and pushes. Its last user-facing message is "phase complete" plus a one-line preview of the new top phase.
> 6. `git pull --ff-only` to pick up the deletion, verify the new top of the file is the expected next phase, and loop to step 2.
>
> **Manual fallback.** If an agent stops without self-popping (context exhaustion, error), find the `## P<N>` header for the just-completed phase and delete everything from that line down through and including the next standalone `---`.
>
> **Branch policy carve-out.** This file is workflow metadata, not application code. Direct commits to `main` are explicitly permitted for `docs/audit/REVIEW_PROMPTS.md` only — the queue must advance without PR overhead between phases.
>
> **Master plan:** `~/.claude/plans/gleaming-crafting-elephant.md`
> **Tracking epic:** GitHub issue #194
> **Prior audit baseline:** `docs/audit/00_EXECUTION_MODEL.md` … `06_GO_LIVE_AND_DEPLOY.md`

---

## P6 — Deploy & runtime hardening · issue #201

**Model:** Opus 4.7 (`/model claude-opus-4-7`) — 913-line bash state-machine review with failure-mode enumeration. Fan-out reasoning task.
**Estimated effort:** 2 days
**Pre-condition:** P0 merged.

**Prompt to paste into a fresh Claude Code session:**

```
You are Claude Code working on Phase 6 of the TACBookings production re-review. Epic #194; this phase is issue #201.

Read first:
- gh issue view 201
- gh issue view 194
- ~/.claude/plans/gleaming-crafting-elephant.md (P6 section)
- DEPLOYMENT.md (likely modified — current state)
- scripts/blue-green-deploy.sh (913 lines — the centerpiece of this phase)
- Caddyfile (modified)
- deploy/caddy/tacbookings-active.caddy if present
- docker-compose.yml (heavily modified)
- Dockerfile
- src/instrumentation.ts (CRON_ENABLED gating)
- sentry.server.config.ts and sentry.edge.config.ts
- src/lib/logger.ts and src/lib/redact-sensitive-json.ts
- src/app/api/health/route.ts

Live-system safety rules: see epic #194. Critical for this phase: blue-green dry-run against STAGING ONLY. Don't run the deploy script against the live host.

This phase is about deploy-time and runtime risk. The deliverables are written analyses, not just findings.

THREAD A — Blue-green deploy script state-machine review (the big one).

Read scripts/blue-green-deploy.sh end to end. Then produce a state machine document.

For each step in the script (build-image, start-inactive-color, health-check-inactive, shadow-DB-migration-test, switch-Caddy-upstream, drain-active, stop-old, cleanup), write:

1. Step name and 2-line description.
2. Preconditions — what state must be true before this step starts.
3. Postconditions — what state is true after success.
4. Failure modes — every way this step can fail. Be exhaustive. For each failure mode:
   a. Detection — does the script detect it? (Check exit code? timeout? specific error pattern?)
   b. Recovery — what does the script do? (Retry? Roll back? Halt?)
   c. Operator visibility — is the operator notified? (Slack? Email? stdout only?)
   d. Resource leak — does failure leave behind dangling containers, partial DB state, half-applied migrations?

Specific failure modes to enumerate (don't be limited to these):
- Health check times out mid-switch (Caddy already pointing at new color but new color not healthy).
- Postgres becomes unavailable during shadow migration.
- New color's container OOMs (resource limits in docker-compose are 1GB).
- Caddy reload fails after upstream file write (split state — file says X, runtime says Y).
- Drain timeout (in-flight requests don't finish in 30s).
- Network partition between Caddy and the new color during switch.
- Cron leader exclusivity violated (both colors have CRON_ENABLED=true).
- Old image deletion happens before validation that new image is serving (no rollback target).

For each failure mode, classify: AUTOMATIC RECOVERY / MANUAL OPERATOR ACTION REQUIRED / DATA LOSS RISK / SERVICE OUTAGE.

Output: a markdown document attached to issue #201, titled "Blue-green deploy script — state-machine analysis". Each step gets a section.

Then run a dry-run against staging:
- Execute the script with the staging compose file.
- Capture logs of each state transition.
- Deliberately fail one step (e.g. break the health-check URL) and verify rollback. Document.

THREAD B — Caddy switch atomicity.

Re-read Caddyfile. The change is `import /etc/caddy/deploy/tacbookings-active.caddy`. The active.caddy file is one line — `app:3000` or `app_blue:3000` or `app_green:3000`.

Failure modes to investigate:
1. Race window: file write is not atomic on most filesystems (rename IS atomic; write-truncate-rewrite is NOT). Confirm scripts/blue-green-deploy.sh writes via tempfile + rename, not direct overwrite. If not, file HIGH finding ("Caddy switch race window — concurrent reload reads partial file").
2. Caddy reload model: signal-based or API-based? Does it hot-swap without dropping in-flight connections? Read Caddy docs at https://caddyserver.com/docs/ if needed.
3. What if the imported file has a syntax error? Caddy reload failure mode — does old config keep running, or does Caddy crash?

Output: a section on Caddy switch atomicity in the same state-machine doc.

THREAD C — docker-compose hardening verification.

The compose file has 141 insertions, 75 deletions vs origin/main. Read the diff:
git diff origin/main -- docker-compose.yml

For each hardening (read-only root FS, tmpfs for /tmp and .next cache, resource limits 1GB/0.8 CPU, no-new-privileges, security_opt):
1. Read-only root FS: trace every place the app writes — uploads, logs, .next cache, /tmp. Confirm each writable destination is either tmpfs or a named volume. If anything writes to root FS (e.g. inadvertent fs.writeFileSync to a relative path), the container will fail at runtime.
2. tmpfs sizing: /tmp and .next cache get how much? Is it enough? .next can be 100s of MB.
3. Resource limits: 1GB mem is tight for Next.js + Prisma. Load-test against staging — any OOM under realistic load = HIGH finding.
4. no-new-privileges + security_opt: verify these don't break anything legitimate (e.g. setuid binaries — none expected in this app, but confirm).

Output: a "docker-compose hardening" section in issue #201.

THREAD D — Cron leader under blue-green.

Re-read src/instrumentation.ts CRON_ENABLED handling. Trace the deploy script's handling of this flag — does the active-color setup imply CRON_ENABLED=true on active and false on inactive, or is it independent?

The desired state: exactly one color runs cron at any time.

Document the desired state, then trace the script to see if it enforces it. If not, file HIGH finding.

THREAD E — Sentry config audit.

Open sentry.server.config.ts and sentry.edge.config.ts.

PII scrubbing rules to verify:
- Stripe payment-method tokens NEVER logged. Look for beforeSend / beforeBreadcrumb hooks.
- Member email addresses: case-by-case (PII; should be redacted in error reports unless essential to debugging).
- Booking amounts: can be logged (financial-debug-relevant; not sensitive PII).
- Password hashes / plaintext passwords: NEVER. Look for any place req.body might be captured.
- Xero tokens: NEVER. Confirm src/lib/redact-sensitive-json.ts catches them by key name.

Sample rates: tracesSampleRate, replaysSessionSampleRate. Document. Cost vs visibility trade-off — if 100% in prod, monthly Sentry bill is non-trivial.

THREAD F — Pino logger redaction.

Re-read src/lib/redact-sensitive-json.ts. Test cases the redaction must catch:
- { password: "..." } → password redacted
- { stripeToken: "..." } / { stripe_token: "..." } → redacted
- { authorization: "Bearer ..." } → redacted
- Xero access_token / refresh_token → redacted
- nested { user: { password: "..." } } → redacted

Run a unit test (or read existing one) verifying each. Anything missed = HIGH finding (PII / secret in logs).

THREAD G — Health check depth.

Open src/app/api/health/route.ts.

Goal: the health check must exercise the dependencies that, if broken, mean the app is down.

Required checks:
- DB reachability — SELECT 1 (cheap)
- DB write capability — optional but good (writes a heartbeat row)
- Stripe reachability — optional (network only)
- Xero reachability — optional
- SES — optional

Currently the check is shallow (likely just returns 200) — confirm and file MEDIUM finding if so. The blue-green script uses this check to decide if the new color is ready; a shallow check means "container started" not "app is ready".

THREAD H — Silent-failure path map.

grep for catch blocks that swallow errors:
grep -rn "catch.*{$" src/ | head -50

For each, open the file and look at the catch body. Anything that doesn't either:
- Log via logger / Sentry
- Re-throw
- Have a clearly intentional comment ("// non-blocking; failure here only affects X")

= MEDIUM finding (silent failure path).

Also grep for cron jobs and webhook handlers that 200-and-log without re-raising — those CAN'T be fixed (must return 200 to stop retries) but the operator must have a Sentry alert or DB row to find them later.

Phase exit criteria (issue #201):
- State-machine doc attached covering blue-green script, Caddy, docker-compose, cron leader
- Dry-run against staging captured (logs + deliberate failure recovery)
- Sentry/Pino redaction confirmed
- Health check depth confirmed sufficient or upgraded
- Silent-failure-path map produced

When done — execute these steps yourself; do NOT ask the user to do them manually:
1. Verify every exit-criteria checkbox in issue #201: `gh issue view 201`.
2. Post completion summary: `gh issue comment 201 --body "Phase 6 complete. Findings: <list>. State-machine analysis: <link to comment>."`
3. Close: `gh issue close 201`
4. **Self-pop this prompt from the queue.** `docs/audit/REVIEW_PROMPTS.md` allows direct commits to `main`:
   a. `cd /home/ubuntu/TACBookings`
   b. If on a feature branch with uncommitted work, `git stash`. Then: `git checkout main && git pull --ff-only origin main`
   c. Edit `docs/audit/REVIEW_PROMPTS.md`. Find `## P6 — Deploy & runtime hardening · issue #201`. Delete from that line down through and INCLUDING the next standalone line containing only `---`.
   d. Verify: read lines 1–25. The first phase header should now be `## P7 — UI / public surface + email templates · issue #202`. If not, undo: `git checkout docs/audit/REVIEW_PROMPTS.md` and escalate.
   e. `git add docs/audit/REVIEW_PROMPTS.md && git commit -m "[Review] P6 complete — pop from prompt queue"`
   f. `git push origin main`
   g. If stashed, `git checkout <feature-branch> && git stash pop`
5. Final user message — exact wording: "P6 complete. Queue self-popped; new top is **P7: UI / public surface + email templates**. Run `git pull` and start a fresh Claude Code session with `/model claude-sonnet-4-6` to continue. Stopping now."
6. STOP. Do not begin P7 in this session.
```

---

## P8 — Finance subsystem deep dive · issue #203

**Model:** Opus 4.7 (`/model claude-opus-4-7`) — highest novelty, no prior baseline, attack-thinking required.
**Estimated effort:** 3 days
**Pre-condition:** P0 merged. **Codex finance/Xero merges PAUSED** (confirm with @thatskiff33 via comment on epic #194 BEFORE starting).

**Prompt to paste into a fresh Claude Code session:**

```
You are Claude Code working on Phase 8 of the TACBookings production re-review. Epic #194; this phase is issue #203.

CRITICAL PRE-CONDITION: Before doing anything else, confirm Codex finance/Xero merges are paused.

Run: gh issue view 203
Look for a comment from @thatskiff33 confirming: "Codex finance freeze active starting <date>".

If that comment is not present:
  Post: gh issue comment 203 --body "Confirming Codex finance/Xero merge freeze before P8 kickoff. @thatskiff33 please ack."
  STOP and wait for the user to confirm via human conversation. Do not proceed.

If confirmation IS present, proceed.

Read first:
- gh issue view 203
- gh issue view 194
- ~/.claude/plans/gleaming-crafting-elephant.md (P8 section)
- docs/finance-dashboard/* — any handoff docs
- docs/XERO_HANDOFF.md
- src/lib/finance-auth.ts and finance-api-auth.ts (already read in P1; re-skim)
- src/lib/finance-xero-token-store.ts (already read in P5; re-skim)

Live-system safety rules: see epic #194. STAGING ONLY for any pen-test. NO live Xero calls.

This phase is the longest because it's the genuinely unaudited surface — 22 finance lib modules, 8 report pages, finance OAuth + token store. Plan ~3 days. Don't rush.

THREAD A — Finance lib module review (read-and-summarize).

Read each of these in full (don't skim — full read):
- finance-auth.ts (probably done in P1)
- finance-api-auth.ts (probably done in P1)
- finance-xero-token-store.ts (probably done in P5)
- finance-xero-oauth-state.ts
- finance-sync-service.ts
- finance-sync-cron.ts
- finance-sync-storage.ts
- finance-sync-datasets.ts
- finance-sync-diagnostics.ts
- finance-sync-xero-datasets.ts (if present)
- finance-xero-api-usage.ts
- finance-xero.ts
- finance-booking-metrics.ts
- All 8 finance-*-report-page.ts files (balance-sheet, bookings, cash, costs, revenue, working-capital, pricing-sensitivity, landing)

For each file, write a 3-line summary: purpose, public surface, dependencies.

Then read each of these report pages under src/app/(admin)/admin/finance/**:
- The page.tsx (server component) for each report
- Any /api/finance/** route the page calls

For each report page:
1. Server-side auth check: does it call requireFinanceViewer or requireFinanceManager EARLY (before any data fetch)? If not = HIGH finding (data could be returned to unauthorized session).
2. Query parameters from search params — are they Zod-validated? Any Prisma raw SQL using them?
3. Pagination — does the report paginate, or load full dataset (memory pressure)?
4. Cross-tenant: a finance viewer at one membership tier — does the report filter to their scope, or show all?

THREAD B — Cross-tenant data exposure pen-test.

This is the offensive thread. Approach as an attacker with FINANCE_VIEWER role on staging:

1. Try to access /admin/finance/* with role=MEMBER — must 403.
2. With FINANCE_VIEWER role, try every URL in /admin/finance/* — should 200 only on viewer-permitted reports, 403 on manager-only.
3. Try parameter injection in date ranges: ?from=2020-01-01&to=2030-12-31 — does it return more data than expected? Try SQL injection patterns: ?from=2020-01-01' OR '1'='1.
4. Try ID parameter manipulation: if a report has /admin/finance/bookings/[bookingId], try a bookingId outside the viewer's scope.
5. Try the Xero OAuth callback URL with a forged state parameter — must reject.

Each successful unauthorized access = CRITICAL finding.

THREAD C — Xero token store deep audit.

Re-read src/lib/finance-xero-token-store.ts.

Reasoning questions to answer in writing:
1. The encryption key is sourced from FINANCE_XERO_ENCRYPTION_KEY. What length is required? What happens if it's the wrong length? (Should fail loudly at startup, not at first decrypt.)
2. What if the key is rotated? Is there a re-encrypt-on-rotate path? If not, MEDIUM finding (operational risk).
3. What if the Xero refresh token expires while the app is offline (Xero refresh tokens last 60 days)? Re-auth flow must be triggered. Find the trigger.
4. Can a token be "stuck" — encrypted with a key that's been rotated out, with no path to recovery? Document the failure mode.
5. Are tokens scoped to a specific Xero org/tenant? If multi-tenant in future, is there a separation guarantee?

THREAD D — Finance OAuth state-parameter audit.

Open finance-xero-oauth-state.ts.

The OAuth state parameter prevents CSRF on the callback. Verify:
1. State is randomBytes(32)+ at minimum, opaque.
2. State is bound to the user session (not just a global random).
3. State has a short TTL (5-10 min typical).
4. State is single-use (consumed on callback).
5. Mismatched state = reject without leaking info.

Anything missing = HIGH finding.

THREAD E — Finance cron loop.

Read finance-sync-cron.ts. Walk through what it does on each tick.

Failure modes:
- Xero rate-limit hit (Xero allows 60 calls/min, 5000/day): does the cron back off? File MEDIUM if not.
- Sync partial-failure: if 100 contacts to sync and 50 fail, does the cron retry just the 50, or restart the whole batch? Restart-whole-batch is wasteful but not a bug. No-retry is HIGH.
- Sync silent-failure: if Xero API errors for 24h, does anyone know? Confirm Sentry alert / admin email triggers after N consecutive failures. If not, MEDIUM.
- Concurrent runs: if cron-tick 1 is still running when tick 2 starts, what happens? Look for an in-flight guard.

THREAD F — Workspace controls (#189) + age-tier groups (#187).

gh issue view 189 — read PR description.
gh issue view 187 — read PR description.

For workspace controls:
- What can a finance manager do that a finance viewer cannot? List the operations.
- For each manager-only operation, confirm the corresponding API route checks requireFinanceManager (not viewer).
- Try as viewer — must 403.

For age-tier groups:
- Writing to Xero contact groups — is the write idempotent? (Re-running the sync shouldn't duplicate group memberships.)
- Group-name collisions: what if a group with the same name exists from before our app's tooling?

THREAD G — Test coverage report scoped to finance.

Run vitest with coverage on finance modules:
npx vitest run --coverage src/lib/finance-* src/app/admin/finance/**

Read the report. Anything <70% line coverage = LOW finding (acceptable for some helpers; gaps on critical paths = MEDIUM).

THREAD H — API auth coverage on finance routes.

For every src/app/api/finance/**/route.ts:
- Does it call requireFinanceViewer or requireFinanceManager?
- Are there any public finance routes? (None should exist.)

Anything missing = HIGH finding.

Phase exit criteria (issue #203):
- 100% of finance API routes have explicit auth check
- Encryption key rotation strategy documented (or finding filed)
- Pen-test results documented; no cross-boundary data leaks (or critical findings filed)
- Coverage report attached
- All ~22 finance lib modules summarized

When done — execute these steps yourself; do NOT ask the user to do them manually:
1. Verify every exit-criteria checkbox in issue #203: `gh issue view 203`.
2. Post completion summary: `gh issue comment 203 --body "Phase 8 complete. Findings: <list>. Pen-test: <pass/fail>. Coverage: <%>. Codex finance freeze can now lift."`
3. Close: `gh issue close 203`
4. **Self-pop this prompt from the queue.** `docs/audit/REVIEW_PROMPTS.md` allows direct commits to `main`:
   a. `cd /home/ubuntu/TACBookings`
   b. If on a feature branch with uncommitted work, `git stash`. Then: `git checkout main && git pull --ff-only origin main`
   c. Edit `docs/audit/REVIEW_PROMPTS.md`. Find `## P8 — Finance subsystem deep dive · issue #203`. Delete from that line down through and INCLUDING the next standalone line containing only `---`.
   d. Verify: read lines 1–25. The first phase header should now be `## P9 — Tests, dependencies, docs · issue #204`. If not, undo: `git checkout docs/audit/REVIEW_PROMPTS.md` and escalate.
   e. `git add docs/audit/REVIEW_PROMPTS.md && git commit -m "[Review] P8 complete — pop from prompt queue"`
   f. `git push origin main`
   g. If stashed, `git checkout <feature-branch> && git stash pop`
5. Final user message — exact wording: "P8 complete. Codex finance freeze can lift; tell @thatskiff33. Queue self-popped; new top is **P9: Tests, dependencies, docs**. Run `git pull` and start a fresh Claude Code session with `/model claude-sonnet-4-6` to continue. Stopping now."
6. STOP. Do not begin P9 in this session.
```

---

## P9 — Tests, dependencies, docs · issue #204

**Model:** Sonnet 4.6 (`/model claude-sonnet-4-6`) — backfill, scan, walk docs. Mechanical.
**Estimated effort:** 2 days
**Pre-condition:** P0–P8 complete (this phase backfills tests for findings from earlier phases).

**Prompt to paste into a fresh Claude Code session:**

```
You are Claude Code working on Phase 9 of the TACBookings production re-review. Epic #194; this phase is issue #204.

Read first:
- gh issue view 204
- gh issue view 194 (specifically the Findings Index — you'll backfill tests for these)
- ~/.claude/plans/gleaming-crafting-elephant.md (P9 section)
- All P1–P8 phase issues (closed) — gh issue view 195/196/.../203 — the "Findings" section lists what tests need adding
- vitest.config.ts
- DEPLOYMENT.md
- docs/ARCHITECTURE.md
- CLAUDE.md
- README.md

Live-system safety rules: see epic #194. Tests run locally; no prod calls.

Threads:

THREAD A — Test backfill from P1–P8 findings.

For every HIGH or MEDIUM finding from P1–P8 that involves a code defect (not config), add a regression test under src/lib/__tests__/.

Methodology:
1. Open each finding issue (filter: gh issue list --label "area: review-finding")
2. For each, decide: does this need a test? (Code defect = yes; config/doc/process = no.)
3. Write the test FIRST against current main (without remediation) — confirm it fails (proves the test catches the bug).
4. The remediation PR (separate work, P10) will make the test pass.

Specific gaps from initial exploration:
- Kiosk PIN session: rotation, brute-force throttling, lockout
- Action-token expiry / rotation
- Finance reports: parameter injection, role boundaries (P8 findings)
- CRON_ENABLED flag transitions
- Cron leader exclusivity under blue-green simulated environment

Each new test goes in the appropriate src/lib/__tests__/ subfile. Run `npm test` to confirm green (without the remediation, the new test SHOULD fail — that's the point).

THREAD B — Test quality audit.

Find any snapshot tests for business logic:
grep -rn "toMatchSnapshot\|toMatchInlineSnapshot" src/lib/__tests__/

Snapshots for rendered emails: OK.
Snapshots for return values of pure functions, pricing calculations, tier logic: ANTI-PATTERN — refactor to assertion-style. File LOW finding for each.

State-leak check: do tests use a shared Prisma client without per-test cleanup? Look for beforeEach / afterEach. Tests that mutate DB without cleanup = LOW finding.

THREAD C — Dependency residuals.

Re-run: npm audit --audit-level=high
Anything new since P0 = remediate. If no remediation possible (vendor not patched), document as accepted-risk.

Specifically check the nodemailer 8 / next-auth peer-range mismatch one more time — confirm runtime is OK.

THREAD D — Docker image scan.

Re-run trivy against the locally-built image:
docker build -t tacbookings:local .
trivy image --severity CRITICAL,HIGH tacbookings:local

Any CRITICAL = HIGH finding (must fix before next deploy).
Any HIGH on an attackable surface (a network-facing daemon, a JIT runtime) = HIGH.
Any HIGH on dev-tools that don't run in production = LOW.

Layer ordering check: COPY of source code should be the last big layer (so dependency layers cache). Read Dockerfile.
Secrets-in-build check: no ARG that takes a secret. No build-time access to .env. Confirm.

THREAD E — Documentation walkthrough.

For each doc, walk it as a fresh reader on a clean checkout. Note any inaccuracies, broken commands, missing steps.

DEPLOYMENT.md:
- Step-by-step commands to deploy. Run them against staging. Anything that fails = HIGH (broken docs = broken deploy).

docs/ARCHITECTURE.md:
- Does it mention the finance subsystem? (Should — added post-audit.)
- Does it mention hashed-token migration? (Should.)
- Does it mention blue-green deploy? (Probably should.)

docs/finance-dashboard/* (if present):
- A non-developer admin should be able to follow the Xero connect flow from these docs. Do a dry-run as a non-developer (mentally or by recruiting someone).

CLAUDE.md:
- Design-decisions section: each entry should still hold. Walk each:
  - "All prices in cents as integers" — still true (verified P3)
  - "Pacific/Auckland tz" — still true
  - "JWT 8h expiry" — still true (P1 verified)
  - "29-bed capacity-based booking" — still true
  - "Season year April-March" — still true
  - "Fixed advisory lock key 1" — still true (P2 verified)
  - "Promo cleanup on cancel/bump" — still true (P2 verified)
  - "Age tiers at season start" — still true
  - "DRAFT 72h expiry" — still true
  - "$0 bookings skip Stripe" — still true (P2 verified)
  - "Email inheritance for dependents" — still true
  - "FIFO waitlist" — still true
  - "MemberCredit ledger" — still true (P2 verified)
  - "Family multi-membership" — still true
  - "Xero tokens AES-256-GCM" — still true (P5 verified)

Any drift = file a finding with severity LOW (docs out of sync = onboarding hazard).

README.md:
- Run setup from scratch on a temp clone. Anything broken = HIGH (first-impressions doc).

Phase exit criteria (issue #204):
- All P1–P8 code-defect findings have a regression test
- Trivy clean against built image
- npm audit clean
- Docs validated by walkthrough on clean checkout

When done — execute these steps yourself; do NOT ask the user to do them manually:
1. Verify every exit-criteria checkbox in issue #204: `gh issue view 204`.
2. Post completion summary: `gh issue comment 204 --body "Phase 9 complete. Findings: <list>. Tests added: <count>. Doc fixes filed: <list>."`
3. Close: `gh issue close 204`
4. **Self-pop this prompt from the queue.** `docs/audit/REVIEW_PROMPTS.md` allows direct commits to `main`:
   a. `cd /home/ubuntu/TACBookings`
   b. If on a feature branch with uncommitted work, `git stash`. Then: `git checkout main && git pull --ff-only origin main`
   c. Edit `docs/audit/REVIEW_PROMPTS.md`. Find `## P9 — Tests, dependencies, docs · issue #204`. Delete from that line down through and INCLUDING the next standalone line containing only `---`.
   d. Verify: read lines 1–25. The first phase header should now be `## P10 — Final report, remediation tracker, sign-off · issue #205`. If not, undo: `git checkout docs/audit/REVIEW_PROMPTS.md` and escalate.
   e. `git add docs/audit/REVIEW_PROMPTS.md && git commit -m "[Review] P9 complete — pop from prompt queue"`
   f. `git push origin main`
   g. If stashed, `git checkout <feature-branch> && git stash pop`
5. Final user message — exact wording: "P9 complete. Queue self-popped; new top is **P10: Final report, remediation tracker, sign-off** (the last phase). Run `git pull` and start a fresh Claude Code session with `/model claude-sonnet-4-6` to continue. Stopping now."
6. STOP. Do not begin P10 in this session.
```

---

## P10 — Final report, remediation tracker, sign-off · issue #205

**Model:** Sonnet 4.6 (`/model claude-sonnet-4-6`) — synthesis-heavy. If Sonnet's severity calibration drifts, override at human PR review.
**Estimated effort:** 3 days (includes shipping remediation PRs)
**Pre-condition:** P0–P9 complete.

**Prompt to paste into a fresh Claude Code session:**

```
You are Claude Code working on Phase 10 of the TACBookings production re-review. Epic #194; this phase is issue #205.

Read first:
- gh issue view 205
- gh issue view 194 (full Findings Index — this is your input)
- All closed phase issues (P0–P9): gh issue view 195/.../204
- All review-finding issues: gh issue list --label "area: review-finding" --state all --limit 200
- ~/.claude/plans/gleaming-crafting-elephant.md (P10 section)
- docs/audit/06_GO_LIVE_AND_DEPLOY.md (the prior-audit final report — match its format)

Live-system safety rules: see epic #194. Remediation PRs go through normal PR review — no direct main commits.

This phase has 4 deliverables. Work them in this order.

DELIVERABLE 1 — Findings remediation PRs.

For every HIGH (and CRITICAL if any) finding:
1. Create a feature branch named: review/fix/<finding-issue-number>-<slug>
2. Implement the fix.
3. Use the regression test added in P9 to validate.
4. Run npm test, npm run build, lint — all must pass.
5. Open a PR with title: "[Review/Fix] <finding title>". Body must include:
   - "Closes #<finding>"
   - One-paragraph description
   - Test plan
6. Request review from @thatskiff33.

For every MEDIUM finding:
- Either fix as above, OR
- File a follow-up issue (label "type: task", milestone "next sprint") and add written acceptance to the finding issue: "Deferred to <issue#>; revisit if <trigger>."

For every LOW finding:
- Roll up into a single "review-cleanup" tracking issue with a checklist; do not block sign-off on it.

DELIVERABLE 2 — Coverage matrix vs prior 2026-04-08 audit.

Produce a markdown table (attach to issue #205 as a comment titled "Coverage matrix vs 2026-04-08 audit"):

| Prior audit phase | Re-verified? | Deepened? | New scope added |
|-------------------|--------------|-----------|------|
| 01_BASELINE_AND_PRIOR_REVIEW | ... | ... | ... |
| 02_SECURITY_AND_BOUNDARY | ... | ... | hashed-token migration validation (new) |
| 03_DATA_LOGIC_AND_INTEGRATIONS | ... | ... | finance subsystem deep-dive (new) |
| 04_UI_TESTS_OPS_AND_DOCS | ... | ... | blue-green deploy script (new) |
| 05_REMEDIATION_AND_VERIFICATION | ... | ... | ... |
| 06_GO_LIVE_AND_DEPLOY | ... | ... | post-launch operational gaps (new) |

Show what got re-verified, what got deepened, and what's genuinely new vs the prior audit.

DELIVERABLE 3 — Final report at docs/audit/07_RE_REVIEW_2026_04.md.

Match the format of docs/audit/00_EXECUTION_MODEL.md and 06_GO_LIVE_AND_DEPLOY.md.

Required sections:
1. Executive summary (1 paragraph): scope, dates, methodology, headline findings.
2. Scope: phases run, sequence, total findings count by severity.
3. Methodology: re-verification of audited spine via citation spot-checks; deep-dive of post-audit surface; live-system safety rules; Codex coordination model.
4. Findings table: every finding with link, severity, status (fixed/deferred/accepted).
5. Remediations applied: table of merged PRs.
6. Deferred items: each with rationale and re-review trigger.
7. Operational watch items: monitors / alerts created (deliverable 4 below).
8. Sign-off: GO / GO-WITH-CAVEATS / HOLD with concrete reasons.

Commit this file in a final PR titled "[Review] Final report and sign-off".

DELIVERABLE 4 — Operational watch items (each must have a real backing).

For each ongoing risk surfaced by the review, create a real monitor:
- Sentry alert for: any cron job that hasn't run for 24h+
- Sentry alert for: any payment_intent webhook that errors
- Sentry alert for: any Xero API call returning 401 (token expired)
- Sentry alert for: any Stripe API call returning idempotency_violation (means dedup logic missed)
- DB-query monitor (or scheduled job) for: any plaintext token row appearing in token tables (hashed-token migration regression)
- Daily check that the cron leader is exactly one (CRON_ENABLED=true on exactly one color)

For each watch item, list:
- The condition.
- The actual monitor (Sentry alert ID, scheduled job filename, etc.).
- The on-call response.

Anything that's "we'll keep an eye on it" without a real backing = file a follow-up to add the actual monitor.

DELIVERABLE 5 — Final sign-off decision.

Based on findings status:
- All CRITICAL fixed, all HIGH fixed-or-accepted = GO.
- HIGH items deferred but with strict triggers and short windows = GO-WITH-CAVEATS.
- Any CRITICAL deferred or HIGH without a trigger = HOLD (reschedule release until fixed).

State the decision in the executive summary of 07_RE_REVIEW_2026_04.md.

Phase exit criteria (issue #205):
- Every HIGH finding has merged PR or written acceptance with re-review trigger
- Every MEDIUM finding has remediation PR or scheduled follow-up issue
- 07_RE_REVIEW_2026_04.md committed
- Coverage matrix attached
- Watch items have real backing
- Final sign-off decision recorded

When done — execute these steps yourself:
1. Verify every exit-criteria checkbox in issue #205: `gh issue view 205`.
2. Post final summary: `gh issue comment 205 --body "Phase 10 complete. Sign-off: <GO/GO-WITH-CAVEATS/HOLD>. Final report: docs/audit/07_RE_REVIEW_2026_04.md. Remediation PRs: <list>."`
3. Close issue #205: `gh issue close 205`
4. Update parent epic #194 body: change all phase checkboxes from `[ ]` to `[x]`, prepend a header line `**Status: SIGNED OFF on YYYY-MM-DD**`. Use `gh issue edit 194 --body "<new body>"`.
5. Close epic #194: `gh issue close 194`
6. **Final queue cleanup.** The review is done; the artifact going forward is `docs/audit/07_RE_REVIEW_2026_04.md`:
   a. `cd /home/ubuntu/TACBookings && git checkout main && git pull --ff-only origin main`
   b. `git rm docs/audit/REVIEW_PROMPTS.md` (the entire file — review queue is now empty)
   c. `git commit -m "[Review] Production re-review complete — remove prompt queue"`
   d. `git push origin main`
7. Final user message — exact wording: "Production re-review COMPLETE. Sign-off: <decision>. Final report committed at `docs/audit/07_RE_REVIEW_2026_04.md`. Epic #194 closed. Prompt queue file removed. Run `git pull` to refresh."
8. STOP.
```

---
