# 04b — Ops Dashboard Requirements

**Date:** 2026-04-05
**Scope:** Operational tools for admin: subscription/payment tracking, audit log viewer, report export

---

## 1. Subscription Tracking UI

### 1a. Subscription Overview Page

- **Description:** New admin page at `/admin/subscriptions` showing all members' subscription statuses for the current (or selected) season year. Summary cards at top (total paid, unpaid, overdue counts). Table of members with subscription status, sortable and filterable.
- **Acceptance criteria:**
  - Page accessible at `/admin/subscriptions`, admin-only
  - Summary cards: total members, paid count, unpaid count, overdue count for selected season year
  - Season year selector (defaults to current season year per April–March logic)
  - Table columns: member name, email, age tier, subscription status, paid date, Xero invoice ID
  - Filter by status (ALL / PAID / UNPAID / OVERDUE)
  - Search by member name or email
  - Rows link to member detail (`/admin/members/[id]`)
  - Empty state when no subscriptions exist for selected season
- **Dependencies:** `MemberSubscription` model (exists), `Member` model (exists), admin layout (exists)
- **Complexity:** M

### 1b. Subscription Status API

- **Description:** New API endpoint `GET /api/admin/subscriptions` returning subscription data with filtering and season year selection. Joins Member + MemberSubscription.
- **Acceptance criteria:**
  - Query params: `seasonYear` (int), `status` (optional filter), `search` (optional text)
  - Returns member info + subscription status for each member
  - Members without a MemberSubscription row for the selected season show as UNPAID
  - Admin-only auth check
  - Zod-validated query params
- **Dependencies:** `MemberSubscription` model, `Member` model, auth helper
- **Complexity:** M

### 1c. Sidebar Navigation Entry

- **Description:** Add "Subscriptions" entry to admin sidebar between "Members" and "Seasons".
- **Acceptance criteria:**
  - New nav item with appropriate icon (e.g. `CreditCard` or `BadgeCheck` from lucide)
  - Active state highlights correctly
  - Renders on both desktop and mobile sidebar
- **Dependencies:** `src/components/admin-sidebar.tsx`
- **Complexity:** S

---

## 2. Payment Tracking UI

### 2a. Payments List Page

- **Description:** New admin page at `/admin/payments` showing all payment records across bookings. Provides a single view of all financial transactions (charges, refunds, failed payments) without needing to drill into individual bookings.
- **Acceptance criteria:**
  - Page accessible at `/admin/payments`, admin-only
  - Summary cards: total collected (succeeded), total refunded, total pending, failed count
  - Table columns: date, booking ID (linked), member name, amount, status, refund amount, Stripe PI ID, Xero invoice ID
  - Filter by payment status (ALL / PENDING / PROCESSING / SUCCEEDED / FAILED / REFUNDED / PARTIALLY_REFUNDED)
  - Date range filter
  - Search by member name, email, or Stripe PI ID
  - Sort by date (default desc), amount, status
  - Pagination (25 per page)
- **Dependencies:** `Payment` model (exists), `Booking` model (exists), `Member` model (exists)
- **Complexity:** L

### 2b. Payments API

- **Description:** New API endpoint `GET /api/admin/payments` returning paginated payment records with joins to booking and member.
- **Acceptance criteria:**
  - Query params: `status`, `from`, `to`, `search`, `page`, `pageSize`, `sortBy`, `sortOrder`
  - Returns payment fields + booking checkIn/checkOut + member name/email
  - Summary stats computed server-side (total collected, refunded, pending, failed count)
  - Admin-only auth check
  - Zod-validated query params
- **Dependencies:** `Payment` model, `Booking` model, `Member` model
- **Complexity:** M

### 2c. Sidebar Navigation Entry

- **Description:** Add "Payments" entry to admin sidebar after "Bookings".
- **Acceptance criteria:**
  - New nav item with `DollarSign` icon from lucide
  - Active state highlights correctly
- **Dependencies:** `src/components/admin-sidebar.tsx`
- **Complexity:** S

---

## 3. Audit Log Viewer

### 3a. Audit Log Page

- **Description:** New admin page at `/admin/audit-log` displaying the `AuditLog` table with filtering and search. Provides visibility into sensitive actions (booking cancellations, season changes, promo code changes, policy updates).
- **Acceptance criteria:**
  - Page accessible at `/admin/audit-log`, admin-only
  - Table columns: timestamp, action, actor (member name or "System"), target ID, details (expandable), IP address
  - Filter by action type (dropdown of distinct action values, e.g. `booking.cancel`, `season.create`, `promoCode.update`, etc.)
  - Date range filter
  - Search by actor name/email or target ID
  - Details column: truncated by default, click to expand full JSON
  - Pagination (50 per page)
  - Sort by timestamp desc (default)
  - Actor column resolves `memberId` to member name via join (graceful fallback if member deleted)
- **Dependencies:** `AuditLog` model (exists, no FK — memberId is plain string), `Member` model for name resolution
- **Complexity:** L

### 3b. Audit Log API

