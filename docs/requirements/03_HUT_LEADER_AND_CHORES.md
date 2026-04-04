# 03 -- Hut Leader Tools, Lodge Kiosk, and Chore System

**Date:** 2026-04-04
**Status:** Draft

---

## Feature 1: LODGE Role and Lodge Account

**Description**

Add `LODGE` to the Prisma `Role` enum. Create a dedicated member account (`lodge@tokoroa.org.nz`) with role `LODGE` for use on a shared iPad in the lodge public area. The LODGE role grants access to lodge-specific pages (kiosk, hut leader tools) but not to the admin panel or member booking features.

**Schema Changes**

- `Role` enum: `MEMBER | ADMIN | LODGE`
- Seed lodge account in `prisma/seed.ts` with `forcePasswordChange: true`

**Auth Changes**

- Update session type in `src/lib/auth.ts` and `src/types/next-auth.d.ts` to include `"LODGE"` in the role union
- JWT expiry for LODGE role: extend to 30 days (or indefinite) instead of the standard 8-hour expiry. The iPad stays logged in permanently.
- Admin layout (`src/app/(admin)/layout.tsx`) already rejects non-ADMIN -- no change needed
- Authenticated layout (`src/app/(authenticated)/layout.tsx`) should redirect LODGE users to `/lodge/kiosk`

**Acceptance Criteria**

- [ ] `LODGE` role exists in Prisma schema and can be assigned to a member
- [ ] `lodge@tokoroa.org.nz` account is created by seed script
- [ ] Logging in as lodge account produces a session with `role: "LODGE"`
- [ ] Lodge account cannot access `/admin/*` pages
- [ ] Lodge account cannot access member-only `/dashboard`, `/book`, `/bookings` pages
- [ ] Lodge account can access `/lodge/*` routes

**Dependencies:** None (foundational)

**Complexity:** S

---

## Feature 2: iPad Kiosk Page

**Description**

Full-screen, touch-optimised page at `/lodge/kiosk`. Displayed on an iPad in the lodge public area, logged in as the lodge account. Shows two panels: (a) lodge list -- who is staying tonight with arriving/departing indicators, and (b) the day's chore roster with tick-off capability. Guests walk up and tap to mark chores done without individual login.

**UI Changes**

- New route group `(lodge)` under `src/app/` with layout requiring `role === "LODGE"` or `role === "ADMIN"` or active hut leader (Feature 8)
- Minimal chrome: no sidebar, no nav bar, large touch targets, optimised for 10.9" iPad
- `/lodge/kiosk` page:
  - Current date prominently displayed; date navigation
  - **Lodge List panel:** All confirmed guests staying that night (bookings where `checkIn <= date < checkOut`), grouped by booking. Each guest shows name, age tier, arriving badge (checkIn === date), departing badge (checkOut === date + 1 day)
  - **Chore Roster panel:** Confirmed chore assignments grouped by chore, with large tap target to toggle CONFIRMED <-> COMPLETED
  - Auto-refresh every 60 seconds or pull-to-refresh
  - "Set Up Today's Roster" button when no confirmed roster exists (links to Feature 6 wizard)

**API Changes**

- `GET /api/lodge/guests/[date]` -- lodge list for the date (LODGE/ADMIN/hut-leader auth)
- `GET /api/lodge/roster/[date]` -- roster data without auto-suggest (LODGE/ADMIN/hut-leader auth)
- `PUT /api/lodge/roster/[date]` -- limited actions: `complete` and `uncomplete` only

**Acceptance Criteria**

- [ ] Kiosk loads when logged in as lodge account
- [ ] Denied to unauthenticated users and MEMBER-role users (unless hut leader)
- [ ] Lodge list shows all guests for selected date with correct arriving/departing indicators
- [ ] Guests visually grouped by booking (family group)
- [ ] Tapping a chore assignment toggles CONFIRMED <-> COMPLETED
- [ ] No additional auth required to mark chores done
- [ ] Usable on 10.9" iPad (large fonts, large tap targets, minimal scrolling)
- [ ] Auto-refreshes periodically

**Dependencies:** Feature 1

**Complexity:** L

---

## Feature 3: Time-of-Day for Chore Templates

**Description**

Add `timeOfDay` field to `ChoreTemplate` classifying each chore as MORNING, EVENING, or ANYTIME. Admin-configurable. Used by the allocator, kiosk display, and print view to group chores.

**Schema Changes**

