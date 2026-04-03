@AGENTS.md

## Build Status

### Phase 2: Seasons & Pricing - COMPLETE

**Built on branch:** `claude/build-phase-2-n9ZfH`

**What was built:**

1. **Minimal Foundation (scaffolding for Phase 2)**
   - Next.js 15 + TypeScript + Tailwind CSS project initialized
   - Prisma 6 schema with ALL entities (Member, Season, SeasonRate, Booking, BookingGuest, Payment, PromoCode, PromoRedemption, ChoreTemplate, ChoreAssignment, CancellationPolicy, XeroToken)
   - shadcn/ui components (Button, Input, Label, Card, Select, Badge, Table) - manually installed
   - NextAuth v5 credentials provider with JWT sessions
   - Admin layout with auth guard (role === ADMIN)

2. **Admin Seasons CRUD** (`/admin/seasons`)
   - Create/edit/delete seasons with name, type (WINTER/SUMMER), date range
   - Set 6 rates per season (3 age tiers x member/non-member)
   - Overlap detection prevents conflicting season dates
   - Toggle active/inactive status
   - API routes: GET/POST `/api/admin/seasons`, GET/PUT/DELETE `/api/admin/seasons/[id]`

3. **Admin Cancellation Policy** (`/admin/cancellation-policy`)
   - Configurable refund rules (days before stay -> refund percentage)
   - Add/remove rules dynamically
   - Policy preview showing how rules apply
   - Atomic replacement of all rules via transaction
   - API routes: GET/PUT `/api/admin/cancellation-policy`

4. **Pricing Engine** (`src/lib/pricing.ts`)
   - `getStayNights()` - generates array of nights for a stay
   - `findSeasonForDate()` - finds active season covering a date
   - `getNightlyRate()` - looks up rate for guest type on a date
   - `calculateGuestPrice()` - total price for one guest across all nights
   - `calculateBookingPrice()` - total for all guests in a booking
   - `calculatePromoDiscount()` - applies PERCENTAGE, FIXED_AMOUNT, or FREE_NIGHTS promos
   - `calculateRefund()` - calculates refund based on cancellation policy
   - `formatCents()` - formats cents as dollar string
   - `getSeasonYear()` - April-March season year logic

5. **Seed Data** (`prisma/seed.ts`)
   - Admin user (admin@tac.org.nz / admin123)
   - Test member (member@tac.org.nz / member123)
   - Winter 2026 season (June-Sept) with rates
   - Summer 2026-27 season (Nov-March) with rates
   - Default cancellation policy (14d=100%, 7d=50%, 0d=0%)

6. **Tests** - 41 tests, all passing
   - Pricing engine fully tested (getStayNights, findSeasonForDate, getNightlyRate, calculateGuestPrice, calculateBookingPrice, calculatePromoDiscount, calculateRefund, formatCents, getSeasonYear)
   - Edge cases: season boundaries, month boundaries, inactive seasons, promo caps, rounding

**How to run:**
```bash
npm install
npx prisma generate
npm test              # 41 tests pass
npm run build         # builds successfully
```

**To seed database (requires running PostgreSQL):**
```bash
npx prisma migrate dev
npm run db:seed
```

**Known considerations:**
- Phase 1 (foundation) is being built in parallel on another branch - merge needed
- Prisma downgraded to v6 (v7 requires adapter/accelerate, incompatible with standard PostgreSQL)
- Google Fonts removed from layout (network not available in build env)
- All prices stored as integer cents per CLAUDE.md spec
- Season year: April-March cycle (month >= 3 = current year, else previous year)

### What's Next: Phase 3 - Core Booking
1. Availability calculator (beds per night)
2. Booking calendar UI
3. Guest addition form
4. Real-time price display
5. Booking creation with concurrency handling
6. My bookings list + detail pages
7. Admin booking management
