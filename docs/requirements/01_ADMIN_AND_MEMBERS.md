# Requirements: Admin Member Management & Member Self-Service

**Date:** 2026-04-04
**Scope:** All features, changes, and improvements for admin member management and member self-service portals.

---

## A. Admin Member Management

### A1. Pagination for Members List

**Description:** The admin members API (`GET /api/admin/members`) fetches all members with no pagination. With ~410 members this works but won't scale, and the table renders all rows at once. Add server-side cursor or offset pagination.

**Acceptance Criteria:**
- API accepts `page` and `pageSize` query params (default pageSize=25)
- API returns `{ members, total, page, pageSize, totalPages }`
- Members table shows pagination controls (prev/next, page numbers)
- Search still works with pagination (resets to page 1 on new search)
- URL query params update to allow bookmarkable/shareable filtered views

**Dependencies:** None

**Complexity:** S

---

### A2. Advanced Filtering for Members List

**Description:** The members table only supports free-text search. Add structured filters for role, active status, age tier, Xero link status, and subscription status.

**Acceptance Criteria:**
- Filter dropdowns/toggles for: role (MEMBER/ADMIN), status (Active/Inactive), age tier (ADULT/YOUTH/CHILD), Xero linked (Yes/No), subscription status (PAID/UNPAID/OVERDUE/None)
- Filters combine with existing text search (AND logic)
- Active filters shown as removable chips/badges
- "Clear all filters" button
- API accepts filter params and applies them server-side
- Filters preserved across pagination

**Dependencies:** A1 (pagination)

**Complexity:** M

---

### A3. CSV Export of Members

**Description:** Admin can export the filtered member list as a CSV file for offline use, mail merges, or committee reports.

**Acceptance Criteria:**
- "Export CSV" button on members page
- Export respects current search and filter state
- CSV includes: firstName, lastName, email, phone, dateOfBirth, role, ageTier, active, xeroContactId, subscriptionStatus, createdAt
- File downloads as `tac-members-YYYY-MM-DD.csv`
- Handles special characters (commas, quotes) in member data correctly

**Dependencies:** A2 (filtering, so export matches what admin sees)

**Complexity:** S

---

### A4. CSV Import of Members

**Description:** Admin can bulk-create members by uploading a CSV file. This is needed for the initial migration from Checkfront/Xero and for onboarding batches of new members.

**Acceptance Criteria:**
- "Import CSV" button opens upload dialog
- Accepts CSV with columns: firstName, lastName, email, phone, dateOfBirth, role (optional, defaults MEMBER)
- Validates all rows before importing (email format, required fields, no duplicates against existing members or within file)
- Shows validation results: valid count, error count, error details per row
- Admin confirms import after reviewing validation results
- Creates members with random placeholder passwords (same as admin create)
- Option to send invite emails to all imported members
- Option to auto-link Xero contacts by email match
- Import results summary: created count, skipped count, errors
- Rate-limited to prevent abuse

**Dependencies:** None (reuses existing `POST /api/admin/members` logic)

**Complexity:** L

---

### A5. Bulk Deactivate/Reactivate Members

**Description:** Admin can select multiple members and deactivate or reactivate them in one action. Needed for annual membership renewals where unpaid members are bulk-deactivated.

**Acceptance Criteria:**
- Checkbox column in members table for row selection
- "Select all on page" checkbox in header
- Bulk action toolbar appears when members selected, showing count
- "Deactivate Selected" and "Reactivate Selected" bulk actions
- Confirmation dialog showing affected member count and names
- Cannot bulk-deactivate the currently logged-in admin
- API endpoint: `POST /api/admin/members/bulk-update` accepting `{ ids: string[], action: "deactivate" | "reactivate" }`
- Success/error summary after operation completes
- Audit log entries for each affected member

**Dependencies:** None

**Complexity:** M

---

### A6. Bulk Role Change

**Description:** Admin can change the role of multiple selected members at once (e.g., promote several members to ADMIN or demote to MEMBER).

**Acceptance Criteria:**
- "Change Role" option in bulk action toolbar
- Role selector dropdown (MEMBER/ADMIN) in confirmation dialog
- Cannot demote own account from ADMIN
- Audit log entries for each role change
- Reuses bulk-update API with `action: "set-role"` and `role` param

