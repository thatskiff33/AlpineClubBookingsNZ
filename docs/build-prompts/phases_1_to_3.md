# Build Prompts: Phases 1-3

---

## Phase 1: Foundational Infrastructure

### Security Review Required: YES

Touches auth (rate limiter on login route), member data (cancellation service handles booking ownership checks), and logging infrastructure that must not leak sensitive data (tokens, passwords, Stripe keys).

---

### 1a. Build Prompt

```
Read CLAUDE.md, docs/DELIVERY_PLAN.md, and the requirement docs for the features
listed below. Build Phase 1 (Foundational Infrastructure) autonomously.

Features to build (in this order):

1. CAN-01: Extract shared cancellation service
   - Create `src/lib/booking-cancel.ts` with `cancelBooking(bookingId, sessionUserId, sessionUserRole, ipAddress)`
   - Both `/api/bookings/cancel` and `/api/bookings/[id]/cancel` delegate to this shared function
   - All existing cancellation behaviour preserved: PENDING cancel, CONFIRMED without payment, CONFIRMED with refund (Stripe + Xero credit note), promo cleanup, audit logging, email
   - Existing tests must pass without modification
   - See docs/requirements/02_BOOKINGS.md CAN-01

2. CAN-02: Deprecate body-based cancel route
   - Update CancelBookingButton to call `/api/bookings/${bookingId}/cancel` instead of `/api/bookings/cancel`
   - The body-based route logs a deprecation warning on each call
   - Both routes remain functional
   - See docs/requirements/02_BOOKINGS.md CAN-02

3. SCH-01: Add BookingModification model
   - Add model to prisma/schema.prisma per the schema in docs/requirements/02_BOOKINGS.md SCH-01
   - Add `modifications BookingModification[]` relation to Booking model
   - Do NOT run migrations (no database available) -- just update schema.prisma and run `npx prisma generate`

4. SCH-02: Add changeFeeCents to Payment
   - Add `changeFeeCents Int @default(0)` to Payment model
   - Run `npx prisma generate`

5. FEE-01: Extract getRefundTier
   - Extract `getRefundTier(daysUntilCheckIn, policy)` from `src/lib/cancellation.ts`
   - Returns `{ refundPercentage, daysBeforeStay }` for the matching tier
   - Refactor `calculateRefundAmount` to use `getRefundTier` internally -- no behaviour change
   - Unit tests covering all tier boundaries (exact match, between tiers, empty policy)
   - See docs/requirements/02_BOOKINGS.md FEE-01

6. OBS-04: Structured logging with pino
   - Install pino. Create logger in `src/lib/logger.ts` with JSON output, configurable via LOG_LEVEL env var
   - Replace ALL ~85 `console.log`/`console.error`/`console.warn` calls in `src/lib/` and `src/app/api/` with logger calls
   - Cron job logs include `job` field
   - Sensitive data (passwords, tokens, keys) must NOT appear in log output
   - Add LOG_LEVEL to .env.example

7. OBS-06: Health endpoint
   - Create `GET /api/health` -- checks DB (SELECT 1), Stripe (key validation), Xero (connection status), SMTP
   - Returns `{ status: "healthy"|"degraded"|"unhealthy", version, uptime, checks: {...} }`
   - Each check has `{ status, latencyMs, error? }`, 3s timeout per check
   - No auth required. HTTP 200 for healthy/degraded, 503 for unhealthy
   - See docs/requirements/04c_OBSERVABILITY.md OBS-06

8. OBS-09: Cron job tracking
   - Add `CronJobRun` model to Prisma schema (jobName, startedAt, completedAt, durationMs, status, resultSummary, error)
   - Update `instrumentation.ts` to persist a CronJobRun record after each cron execution
   - Run `npx prisma generate`
   - See docs/requirements/04c_OBSERVABILITY.md OBS-09

9. OBS-13: Docker log rotation
   - Add `logging` config to all 3 services in docker-compose.yml: json-file driver, max-size 10m, max-file 5

Write tests for all business logic (FEE-01 tests, health endpoint tests, logger tests if meaningful).
Run `npm test` and `npm run build` to verify everything passes.
Commit after each major milestone (e.g., cancel consolidation, schema changes, logging, health endpoint).
When done, push all commits.
```

---

### 1b. Review & Test Prompt