- **Description:** New API endpoint `GET /api/admin/audit-log` returning paginated audit log entries with optional actor name resolution.
- **Acceptance criteria:**
  - Query params: `action`, `from`, `to`, `search`, `page`, `pageSize`
  - Resolves `memberId` to member name where member still exists (left join or secondary lookup)
  - Returns entries sorted by `createdAt` desc
  - Admin-only auth check
  - Zod-validated query params
  - Returns list of distinct action values for filter dropdown
- **Dependencies:** `AuditLog` model, `Member` model
- **Complexity:** M

### 3c. Sidebar Navigation Entry

- **Description:** Add "Audit Log" entry to admin sidebar after "Reports".
- **Acceptance criteria:**
  - New nav item with `ScrollText` or `FileText` icon from lucide
  - Active state highlights correctly
- **Dependencies:** `src/components/admin-sidebar.tsx`
- **Complexity:** S

---

## 4. Report Export

### 4a. CSV Export Button on Reports Page

- **Description:** Add a "Download CSV" button to the existing reports page that exports the currently displayed data (summary + all chart datasets) as a CSV file. Client-side generation from already-fetched data.
- **Acceptance criteria:**
  - Button visible next to the date range controls
  - Exports a single CSV file with multiple sections separated by blank rows:
    - Section 1: Summary (Total Bookings, Revenue, Guests, Avg Occupancy, Member Guests, Non-Member Guests)
    - Section 2: Status Breakdown (Confirmed, Completed, Pending, Cancelled, Bumped)
    - Section 3: Occupancy by Date (date, occupied beds, available beds, occupancy rate %)
    - Section 4: Revenue by Month (month, revenue, booking count)
    - Section 5: Booking Trends by Week (week, total, confirmed, cancelled, bumped, pending)
  - Revenue values exported in dollars (not cents) with 2 decimal places
  - Filename: `tac-reports-{from}-to-{to}.csv`
  - Download triggers via browser Blob/URL.createObjectURL (no server round-trip)
  - Button disabled when no data is loaded
- **Dependencies:** Existing reports page (`src/app/(admin)/admin/reports/page.tsx`), existing `ReportData` interface
- **Complexity:** S

### 4b. PDF Export Button on Reports Page

- **Description:** Add a "Download PDF" button that generates a printable PDF of the reports dashboard using the browser's print-to-PDF capability with a print-optimized stylesheet.
- **Acceptance criteria:**
  - Button visible next to CSV export button
  - Triggers `window.print()` with print-specific CSS (`@media print`)
  - Print stylesheet: hides date picker / buttons, renders charts at fixed width, forces white background, page breaks between chart sections
  - Charts render at readable size in print (min 600px width)
  - Page title includes date range
- **Dependencies:** Existing reports page, recharts (renders to SVG, prints natively)
- **Complexity:** M

---

## 5. Admin Dashboard Hydration

### 5a. Fix Stubbed Admin Dashboard

- **Description:** The admin dashboard at `/admin/dashboard` currently has `totalBookings` hardcoded to `0`. Replace with real database queries to show live summary stats.
- **Acceptance criteria:**
  - Total members count (active only)
  - Active members count (with PAID subscription for current season)
  - Total bookings (all time, excludes CANCELLED/BUMPED)
  - Upcoming bookings (CONFIRMED with checkIn >= today)
  - Revenue this month (sum of finalPriceCents for CONFIRMED/COMPLETED bookings created this month)
  - Occupancy today (guests in confirmed bookings where today is between checkIn and checkOut)
  - All values fetched server-side (server component or API call)
  - No hardcoded values remain
- **Dependencies:** `src/app/(admin)/admin/dashboard/page.tsx` (exists, stubbed), Prisma models
- **Complexity:** M

### 5b. Fix Stubbed Member Dashboard

- **Description:** The member dashboard at `/dashboard` has hardcoded "Upcoming Bookings" count and static placeholder for "Recent Bookings". Replace with real queries.
- **Acceptance criteria:**
  - Upcoming bookings count (CONFIRMED/PENDING with checkIn >= today for current user)
  - Recent bookings list (last 5 bookings for current user, showing dates, status, guest count)
  - Each booking links to `/bookings/[id]`
  - No hardcoded values remain
- **Dependencies:** `src/app/(authenticated)/dashboard/page.tsx` (exists, stubbed), Prisma models
- **Complexity:** S

---

## Summary

| # | Feature | Complexity |
|---|---------|------------|
| 1a | Subscription overview page | M |
| 1b | Subscription status API | M |
| 1c | Sidebar entry (Subscriptions) | S |
| 2a | Payments list page | L |
| 2b | Payments API | M |
| 2c | Sidebar entry (Payments) | S |
| 3a | Audit log page | L |
| 3b | Audit log API | M |
| 3c | Sidebar entry (Audit Log) | S |
| 4a | CSV export on reports page | S |
| 4b | PDF export on reports page | M |
| 5a | Fix stubbed admin dashboard | M |
| 5b | Fix stubbed member dashboard | S |

**Total: 13 features** (4S, 6M, 2L, 0XL)