- New enum `ChoreTimeOfDay`: `MORNING | EVENING | ANYTIME`
- New field `ChoreTemplate.timeOfDay ChoreTimeOfDay @default(ANYTIME)`
- Migration sets defaults for the 17 seeded chores:
  - MORNING: Breakfast, Fridge, Breakfast dishes, Dining room floor, Oven/microwave/hob, Tea towels (sortOrder 1-6)
  - EVENING: Dinner, Pre-dinner dishes, Dinner dishes (sortOrder 9-11)
  - ANYTIME: Firewood, Rubbish, Bathrooms x2, Ski room, Lounge, Bunkrooms, Stores (sortOrder 7-8, 12-17)
- Update `prisma/seed.ts` to include `timeOfDay` per chore

**UI Changes**

- Admin chore template form: add `timeOfDay` dropdown
- Admin roster page and print view: group chores under Morning / Evening / Anytime headings
- Kiosk page: group chores by time of day

**API Changes**

- Update `GET/POST /api/admin/chores` and `PUT/DELETE /api/admin/chores/[id]` to include `timeOfDay`

**Allocator Changes**

- Add `timeOfDay` to `ChoreTemplateInput` interface in `src/lib/chore-allocator.ts`
- No filtering by time-of-day yet (that's Feature 7), but field must flow through

**Acceptance Criteria**

- [ ] Each chore template has a `timeOfDay` field defaulting to ANYTIME
- [ ] Admins can set time of day when creating/editing a chore template
- [ ] Roster page and print view group chores under Morning / Evening / Anytime headings
- [ ] Existing 17 chores receive correct default values via migration

**Dependencies:** None

**Complexity:** M

---

## Feature 4: Chore Frequency Settings

**Description**

Allow admins to configure how often a chore should be rostered. Two modes: (a) minimum every X days, or (b) on specific days of the week. The allocator consults the chore's last rostered date to decide whether to include it.

**Schema Changes**

- New enum `ChoreFrequencyMode`: `DAILY | EVERY_X_DAYS | SPECIFIC_DAYS`
- New fields on `ChoreTemplate`:
  - `frequencyMode ChoreFrequencyMode @default(DAILY)`
  - `frequencyDays Int?` -- interval for EVERY_X_DAYS (e.g. 3 = every 3 days)
  - `frequencyDaysOfWeek Int[]` -- ISO day numbers for SPECIFIC_DAYS (1=Mon, 7=Sun). Postgres native int array.

**UI Changes**

- Admin chore template form:
  - Radio/select for frequency mode (Daily / Every X Days / Specific Days)
  - Conditional number input for interval days
  - Conditional day-of-week checkboxes

**Allocator Changes**

- Add `frequencyMode`, `frequencyDays`, `frequencyDaysOfWeek` to `ChoreTemplateInput`
- New exported function `filterChoresByFrequency(chores, choreLastRosteredDates: Map<string, Date>, currentDate: Date)` returns only chores that are "due":
  - `DAILY`: always included
  - `EVERY_X_DAYS`: included only if last rostered >= X days ago (or never rostered)
  - `SPECIFIC_DAYS`: included only if current date's day-of-week is in the array
- Called before `selectChoresForOccupancy` in the pipeline
- Accepts `choreLastRosteredDates` parameter (may need lookback beyond 4 days for large intervals)

**API Changes**

- Roster GET endpoint must query most recent assignment date per chore template and pass to allocator
- Update chore template CRUD endpoints to handle new fields

**Acceptance Criteria**

- [ ] Admins can set a chore to Daily, Every X Days, or Specific Days
- [ ] A chore set to "every 3 days" is excluded from auto-suggest if rostered within last 2 days
- [ ] A chore set to "Sunday and Thursday" only appears on those days
- [ ] Daily chores behave identically to current behavior
- [ ] Hut leader wizard (Feature 6) can manually override frequency exclusions
- [ ] Essential daily chores are always included (backward compatible)

**Dependencies:** None (integrates with Feature 6 and 11)

**Complexity:** L

---

## Feature 5: Family Group Allocation

**Description**

The allocator prefers to group guests from the same booking (family group) onto the same chore. For chores needing 2+ people, after picking the first guest, prefer remaining guests from the same `bookingId` (if eligible).

**Schema Changes:** None. `bookingId` already exists on `GuestInput`.

**Allocator Changes**

- In `allocateChores()`, after sorting eligible guests by assignment count and history, add family-grouping tie-breaker:
  - Among guests with equal assignment count and equal history, prefer same-booking guests as the first picked guest
- For MIXED_PREFERRED: prefer adult+child from the same booking
- For ADULT_SUPERVISED: prefer supervising adult from the same booking as assigned children
- Family preference is secondary to round-robin fairness (don't overload one family)

**Acceptance Criteria**

- [ ] When a chore needs 2 people and a family of 4 is staying, both assigned come from same family (all else equal)
- [ ] Family grouping does not override round-robin fairness
- [ ] Family grouping does not override age restrictions
- [ ] For MIXED_PREFERRED, prefers adult+child from same booking
- [ ] Single-person chores are unaffected
- [ ] Allocator remains a pure function with no database calls

**Dependencies:** None

**Complexity:** M

---

## Feature 6: Hut Leader Wizard / Stepped Flow

**Description**

Multi-step wizard at `/lodge/roster/[date]/setup` where the hut leader reviews guests, selects chores, reviews/tweaks the generated roster, and confirms. Replaces the auto-suggest-on-load behaviour for the hut leader workflow.

**UI Changes**

- New page accessible by LODGE, ADMIN, or active hut leader
- **Step 1 -- Review Guests:** Shows who is staying with arriving/departing indicators. Read-only confirmation.
- **Step 2 -- Select Chores:** All active chore templates grouped by time of day. Pre-checks based on frequency rules and occupancy. Hut leader checks/unchecks any chore. Chores excluded by frequency shown unchecked with explanation (e.g. "Last done 1 day ago, next due in 2 days"). Essential daily chores pre-checked and highlighted.
- **Step 3 -- Review Roster:** Generated allocation shown in full. Manual reassignment via dropdown (per existing admin roster UI). "Regenerate" button re-runs allocator with same chore selections.
- **Step 4 -- Confirm:** Sets all assignments to CONFIRMED, returns to kiosk view.

**API Changes**

- `POST /api/lodge/roster/[date]/generate` -- accepts selected `choreTemplateId[]`, returns allocation without saving
- `POST /api/lodge/roster/[date]/confirm` -- saves final roster, sets status to CONFIRMED
- `PUT /api/lodge/roster/[date]/reassign` -- manual guest swaps during step 3

**Acceptance Criteria**

- [ ] Wizard accessible from kiosk via "Set Up Today's Roster" button (shown when no confirmed roster exists)
- [ ] Step 1 shows all guests with arriving/departing status
- [ ] Step 2 shows all active chores with frequency-based pre-selection
- [ ] Step 2 allows hut leader to override any selection
- [ ] Step 3 shows generated roster with manual reassignment
- [ ] Step 4 confirms roster and navigates to kiosk
- [ ] Already-confirmed roster cannot be overwritten without explicit acknowledgment
- [ ] Touch-optimised for iPad

**Dependencies:** Features 1, 2, 3, 4

**Complexity:** XL

---

## Feature 7: Arriving/Departing Guest Routing

**Description**

The allocator considers whether each guest is arriving or departing on the roster date:
- **Arriving** (checkIn === roster date): only EVENING or ANYTIME chores
- **Departing** (checkOut === roster date + 1 day): only MORNING or ANYTIME chores
- **Staying through**: any time-of-day chore

**Schema Changes:** None. Determined at allocation time from booking `checkIn`/`checkOut`.

**Allocator Changes**

- Extend `GuestInput` with `isArriving: boolean` and `isDeparting: boolean`
- New eligibility filter (applied before age check):
  - Arriving + MORNING chore = ineligible
  - Departing + EVENING chore = ineligible
  - All other combinations = eligible

**API Changes**

- Roster endpoints must compute and pass `isArriving`/`isDeparting` flags per guest. The booking data is already loaded.

**Acceptance Criteria**

- [ ] Arriving guest is never assigned to a MORNING chore
- [ ] Departing guest is never assigned to an EVENING chore
- [ ] Staying-through guest can be assigned to any chore
- [ ] If all guests are arriving, MORNING chores go unassigned (with warning in wizard)
- [ ] Wizard and kiosk show arriving/departing badges next to guest names

**Dependencies:** Feature 3

**Complexity:** M

---

## Feature 8: Hut Leader Role Assignment

**Description**

Admin can designate any member as "hut leader" for a date range. The member uses their own credentials and gains access to lodge tools for their assigned dates. Date-scoped elevation, not a permanent role change.

**Schema Changes**

- New model `HutLeaderAssignment`:
  - `id String @id @default(cuid())`
  - `memberId String` (FK -> Member)
  - `startDate DateTime @db.Date`
  - `endDate DateTime @db.Date`
  - `createdAt DateTime @default(now())`
  - `updatedAt DateTime @updatedAt`
  - Index on `[memberId]` and `[startDate, endDate]`
- Add `hutLeaderAssignments HutLeaderAssignment[]` relation on Member

**Auth Changes**

- Helper function `isHutLeader(memberId: string, date: Date): Promise<boolean>` in `src/lib/hut-leader.ts`
- Lodge layout and lodge API endpoints accept LODGE, ADMIN, or MEMBER with active hut leader assignment

**UI Changes**

- Admin page `/admin/hut-leaders`: list assignments, create (member picker + date range), edit, delete
- Member nav bar shows "Hut Leader" link when member has active assignment
- Member dashboard shows hut leader callout card when active

**API Changes**

- `GET/POST /api/admin/hut-leaders` -- list and create
- `PUT/DELETE /api/admin/hut-leaders/[id]` -- update and delete
- Lodge API endpoints (`/api/lodge/*`) check hut leader status in addition to role

**Acceptance Criteria**

- [ ] Admin can assign any member as hut leader for a date range
- [ ] Assigned member can access kiosk and wizard for dates within their range
- [ ] Member cannot access lodge tools for dates outside their assignment
- [ ] Assignment does not change the member's `role` field
- [ ] Multiple members can be hut leader for overlapping dates
- [ ] Admin can view, edit, and delete assignments

**Dependencies:** Features 1, 2, 6

**Complexity:** L

---

## Feature 9: Guest Arrival/Departure and Chore Tick-Off Without Login

**Description**

On the kiosk, any person can mark chores complete and mark guests as arrived/departed. No individual authentication -- relies on physical presence and social trust. The lodge account session provides the auth context.

**Schema Changes**

- `ChoreAssignment.completedAt DateTime?` -- timestamp when marked complete
- `ChoreAssignment.completedVia String?` -- `"KIOSK"`, `"ADMIN"`, or `"GUEST_LINK"` (for Feature 10)
- `BookingGuest.arrivedAt DateTime?` -- kiosk-level arrival indicator
- `BookingGuest.departedAt DateTime?` -- kiosk-level departure indicator

**UI Changes**

- Kiosk lodge list: tap target per guest for "Mark Arrived" / "Mark Departed"
- Kiosk chore roster: large checkbox per assignment to toggle CONFIRMED <-> COMPLETED
- Visual feedback on completion (color change, checkmark)
- No confirmation dialog (fast, low-friction for shared device)

**API Changes**

- `PUT /api/lodge/roster/[date]` `complete`/`uncomplete` actions set `completedAt` and `completedVia: "KIOSK"`
- `PUT /api/lodge/guests/[date]/arrive` and `/depart` endpoints set `arrivedAt`/`departedAt` on BookingGuest

**Acceptance Criteria**

- [ ] Any person at kiosk can mark a chore as completed
- [ ] Any person at kiosk can mark a guest as arrived or departed
- [ ] Completion records timestamp and method (`KIOSK`)
- [ ] Arrived/departed shown visually on lodge list
- [ ] Arrived/departed does not affect booking `status` (CONFIRMED stays CONFIRMED)
- [ ] No per-guest auth prompt on kiosk

**Dependencies:** Features 1, 2

**Complexity:** M

---

## Feature 10: Per-Guest Email Link for Chore Access

**Description**

When the roster email is sent, include a unique time-limited link per guest. The link shows only that guest's assigned chores and allows marking them complete from their own device.

**Schema Changes**

- New model `GuestChoreToken`:
  - `id String @id @default(cuid())`
  - `token String @unique`
  - `bookingGuestId String` (FK -> BookingGuest)
  - `date DateTime @db.Date`
  - `expiresAt DateTime`
  - `createdAt DateTime @default(now())`
  - Index on `[token]` and `[bookingGuestId]`
- Add `choreTokens GuestChoreToken[]` relation on BookingGuest

**UI Changes**

- New public (unauthenticated) page at `/chores/[token]`:
  - Validates token and checks expiry
  - Shows guest's name and date
  - Lists only that guest's assigned chores
  - Tap targets to mark each chore COMPLETED
  - Clear message for expired/invalid tokens
- Lives outside `(authenticated)` and `(admin)` layouts -- fully public, protected by token unguessability

**API Changes**

- `GET /api/chores/[token]` -- validate token, return guest's assignments
- `PUT /api/chores/[token]` -- mark assignments COMPLETED with `completedVia: "GUEST_LINK"`
- Update roster email action to generate `GuestChoreToken` per guest and embed URL
- Update `sendChoreRosterEmail` and `choreRosterTemplate` to include the link

**Acceptance Criteria**

- [ ] Roster email includes unique link per guest (all guests have email addresses, including non-members)
- [ ] Each guest receives their own email with their own link (not bundled to the booking member)
- [ ] Link shows only that guest's chores for the date
- [ ] Guest can mark chores complete without logging in
- [ ] Token expires after 48 hours
- [ ] Expired/invalid token shows clear error
- [ ] Completion records `completedVia: "GUEST_LINK"`
- [ ] Works on mobile browsers

**Dependencies:** Feature 9

**Complexity:** L

---

## Feature 11: Chore History Lookback for Frequency-Based Roster Generation

**Description**

Ensure the 4-day history lookback is also used at the chore-template level when deciding which chores to include, particularly with frequency settings (Feature 4). The existing guest-level lookback for round-robin fairness continues unchanged.

**Allocator Changes**

- New parameter `choreLastRosteredDates: Map<string, Date>` on `allocateChores` (mapping choreTemplateId to most recent roster date)
- New exported function `filterChoresByFrequency(chores, choreLastRosteredDates, currentDate)` returns only "due" chores
- Called before `selectChoresForOccupancy`

**API Changes**

- Roster GET endpoints query most recent assignment date per chore template and pass to allocator

**Acceptance Criteria**

- [ ] EVERY_X_DAYS chore with `frequencyDays: 3` excluded if rostered within last 2 days
- [ ] SPECIFIC_DAYS chore excluded on non-matching days
- [ ] DAILY chore always included
- [ ] Hut leader wizard shows excluded chores with reason
- [ ] Guest-level 4-day lookback continues working for round-robin

**Dependencies:** Feature 4

**Complexity:** M

---

## Summary

| # | Feature | Complexity | Dependencies |
|---|---------|-----------|-------------|
| 1 | LODGE Role and Lodge Account | S | None |
| 2 | iPad Kiosk Page | L | 1 |
| 3 | Time-of-Day for Chore Templates | M | None |
| 4 | Chore Frequency Settings | L | None |
| 5 | Family Group Allocation | M | None |
| 6 | Hut Leader Wizard / Stepped Flow | XL | 1, 2, 3, 4 |
| 7 | Arriving/Departing Guest Routing | M | 3 |
| 8 | Hut Leader Role Assignment | L | 1, 2, 6 |
| 9 | Guest Arrival/Departure and Chore Tick-Off | M | 1, 2 |
| 10 | Per-Guest Email Link for Chore Access | L | 9 |
| 11 | Chore History Lookback for Frequency | M | 4 |

## Schema Change Summary

**Modified Enums:**
- `Role`: add `LODGE`

**New Enums:**
- `ChoreTimeOfDay`: `MORNING | EVENING | ANYTIME`
- `ChoreFrequencyMode`: `DAILY | EVERY_X_DAYS | SPECIFIC_DAYS`

**New Fields on Existing Models:**
- `ChoreTemplate.timeOfDay`: `ChoreTimeOfDay @default(ANYTIME)`
- `ChoreTemplate.frequencyMode`: `ChoreFrequencyMode @default(DAILY)`
- `ChoreTemplate.frequencyDays`: `Int?`
- `ChoreTemplate.frequencyDaysOfWeek`: `Int[]`
- `ChoreAssignment.completedAt`: `DateTime?`
- `ChoreAssignment.completedVia`: `String?`
- `BookingGuest.arrivedAt`: `DateTime?`
- `BookingGuest.departedAt`: `DateTime?`

**New Models:**
- `HutLeaderAssignment` (id, memberId, startDate, endDate, timestamps)
- `GuestChoreToken` (id, token, bookingGuestId, date, expiresAt, timestamps)

**New Relations:**
- `Member.hutLeaderAssignments` -> `HutLeaderAssignment[]`
- `BookingGuest.choreTokens` -> `GuestChoreToken[]`

## Critical Files

- `prisma/schema.prisma` -- schema changes
- `prisma/seed.ts` -- lodge account, updated chore template seeds
- `src/lib/chore-allocator.ts` -- family grouping, time-of-day routing, frequency filtering
- `src/lib/auth.ts` -- LODGE role in session types
- `src/types/next-auth.d.ts` -- session type augmentation
- `src/app/(lodge)/` -- new route group for kiosk and wizard
- `src/app/api/lodge/` -- new API endpoints
- `src/app/api/admin/roster/[date]/route.ts` -- existing roster API
- `src/app/(admin)/admin/chores/page.tsx` -- chore template form updates
- `src/lib/email-templates.ts` -- guest chore link in roster email
- `src/lib/email.ts` -- updated sendChoreRosterEmail