```
Read CLAUDE.md and docs/DELIVERY_PLAN.md. Review Phase 1 (Foundational Infrastructure) code.

Verify:
1. CAN-01: Both cancel routes delegate to the shared service. Test by reading both route files and the shared function. Verify all cancellation paths are covered (PENDING, CONFIRMED no payment, CONFIRMED with refund, promo cleanup, audit, email).
2. CAN-02: CancelBookingButton uses path-based URL. Body-based route logs deprecation.
3. SCH-01/SCH-02: BookingModification model and Payment.changeFeeCents exist in schema.prisma with correct fields, indexes, and relations.
4. FEE-01: getRefundTier is exported, calculateRefundAmount uses it internally, tests cover all boundary cases.
5. OBS-04: No `console.log`/`console.error`/`console.warn` remain in `src/lib/` or `src/app/api/`. Logger does not log passwords, tokens, or API keys. Verify with grep.
6. OBS-06: Health endpoint returns correct structure. Does not expose sensitive details (connection strings, keys).
7. OBS-09: CronJobRun model in schema, instrumentation.ts persists records.
8. OBS-13: All docker-compose services have log rotation config.

Run `npm test` and `npm run build` -- both must pass.
Fix any issues found. Do NOT add features or refactor beyond what's needed.
Commit fixes and push.
```

---

### 1c. Merge Prompt

```
Merge the Phase 1 feature branch into main.

Steps:
1. Ensure all tests pass on the feature branch: `npm test && npm run build`
2. Switch to main: `git checkout main && git pull origin main`
3. Merge: `git merge <feature-branch> --no-ff -m "Merge Phase 1: Foundational Infrastructure"`
4. Run tests again on main: `npm test && npm run build`
5. Push main: `git push origin main`
6. If merge conflicts occur, resolve them preserving Phase 1 changes and existing main functionality. Run tests after resolution.
```

---

## Phase 2: Dashboard Hydration & Profile Quick Wins

### Security Review Required: YES

Touches member data exposure (B1 password change, B8 security section with passwordChangedAt, B9 subscription status). Also A10 exposes forcePasswordChange toggle which is an auth-adjacent feature. Review that password change flow validates current password, that subscription data doesn't leak across members, and that forcePasswordChange is admin-only.

---

### 2a. Build Prompt

```
Read CLAUDE.md, docs/DELIVERY_PLAN.md, and docs/requirements/01_ADMIN_AND_MEMBERS.md.
Build Phase 2 (Dashboard Hydration & Profile Quick Wins) autonomously.

Features to build:

1. A9/5a: Admin dashboard real data
   - Replace hardcoded `totalBookings: 0` in `/admin/dashboard` with real DB queries
   - Add cards: "Active Bookings" (CONFIRMED + PENDING count), "Revenue This Month" (sum of succeeded payments this month), "Upcoming Check-ins" (bookings with checkIn in next 7 days)
   - Add "Recent Bookings" list: last 5 bookings with status badges and links
   - Add "Members by Status": active vs inactive count
   - All data fetched server-side (RSC), no client fetch

2. B4/5b: Member dashboard real data
   - "Upcoming Bookings" card: count of CONFIRMED + PENDING where checkIn >= today for this member
   - "Next Stay" card: nearest upcoming booking checkIn date, or "No upcoming stays"
   - "Recent Bookings": last 5 bookings with dates, status badge, guest count, price, links to `/bookings/[id]`
   - "View all" link to `/bookings`
   - All server-side (RSC)

3. A7: Subscription status column in admin members table
   - New "Subscription" column showing PAID (green), UNPAID (yellow), OVERDUE (red), or "-"
   - API `GET /api/admin/members` joins MemberSubscription for current season year
   - Use existing `getSeasonYear()` to determine current season

4. A10: Force password change toggle
   - Add "Force Password Change" action in admin member actions (edit dialog or actions dropdown)
   - Sets `forcePasswordChange: true` on member record
   - Show badge/indicator on member row when forcePasswordChange is true
   - Audit log entry when set
   - Admin-only action

5. B1: Password change from profile page
   - Add "Change Password" section/card on profile page (`/profile`)
   - Form: current password, new password, confirm password
   - Client validation: min 12 chars, passwords match, new != current
   - Calls existing `POST /api/auth/change-password`
   - Toast on success, form clears

6. B8: Profile security section
   - Add "Security" card on profile page with link to change password
   - Add `passwordChangedAt DateTime?` field to Member model in schema.prisma
   - Set passwordChangedAt in register route and change-password route
   - Display "Password last changed: <date>" on profile security card
   - Run `npx prisma generate` after schema change

7. B7: Editable booking notes
   - Add inline-editable notes field on booking detail page `/bookings/[id]`
   - Create `PUT /api/bookings/[id]/notes` endpoint
   - Validates: max 500 chars, sanitised (strip HTML), owner or admin only
   - Works for CONFIRMED and PENDING bookings only

8. B9: Membership status on profile
   - Add "Membership Status" card on profile page
   - Shows current season year + status badge (PAID/UNPAID/OVERDUE)
   - "No subscription record -- contact the club" if none exists
   - Shows subscription history (last 3 seasons)
   - Read-only

Write tests for any new API endpoints (B7 notes endpoint).
Run `npm test` and `npm run build`.
Commit after each major milestone. Push when done.
```

