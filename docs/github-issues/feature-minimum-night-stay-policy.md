## Summary

Configurable booking policies that enforce **minimum night stays** when a booking touches certain days of the week during specified date ranges. 

**Example:** During Winter season, any booking that includes a Saturday night must be at least 2 nights.

This applies to both **new bookings** and **booking modifications** (date changes, guest changes that affect dates).

---

## Background

The club has historically required a minimum 2-night stay when booking a Saturday during winter. This prevents single-night Saturday bookings that leave adjacent nights harder to fill. The policy needs to be:

- **Date-range scoped** — only active between specific dates (e.g., winter season dates)
- **Day-of-week triggered** — only applies when booking touches specific days (e.g., Saturday)
- **Configurable minimum** — admin sets the minimum number of nights
- **Applied to new bookings AND modifications** — date changes must also comply

---

## Implementation Plan

### 1. Prisma Model: `MinimumStayPolicy`

```prisma
model MinimumStayPolicy {
  id            String   @id @default(cuid())
  name          String                          // e.g. "Winter Saturday Minimum Stay"
  startDate     DateTime @db.Date               // Policy active from (inclusive)
  endDate       DateTime @db.Date               // Policy active until (inclusive)
  triggerDays   Int[]                            // Days of week: 0=Sunday, 1=Monday, ..., 6=Saturday
  minimumNights Int                              // Minimum nights required if triggered
  active        Boolean  @default(true)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([startDate, endDate])
  @@index([active])
}
```

### 2. Validation Logic: `src/lib/booking-policies.ts`

```typescript
export interface MinimumStayViolation {
  policyName: string;
  triggerDay: string;       // e.g. "Saturday"
  minimumNights: number;
  actualNights: number;
}

/**
 * Validate booking dates against all active minimum stay policies.
 * Returns { valid: true } or { valid: false, violations: [...] }
 */
export async function validateMinimumStay(
  checkIn: Date, 
  checkOut: Date
): Promise<{ valid: boolean; violations: MinimumStayViolation[] }>
```

**Logic:**
1. Calculate all nights in the stay: `getStayNights(checkIn, checkOut)` from `src/lib/pricing.ts`
2. Query all active `MinimumStayPolicy` records where the policy date range overlaps with the booking date range
3. For each policy:
   - Check if any night in the stay falls on one of the policy's `triggerDays` AND is within the policy's `startDate`–`endDate` range
   - If yes: check if total number of nights >= `minimumNights`
   - If violation: add to violations array with human-readable info
4. Return result

**Helper:**
```typescript
// Convert day number to name for user-friendly messages
function dayName(day: number): string  // 0 → "Sunday", 6 → "Saturday"

// Check if a date range overlaps with a policy range
function dateRangesOverlap(a: Date, b: Date, c: Date, d: Date): boolean
```

### 3. Booking Creation Integration

**Update `src/app/api/bookings/route.ts`:**
- After date parsing and before capacity check, call `validateMinimumStay(checkIn, checkOut)`
- If invalid: return 400 with user-friendly message:
  ```json
  {
    "error": "Booking does not meet minimum stay requirement",
    "details": "Bookings including a Saturday night between 1 Jun – 30 Sep 2026 require a minimum stay of 2 nights. Your booking is 1 night.",
    "code": "MINIMUM_STAY_VIOLATION"
  }
  ```
- Skip validation for ADMIN role (admins can override)

### 4. Booking Modification Integration

**Update `src/app/api/bookings/[id]/modify-dates/route.ts`:**
- After new date validation, before capacity check, call `validateMinimumStay(newCheckIn, newCheckOut)`
- If invalid: return 400 with same error format
- Skip for ADMIN

**Update `src/app/api/bookings/[id]/modify-quote/route.ts`:**
- Include minimum stay validation in quote response so UI can show warnings before user commits

### 5. Pre-Check API (for booking wizard)

**New: `GET /api/booking-policies/check?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD`**
- Public endpoint (no auth required — helps with UX before login)
- Returns validation result + all active policies that apply to the date range
- Used by booking wizard to show inline warnings after date selection

### 6. Admin CRUD API

**`GET /api/admin/booking-policies`**
- List all policies (with optional `?active=true` filter)
- Sorted by startDate DESC

