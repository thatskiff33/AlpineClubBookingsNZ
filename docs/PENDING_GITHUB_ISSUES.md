# Pending GitHub Issues (Round 2)

These issues need to be created on GitHub (thatskiff33/tacbookings) when the MCP server reconnects.

---

## Issue 1: [Phase A] Feature: Add Sentry Session Replay integration

**Labels**: `enhancement`, `phase-a`

### Summary

Add Sentry Session Replay to the client-side configuration to capture user session recordings for debugging. This was recommended by Sentry's setup wizard.

### Background

Sentry is already configured for server-side and client-side error tracking (Phase 9: Observability). The client-side config exists at `sentry.client.config.ts` in the project root. Session Replay needs to be added as an additional integration.

### Implementation

#### 1. Install Sentry Replay (if not already bundled)

The `@sentry/nextjs` package should already include the replay integration. Verify with:
```bash
npm ls @sentry/nextjs
```

If the replay integration is not available, you may need to update `@sentry/nextjs` to the latest version.

#### 2. Create `instrumentation-client.ts`

**Important**: Per Sentry docs, the Replay integration for Next.js must go in `instrumentation-client.ts` (or `.js`), NOT in `sentry.client.config.ts` or any server-side config. Adding it to server-side files will break the build because Replay depends on Browser APIs.

**New file**: `instrumentation-client.ts` (project root, alongside `instrumentation.ts`)

```typescript
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://a67e1f1e5f1f3c6468b33313a196ccea@o4511170035908608.ingest.us.sentry.io/4511170038857728",

  integrations: [
    Sentry.replayIntegration(),
  ],

  // Session Replay sampling
  replaysSessionSampleRate: 0.1,  // 10% of sessions in production
  replaysOnErrorSampleRate: 1.0,  // 100% of sessions with errors
});
```

#### 3. Reconcile with existing `sentry.client.config.ts`

The existing `sentry.client.config.ts` already has a `Sentry.init()` call with:
- Performance tracing (0.2 sample rate prod, 1.0 dev)
- Breadcrumb integrations (console, DOM, fetch, history)
- Sensitive field scrubbing (beforeSend)
- Error filtering (ResizeObserver, network failures, etc.)

**Option A (Recommended)**: Move ALL client-side Sentry config into `instrumentation-client.ts` and delete `sentry.client.config.ts`. Merge the existing integrations, tracing config, beforeSend scrubbing, and error filtering with the new replay integration.

**Option B**: Keep both files — but this risks double-init. Verify Next.js doesn't call both.

#### 4. Verify CSP allows Sentry Replay

**File**: `src/middleware.ts`

The Content Security Policy may need updating to allow Sentry's replay worker. Check if `connect-src` already includes the Sentry ingest domain. Replay may also need `worker-src blob:` if it uses a web worker.

#### 5. Update environment variables

The DSN is currently read from `NEXT_PUBLIC_SENTRY_DSN`. The instrumentation-client file should use the same env var:

```typescript
dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
```

Sentry org and project for reference:
- **Org**: `tokoroa-alpine-club-incorporat`
- **Project**: `javascript-nextjs`

### Configuration Details

| Setting | Value | Rationale |
|---------|-------|-----------|
| `replaysSessionSampleRate` | `0.1` (10%) | Balance between coverage and data volume for ~410 member club |
| `replaysOnErrorSampleRate` | `1.0` (100%) | Always capture full replay when errors occur |

### Testing

- Build the app (`npm run build`) — verify no errors from Replay integration
- Run in dev mode and check browser console for Sentry replay initialization messages
- Trigger a test error and verify the replay appears in Sentry dashboard
- Verify existing error tracking, performance tracing, and breadcrumbs still work
- Check that sensitive data scrubbing (passwords, tokens) still applies

---

## Issue 2: [Phase B1] Feature: Expected Arrival Time on bookings with kiosk display

**Labels**: `enhancement`, `phase-b1`

### Summary

Allow members to set an Expected Time of Arrival on their bookings. This should display on the Lodge Kiosk so lodge staff and hut leaders can plan for guest arrivals. The field should be editable up until the first day of the booking has passed.

### Schema Change

**File**: `prisma/schema.prisma`

Add to the Booking model:
```prisma
model Booking {
  // ... existing fields ...
  expectedArrivalTime  String?    // Format: "HH:mm" (e.g. "14:00", "16:30")
  // ...
}
```

Run migration: `npx prisma migrate dev --name add-expected-arrival-time`

Use a String rather than DateTime because this is a time-of-day only, not a full timestamp.

### UI: Time Picker (30-minute increments)

Create a reusable time picker component that presents a dropdown with 30-minute increments:

**New component**: `src/components/time-picker.tsx`

Options: 06:00, 06:30, 07:00, 07:30, ... 22:00, 22:30, 23:00 (plus a "Not sure" / blank option)

Display format: "2:00 PM", "2:30 PM" etc. (12-hour with AM/PM for display, store as "14:00", "14:30" in 24-hour format)

#### Booking Wizard (Create Booking)

**File**: `src/app/(authenticated)/book/page.tsx`

- Add an "Expected Arrival Time" field after the date selection step (or in the review step)
- Optional — not required to complete the booking
- Default: empty/unset
- Use the time picker component

#### Booking Detail Page (Edit)

**File**: `src/app/(authenticated)/bookings/[id]/page.tsx`

- Show the current expected arrival time (or "Not set")
- Allow editing via the time picker — inline edit or a small form
- **Editable only if**: the booking's `checkIn` date has NOT yet passed (i.e. `checkIn >= today`)
- After checkIn has passed, show the time as read-only text
- Save via API call on change

### API

#### Create Booking

**File**: `src/app/api/bookings/route.ts`

Accept optional `expectedArrivalTime` field in the POST body. Validate format with Zod:
```typescript
expectedArrivalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]0$/).optional(),
// Matches HH:mm with 30-min increments: 00, 30
```

#### Update Arrival Time

**New file**: `src/app/api/bookings/[id]/arrival-time/route.ts`

`PUT /api/bookings/[id]/arrival-time`
```json
{ "expectedArrivalTime": "14:00" }
```
- Auth: booking owner or ADMIN
- Validate: booking checkIn date has not passed
- Validate: time format (HH:mm, 30-min increments)
- Update booking record
- Return updated booking

`DELETE /api/bookings/[id]/arrival-time` — clear the arrival time (set to null)

#### Booking Modification APIs

**Files**: `src/app/api/bookings/[id]/modify-dates/route.ts`