---

### 2b. Review & Test Prompt

```
Read CLAUDE.md. Review Phase 2 (Dashboard Hydration & Profile Quick Wins) code.

Verify:
1. A9: Admin dashboard queries are correct (no N+1, correct status filters for counts). Revenue query sums only SUCCEEDED payments.
2. B4: Member dashboard only shows the logged-in member's bookings (no data leakage). Queries filter by memberId from session.
3. A7: Subscription join uses correct season year calculation. No N+1 queries.
4. A10: forcePasswordChange is admin-only. Cannot be set via member-facing endpoints. Audit log created.
5. B1: Change password form validates current password server-side (not just client-side). The existing API already does this -- verify it's called correctly.
6. B8: passwordChangedAt is set on registration and password change. Not exposed to other members.
7. B7: Notes endpoint checks booking ownership (memberId matches session user, or user is admin). HTML stripped/sanitised. 500 char limit enforced server-side.
8. B9: Subscription data scoped to the logged-in member only.

Security focus: ensure no member can see another member's data through any of these endpoints.

Run `npm test` and `npm run build`. Fix issues. Commit and push.
```

---

### 2c. Merge Prompt

```
Merge the Phase 2 feature branch into main.

Steps:
1. Ensure all tests pass on the feature branch: `npm test && npm run build`
2. Switch to main: `git checkout main && git pull origin main`
3. Merge: `git merge <feature-branch> --no-ff -m "Merge Phase 2: Dashboard Hydration & Profile Quick Wins"`
4. Run tests again on main: `npm test && npm run build`
5. Push main: `git push origin main`
6. If merge conflicts occur, resolve preserving both Phase 2 changes and existing main functionality.
```

---

## Phase 3: Admin Member Management

### Security Review Required: YES

Touches member data extensively: CSV export (A3) could leak PII, CSV import (A4) creates member accounts with passwords, bulk operations (A5/A6) modify auth roles, and member detail view (A8) exposes booking history and audit logs. Review that all endpoints are admin-only, CSV export doesn't include password hashes, import generates secure random passwords, and bulk role change prevents privilege escalation.

---

### 3a. Build Prompt