**`POST /api/admin/booking-policies`**
- Create new policy
- Zod validation: name required, startDate < endDate, triggerDays 0-6, minimumNights >= 2
- Audit log entry

**`PUT /api/admin/booking-policies/[id]`**
- Update existing policy
- Same validation
- Audit log entry

**`DELETE /api/admin/booking-policies/[id]`**
- Soft delete (set active=false) rather than hard delete to preserve audit history
- Audit log entry

### 7. Admin UI: `/admin/booking-policies`

**Page layout:**
- Header: "Booking Policies" with "Create Policy" button
- Table: name, date range, trigger days (as badges: "Sat", "Sun"), minimum nights, active toggle
- Click row to edit (inline or modal)
- Create/edit form:
  - Name (text input)
  - Date range (date pickers for start/end)
  - Trigger days (checkbox group: Mon, Tue, Wed, Thu, Fri, Sat, Sun)
  - Minimum nights (number input, min 2)
  - Active toggle

**Add to admin sidebar** (`src/components/admin-sidebar.tsx`):
- "Booking Policies" entry under the existing "Cancellation Policy" entry

### 8. Booking Wizard UX

**Update `src/app/(authenticated)/book/page.tsx`:**
- After date selection step: call `/api/booking-policies/check` with selected dates
- If violation detected: show amber warning banner inline:
  - "Bookings including a Saturday between 1 Jun – 30 Sep require a minimum 2-night stay. Please adjust your dates."
  - Disable "Continue" button until dates comply
- For modification dialogs: same validation before allowing date change submission

**Update `src/components/change-dates-dialog.tsx`:**
- After new date selection: validate against minimum stay policies
- Show warning if violation, disable confirm button

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `prisma/schema.prisma` | MODIFY — add MinimumStayPolicy model |
| `src/lib/booking-policies.ts` | NEW — validation logic |
| `src/app/api/admin/booking-policies/route.ts` | NEW — GET/POST admin API |
| `src/app/api/admin/booking-policies/[id]/route.ts` | NEW — PUT/DELETE admin API |
| `src/app/api/booking-policies/check/route.ts` | NEW — public pre-check API |
| `src/app/(admin)/admin/booking-policies/page.tsx` | NEW — admin UI |
| `src/app/api/bookings/route.ts` | MODIFY — add validation call |
| `src/app/api/bookings/[id]/modify-dates/route.ts` | MODIFY — add validation call |
| `src/app/api/bookings/[id]/modify-quote/route.ts` | MODIFY — include validation in quote |
| `src/components/change-dates-dialog.tsx` | MODIFY — add validation on date change |
| `src/app/(authenticated)/book/page.tsx` | MODIFY — pre-check after date selection |
| `src/components/admin-sidebar.tsx` | MODIFY — add nav entry |
| `src/lib/__tests__/booking-policies.test.ts` | NEW — validation + API tests |

---

## Test Plan

- [ ] Create policy: Winter Saturdays (Jun–Sep), triggerDays=[6], minimumNights=2
- [ ] Book 1 night on a Saturday within range → verify 400 error with clear message
- [ ] Book 2 nights Fri–Sun within range → verify passes (Saturday touched, 2 nights meets minimum)
- [ ] Book 1 night on a Friday within range → verify passes (Saturday not touched)
- [ ] Book 1 night on a Saturday OUTSIDE policy date range → verify passes
- [ ] Modify existing 2-night booking to 1 night touching Saturday → verify 400 error
- [ ] Modify existing booking dates to comply → verify passes
- [ ] Admin creates/edits/deactivates policy → verify CRUD works
- [ ] Deactivate policy → verify Saturday 1-night booking now passes
- [ ] Booking wizard: select violating dates → verify inline warning shown, continue disabled
- [ ] Admin user: verify can override minimum stay (or decide if admins should also be blocked)
- [ ] Run `npm test` and `npm run build`

---

## Edge Cases

- **Multiple overlapping policies**: If two policies overlap and both trigger, the stricter (higher minimumNights) should apply
- **Policy spans multiple seasons**: A policy can span across season boundaries — validation only checks if nights fall within the policy date range, not the season
- **DRAFT bookings**: Should DRAFT bookings be validated? Recommended: yes, validate on creation to prevent drafts that can never be confirmed
- **PENDING bookings**: Already created PENDING bookings should not be retroactively invalidated if a policy is created after booking
