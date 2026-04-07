# Phase 5a: Cron & Notification High-Priority Fixes

You are fixing 3 high-priority notification/cron issues. Make each change exactly as described.

## Setup

```
git checkout -b fix/phase-5a-cron-high
```

## Change 1 of 3: Add Sentry cron monitoring to 5 jobs

Read `src/instrumentation.ts` lines 85-107 to see the EXISTING Sentry pattern used by `confirm-pending-bookings`:

```typescript
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "confirm-pending-bookings", status: "in_progress" },
        { schedule: { type: "crontab", value: "0 */3 * * *" }, checkinMargin: 10, maxRuntime: 30 }
      );
      // ... try block ...
        Sentry.captureCheckIn({ checkInId, monitorSlug: "confirm-pending-bookings", status: "ok" });
      // ... catch block ...
        Sentry.captureCheckIn({ checkInId, monitorSlug: "confirm-pending-bookings", status: "error" });
```

Now apply this SAME pattern to these 5 cron jobs. Read each section to find the try/catch, then add the 3 Sentry calls (in_progress at start, ok in try, error in catch):

**Job 1: `pending-deadline-alerts`** (lines ~238-262, cron: `"0 8 * * *"`)
- monitorSlug: `"pending-deadline-alerts"`
- schedule value: `"0 8 * * *"`
- maxRuntime: 10

**Job 2: `checkin-reminders`** (lines ~266-290, cron: `"0 9 * * *"`)
- monitorSlug: `"checkin-reminders"`
- schedule value: `"0 9 * * *"`
- maxRuntime: 15

**Job 3: `capacity-warnings`** (lines ~294-318, cron: `"0 7 * * *"`)
- monitorSlug: `"capacity-warnings"`
- schedule value: `"0 7 * * *"`
- maxRuntime: 10

**Job 4: `email-retry`** (lines ~322-346, cron: `"*/30 * * * *"`)
- monitorSlug: `"email-retry"`
- schedule value: `"*/30 * * * *"`
- maxRuntime: 10

**Job 5: `feedback-requests`** (lines ~378-404, cron: `"0 10 * * *"`)
- monitorSlug: `"feedback-requests"`
- schedule value: `"0 10 * * *"`
- maxRuntime: 10

For each job, add BEFORE the try block:

```typescript
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "SLUG_HERE", status: "in_progress" },
        { schedule: { type: "crontab", value: "CRON_HERE" }, checkinMargin: 10, maxRuntime: MAX_HERE }
      );
```

Add at the END of the try block (before catch):

```typescript
        Sentry.captureCheckIn({ checkInId, monitorSlug: "SLUG_HERE", status: "ok" });
```

Add in the catch block (after `Sentry.captureException(err)`):

```typescript
        Sentry.captureCheckIn({ checkInId, monitorSlug: "SLUG_HERE", status: "error" });
```

## Change 2 of 3: Fix EmailLog fire-and-forget error swallowing

Read `src/lib/email.ts` lines 43-120. Find ALL instances of `.catch(() => {})` or `.catch((_err) => {})` related to EmailLog updates. There should be 2-3 instances.

Replace each one with proper error logging. For example, change:

```typescript
.catch(() => {})
```

to:

```typescript
.catch((err) => logger.error({ err, to, templateName }, "Failed to update EmailLog"))
```

Make sure `logger` is imported at the top of the file. Check if it already is — there should be `import logger from "@/lib/logger"` near line 28.

## Change 3 of 3: Fix check-in reminder dedup to only check SENT status

Read `src/lib/cron-checkin-reminders.ts` lines 62-72. You will see:

```typescript
    const alreadySent = await prisma.emailLog.findFirst({
      where: {
        templateName: "checkin-reminder",
        to: booking.member.email,
        subject: "Check-in Reminder - TAC Lodge",
        status: { in: ["SENT", "QUEUED"] },
        createdAt: { gte: new Date(now.getTime() - 48 * 60 * 60 * 1000) },
      },
    });
```

Change the status filter from `{ in: ["SENT", "QUEUED"] }` to just `"SENT"`:

```typescript
    const alreadySent = await prisma.emailLog.findFirst({
      where: {
        templateName: "checkin-reminder",
        to: booking.member.email,
        subject: "Check-in Reminder - TAC Lodge",
        status: "SENT",
        createdAt: { gte: new Date(now.getTime() - 48 * 60 * 60 * 1000) },
      },
    });
```

This ensures that if a previous reminder attempt FAILED or is still QUEUED, the cron job will try again.

## Verify

```bash
npm test
npm run build
```

## Commit

```bash
git add -A
git commit -m "Cron reliability: Sentry monitoring, EmailLog error logging, dedup fix

- H12: Add Sentry cron check-in/out to 5 unmonitored jobs
- H13: Replace silent .catch(() => {}) with error logging on EmailLog updates
- H14: Fix check-in reminder dedup to only skip on SENT status (not QUEUED)"
```