```
Read CLAUDE.md, docs/DELIVERY_PLAN.md, and docs/requirements/01_ADMIN_AND_MEMBERS.md.
Build Phase 3 (Admin Member Management) autonomously.

Internal dependency chain: A1 -> A2 -> A3, A1 -> A11, A5 -> A6. Build in order.

Features to build:

1. A1: Server-side pagination
   - Update `GET /api/admin/members` to accept `page` (default 1) and `pageSize` (default 25) query params
   - Return `{ members, total, page, pageSize, totalPages }`
   - Update admin members page with pagination controls (prev/next, page numbers)
   - Search resets to page 1 on new query
   - URL query params for bookmarkable views (use Next.js searchParams)

2. A11: Sortable table columns
   - API accepts `sortBy` (name, email, role, ageTier, active, createdAt) and `sortDir` (asc, desc) params
   - Default: name asc (lastName, firstName)
   - Column headers clickable with arrow indicators showing current sort
   - Sort preserved across pagination

3. A2: Advanced filtering
   - Filter dropdowns for: role (MEMBER/ADMIN), status (Active/Inactive), age tier (ADULT/YOUTH/CHILD), Xero linked (Yes/No), subscription status (PAID/UNPAID/OVERDUE/None)
   - Filters combine with text search (AND logic)
   - Active filters shown as removable chips/badges
   - "Clear all filters" button
   - API accepts filter params, applies server-side with Prisma where clauses
   - Filters preserved across pagination, reset page to 1 on filter change

4. A3: CSV export
   - "Export CSV" button on members page
   - Respects current search + filter state
   - Columns: firstName, lastName, email, phone, dateOfBirth, role, ageTier, active, xeroContactId, subscriptionStatus, createdAt
   - Downloads as `tac-members-YYYY-MM-DD.csv`
   - Handles commas and quotes in data correctly (RFC 4180)
   - Do NOT include passwordHash or any sensitive auth fields
   - Implement as API endpoint `GET /api/admin/members/export` that returns CSV with Content-Disposition header

5. A4: CSV import
   - "Import CSV" button opens upload dialog
   - Accepts CSV: firstName, lastName, email, phone, dateOfBirth, role (optional, defaults MEMBER)
   - Client-side file parsing (use papaparse or manual CSV parse)
   - Validates all rows: email format, required fields (firstName, lastName, email), no duplicate emails (within file + against DB)
   - Shows preview with valid/error counts and per-row errors
   - Creates members with `crypto.randomBytes(16).toString('hex')` placeholder passwords
   - Option checkboxes: "Send invite emails" and "Auto-link Xero contacts by email"
   - Creates `POST /api/admin/members/import` endpoint
   - Returns summary: created count, skipped, errors
   - Rate-limited

6. A5: Bulk deactivate/reactivate
   - Checkbox column in members table
   - "Select all on page" header checkbox
   - Bulk action toolbar when members selected (shows count)
   - "Deactivate Selected" and "Reactivate Selected" actions
   - Confirmation dialog with member count and names
   - Cannot deactivate the currently logged-in admin
   - Create `POST /api/admin/members/bulk-update` accepting `{ ids, action: "deactivate"|"reactivate"|"set-role", role? }`
   - Audit log entry per member
   - Success/error summary toast

7. A6: Bulk role change
   - "Change Role" option in bulk action toolbar
   - Role selector (MEMBER/ADMIN) in confirmation dialog
   - Cannot demote own admin account
   - Reuses the bulk-update API with `action: "set-role"` and `role` param
   - Audit log per change

8. A8: Member detail view
   - Create `/admin/members/[id]` page
   - Shows all member fields including subscription history (all seasons)
   - Booking history: list of bookings (dates, status, guest count, total) with links to `/admin/bookings` filtered by member
   - Summary stats: total bookings, total spend, last stay date
   - Audit log entries for this member (from AuditLog model)
   - "Edit" button to open edit dialog
   - "View in Xero" link if xeroContactId set (links to `https://go.xero.com/Contacts/View/<xeroContactId>`)
   - Create `GET /api/admin/members/[id]` endpoint returning full member data with bookings, subscriptions, audit logs

Write tests for:
- Pagination logic (page boundaries, total calculation)
- Filtering (each filter type, combinations)
- CSV export format (special characters, correct columns)
- CSV import validation (duplicate detection, required fields)
- Bulk update (deactivate, reactivate, role change, self-protection)
- Member detail endpoint (auth, data shape)

Run `npm test` and `npm run build`. Commit after each milestone. Push when done.
```

---

### 3b. Review & Test Prompt

```
Read CLAUDE.md. Review Phase 3 (Admin Member Management) code.

Verify:
1. A1: Pagination uses offset/limit in Prisma, not fetching all records. `total` count query is correct.
2. A11: Sort params validated (whitelist of allowed sort columns). No SQL injection via sort params.
3. A2: All filter params validated. Subscription filter joins MemberSubscription correctly.
4. A3: CSV export does NOT include passwordHash, any tokens, or session data. Only the listed columns. RFC 4180 compliant quoting. Export endpoint is admin-only (auth + role check).
5. A4: Import generates cryptographically random passwords (not predictable). Email validation is strict. Duplicate detection checks both within-file and against DB. Import endpoint is admin-only and rate-limited. Invite emails use the existing password reset flow (not plaintext passwords).
6. A5/A6: Bulk update endpoint is admin-only. Self-protection works (cannot deactivate/demote self). Audit log entries created for each member. Transaction wraps all updates.
7. A8: Member detail endpoint is admin-only. No member can access another member's detail page. Xero link URL is correctly formatted.
8. All new endpoints check auth() and role === "ADMIN".

Security focus: CSV export PII handling, import password generation, bulk operations privilege escalation prevention.

Run `npm test` and `npm run build`. Fix issues. Commit and push.
```

---

### 3c. Merge Prompt

```
Merge the Phase 3 feature branch into main.

Steps:
1. Ensure all tests pass on the feature branch: `npm test && npm run build`
2. Switch to main: `git checkout main && git pull origin main`
3. Merge: `git merge <feature-branch> --no-ff -m "Merge Phase 3: Admin Member Management"`
4. Run tests again on main: `npm test && npm run build`
5. Push main: `git push origin main`
6. If merge conflicts occur, resolve preserving both Phase 3 changes and existing main functionality.
```
