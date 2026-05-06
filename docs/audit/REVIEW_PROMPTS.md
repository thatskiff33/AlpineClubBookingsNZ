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

## P3 — Database, schema, migration safety · issue #198

**Model:** Sonnet 4.6 (`/model claude-sonnet-4-6`) — schema audit, migration classification, restore drill. Procedural.
**Estimated effort:** 1 day
**Pre-condition:** P0 merged; shadow DB ready (from P0).

**Prompt to paste into a fresh Claude Code session:**

```
You are Claude Code working on Phase 3 of the TACBookings production re-review. Epic #194; this phase is issue #198.

Read first:
- gh issue view 198
- gh issue view 194
- ~/.claude/plans/gleaming-crafting-elephant.md (P3 section)
- docs/audit/03_DATA_LOGIC_AND_INTEGRATIONS_AUDIT.md (prior schema baseline)
- prisma/schema.prisma (full file)
- .claude/rules/database.md
- src/lib/backup.ts

Live-system safety rules: see epic #194. Critical for this phase: backup-restore drill in SHADOW DB ONLY. Never restore over live.

Threads (run in order):

THREAD A — Schema review of post-audit additions.

List tables added or modified since 2026-04-08 by reading the migration directory:
ls -la prisma/migrations/
Read each migration directory created on or after 2026-04-08. For each, write a one-line summary.

For new tables (FinanceXeroToken, XeroSyncOperation, XeroInboundEvent, family group join tables, etc.), audit:
1. Primary key uses cuid() (or similar).
2. All foreign keys have an explicit @@index() in schema.prisma.
3. Cascade rules — onDelete should be Restrict for parent records that hold financial history (Booking, Payment, Member). Cascade only for true ownership relations (e.g. BookingGuest under Booking).
4. Money columns (any *Cents field) are Int, never Float or Decimal stored as Float.
5. Timestamps default to now() and use the proper timezone (Pacific/Auckland is implicit at DB level — TIMESTAMPTZ).
6. Required-by-business-rule fields are NOT NULL.
7. Email-bearing fields don't allow duplicates where business rules forbid it (unique constraints).

File MEDIUM finding for any missing index, missing unique constraint, or wrong cascade rule. File HIGH for money-as-float.

THREAD B — Transaction boundary audit.

Goal: find any multi-table mutation NOT wrapped in prisma.$transaction.

Methodology:
1. grep -rn "prisma\.[a-zA-Z]*\.\(create\|update\|delete\|createMany\|updateMany\|deleteMany\|upsert\)" src/lib src/app/api > /tmp/all-mutations.txt
2. For each file with 2+ mutations, open it and verify the mutations are inside a $transaction or a single Prisma extended-call. Files where multiple unrelated mutations execute sequentially without a transaction = HIGH finding (atomicity violation).
3. Pay special attention to: booking creation flow (booking + guests + payment + audit), credit ledger application + booking update, promo redemption + booking confirmation.

THREAD C — Hashed-token migration cross-check (schema-side validation).

Cross-validate P1's auth-side validation:
1. Open prisma/schema.prisma. For every table referenced in docs/HASHED_TOKEN_MIGRATION.md, confirm:
   - The tokenHash column exists with @unique (or proper index).
   - Any plaintext "token" / "tokenPlain" column has been dropped (look at the latest migration directory for that table).
2. If tokenHash is missing or plaintext column lingers → CRITICAL finding (cross-link to P1 in case auth-side catches it too).

THREAD D — Blue-green migration backward compatibility.

For each post-audit migration, classify as:
- ADDITIVE — adds tables/columns/indexes; no destructive change. Safe for blue-green.
- DESTRUCTIVE — drops a column, narrows a type, adds NOT NULL to existing nullable, changes a default in a way that breaks running code. Must be split into expand+contract (two releases).

For any DESTRUCTIVE migration, confirm it was done as expand+contract OR file HIGH finding (blue-green will break the active color when only one color has the new code).

THREAD E — Backup integrity drill (the deliverable that proves DR works).

1. Identify the most recent S3 backup. Look at src/lib/backup.ts to find the bucket/prefix path. Confirm the recent commit "Align S3 backups with tacbookings prefix" (7e76462) is in effect on the production deploy.
2. Pull the most recent dump to local /tmp.
3. Restore into the shadow DB created in P0:
   pg_restore --clean --if-exists -d <shadow_dsn> /tmp/<dump-file>
4. Run smoke queries:
   SELECT count(*) FROM "Member";
   SELECT count(*) FROM "Booking";
   SELECT count(*) FROM "Payment";
   SELECT max("createdAt") FROM "Booking";
5. Time the restore. Capture as the RTO (recovery time objective) data point.
6. Verify the dump is fresh (max createdAt within last 24h, ideally last 4h depending on cron schedule).

If the restore fails or data is stale → HIGH finding.

THREAD F — Long-running migration risk.

For each post-audit migration, look at the ALTER statements. Any ALTER TABLE on Member, Booking, Payment, Membership without CONCURRENTLY (for indexes) or without table-rewrite avoidance (for columns) is a HIGH finding under live traffic.

Phase exit criteria (issue #198):
- All recent migrations classified additive vs destructive
- Restore drill from S3 to shadow DB completes with timing captured
- No multi-table mutation found outside a transaction
- Schema audit complete with findings filed

When done — execute these steps yourself; do NOT ask the user to do them manually:
1. Verify every exit-criteria checkbox in issue #198: `gh issue view 198`.
2. Post completion summary: `gh issue comment 198 --body "Phase 3 complete. Findings: <list>. Restore drill RTO: <minutes>."`
3. Close: `gh issue close 198`
4. **Self-pop this prompt from the queue.** `docs/audit/REVIEW_PROMPTS.md` allows direct commits to `main`:
   a. `cd /home/ubuntu/TACBookings`
   b. If on a feature branch with uncommitted work, `git stash`. Then: `git checkout main && git pull --ff-only origin main`
   c. Edit `docs/audit/REVIEW_PROMPTS.md`. Find `## P3 — Database, schema, migration safety · issue #198`. Delete from that line down through and INCLUDING the next standalone line containing only `---`.
   d. Verify: read lines 1–25. The first phase header should now be `## P4 — API surface sweep · issue #199`. If not, undo: `git checkout docs/audit/REVIEW_PROMPTS.md` and escalate.
   e. `git add docs/audit/REVIEW_PROMPTS.md && git commit -m "[Review] P3 complete — pop from prompt queue"`
   f. `git push origin main`
   g. If stashed, `git checkout <feature-branch> && git stash pop`