**Dependencies:** A5 (shares selection UI and bulk action infrastructure)

**Complexity:** S

---

### A7. Subscription Status in Members Table

**Description:** The members table shows Xero link status but not subscription/membership payment status. Admin needs to see at a glance who has paid for the current season.

**Acceptance Criteria:**
- New "Subscription" column in members table between "Xero" and "Joined"
- Shows badge: PAID (green), UNPAID (yellow), OVERDUE (red), or "-" if no subscription record
- Subscription status fetched for current season year
- API `GET /api/admin/members` includes `currentSubscriptionStatus` field by joining `MemberSubscription` for the current season year

**Dependencies:** None (MemberSubscription model already exists)

**Complexity:** S

---

### A8. Member Detail View with Booking History

**Description:** Clicking a member row or a "View" action opens a detail page/panel showing full member info plus their booking history. Currently the edit dialog only shows editable fields.

**Acceptance Criteria:**
- Member detail accessible via `/admin/members/[id]` page or slide-over panel
- Shows all member fields including subscription history
- Shows booking history: list of bookings (date, status, guests, total) with links to admin booking detail
- Shows total bookings, total spend, last stay date
- Shows audit log entries for this member
- "Edit" button opens edit dialog from this view
- "View in Xero" link if xeroContactId is set

**Dependencies:** None (API `GET /api/admin/members/[id]` already returns subscription data)

**Complexity:** M

---

### A9. Admin Dashboard — Real Data

**Description:** The admin dashboard (`/admin/dashboard`) shows a hardcoded `totalBookings: 0`. The member counts are real but no booking, revenue, or occupancy data is shown.

**Acceptance Criteria:**
- "Total Bookings" card shows actual count from DB (all-time)
- Add cards: "Active Bookings" (CONFIRMED + PENDING), "Revenue This Month" (sum of succeeded payments), "Upcoming Check-ins" (next 7 days)
- Add "Recent Bookings" list showing last 5 bookings with status badges and links
- Add "Members by Status" breakdown (active vs inactive count)
- All data fetched server-side (RSC) — no client-side fetching needed
- No caching needed at this scale (~410 members)

**Dependencies:** None

**Complexity:** M

---

### A10. Admin Force Password Reset for Member

**Description:** The "Reset PW" button on the members page sends a password reset email, but there's no way to force a member to change their password on next login without sending an email (e.g., after a security incident). The `forcePasswordChange` field exists in the schema but isn't exposed in admin UI.

**Acceptance Criteria:**
- New "Force Password Change" action in member edit dialog or actions menu
- Sets `forcePasswordChange: true` on the member record
- Member is redirected to `/change-password` on next login (existing flow in authenticated layout)
- Admin sees `forcePasswordChange` status as a badge/indicator on member row
- Can combine with sending a reset email, or do independently
- Audit log entry when force password change is set

**Dependencies:** None (`forcePasswordChange` field and redirect logic already exist)

**Complexity:** S

---

### A11. Sortable Members Table Columns

**Description:** The members table sorts by lastName/firstName only. Admin should be able to click column headers to sort by any column.

**Acceptance Criteria:**
- Clickable sort indicators on columns: Name, Email, Role, Age Tier, Status, Joined
- Sort direction toggles (asc/desc) on click
- Sort applied server-side via API params `sortBy` and `sortDir`
- Current sort state shown with arrow indicators on column header
- Default sort remains lastName asc

**Dependencies:** A1 (pagination, since sort params go to API)

**Complexity:** S

---

## B. Member Self-Service

### B1. Password Change from Profile Page

**Description:** A change password API and page exist (`/change-password`, `/api/auth/change-password`) but there is no link to it from the profile page. Members can only access it if `forcePasswordChange` is set or if they know the URL.

**Acceptance Criteria:**
- "Change Password" section/card on the profile page (`/profile`)
- Form with: current password, new password, confirm new password
- Client-side validation: min 12 chars, passwords match, new != current
- On success: toast notification, form clears
- Reuses existing `POST /api/auth/change-password` endpoint
- Alternative: link/button on profile page that navigates to existing `/change-password` page

**Dependencies:** None (API already exists)

**Complexity:** S

---

### B2. Email Change with Verification

