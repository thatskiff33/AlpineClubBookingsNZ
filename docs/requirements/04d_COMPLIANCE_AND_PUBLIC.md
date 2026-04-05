# 04d: Compliance & Public Pages

## Privacy Compliance

### F-COMP-01: Privacy Policy Page

**Description:** Public page displaying TAC's privacy policy covering data collection, use, storage, and member rights under NZ Privacy Act 2020.

**Acceptance Criteria:**
- Accessible at `/privacy` without authentication
- Covers: what data is collected, why, how it's stored, who it's shared with (Stripe, Xero, AWS SES), retention periods, member rights
- References NZ Privacy Act 2020 and the 13 Information Privacy Principles
- Includes contact details for the club privacy officer
- Linked from site footer on all pages
- Linked from registration page before account creation

**Dependencies:** None

**Complexity:** S

---

### F-COMP-02: Terms of Service Page

**Description:** Public page displaying TAC's terms of service covering booking rules, payment terms, cancellation policy summary, liability, and acceptable use.

**Acceptance Criteria:**
- Accessible at `/terms` without authentication
- Covers: eligibility, booking rules, payment and refund terms, member conduct, liability limitations, account termination
- References the cancellation policy (links to relevant section or summarises tiers)
- Includes effective date and last-updated date
- Linked from site footer on all pages
- Linked from registration page; registration requires implicit acceptance (checkbox or "by registering you agree" text)

**Dependencies:** None

**Complexity:** S

---

### F-COMP-03: Personal Data Export

**Description:** Members can download a machine-readable export of all personal data the system holds about them.

**Acceptance Criteria:**
- Available from the member profile page via a "Download My Data" button
- Export is JSON format
- Includes: profile info (name, email, phone, DOB), all bookings (with guests, payments, promo redemptions), chore assignments, subscription status, audit log entries where they are the actor or target
- Excludes: password hash, internal IDs not meaningful to the user, other members' data
- File is generated on-demand and downloaded directly (no email)
- Rate limited to prevent abuse (max 5 exports per day)
- Response includes `Content-Disposition: attachment` header with filename `tac-my-data-YYYY-MM-DD.json`

**Dependencies:** Profile page (Phase 1), Bookings (Phase 3), Payments (Phase 4), Chore assignments (Phase 8)

**Complexity:** M

---

### F-COMP-04: Account Deletion Workflow

**Description:** Members can request account deletion; admin reviews and approves; personal data is purged or anonymised.

**Acceptance Criteria:**
- Member clicks "Request Account Deletion" on their profile page
- Member must confirm with a modal/dialog explaining consequences (bookings cancelled, data purged, action irreversible)
- Request is recorded in the database with status PENDING, timestamp, and reason (optional free-text)
- Admin sees pending deletion requests on a dedicated admin page (`/admin/deletion-requests`)
- Admin can approve or reject each request with an optional note
- On approval:
  - All future bookings for the member are cancelled (with refunds per cancellation policy)
  - Member profile fields are anonymised (name -> "Deleted Member", email -> random@deleted.invalid, phone/DOB cleared)
  - Password hash is cleared, account is deactivated (cannot log in)
  - Booking history is retained with anonymised member reference (for financial/audit integrity)
  - Payments and Xero invoice references are retained (legal/tax requirement)
  - Chore assignments are retained with anonymised guest names
  - Audit log entry is created recording the deletion
  - Member receives a confirmation email before anonymisation that their request was processed
- On rejection: member is notified by email with the admin's note
- Members with ADMIN role cannot request self-deletion (must be removed by another admin)

**Dependencies:** Profile page (Phase 1), Booking cancellation (Phase 4/5), Email (Phase 1), Admin layout (Phase 1), Audit log (Security Audit)

**Complexity:** XL

---

## Public Pages

### F-PUB-01: Committee Page Content

**Description:** Replace placeholder content on the committee page with actual committee member information.

**Acceptance Criteria:**
- Displays committee roles and member names (President, Vice President, Treasurer, Secretary, Hut Convenor, and any other roles)
- Each entry shows: role title, name, and optional contact email
- Content is admin-editable or stored in a config/data file (not hardcoded in JSX) so committee changes don't require a code deploy
- Falls back gracefully if no committee data is configured (shows "Committee information coming soon" rather than broken layout)
- Page is publicly accessible without authentication

**Dependencies:** None

**Complexity:** M

---

### F-PUB-02: Join Page with Fee Information

**Description:** Replace placeholder content on the join/membership page with actual membership categories, fees, benefits, and a clear call-to-action.

**Acceptance Criteria:**
- Displays all membership categories with annual fees: Adult, Youth, Child (and Family if applicable)
- Fee amounts are pulled from a config/data source (not hardcoded) so they can be updated without code changes
- Describes benefits of membership (priority booking, member rates, lodge access, etc.)
- Includes a clear "Register" or "Join Now" CTA linking to the registration page
- Explains the membership year (April-March cycle)
- Mentions how payment works (Xero invoice / payment instructions)
- Page is publicly accessible without authentication

**Dependencies:** Registration page (Phase 1)

**Complexity:** M

---

### F-PUB-03: Contact Page Content

**Description:** Replace placeholder content on the contact page with actual club contact information.

**Acceptance Criteria:**
- Displays: club mailing address, general enquiry email, phone number (if applicable)
- Includes a simple contact form (name, email, message) that sends an email to the club's configured address
- Contact form has validation (required fields, valid email format) and rate limiting (max 10 submissions per IP per hour)
- Shows a success message after submission
- Optionally includes lodge location/directions (address, map link, or embedded map)
- Page is publicly accessible without authentication

**Dependencies:** Email utility (Phase 1)

**Complexity:** M

---

### F-PUB-04: FAQ Page

**Description:** New public page with frequently asked questions about the lodge, bookings, membership, and general club info.

**Acceptance Criteria:**
- Accessible at `/faq` without authentication
- Accordion/collapsible UI for question-answer pairs
- Covers at minimum:
  - How do I book a stay?
  - What is the cancellation policy?
  - What are the nightly rates?
  - Do I need to be a member to stay?
  - What is the non-member priority/bumping system?
  - What facilities does the lodge have?
  - What should I bring?
  - How do chore rosters work?
  - How do I become a member?
  - How do I reset my password?
- FAQ content is stored in a config/data file (not hardcoded in JSX) for easy updates
- Linked from site footer and navigation
- Linked from relevant pages contextually (e.g., booking page links to "cancellation policy" FAQ)

**Dependencies:** None

**Complexity:** M

---

## Summary

| ID | Feature | Complexity |
|----|---------|------------|
| F-COMP-01 | Privacy Policy Page | S |
| F-COMP-02 | Terms of Service Page | S |
| F-COMP-03 | Personal Data Export | M |
| F-COMP-04 | Account Deletion Workflow | XL |
| F-PUB-01 | Committee Page Content | M |
| F-PUB-02 | Join Page with Fee Information | M |
| F-PUB-03 | Contact Page Content | M |
| F-PUB-04 | FAQ Page | M |

**Total: 2S + 5M + 1XL**