5. Final user message — exact wording: "P3 complete. Queue self-popped; new top is **P4: API surface sweep**. Run `git pull` and start a fresh Claude Code session with `/model claude-sonnet-4-6` to continue. Stopping now."
6. STOP. Do not begin P4 in this session.
```

---

## P4 — API surface sweep · issue #199

**Model:** Sonnet 4.6 (`/model claude-sonnet-4-6`) — methodical enumeration over 184 endpoints. Sonnet's strength.
**Estimated effort:** 2 days
**Pre-condition:** P0 merged.
**Note:** can run in parallel with P3, P5, P7 (independent file scopes).

**Prompt to paste into a fresh Claude Code session:**

```
You are Claude Code working on Phase 4 of the TACBookings production re-review. Epic #194; this phase is issue #199.

Read first:
- gh issue view 199
- gh issue view 194
- ~/.claude/plans/gleaming-crafting-elephant.md (P4 section)
- .claude/rules/api.md (the project's API rules)
- src/lib/rate-limit.ts (current rate-limit implementation)
- docs/audit/02_SECURITY_AND_BOUNDARY_AUDIT.md (prior baseline)

Live-system safety rules: see epic #194. Critical for this phase: brute-force tests against STAGING ONLY.

Goal of this phase: produce 4 coverage matrices over the full 184-endpoint surface. Each matrix is the deliverable.

Setup:
1. Generate the endpoint inventory:
   find src/app/api -name "route.ts" -o -name "route.tsx" | sort > /tmp/endpoints.txt
   wc -l /tmp/endpoints.txt   # should be ~184
2. For each endpoint, identify its HTTP methods (GET/POST/PUT/PATCH/DELETE) by grepping for `export async function` in the file.
3. Cross-reference with post-audit churn:
   git log --since=2026-04-08 --name-only --oneline -- src/app/api/ | grep "route\.\(ts\|tsx\)" | sort -u > /tmp/post-audit-routes.txt
   These get extra scrutiny.

MATRIX 1 — Authentication coverage.

For each endpoint × method, classify:
- AUTHENTICATED — calls auth() or imports a wrapper that does
- ROLE-GATED — checks session.user.role === "ADMIN" or uses requireFinanceViewer/Manager
- LODGE-SCOPED — uses src/lib/lodge-auth or kiosk-access
- PUBLIC-BY-DESIGN — webhook (signature verified), cron (CRON_SECRET), health, public read endpoint
- UNKNOWN — neither auth nor explicitly public — INVESTIGATE

Output as a markdown table sorted by classification. UNKNOWN rows must be investigated (read the file). If a mutation endpoint (POST/PUT/PATCH/DELETE) lands in UNKNOWN even after investigation → CRITICAL finding (unauthenticated mutation).

The only legitimate PUBLIC mutation endpoints are: /api/webhooks/*, /api/cron/* (CRON_SECRET protected), and any public registration/contact form endpoints (these need rate-limit instead). Anything else mutating without auth = critical finding.

MATRIX 2 — IDOR coverage.

For each endpoint with a path parameter ([id], [token], [bookingId], [memberId], [familyGroupId], etc.):
- Open the route file.
- Confirm the handler verifies the authenticated user's relationship to the resource (member can only access own; admin can access all; lodge access scoped to date).
- The check should appear BEFORE any data is read or returned.

Classification per route:
- OWNERSHIP-CHECKED — explicit verification present
- ROLE-ONLY — only checks role (admin), no per-resource ownership for non-admin paths
- MISSING — no check found

ROLE-ONLY is acceptable for admin-only routes (/api/admin/**); missing on member-facing routes is HIGH (IDOR vulnerability).

MATRIX 3 — Zod validation coverage.

For each MUTATION endpoint:
- Does the handler call zodSchema.safeParse() (or .parse()) on req.json() / params / searchParams?
- Are query parameters validated (not just body)?

Anything missing Zod on mutation = HIGH finding. Anything missing Zod on query params that affect data filtering = MEDIUM (potential SQL/IDOR vector via Prisma query construction).

MATRIX 4 — Rate-limit coverage.

For these endpoints, confirm rate-limit is in place:
- /api/auth/* (login, password reset, signup, verify-email)
- /api/contact (spam vector)
- Any /api/*/[token]/* (token-bearing routes — anti-enumeration)
- /api/applications (membership applications — abuse vector)

Bonus check: brute-force the staging /api/auth/signin endpoint with 100 requests in 10 seconds. Confirm rate-limit kicks in (429 response). Document the threshold.

Anything missing rate-limit on the list above = HIGH finding.

ADDITIONAL:
- Error response shape: spot-check 20 random routes — they should all return { error: string, details?: any } per .claude/rules/api.md. Inconsistencies = LOW finding (cleanup, but not security risk).
- CSRF: NextAuth handles auth-flow CSRF. For other mutations, confirm same-origin via Sec-Fetch-Site or that the API tokens themselves are non-cookie (Authorization: Bearer). Document the CSRF model in a phase comment.

Each matrix should be attached to issue #199 as a comment with a clear title ("MATRIX 1 — Authentication coverage", etc.). Findings filed in standard format (see epic #194).

Phase exit criteria (issue #199):
- 4 matrices attached
- 100% of mutation endpoints classified (no UNKNOWN remaining)
- IDOR check complete on all [id]/[token] routes
- Rate-limit brute-force test against staging documented

When done — execute these steps yourself; do NOT ask the user to do them manually:
1. Verify every exit-criteria checkbox in issue #199: `gh issue view 199`.
2. Post completion summary: `gh issue comment 199 --body "Phase 4 complete. Findings: <list>. Coverage stats: auth <%>; IDOR <%>; Zod <%>; rate-limit <%>."`
3. Close: `gh issue close 199`
4. **Self-pop this prompt from the queue.** `docs/audit/REVIEW_PROMPTS.md` allows direct commits to `main`:
   a. `cd /home/ubuntu/TACBookings`
   b. If on a feature branch with uncommitted work, `git stash`. Then: `git checkout main && git pull --ff-only origin main`
   c. Edit `docs/audit/REVIEW_PROMPTS.md`. Find `## P4 — API surface sweep · issue #199`. Delete from that line down through and INCLUDING the next standalone line containing only `---`.
   d. Verify: read lines 1–25. The first phase header should now be `## P5 — External integrations & cron · issue #200`. If not, undo: `git checkout docs/audit/REVIEW_PROMPTS.md` and escalate.
   e. `git add docs/audit/REVIEW_PROMPTS.md && git commit -m "[Review] P4 complete — pop from prompt queue"`
   f. `git push origin main`
   g. If stashed, `git checkout <feature-branch> && git stash pop`
5. Final user message — exact wording: "P4 complete. Queue self-popped; new top is **P5: External integrations & cron**. Run `git pull` and start a fresh Claude Code session with `/model claude-sonnet-4-6` to continue. Stopping now."
6. STOP. Do not begin P5 in this session.
```

---

## P5 — External integrations & cron · issue #200

**Model:** Sonnet 4.6 (`/model claude-sonnet-4-6`) — needs explicit failure-mode prompts (included below) for the subtle parts.
**Estimated effort:** 1 day
**Pre-condition:** P0 merged.
**Note:** can run in parallel with P3, P4, P7.

**Prompt to paste into a fresh Claude Code session:**

```
You are Claude Code working on Phase 5 of the TACBookings production re-review. Epic #194; this phase is issue #200.

Read first:
- gh issue view 200
- gh issue view 194
- ~/.claude/plans/gleaming-crafting-elephant.md (P5 section)
- .claude/rules/stripe.md
- src/lib/stripe.ts
- src/lib/xero.ts (it's the largest file — skim structure first)
- src/lib/finance-xero-token-store.ts
- src/lib/email.ts and email-sender.ts
- src/instrumentation.ts (where cron is wired up)

Live-system safety rules: see epic #194. NO live API calls — Stripe test keys + Xero demo org only.

Threads:

THREAD A — Stripe SDK usage.

Open every file under src/ that imports stripe. For each Stripe API call:
- charges.refund / refunds.create — confirm idempotency_key passed
- paymentIntents.create / paymentIntents.confirm — confirm amount sourced server-side, idempotency_key for confirmation retries
- setupIntents.create — same
- For each call site, list the error-handling. Error types to confirm handled: card_declined, idempotency_violation (means a duplicate slipped through — log and surface), rate_limit (need backoff), authentication_error (key rotation needed)

Anything missing idempotency on a state-changing call = HIGH finding. Anything that swallows error silently = MEDIUM.

THREAD B — Xero wrapper-audit.

Confirm the prior fix holds: NO direct accountingApi calls outside callXeroApi.
grep -rn "accountingApi\." src/ | grep -v "callXeroApi" | grep -v "src/lib/xero"
Anything found = HIGH finding (regression of the wrapper-audit rule).

Then for src/lib/finance-xero-token-store.ts:
- Confirm AES-256-GCM (cipher name "aes-256-gcm")
- Confirm IV is randomBytes(12) per call (not reused)
- Confirm authTag verified on decrypt
- Find the encryption key source: process.env.FINANCE_XERO_ENCRYPTION_KEY
- Document: is there a key rotation strategy? Re-encrypt-on-rotate code? If no, file MEDIUM finding ("no key rotation strategy documented") — encryption keys must be rotatable in any production system.
- What happens if the key changes mid-flight? (Lost-decrypt → token refresh fails → user must reconnect Xero → 24h+ business disruption.) Document the failure mode in a phase comment.

THREAD C — AWS SES bounce/complaint handling.

Look for SES SNS notification handling:
grep -rn "sns\|SNS\|notification" src/lib/email* src/app/api
grep -rn "bounce\|complaint" src/

If nothing found that processes SES bounce/complaint events:
- The risk is hard-bounce accumulation: SES suspends sending after a too-high bounce rate, and members with bad email addresses keep accumulating in send lists.
- File MEDIUM finding: "No bounce/complaint feedback loop wired up. Recommend SNS topic + endpoint that disables sending to bounced addresses."

If found, audit the handler: signature verification on SNS notifications, bounce-rate metric exposed.

THREAD D — node-cron review (12 files).

For each src/lib/cron-*.ts file:
- Read the entire file.
- Identify any DB mutation. For each, confirm:
  a. Idempotent — running the cron twice produces the same end state (typically via WHERE status = X clause in updateMany, or via an idempotency column).
  b. Failure-isolated — one record's failure doesn't abort the whole batch.
  c. Logged — Sentry / pino captures errors.

Specifically check:
- cron-confirm-pending.ts — already cited as line 168 (atomic claim) and line 185 (idempotency_key on Stripe). Re-read; verify holds.
- cron-credit-reconciliation.ts — runs daily 5 AM. Race with apply/restore credit calls — what guards?
- cron-waitlist.ts — FIFO offer issuance. Race with user accepting / declining manually?
- cron-email-retry.ts — retry storm risk if email sender is broken.
- cron-job-run.ts — log of cron runs. Verify Sentry alert if a cron hasn't run for 24h+.

Anything not idempotent under double-run = HIGH finding.

THREAD E — Single-leader cron under blue-green.

In src/instrumentation.ts, find the CRON_ENABLED flag handling. Walk the failure modes:
- Both colors have CRON_ENABLED=true → duplicate execution → CRITICAL (duplicate emails/charges).
- Neither has CRON_ENABLED=true → no execution → HIGH (jobs silently skipped).
- The active color has it disabled, inactive has it enabled → wrong color running cron → MEDIUM (works but counterintuitive).

Trace through the blue-green deploy script (scripts/blue-green-deploy.sh) — does it manage CRON_ENABLED on each color, or rely on operator? Document.

THREAD F — Cron failure alerting.

The recursive admin-alert fix (commit d64c067) should prevent: alert email fails → triggers admin-alert email → that fails → triggers admin-alert email → ... infinite loop.

Find the relevant code (likely in src/lib/email.ts or admin-notification-preferences.ts). Re-trace the loop-break: what condition stops re-alerting? Is it actually safe? File finding if it's a bounded retry rather than a true loop-break.

THREAD G — Dependency residuals.

Re-run npm audit --audit-level=high (P0 should have made this green). If anything new since P0, file finding. Specifically check nodemailer 8 vs next-auth peer-range mismatch is still benign.

Phase exit criteria (issue #200):
- Every external API call has idempotency keys (where supported)
- Bounce/complaint handling either confirmed or filed as finding
- Single-leader cron behavior documented
- Recursive-alert loop break verified
- npm audit clean

When done — execute these steps yourself; do NOT ask the user to do them manually:
1. Verify every exit-criteria checkbox in issue #200: `gh issue view 200`.
2. Post completion summary: `gh issue comment 200 --body "Phase 5 complete. Findings: <list>. Encryption key rotation: <documented yes/no>. SES bounces: <handled/unhandled>."`
3. Close: `gh issue close 200`
4. **Self-pop this prompt from the queue.** `docs/audit/REVIEW_PROMPTS.md` allows direct commits to `main`:
   a. `cd /home/ubuntu/TACBookings`
   b. If on a feature branch with uncommitted work, `git stash`. Then: `git checkout main && git pull --ff-only origin main`
   c. Edit `docs/audit/REVIEW_PROMPTS.md`. Find `## P5 — External integrations & cron · issue #200`. Delete from that line down through and INCLUDING the next standalone line containing only `---`.
   d. Verify: read lines 1–25. The first phase header should now be `## P6 — Deploy & runtime hardening · issue #201`. If not, undo: `git checkout docs/audit/REVIEW_PROMPTS.md` and escalate.
   e. `git add docs/audit/REVIEW_PROMPTS.md && git commit -m "[Review] P5 complete — pop from prompt queue"`
   f. `git push origin main`
   g. If stashed, `git checkout <feature-branch> && git stash pop`
5. Final user message — exact wording: "P5 complete. Queue self-popped; new top is **P6: Deploy & runtime hardening**. Run `git pull` and start a fresh Claude Code session with `/model claude-opus-4-7` to continue. Stopping now."
6. STOP. Do not begin P6 in this session.
```

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

## P7 — UI / public surface + email templates · issue #202

**Model:** Sonnet 4.6 (`/model claude-sonnet-4-6`) — verify recent fixes, run Lighthouse, check templates.
**Estimated effort:** 1 day
**Pre-condition:** P0 merged.
**Note:** can run in parallel with P3, P4, P5.

**Prompt to paste into a fresh Claude Code session:**

```
You are Claude Code working on Phase 7 of the TACBookings production re-review. Epic #194; this phase is issue #202.

Read first:
- gh issue view 202
- gh issue view 194
- ~/.claude/plans/gleaming-crafting-elephant.md (P7 section)
- src/lib/email.ts, email-templates.ts, email-text.ts, email-sender.ts
- src/lib/redact-sensitive-json.ts (touched in P6 too)
- The closed issues for context: #178 #179 #180 #181 #182 #183
  (gh issue view 178; gh issue view 179; etc.)

Live-system safety rules: see epic #194. Lighthouse and any web testing → STAGING ONLY.

Threads:

THREAD A — Email template fix verification.

For each closed issue #178–#183, verify the fix held:
- #178: Admin issue-report links — open the email template that includes them. The link target must be allowlisted (typically only same-origin or a small list of trusted domains). Try injecting a malicious URL via the issue-report flow and confirm it's rejected.
- #179: Plain-text alternatives — every HTML email send must include a text fallback. grep for nodemailer.sendMail calls; confirm both `html` and `text` fields are passed.
- #180: Centralized support email — there should be one constant (e.g. SUPPORT_EMAIL in a config file) that every template references. grep for hard-coded support email addresses; anything else is a regression.
- #181: NZ-local expiry times — every time-sensitive email (password reset, email verification, action tokens) shows expiry in NZST/NZDT. Confirm the templates use the project's date-formatting helper, not raw .toString() (which would render UTC).
- #182: Dead /feedback CTA removed — grep for "/feedback" across all email templates. Should be 0 hits.
- #183: Line-break preservation in free-text — the rendered HTML must convert \n to <br /> (or use white-space: pre-wrap). Test by sending an email with embedded newlines via the staging tooling.

For each issue, write a one-line VERIFIED / REGRESSED in a comment on issue #202.

THREAD B — Public-page security.

Public pages live under src/app/(website)/** and src/app/(auth)/**.

For each page, check:
1. XSS — any user-controlled string rendered without React's default escaping (e.g. dangerouslySetInnerHTML)? Acceptable only with sanitizer (look for DOMPurify usage).
2. Form handlers — if it's a form, where does it POST? Verify Zod validation server-side (covered in P4 but spot-check the contact form here).
3. Rate-limit on the contact form — is it rate-limited? If not, MEDIUM finding (spam vector).
4. Honeypot fields — any hidden fields to trap bots? (Not required, but note presence.)

THREAD C — Action links.

Open the action-token email templates. Verify:
- The link target uses an opaque token (long random string, not user data).
- The URL has no PII (member ID, email) unless required.
- The expiry time appears in the email body (per #181).
- Clicking an expired token shows a friendly error page, NOT a stack trace. Test by manually crafting an expired token and visiting.

THREAD D — Print views.

The kiosk roster has an A4 print template. Find it (probably under src/app/(kiosk)/lodge/roster/* or src/app/(admin)/admin/roster/*).

Inspect the rendered output (View Source or print preview):
- Do guest names appear that shouldn't (e.g. only chore-relevant info should print)?
- Do emergency contact phone numbers appear? (Maybe legitimate — but document.)
- Member-internal IDs leaking?

Document the data exposure. If any sensitive PII appears that isn't required for the print's purpose → MEDIUM finding.

THREAD E — Accessibility baseline.

Run Lighthouse against staging on these pages:
- Member dashboard (/dashboard or equivalent — check src/app/(authenticated)/page.tsx)
- Booking wizard (the booking creation flow)
- Public registration (/register)

Target: WCAG AA / Lighthouse a11y score ≥ 90.

Anything <90 = MEDIUM finding with the failing audits listed.

THREAD F — Print contrast.

Print one of the kiosk pages with default colors AND with dark mode. If contrast falls below WCAG AA in either mode → LOW finding.

Phase exit criteria (issue #202):
- Each #178–#183 verified
- Public-form rate limits in place
- Lighthouse a11y ≥ 90 on key pages (or findings filed)
- Print views audited for PII

When done — execute these steps yourself; do NOT ask the user to do them manually:
1. Verify every exit-criteria checkbox in issue #202: `gh issue view 202`.
2. Post completion summary: `gh issue comment 202 --body "Phase 7 complete. Findings: <list>. Email regressions: <none|list>. a11y scores: <by page>."`
3. Close: `gh issue close 202`
4. **Self-pop this prompt from the queue.** `docs/audit/REVIEW_PROMPTS.md` allows direct commits to `main`:
   a. `cd /home/ubuntu/TACBookings`
   b. If on a feature branch with uncommitted work, `git stash`. Then: `git checkout main && git pull --ff-only origin main`
   c. Edit `docs/audit/REVIEW_PROMPTS.md`. Find `## P7 — UI / public surface + email templates · issue #202`. Delete from that line down through and INCLUDING the next standalone line containing only `---`.
   d. Verify: read lines 1–25. The first phase header should now be `## P8 — Finance subsystem deep dive · issue #203`. If not, undo: `git checkout docs/audit/REVIEW_PROMPTS.md` and escalate.
   e. `git add docs/audit/REVIEW_PROMPTS.md && git commit -m "[Review] P7 complete — pop from prompt queue"`
   f. `git push origin main`
   g. If stashed, `git checkout <feature-branch> && git stash pop`
5. Final user message — exact wording: "P7 complete. Queue self-popped; new top is **P8: Finance subsystem deep dive** — REQUIRES Codex finance/Xero merge freeze before kickoff. Confirm with @thatskiff33 first. Then run `git pull` and start a fresh Claude Code session with `/model claude-opus-4-7`. Stopping now."
6. STOP. Do not begin P8 in this session.
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