**Description:** Members cannot change their email address. The profile form only allows name/phone/DOB edits. Email is shown as read-only in the account info card. Members should be able to request an email change, with verification of the new address before it takes effect.

**Acceptance Criteria:**
- "Change Email" button/section on profile page
- Opens form to enter new email address and current password (for security)
- Server validates: email format, not already taken, password correct
- Sends verification email to the NEW address with a time-limited token (1 hour)
- Member clicks verification link to confirm the change
- On confirmation: email updated in DB, old email notified of the change, JWT session updated
- If token expires without confirmation, no change occurs
- Xero contact updated if connected
- Audit log entry for email change

**New schema required:**
- `EmailChangeToken` model: id, memberId, newEmail, token (unique), expiresAt, used, createdAt

**New API routes:**
- `POST /api/profile/change-email` — request email change (validates, sends verification)
- `GET /api/auth/verify-email-change?token=xxx` — confirm email change

**Dependencies:** None

**Complexity:** L

---

### B3. Email Verification on Registration

**Description:** Registration creates an active member immediately with no email verification. Any email address can be used, including typos or others' addresses. New members should verify their email before they can book.

**Acceptance Criteria:**
- Registration creates member with `emailVerified: false`
- Verification email sent with time-limited token (24 hours)
- Member can log in but sees a banner "Please verify your email" and cannot create bookings
- Resend verification email button (rate-limited)
- Clicking verification link sets `emailVerified: true`
- Admin-created members are auto-verified (admin vouches for them)
- Existing members (pre-feature) are grandfathered as verified
- Booking creation API checks `emailVerified` and rejects if false

**New schema required:**
- Add `emailVerified Boolean @default(false)` to Member model
- `EmailVerificationToken` model: id, memberId, token (unique), expiresAt, createdAt
- Migration to set `emailVerified = true` for all existing members

**New API routes:**
- `POST /api/auth/resend-verification` — resend verification email
- `GET /api/auth/verify-email?token=xxx` — verify email address

**Dependencies:** None

**Complexity:** L

---

### B4. Member Dashboard — Real Data

**Description:** The member dashboard (`/dashboard`) shows hardcoded placeholder data. All three cards and the recent bookings section need to query real data.

**Acceptance Criteria:**
- "Upcoming Bookings" card shows count of CONFIRMED + PENDING bookings where checkIn >= today
- "Next Stay" card shows check-in date and lodge name for the nearest upcoming booking, or "No upcoming stays" if none
- "Recent Bookings" section shows the member's last 5 bookings with: dates, status badge, guest count, total price
- Each recent booking links to `/bookings/[id]`
- "View all" link goes to `/bookings`
- All data fetched server-side (RSC)

**Dependencies:** None

**Complexity:** S

---

### B5. Booking Modification — Change Dates

**Description:** Members currently cannot modify a booking's dates. The only option is to cancel and rebook, which may lose availability, promo codes, or incur cancellation fees. Members should be able to change check-in/check-out dates on CONFIRMED or PENDING bookings.