When dates are changed, the arrival time should be preserved (it's date-independent). No changes needed unless the booking is moved to a past date.

### Lodge Kiosk Display

**File**: `src/app/(lodge)/lodge/kiosk/page.tsx`

In the guest list section, show the expected arrival time next to each booking group:

```
Wayne Peterson's Booking
  Expected arrival: 2:30 PM
  Guests:
    Wayne Peterson — ADULT · Member
    Charlotte Peterson — YOUTH · Member
```

If no arrival time is set, show "Arrival time: Not specified"

For arriving guests specifically (where `isArriving === true`), the arrival time is most relevant. Consider highlighting it more prominently for today's arrivals.

#### Lodge API

**File**: `src/app/api/lodge/guests/[date]/route.ts`

Include `expectedArrivalTime` in the booking group data returned to the kiosk:
```json
{
  "bookingId": "...",
  "memberName": "Wayne Peterson",
  "expectedArrivalTime": "14:30",
  "guests": [...]
}
```

### Key Files to Modify

- `prisma/schema.prisma` — Add `expectedArrivalTime` field
- `src/app/api/bookings/route.ts` — Accept field on create
- New: `src/app/api/bookings/[id]/arrival-time/route.ts` — Update/delete arrival time
- `src/app/(authenticated)/book/page.tsx` — Time picker in booking wizard
- `src/app/(authenticated)/bookings/[id]/page.tsx` — Editable arrival time on detail
- `src/app/(lodge)/lodge/kiosk/page.tsx` — Display arrival time
- `src/app/api/lodge/guests/[date]/route.ts` — Include in API response
- New: `src/components/time-picker.tsx` — Reusable time picker component

### Testing

- Test time picker renders 30-min increments from 06:00 to 23:00
- Test booking creation with and without arrival time
- Test arrival time update via API (valid format, invalid format, past booking rejected)
- Test arrival time shows on kiosk for arriving guests
- Test editing is blocked after checkIn date has passed
- Test arrival time is preserved when booking dates are modified

---

## Issue 3: [Phase C1] Feature: Subscriptions Xero invoice link + member payment link for unpaid subscriptions

**Labels**: `enhancement`, `phase-c1`

### Summary

Two Xero-related improvements for the member and admin experience:

1. Admin Subscriptions page: Make Xero Invoice column show the invoice number as a clickable link
2. Member booking page: When subscription is unpaid, show a link to the Xero invoice so they can pay

### 1. Admin Subscriptions — Xero Invoice Clickable Link

#### Current Behavior
The Admin > Subscriptions page (`/admin/subscriptions`) shows the `xeroInvoiceId` (internal UUID) as plain text or "—" if null.

#### Required Behavior
- Show the **Xero Invoice Number** (e.g. "INV-0042") as the link text
- Make it a clickable link that opens the invoice in Xero: `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID={xeroInvoiceId}`
- Opens in a new tab

#### Schema Change

**File**: `prisma/schema.prisma`

Add `xeroInvoiceNumber` to the `MemberSubscription` model (same pattern as Issue #26 for Payment):
```prisma
model MemberSubscription {
  // ... existing fields ...
  xeroInvoiceId      String?
  xeroInvoiceNumber  String?     // Human-readable invoice number
  // ...
}
```

Run migration: `npx prisma migrate dev --name add-subscription-xero-invoice-number`

#### Populate Invoice Number

**File**: `src/lib/xero.ts`

In the membership verification/sync logic (likely `syncMembershipSubscriptions` or `findSubscriptionInvoice`), when creating or updating `MemberSubscription` records with a `xeroInvoiceId`, also store the invoice number from the Xero API response (`invoice.InvoiceNumber`).

#### Backfill
For existing records with `xeroInvoiceId` but no `xeroInvoiceNumber`, fetch invoice numbers from Xero API in a one-time migration or admin action.

#### UI Update

**File**: `src/app/(admin)/admin/subscriptions/page.tsx`

Change the Xero Invoice column from plain text to a clickable link:
```tsx
{sub.xeroInvoiceId ? (
  <a
    href={`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${sub.xeroInvoiceId}`}
    target="_blank"
    rel="noopener noreferrer"
    className="text-blue-600 hover:underline"
  >
    {sub.xeroInvoiceNumber || sub.xeroInvoiceId}
  </a>
) : "—"}
```

#### API Update

**File**: `src/app/api/admin/subscriptions/route.ts`

Include `xeroInvoiceNumber` in the subscription records returned by the API.

---

### 2. Member Booking Page — Xero Invoice Link for Unpaid Subscription

#### Current Behavior
When a member with an unpaid/overdue subscription tries to create a booking, they get a 403 error with message: "Your membership subscription for the {year}/{year+1} season is not paid. Please contact the club to arrange payment before booking."

No link to the invoice is provided.

#### Required Behavior
- Include a link to the member's Xero invoice in the error response
- The link should be the **public-facing Xero invoice URL** (the same URL sent via email when the invoice was first issued) — this does NOT require Xero login
- Display the link in the booking wizard UI so the member can click through and pay

#### Xero Online Invoice URL

Xero provides an "OnlineInvoiceUrl" field on invoices that gives a public, no-login-required payment link. This needs to be:
1. Fetched via the Xero API when creating/syncing subscription records
2. Stored on the `MemberSubscription` model

**Schema addition**:
```prisma
model MemberSubscription {
  // ... existing fields ...
  xeroOnlineInvoiceUrl  String?   // Public-facing Xero invoice URL for member payment
  // ...
}
```

**File**: `src/lib/xero.ts`

When syncing subscription invoices, fetch the online invoice URL:
```typescript
// The Xero API returns OnlineInvoiceUrl in the invoice response
// Store it: subscription.xeroOnlineInvoiceUrl = invoice.OnlineInvoiceUrl
```

Note: The Xero API may require a separate call to get the online invoice URL (`GET /api.xro/2.0/Invoices/{InvoiceID}/OnlineInvoice`). Check the xero-node SDK docs.

#### API Change

**File**: `src/app/api/bookings/route.ts` (lines ~86-105)

When returning the 403 SUBSCRIPTION_REQUIRED error, include the invoice URL:

```typescript
// Find the member's subscription record
const subscription = await prisma.memberSubscription.findFirst({
  where: { memberId: session.user.id, seasonYear },
});

return NextResponse.json({
  error: "Your membership subscription...",
  code: "SUBSCRIPTION_REQUIRED",
  invoiceUrl: subscription?.xeroOnlineInvoiceUrl || null,
  invoiceNumber: subscription?.xeroInvoiceNumber || null,
}, { status: 403 });
```

#### UI Change

**File**: `src/app/(authenticated)/book/page.tsx`

When the booking creation returns a SUBSCRIPTION_REQUIRED error:
- Show the error message
- If `invoiceUrl` is present, show a prominent "Pay Your Subscription" button/link that opens the Xero invoice URL in a new tab
- If no URL available, show "Please contact the club at support@tokoroa.org.nz to arrange payment"

### Key Files

- `prisma/schema.prisma` — Add fields to MemberSubscription
- `src/lib/xero.ts` — Store invoice number and online URL during sync
- `src/app/api/admin/subscriptions/route.ts` — Include new fields in response
- `src/app/(admin)/admin/subscriptions/page.tsx` — Clickable invoice link
- `src/app/api/bookings/route.ts` — Include invoice URL in 403 response
- `src/app/(authenticated)/book/page.tsx` — Show pay link on subscription error

### Testing

- Test subscription page shows invoice number as clickable link
- Test link opens correct Xero invoice
- Test fallback when no invoice number (show ID or "—")
- Test 403 response includes invoiceUrl when available
- Test booking wizard shows "Pay Your Subscription" link on subscription error
- Test graceful fallback when no invoice URL available

---

## Issue 4: [Phase D] Feature: Admin Bookings Calendar View (month view)

**Labels**: `enhancement`, `phase-d`

### Summary

Add a month-view calendar to the Admin Bookings page showing bookings as horizontal bars spanning their date ranges, color-coded by status. This sits above the existing table view which remains unchanged.

### Requirements

#### Calendar Layout
- **Month view** displayed as a grid (similar to Gantt chart)
- Rows represent individual bookings
- Horizontal bars span from checkIn to checkOut date
- Bars are color-coded by booking status using the existing `src/lib/status-colors.ts` utility:
  - DRAFT = slate/grey
  - PENDING = yellow
  - CONFIRMED = green
  - PAID = blue
  - BUMPED = orange
  - CANCELLED = red
  - COMPLETED = purple
- Each bar shows the member name (truncated if needed)
- Clicking a bar navigates to the booking detail page (`/bookings/{id}` or admin view)

#### Navigation
- Month/year selector (previous/next month arrows + month/year display)
- "Today" button to jump to current month

#### Filters
- Status filter checkboxes at the top (shared state with the existing table below)
- When a status filter is applied, both the calendar and the table update
- Default: exclude DRAFT and CANCELLED (same as existing table default)

#### Layout on Page
```
[Status Filters]
[← April 2026 →] [Today]
[Calendar Grid - Month View with booking bars]
[Existing Bookings Table (unchanged)]
```

### Implementation

#### Data Requirements

The existing `GET /api/admin/bookings` endpoint may need an additional query mode that returns all bookings overlapping a given month (not just paginated). Add a query parameter:

**File**: `src/app/api/admin/bookings/route.ts`

Add support for `calendarMonth` parameter (format: `YYYY-MM`):
```
GET /api/admin/bookings?calendarMonth=2026-04
```
Returns all bookings where the date range overlaps the given month (checkIn <= monthEnd AND checkOut >= monthStart). No pagination limit for calendar view (lodge is 29 beds, so max bookings per month is manageable).

Response should include: `id`, `memberName`, `checkIn`, `checkOut`, `status`, `guestCount`.

#### Calendar Component

**New component**: `src/components/admin-booking-calendar.tsx`

A month-view calendar component that:
- Renders a day grid for the month (7 columns for days of week)
- Overlays booking bars across the date cells
- Handles bookings that span month boundaries (show partial bars with arrow indicators)
- Color-codes bars using `bookingStatusClass()` from `src/lib/status-colors.ts`
- Shows member name on each bar (tooltip for full details on hover)
- Click handler navigates to booking detail
- Responsive: stacks or scrolls on smaller screens

Consider using a library like `@fullcalendar/react` for the heavy lifting, or build custom with CSS Grid. A custom implementation keeps the bundle smaller and matches the existing UI style.

#### Page Integration

**File**: `src/app/(admin)/admin/bookings/page.tsx`

- Add the calendar component above the existing table
- Share filter state between calendar and table
- Calendar fetches data via the `calendarMonth` API parameter
- Table continues to work as before with its own pagination

### Key Files

- `src/app/api/admin/bookings/route.ts` — Add calendarMonth query mode
- New: `src/components/admin-booking-calendar.tsx` — Month view calendar component
- `src/app/(admin)/admin/bookings/page.tsx` — Integrate calendar above table
- `src/lib/status-colors.ts` — Reuse existing status color mappings

### Testing

- Test calendar renders correct number of days for each month
- Test bookings appear as bars spanning correct dates
- Test color-coding matches status
- Test clicking a booking navigates to detail page
- Test month navigation (previous/next/today)
- Test status filters update both calendar and table
- Test bookings spanning month boundaries show correctly
- Test empty months display gracefully
- Manual test: compare calendar view with table view to verify consistency

---

## Issue 5: [Phase D] Feature: Reports PDF generation (replace window.print)

**Labels**: `enhancement`, `phase-d`

### Summary

Replace the current Print button on the Admin Reports page (which uses `window.print()`) with proper PDF generation that creates a clean, formatted document including all report data as configured on screen.

### Current Behavior

**File**: `src/app/(admin)/admin/reports/page.tsx`

The Print button (lines ~219-221) calls `window.print()` which:
- Opens the browser's native print dialog
- Relies on `@media print` CSS to hide nav/sidebar/filters
- Quality varies by browser
- No control over page breaks, sizing, or formatting
- Charts may not render correctly in print view

### Required Behavior

A "Download PDF" button that:
1. Generates a clean, formatted PDF document
2. Includes the date range selections as currently set by the admin
3. Includes all report sections: summary cards, charts (occupancy, revenue, trends), and data tables
4. Properly sized for A4 with margins and headers
5. TAC branding (club name, report title, date range, generation timestamp)
6. Filename: `tac-report-YYYY-MM-DD.pdf`

### Implementation

#### Library Choice

**Recommended**: `jspdf` + `html2canvas`
- `html2canvas` captures the report content (including charts rendered by recharts) as an image
- `jspdf` creates the PDF and places the captured content with proper A4 layout
- This approach works well with recharts (which renders SVG/Canvas) without needing to re-render charts

**Alternative**: `@react-pdf/renderer` — more control but requires re-implementing all report layouts in react-pdf components, which is significantly more work and would duplicate the existing UI.

#### Install Dependencies

```bash
npm install jspdf html2canvas
npm install -D @types/html2canvas  # if needed
```

#### PDF Generation Logic

**New file**: `src/lib/report-pdf.ts`

```typescript
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

export async function generateReportPDF(
  reportElement: HTMLElement,
  dateRange: { from: string; to: string }
): Promise<void> {
  // 1. Capture the report content area as a canvas
  const canvas = await html2canvas(reportElement, {
    scale: 2,  // Higher resolution
    useCORS: true,
    logging: false,
  });

  // 2. Create PDF (A4: 210mm x 297mm)
  const pdf = new jsPDF("p", "mm", "a4");
  const pageWidth = 210;
  const pageHeight = 297;
  const margin = 15;
  const contentWidth = pageWidth - (margin * 2);

  // 3. Add header
  pdf.setFontSize(16);
  pdf.text("Tokoroa Alpine Club — Reports", margin, margin + 5);
  pdf.setFontSize(10);
  pdf.text(`Date range: ${dateRange.from} to ${dateRange.to}`, margin, margin + 12);
  pdf.text(`Generated: ${new Date().toLocaleDateString("en-NZ")}`, margin, margin + 17);

  // 4. Add report content as image
  const imgData = canvas.toDataURL("image/png");
  const imgWidth = contentWidth;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;

  // Handle multi-page if content is tall
  let yOffset = margin + 22;
  const availableHeight = pageHeight - yOffset - margin;

  if (imgHeight <= availableHeight) {
    pdf.addImage(imgData, "PNG", margin, yOffset, imgWidth, imgHeight);
  } else {
    // Split across pages
    // ... pagination logic
  }

  // 5. Save
  const dateStr = new Date().toISOString().split("T")[0];
  pdf.save(`tac-report-${dateStr}.pdf`);
}
```

#### UI Changes

**File**: `src/app/(admin)/admin/reports/page.tsx`

1. Add a `ref` to the report content area (wrapping summary cards, charts, data sections)
2. Replace the Print button `onClick` from `window.print()` to:
```typescript
const handleDownloadPDF = async () => {
  if (!reportRef.current) return;
  setGeneratingPDF(true);
  try {
    await generateReportPDF(reportRef.current, { from: startDate, to: endDate });
  } finally {
    setGeneratingPDF(false);
  }
};
```
3. Button text: "Download PDF" (with a loading spinner while generating)
4. Keep the existing CSV export button as-is
5. Optionally keep `window.print()` as a secondary "Print" option

#### Report Content Preparation

Before capturing with html2canvas:
- Ensure all charts are fully rendered (recharts may need a moment)
- Hide interactive elements (filter dropdowns, buttons) from the capture area
- Add a CSS class `pdf-capture` to the content area for any PDF-specific styling
- Ensure background colors render (html2canvas needs `backgroundColor` option)

### Key Files

- New: `src/lib/report-pdf.ts` — PDF generation logic
- `src/app/(admin)/admin/reports/page.tsx` — Replace Print button, add ref to content area
- `package.json` — Add jspdf and html2canvas dependencies

### Testing

- Test PDF generates without errors
- Test PDF includes all report sections (summary, charts, tables)
- Test PDF shows correct date range in header
- Test PDF filename includes current date
- Test PDF is properly sized for A4
- Test multi-page PDF works when report content is long
- Test loading state shows while PDF is generating
- Manual test: compare PDF content with on-screen report to verify accuracy
