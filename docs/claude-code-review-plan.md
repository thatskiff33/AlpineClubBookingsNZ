# Comprehensive Best-Practice Review Plan — TACBookings

> Superseded as the canonical runbook by `docs/audit/00_EXECUTION_MODEL.md`.
> Keep this file as source context only.

## Context

TACBookings is a production Next.js 16 booking system for Tokoroa Alpine Club (29-bed lodge, ~410 members). It integrates Stripe, Xero, AWS SES, and runs on Docker/Lightsail. A prior code review (2026-04-07) identified 46 issues; many have been fixed in subsequent commits but the status of each is unverified. The system has 1381 passing tests and a successful build. This plan covers a **full 12-area best-practice audit** producing a **report-only output** (no code changes). All severity levels will be catalogued.

## Output

A single consolidated report file at `docs/COMPREHENSIVE_REVIEW_2026-04-11.md` containing:
- Status verification of all 46 prior review findings (FIXED / OPEN / PARTIALLY FIXED)
- New findings organized by area, each with severity, file:line, impact, and recommended fix
- Summary table by area and severity
- Prioritized remediation order

## Configuration

- **Mode:** Report only (no code changes)
- **Prior review:** Verify + extend (check what's fixed, find new issues)
- **Scope:** Full 12-area audit (everything)
- **Severity threshold:** All levels (CRITICAL through LOW)
- **Execution:** Fully autonomous, no pauses between stages

---

## Staged Execution (Fully Autonomous, No Pauses)

### Stage 1: Prior Review Verification
**Goal:** Determine which of the 46 issues from `docs/CODEBASE_REVIEW_2026-04-07.md` are fixed.

**Method:** For each issue (C1-C5, H1-H15, M1-M16, L1-L10), read the cited file:line and check whether the fix described has been applied. Mark each as FIXED, OPEN, or PARTIALLY FIXED with evidence.

**Key files:**
- `docs/CODEBASE_REVIEW_2026-04-07.md` (the prior review)
- `prisma/schema.prisma` (C1: email @unique, H4/H5: onDelete, L10: VarChar)
- `src/components/booking-calendar.tsx` (C2: color thresholds)
- `src/app/api/admin/roster/[date]/route.ts` (C3: transaction, H9: allSettled, M12: token dedup)
- `src/app/(lodge)/lodge/roster/[date]/setup/page.tsx` (C4: eligibility filter)
- `src/app/api/bookings/route.ts` (C5: max length, M4: max guests)
- `src/app/api/webhooks/stripe/route.ts` (H1: amount validation, M1: idempotency)
- `src/lib/xero.ts` (H2: credit note sign, H3: contact race, M7-M10: Xero issues)
- `src/lib/verification-tokens.ts` (H6: expiry, M15: cleanup)
- `src/app/api/auth/confirm-email-change/route.ts` (H7: race condition)
- `src/app/(lodge)/lodge/kiosk/page.tsx` (H8: silent failures, L3: backoff)
- `src/components/nav-bar.tsx` (H11: branding link)
- `src/instrumentation.ts` (H12: Sentry crons, M6: pruning)
- `src/lib/email.ts` (H13: fire-and-forget)
- `src/lib/cron-checkin-reminders.ts` (H14: dedup check)
- `src/lib/cancellation.ts` (H15: status mismatch)
- `src/app/(public)/register/page.tsx` (M9: password text)

---

### Stage 2: Security Audit
**Goal:** Identify security vulnerabilities across auth, input validation, injection risks, secrets, headers, CORS.

**Areas to check:**
1. **Auth & session** — JWT config, session expiry, token rotation, active-member enforcement, role guards on all admin/lodge routes
2. **Input validation** — Every API route has Zod validation; check for missing `.max()`, unvalidated query params, raw SQL
3. **Injection** — XSS (HTML escaping in templates, user content rendering), SQL injection (raw queries), command injection
4. **Secrets** — No hardcoded credentials in source (grep for patterns); `.env` in `.gitignore`; encryption key strength
5. **Rate limiting** — Coverage of all public endpoints; per-IP vs per-user; bypass vectors
6. **Security headers** — CSP, HSTS, X-Frame-Options, X-Content-Type-Options (Caddyfile handles these, but verify middleware.ts absence)
7. **CORS** — Verify no overly permissive cross-origin access
8. **Webhook security** — Stripe signature verification, Xero intent-to-receive, timing-safe comparisons
9. **Password policy** — Hashing algorithm, salt rounds, min length enforcement
10. **Data exposure** — API responses don't leak sensitive fields (passwordHash, tokens, internal IDs)

**Key files:** `src/lib/auth.ts`, `src/lib/rate-limit.ts`, `Caddyfile`, `src/lib/email-templates.ts`, `src/app/api/webhooks/stripe/route.ts`, `src/app/api/webhooks/xero/route.ts`, all `route.ts` files under `src/app/api/`

---

### Stage 3: Database & Schema Audit
**Goal:** Verify schema design, constraints, indexes, cascades, and query patterns.

**Areas to check:**
1. **Unique constraints** — Every field that should be unique IS unique (Member.email is the known gap)
2. **Indexes** — All FKs have indexes; commonly queried fields indexed; composite indexes where appropriate
3. **Cascade policies** — Every relation has explicit `onDelete` (Cascade, Restrict, or SetNull)
4. **Data types** — Money stored as Int (cents), dates as DateTime, appropriate use of `@db.VarChar` for bounded fields
5. **Enum consistency** — Prisma enums match application usage; no orphaned enum values
6. **Migration safety** — Check for destructive migrations, missing `NOT NULL` defaults
7. **Query patterns** — N+1 queries, unbounded selects, missing `select` clauses on large models
8. **Concurrency** — Advisory lock usage, transaction isolation, race conditions

**Key files:** `prisma/schema.prisma`, `prisma/migrations/`, `src/lib/prisma.ts`, all files using `prisma.` queries

---

### Stage 4: API Design & Consistency Audit
**Goal:** Verify all API routes follow consistent patterns for auth, validation, error responses.

**Areas to check:**
1. **Auth guards** — Every non-public route checks `auth()` and appropriate role
2. **Input validation** — Every route accepting input uses Zod; schemas have appropriate constraints
3. **Error shape** — Consistent `{ error: string, details?: any }` across all routes
4. **HTTP status codes** — Correct codes (400 vs 422, 401 vs 403, 404 vs 410)
5. **Method handling** — Routes export only the methods they support; no catch-all handlers
6. **Response shape** — Consistent pagination format, list vs detail, metadata fields
7. **Idempotency** — Payment and webhook endpoints handle duplicate requests
8. **Missing endpoints** — Any CRUD gaps (e.g., can create but not delete)

**Key files:** All 125 `route.ts` files under `src/app/api/`

---

### Stage 5: Business Logic Audit
**Goal:** Verify correctness of core algorithms and flows.

**Areas to check:**
1. **Pricing engine** — Season rate lookup, multi-night stays crossing season boundaries, promo code application order, rounding
2. **Capacity calculation** — 29-bed limit, correct status filtering, date boundary handling (checkIn inclusive, checkOut exclusive)
3. **Bumping algorithm** — FIFO order, cleanup (promo, chores, notifications), status transitions
4. **Cancellation & refunds** — Tier calculation, change fee exclusion, Stripe refund + Xero credit note
5. **Waitlist** — FIFO ordering, offer expiry, capacity re-check on confirm, concurrent offer handling
6. **Age tier computation** — Season start date reference, configurable boundaries, recomputation on DOB change
7. **Chore allocation** — Round-robin fairness, age restrictions, frequency filtering, history lookback
8. **Non-member hold** — 7-day window, auto-confirm cron, payment method charge
9. **Draft bookings** — 72h expiry, capacity check on confirm, no Stripe/Xero until confirmed
10. **Subscription enforcement** — Block booking creation for unpaid/overdue members

**Key files:** `src/lib/pricing.ts`, `src/lib/capacity.ts`, `src/lib/bumping.ts`, `src/lib/cancellation.ts`, `src/lib/waitlist.ts`, `src/lib/age-tier.ts`, `src/lib/chore-allocator.ts`, `src/lib/booking-cancel.ts`

---

### Stage 6: Integration Audit (Stripe, Xero, Email)
**Goal:** Verify external integration correctness and resilience.

**Areas to check:**
1. **Stripe** — PaymentIntent flow, SetupIntent flow, webhook handler completeness (all event types), refund handling, idempotency keys, customer creation
2. **Xero** — OAuth token refresh, encrypted storage, contact sync, invoice creation, credit notes, account mapping, rate limit handling, daily limit guard
3. **Email (SES)** — Template HTML safety, delivery tracking (EmailLog), retry logic, preference gating, rate limiting on bulk sends
4. **Error resilience** — What happens when each integration is down? Graceful degradation or hard failure?
5. **Data consistency** — Stripe payment amount matches DB; Xero invoice matches booking; email sent matches booking state

**Key files:** `src/lib/stripe.ts`, `src/lib/xero.ts`, `src/lib/email.ts`, `src/lib/email-templates.ts`, `src/app/api/webhooks/stripe/route.ts`, `src/app/api/webhooks/xero/route.ts`

---

### Stage 7: Testing Audit
**Goal:** Assess test coverage, quality, and gaps.

**Areas to check:**
1. **Coverage** — Which lib/ modules have tests, which don't? List untested modules
2. **Test quality** — Are tests testing behavior or implementation? Assertion quality
3. **Mock correctness** — Do mocks match real API shapes? Outdated mocks that mask bugs
4. **Edge cases** — Season boundaries, capacity=0, $0 bookings, concurrent requests, timezone edge cases
5. **Integration tests** — API route tests that test the full stack (request to response)
6. **Missing test categories** — No E2E tests, no security tests, no performance tests (note gaps)
7. **Test infrastructure** — Vitest config, test utilities, factories/fixtures

**Key files:** All files in `src/lib/__tests__/`, `vitest.config.ts`

---

### Stage 8: Performance Audit
**Goal:** Identify performance bottlenecks and optimization opportunities.

**Areas to check:**
1. **Database queries** — N+1 patterns, unbounded selects, missing pagination, large includes
2. **API response size** — Routes returning more data than needed; missing `select` in Prisma queries
3. **Cron job efficiency** — Batch processing vs one-at-a-time; query optimization in crons
4. **Client bundle** — Dynamic imports, code splitting, heavy dependencies loaded unnecessarily
5. **Caching** — Any caching strategy? In-memory caches with no TTL? Missing cache opportunities
6. **Connection pooling** — Prisma connection limits, pool exhaustion risks

**Key files:** `src/lib/prisma.ts`, `src/instrumentation.ts`, `next.config.ts`, all `cron-*.ts` files

---

### Stage 9: Infrastructure & DevOps Audit
**Goal:** Assess production readiness of deployment, monitoring, and operations.

**Areas to check:**
1. **Docker** — Image security (non-root, read-only FS, tmpfs), resource limits, health checks, log rotation
2. **Deployment** — Rollback strategy, zero-downtime deployment, migration safety
3. **CI/CD** — Absence of automated pipeline (no GitHub Actions); document what should exist
4. **Monitoring** — Sentry coverage (all crons?), health endpoint completeness, uptime monitoring
5. **Backups** — pg_dump cron, S3 upload, retention policy, restore procedure documented?
6. **Secrets management** — .env handling, key rotation strategy, encryption key management
7. **SSL/TLS** — Caddy auto-HTTPS, HSTS preload readiness, certificate monitoring
8. **Scaling** — Single-instance limitations, cron job distributed lock gaps, session store

**Key files:** `docker-compose.yml`, `Dockerfile`, `Caddyfile`, `.env.example`, `src/lib/backup.ts`, `src/instrumentation.ts`

---

### Stage 10: UI/UX Audit
**Goal:** Check frontend quality, accessibility, and user experience patterns.

**Areas to check:**
1. **Error states** — Do pages handle API errors gracefully? Are error messages user-friendly?
2. **Loading states** — Are there loading indicators? Skeleton screens? Suspense boundaries?
3. **Form validation** — Client-side validation matches server-side? Inline error messages?
4. **Accessibility** — ARIA labels, keyboard navigation, color contrast, screen reader support
5. **Mobile responsiveness** — Responsive layout, touch targets, viewport handling
6. **Feedback** — Toast/notification on actions (save, delete, send email)
7. **Navigation** — Consistent patterns, breadcrumbs, back links

**Key files:** `src/app/(authenticated)/book/page.tsx`, `src/app/(admin)/admin/dashboard/page.tsx`, `src/components/nav-bar.tsx`, `src/components/admin-sidebar.tsx`, `src/app/globals.css`, selected page components

---

### Stage 11: Documentation Audit
**Goal:** Assess documentation completeness and accuracy.

**Areas to check:**
1. **README.md** — Setup instructions, architecture overview, deployment guide
2. **CLAUDE.md** — Accuracy vs current codebase (stale references, missing new features)
3. **API documentation** — Is there an OpenAPI/Swagger spec? Are endpoints documented?
4. **Code comments** — Are complex algorithms documented? Are there misleading comments?
5. **Environment variables** — .env.example complete? All vars documented?
6. **Deployment docs** — DEPLOYMENT.md accuracy, rollback procedure, troubleshooting
7. **Runbooks** — Incident response, common operations (Xero reconnect, member data export)

**Key files:** `README.md`, `CLAUDE.md`, `DEPLOYMENT.md`, `docs/`, `.env.example`

---

### Stage 12: Dependency Audit
**Goal:** Check for outdated, vulnerable, or unnecessary dependencies.

**Areas to check:**
1. **Outdated packages** — Run `npm outdated`, identify major version gaps
2. **Security vulnerabilities** — Run `npm audit`, catalog findings by severity
3. **Unused dependencies** — Packages in package.json not imported anywhere
4. **License compliance** — Any copyleft licenses incompatible with the project?
5. **Pinning strategy** — Are versions pinned appropriately? Lock file present?
6. **Heavy dependencies** — Large packages that could be replaced with lighter alternatives

**Key files:** `package.json`, `package-lock.json`

---

## Verification

After producing the report:
1. Verify all file:line references in the report are accurate (spot-check 10+ citations)
2. Confirm the prior review status table accounts for all 46 original issues
3. Ensure every new finding has: severity, file:line, impact description, and recommended fix
4. Run `npm test` and `npm run build` to confirm the report accurately reflects current state
5. Check total finding count matches the summary table

## Execution Approach

- Launch parallel Explore subagents per stage (2-3 at a time) for maximum throughput
- Each agent gets a focused scope (e.g., "audit all admin API routes for auth guards and input validation")
- Consolidate all findings into a single report at the end
- No code changes — report only

## Execution Prompt

To execute this plan, use the following prompt:

```
Execute the review plan at docs/claude-code-review-plan.md fully autonomously.
Run all 12 stages, produce the consolidated report at docs/COMPREHENSIVE_REVIEW_2026-04-11.md,
and verify the report is accurate. No code changes — report only.
```