**Acceptance Criteria:**
- "Modify Booking" button on booking detail page (visible for CONFIRMED and PENDING bookings)
- Opens date modification interface with availability calendar
- System checks availability for new dates (excluding current booking's beds from capacity count)
- Recalculates price for all guests across new dates using current season rates
- Shows price difference: additional charge or refund amount
- If price increases: collects additional payment (new PaymentIntent for the difference)
- If price decreases: processes partial refund via Stripe
- Updates Xero invoice (void + recreate, or credit note + new invoice)
- Promo code re-validated for new dates; if no longer valid, discount removed and member notified
- Booking `updatedAt` timestamp updated
- Confirmation email sent with updated details
- Audit log entry with old and new dates
- Cannot modify to dates that have already passed
- Cannot modify a booking whose check-in date has passed (stay already started)

**Constraints:**
- Date changes on PENDING bookings recalculate `nonMemberHoldUntil`
- If new dates make the booking all-member (no non-member guests), promote from PENDING to CONFIRMED
- Advisory lock during modification to prevent concurrent booking conflicts

**New API route:**
- `PUT /api/bookings/[id]/modify-dates` — validate availability, recalculate price, process payment/refund

**Dependencies:** B2 is independent; this depends on existing pricing engine, Stripe, and Xero integration

**Complexity:** XL

---

### B6. Booking Modification — Add/Remove Guests

**Description:** Members cannot change the guest list after booking. They should be able to add or remove guests from CONFIRMED or PENDING bookings without cancelling.

**Acceptance Criteria:**
- "Edit Guests" section/button on booking detail page
- Can add new guests (name, age tier, member/non-member) up to available capacity
- Can remove guests (minimum 1 guest must remain — the booking member)
- Recalculates price when guests change
- Price difference handled same as date modification (additional charge or refund)
- Updates Xero invoice
- Promo code re-validated (some codes may be members-only; adding non-member guest could invalidate)
- If removing all non-member guests from a PENDING booking, promote to CONFIRMED
- If adding non-member guests to a CONFIRMED booking with check-in > 7 days, may need to transition to PENDING
- Chore assignments for removed guests are deleted
- Confirmation email with updated guest list and price
- Audit log entry with guest changes
- Cannot reduce below capacity that would make the booking invalid

**New API route:**
- `PUT /api/bookings/[id]/modify-guests` — validate capacity, recalculate price, process payment/refund

**Dependencies:** B5 (shares price recalculation and payment adjustment logic)

**Complexity:** XL

---

### B7. Booking Modification — Update Notes

**Description:** Members cannot edit the notes field on a booking after creation. This is a simple text update with no financial implications.

**Acceptance Criteria:**
- Editable notes field on booking detail page (inline edit or modal)
- Save triggers `PUT /api/bookings/[id]/notes` with new notes text
- Notes field validated: max 500 characters, sanitised (no HTML)
- Only the booking owner or admin can edit notes
- No email notification needed for notes changes
- Works for CONFIRMED and PENDING bookings only

**New API route:**
- `PUT /api/bookings/[id]/notes`

**Dependencies:** None

**Complexity:** S

---

### B8. Profile Page — Link to Change Password

**Description:** Even if B1 adds a full inline form, the existing `/change-password` page should be discoverable from the profile page at minimum.

**Acceptance Criteria:**
- Profile page includes a "Security" card/section
- Contains a "Change Password" link/button pointing to `/change-password` or inline form (per B1)
- Shows when password was last changed (requires tracking `passwordChangedAt`)

**New schema (optional enhancement):**
- Add `passwordChangedAt DateTime?` to Member model
- Set on registration and password change

**Dependencies:** B1

**Complexity:** S

---

### B9. Member Profile — View Subscription Status

**Description:** Members have no visibility into their subscription/membership payment status. This data exists in `MemberSubscription` (sourced from Xero) but is not exposed in the member portal.

**Acceptance Criteria:**
- Profile page shows "Membership Status" card
- Displays current season year and status: PAID (green badge), UNPAID (yellow), OVERDUE (red)
- If no subscription record exists, shows "No subscription record — contact the club"
- Shows subscription history (last 3 seasons)
- Read-only (members cannot change subscription status)

**Dependencies:** None (MemberSubscription model and data already exist)

**Complexity:** S

---

## Summary Table

| ID | Feature | Complexity | Dependencies |
|----|---------|-----------|-------------|
| A1 | Pagination for Members List | S | None |
| A2 | Advanced Filtering for Members List | M | A1 |
| A3 | CSV Export of Members | S | A2 |
| A4 | CSV Import of Members | L | None |
| A5 | Bulk Deactivate/Reactivate Members | M | None |
| A6 | Bulk Role Change | S | A5 |
| A7 | Subscription Status in Members Table | S | None |
| A8 | Member Detail View with Booking History | M | None |
| A9 | Admin Dashboard — Real Data | M | None |
| A10 | Admin Force Password Reset for Member | S | None |
| A11 | Sortable Members Table Columns | S | A1 |
| B1 | Password Change from Profile Page | S | None |
| B2 | Email Change with Verification | L | None |
| B3 | Email Verification on Registration | L | None |
| B4 | Member Dashboard — Real Data | S | None |
| B5 | Booking Modification — Change Dates | XL | None |
| B6 | Booking Modification — Add/Remove Guests | XL | B5 |
| B7 | Booking Modification — Update Notes | S | None |
| B8 | Profile Page — Security Section | S | B1 |
| B9 | Member Profile — View Subscription Status | S | None |
