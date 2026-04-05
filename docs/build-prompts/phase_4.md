# Phase 4: Admin Operations & Tooling — Build Prompts

## Overview

**Features:** 1a-c (Subscription tracking), 2a-c (Payments list), 3a-c (Audit log viewer), 4a-b (Report export)
**Dependencies:** None
**Effort:** L
**Security review:** Not required — read-only admin pages with existing auth guards, no new payment/auth flows.

---

## 1. Build Prompt

```
Read CLAUDE.md. Build Phase 4: Admin Operations & Tooling.

This phase adds four admin tools — all read-only views over existing data. No schema migrations are needed (AuditLog and Payment models already exist). All pages must be admin-only (verify role === ADMIN).

### 1a-c: Subscription Tracking

- Create `GET /api/admin/subscriptions` — returns MemberSubscription records joined with Member (firstName, lastName, email). Accept query params: `seasonYear` (integer, defaults to current season year), `status` filter (PAID | UNPAID | OVERDUE | all), `page` and `pageSize` for pagination. Validate with Zod. Return `{ data, total, page, pageSize }`.
- Create `/admin/subscriptions` page:
  - Season year selector dropdown (current year ± 2 years, using April-March season year logic).
  - Summary cards: total members, paid count, unpaid count, overdue count for selected season.
  - Filterable table: member name, email, status (colour-coded badge), Xero invoice ID, paid date.
  - Pagination controls.
- Add "Subscriptions" entry to the admin sidebar nav (between Members and Bookings).

### 2a-c: Payments List

- Create `GET /api/admin/payments` — returns Payment records joined with Booking (checkIn, checkOut) and Member (name, email). Accept query params: `status` filter (PENDING | PROCESSING | SUCCEEDED | FAILED | REFUNDED | PARTIALLY_REFUNDED | all), `from` and `to` date range (on booking checkIn), `page`, `pageSize`. Validate with Zod. Return `{ data, total, page, pageSize, summary }` where summary = { totalRevenueCents, refundedCents, count }.
- Create `/admin/payments` page:
  - Summary cards: total revenue, total refunded, payment count, success rate.
  - Filterable table: date (booking checkIn), member name, amount, status badge, Stripe payment intent ID (truncated, copyable), Xero invoice ID, refund amount.
  - Date range picker and status filter.
  - Pagination controls.
- Add "Payments" entry to the admin sidebar nav (after Bookings).

### 3a-c: Audit Log Viewer

- Create `GET /api/admin/audit-log` — returns AuditLog records ordered by createdAt DESC. Accept query params: `action` filter, `actorId` filter, `from`/`to` date range, `page`, `pageSize`. Validate with Zod. Return `{ data, total, page, pageSize }`.
- Create `/admin/audit-log` page:
  - Filterable table: timestamp, actor (name or "System"), action, target type, target ID, IP address.
  - Expandable row detail showing full `details` JSON (formatted).
  - Action filter dropdown (populated from distinct actions in DB).
  - Date range picker.
  - Pagination controls.
- Add "Audit Log" entry to admin sidebar nav (at the bottom, before Xero).

### 4a-b: Report Export

- On the existing `/admin/reports` page, add two export buttons:
  - **CSV Export**: Client-side — take the currently displayed report data (summary + chart data), generate a CSV Blob, trigger download as `tac-report-YYYY-MM-DD.csv`. Include summary row + occupancy/revenue/booking data rows.
  - **PDF Export**: Use `window.print()` with a `@media print` stylesheet that hides the sidebar, nav, filters, and export buttons, sizes charts to fit A4, and adds a "TAC Bookings Report — {date range}" header.

### General requirements

- Use existing shadcn/ui components (Table, Card, Badge, Select, Button, Popover for date pickers).
- All API routes: check auth(), verify role === ADMIN, return 401/403 appropriately.
- All inputs validated with Zod.
- Follow existing code patterns — look at `/api/admin/reports/route.ts` and `/admin/reports/page.tsx` as the reference for admin page structure.
- Write tests for all new API routes (mock Prisma, verify auth checks, verify pagination math, verify filters).
- Do NOT modify the Prisma schema — all models needed already exist.
- Commit after each major milestone (subscriptions, payments, audit log, report export).
- When done, update CLAUDE.md build status with Phase 4 completion details. Push all commits.
```

---

## 2. Review & Test Prompt

```
Read CLAUDE.md. Review Phase 4 (Admin Operations & Tooling) code for:

1. **Auth & authorisation**: Every new API route must call auth() and check role === ADMIN. Verify 401 for unauthenticated, 403 for non-admin. Check that no data leaks in error responses.
2. **Input validation**: All query params validated with Zod. Verify no SQL injection via Prisma (should be safe, but confirm no raw queries). Test malformed inputs (negative page, invalid dates, missing params).
3. **Pagination correctness**: Verify `skip`/`take` math, total count accuracy, edge cases (page beyond total, pageSize=0).
4. **Data exposure**: Ensure no sensitive fields leak (password hashes, tokens, encryption keys). Verify Payment responses don't include full Stripe secret keys.
5. **Performance**: Check for N+1 queries (should use Prisma `include` not separate queries). Verify audit log query with large datasets won't timeout (needs index on createdAt — confirm it exists).
6. **CSV/PDF export**: Verify CSV handles commas/quotes in data (proper escaping). Verify print stylesheet hides interactive elements.
7. **Test coverage**: Every API route should have tests for auth (401/403), valid request, pagination, and filters.

Fix any issues found. Run `npm test` and `npm run build` to verify. Commit fixes and push.
```

---

## 3. Merge Prompt

```
Read CLAUDE.md. Merge the Phase 4 branch into main.

1. Run `npm test` and `npm run build` on the current branch to confirm green.
2. Switch to main: `git checkout main && git pull origin main`.
3. Merge: `git merge <phase-4-branch> --no-ff -m "Merge Phase 4: Admin Operations & Tooling"`.
4. Run `npm test` and `npm run build` again to confirm no merge regressions.
5. Push main: `git push origin main`.
6. If there are merge conflicts, resolve them preserving Phase 4 functionality, re-run tests, then push.
```

---

## Security Review

**Not required.** This phase is entirely read-only admin views over existing data. No new authentication flows, no payment processing, no user input that modifies state, no new external service integrations. Standard admin auth guards (already battle-tested across 20+ admin routes) are sufficient. The review prompt above covers the relevant security checks (auth, data exposure, input validation).
