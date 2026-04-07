# Phase 2: UI/UX Bug Fixes

You are fixing 7 UI/UX bugs in a Next.js booking system for a 29-bed alpine lodge. Make each change exactly as described, then run tests and build.

## Setup

```
git checkout -b fix/phase-2-ui-ux
```

## Change 1 of 7: Fix calendar availability color thresholds (CRITICAL)

Read `src/components/booking-calendar.tsx` lines 91-99. You will see:

```typescript
    if (isPast) {
      classes += "text-gray-300 cursor-not-allowed ";
    } else if (available <= 0) {
      classes += "bg-red-100 text-red-400 cursor-not-allowed ";
    } else if (available <= 5) {
      classes += "bg-yellow-100 text-yellow-800 hover:bg-yellow-200 cursor-pointer ";
    } else {
      classes += "bg-green-100 text-green-800 hover:bg-green-200 cursor-pointer ";
    }
```

Replace with 4 tiers (grey/red/amber/green):

```typescript
    if (isPast) {
      classes += "text-gray-300 cursor-not-allowed ";
    } else if (available <= 0) {
      classes += "bg-gray-100 text-gray-400 cursor-not-allowed ";
    } else if (available <= 5) {
      classes += "bg-red-100 text-red-700 hover:bg-red-200 cursor-pointer ";
    } else if (available <= 15) {
      classes += "bg-amber-100 text-amber-800 hover:bg-amber-200 cursor-pointer ";
    } else {
      classes += "bg-green-100 text-green-800 hover:bg-green-200 cursor-pointer ";
    }
```

Now read lines 188-199 (the legend section). Replace:

```tsx
      <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-green-100" /> Available
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-yellow-100" /> Limited (&le;5 beds)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-red-100" /> Full
        </span>
      </div>
```

with:

```tsx
      <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-green-100" /> Available (&gt;15 beds)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-amber-100" /> Moderate (6-15 beds)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-red-100" /> Limited (1-5 beds)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 w-3 rounded bg-gray-100" /> Full
        </span>
      </div>
```

## Change 2 of 7: Fix hut leader reassign dropdown eligibility (CRITICAL)

Read `src/app/(lodge)/lodge/roster/[date]/setup/page.tsx` lines 660-672. You will see a `<select>` dropdown that maps ALL guests:

```tsx
{allGuests.map((g) => (
  <option key={g.id} value={g.id}>
    {g.firstName} {g.lastName} ({g.ageTier})
  </option>
))}
```

This needs to filter guests based on the chore's eligibility. First, read the file from the top to understand the data structures. The `allGuests` array has objects with `ageTier` (ADULT/YOUTH/CHILD). The chore data in the roster has `ageRestriction` (ADULTS_ONLY, MIXED_PREFERRED, NONE) and `minAge` fields.

You need to find where the chore's properties are accessible in this render context. Look at the surrounding code — the `chore` variable in the map loop (around line 650) should have the template data.

Create a helper function near the top of the component (inside the component function, before the return):

```typescript
  const isGuestEligible = (guest: typeof allGuests[0], ageRestriction: string, minAge: number | null) => {
    if (ageRestriction === "ADULTS_ONLY" && guest.ageTier !== "ADULT") return false;
    if (minAge !== null) {
      if (guest.ageTier === "CHILD" && minAge > 9) return false;
      if (guest.ageTier === "YOUTH" && minAge > 17) return false;
    }
    return true;
  };
```

Then change the dropdown to filter:

```tsx
{allGuests
  .filter((g) => isGuestEligible(g, chore.ageRestriction ?? "NONE", chore.minAge ?? null))
  .map((g) => (
    <option key={g.id} value={g.id}>
      {g.firstName} {g.lastName} ({g.ageTier})
    </option>
  ))}
```

Make sure `chore.ageRestriction` and `chore.minAge` are available in scope. Read the data structures to confirm the field names — they may be nested under `choreTemplate` or similar. Adjust the field access path accordingly.

## Change 3 of 7: Fix kiosk silent action failures

Read `src/app/(lodge)/lodge/kiosk/page.tsx` lines 124-173. There are three `catch` blocks that silently swallow errors.

Add a state variable near the other useState hooks at the top of the component:

```typescript
const [actionError, setActionError] = useState<string | null>(null);
```

Then in each of the three catch blocks, replace the silent catch with:

For `toggleChore` (~line 124):
```typescript
    } catch {
      setActionError("Failed to update chore");
      setTimeout(() => setActionError(null), 3000);
    }
```

For `toggleArrival` (~line 147):
```typescript
    } catch {
      setActionError("Failed to update arrival");
      setTimeout(() => setActionError(null), 3000);
    }
```

For `toggleDeparture` (~line 170):
```typescript
    } catch {
      setActionError("Failed to update departure");
      setTimeout(() => setActionError(null), 3000);
    }
```

Also add a visible error banner in the JSX, right after the opening container div:

```tsx
{actionError && (
  <div className="bg-red-600 text-white text-center py-2 text-sm font-medium">
    {actionError}
  </div>
)}
```

## Change 4 of 7: Fix navbar branding link

Read `src/components/nav-bar.tsx` lines 63-70. You will see:

```tsx
        <Link
          href="/"
          className="flex items-center gap-2 font-bold text-slate-900 hover:opacity-80 transition-opacity"
        >
```

Change `href="/"` to `href="/dashboard"`. The NavBar component is only rendered for authenticated users (check the layout that renders it), so it should always go to `/dashboard`:

```tsx
        <Link
          href="/dashboard"
          className="flex items-center gap-2 font-bold text-slate-900 hover:opacity-80 transition-opacity"
        >
```

## Change 5 of 7: Fix register page password hint

Read `src/app/(public)/register/page.tsx` line 188. You will see:

```tsx
              placeholder="At least 8 characters"
```

Change to:

```tsx
              placeholder="At least 12 characters"
```

## Change 6 of 7: Fix print roster to filter by status

Read `src/app/(admin)/admin/roster/[date]/print/page.tsx` lines 52-54. You will see:

```typescript
  for (const a of roster.assignments) {
```

Add a filter before the loop to only show confirmed/completed assignments:

```typescript
  const confirmedAssignments = roster.assignments.filter(
    (a) => a.status === "CONFIRMED" || a.status === "COMPLETED"
  );
  for (const a of confirmedAssignments) {
```

## Change 7 of 7: Fix admin sidebar Home label

Read `src/components/admin-sidebar.tsx` lines 71-78. You will see:

```tsx
      <Link
        href="/dashboard"
        onClick={onNavigate}
        className="..."
      >
        <House className="h-4 w-4 shrink-0 text-slate-400" />
        Home
      </Link>
```

Change `Home` to `Member Dashboard`:

```tsx
        Member Dashboard
```

## Verify

```bash
npm test
npm run build
```

All 948 tests must pass.

## Commit

```bash
git add -A
git commit -m "UI/UX fixes: calendar colors, dropdown filtering, kiosk errors, nav links

- C2: Fix calendar to 4-tier colors (grey/red/amber/green)
- C4: Filter hut leader reassign dropdown by chore eligibility
- H8: Show error feedback on kiosk action failures
- H11: Fix navbar branding link to /dashboard
- M9: Fix register page password hint (8 -> 12 chars)
- L4: Filter print roster to CONFIRMED/COMPLETED only
- L7: Rename admin sidebar Home to Member Dashboard"
```
