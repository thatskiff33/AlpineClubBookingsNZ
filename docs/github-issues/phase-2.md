## Phase 2: UI/UX Bugs

**Priority:** Critical/High — must complete before UAT
**Depends on:** None
**Reference:** [docs/CODEBASE_REVIEW_2026-04-07.md](../CODEBASE_REVIEW_2026-04-07.md)

### Issues Addressed

| ID | Severity | Description |
|----|----------|-------------|
| C2 | Critical | Calendar availability color thresholds wrong (3 tiers, spec requires 4) |
| C4 | Critical | Hut leader reassign dropdown shows all guests without eligibility filtering |
| H8 | High | Kiosk toggle actions silently swallow failures — no user feedback |
| H11 | High | NavBar branding link always goes to `/` instead of `/dashboard` for auth'd users |
| M9 | Medium | Register page says "8 characters" but schema enforces 12 |
| L4 | Low | Print roster shows all assignment statuses including SUGGESTED |
| L7 | Low | Admin sidebar "Home" link label is ambiguous |

### Checklist

- [ ] **C2** — Fix `src/components/booking-calendar.tsx:93-99`:
  - `available === 0` → grey (`bg-gray-100 text-gray-400 cursor-not-allowed`)
  - `available <= 5` → red (`bg-red-100 text-red-800`)
  - `available <= 15` → amber (`bg-amber-100 text-amber-800`)
  - `available > 15` → green (`bg-green-100 text-green-800`)
  - Update legend at ~line 190 to show all 4 tiers with correct labels
- [ ] **C4** — Fix `src/app/(lodge)/lodge/roster/[date]/setup/page.tsx:660-672`:
  - Filter reassign dropdown by chore eligibility (minAge, ageRestriction, time-of-day)
  - ADULTS_ONLY chores should not show CHILD/YOUTH guests
  - Show age tier badge next to each guest name
- [ ] **H8** — Fix `src/app/(lodge)/lodge/kiosk/page.tsx:124-126, 147-149, 170-172`:
  - Replace silent failure with brief error feedback (red flash on the button, or small error text)
  - Keep auto-refresh as eventual consistency backup
- [ ] **H11** — Fix `src/components/nav-bar.tsx:64`:
  - Change `href="/"` to be conditional: `/dashboard` when session exists, `/` otherwise
  - NavBar receives session as prop — use it
- [ ] **M9** — Fix `src/app/(public)/register/page.tsx:189`:
  - Change "At least 8 characters" to "At least 12 characters"
- [ ] **L4** — Fix `src/app/(admin)/admin/roster/[date]/print/page.tsx`:
  - Filter assignments to `status in ['CONFIRMED', 'COMPLETED']` before rendering
- [ ] **L7** — Fix `src/components/admin-sidebar.tsx:72`:
  - Change label from "Home" to "Member Dashboard" or point to `/admin/dashboard`
- [ ] Run full test suite: `npm test`
- [ ] Run build: `npm run build`

### Agent Prompt

```
Fix 7 UI/UX bugs from the codebase review (docs/CODEBASE_REVIEW_2026-04-07.md, Phase 2).

1. src/components/booking-calendar.tsx:93-99 — Fix availability color thresholds.
   Current: Green (>5), Yellow (<=5), Red (0). 
   Required: Green (>15), Amber (6-15), Red (1-5), Grey (0).
   Also update the legend section (~line 190) to show all 4 tiers.

2. src/app/(lodge)/lodge/roster/[date]/setup/page.tsx:660-672 — The reassign dropdown
   shows ALL guests. Filter by chore eligibility: check the chore's ageRestriction
   (ADULTS_ONLY, MIXED_PREFERRED, NONE) and minAge against each guest's ageTier.

3. src/app/(lodge)/lodge/kiosk/page.tsx — Three toggle functions at lines 124, 147, 170
   silently catch errors. Add visible feedback — e.g. set a transient error state that
   shows "Failed" on the button for 3 seconds before auto-refresh clears it.

4. src/components/nav-bar.tsx:64 — Branding link hardcodes href="/". The component
   receives session data. Make it conditional: href="/dashboard" when authenticated,
   href="/" when not.

5. src/app/(public)/register/page.tsx:189 — Change password hint text from
   "At least 8 characters" to "At least 12 characters".

6. src/app/(admin)/admin/roster/[date]/print/page.tsx — Filter displayed assignments
   to only show status "CONFIRMED" or "COMPLETED" (not "SUGGESTED").

7. src/components/admin-sidebar.tsx:72 — Change "Home" label to "Member Dashboard".

After all changes: npm test && npm run build. Commit on branch: fix/phase-2-ui-ux
```
