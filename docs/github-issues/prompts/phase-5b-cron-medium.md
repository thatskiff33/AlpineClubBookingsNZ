# Phase 5b: Cron & Notification Medium/Low Fixes

You are fixing 7 medium/low notification and cron issues. Make each change exactly as described.

## Setup

```
git checkout -b fix/phase-5b-cron-medium
```

## Change 1 of 7: Extract shared NZST date utility

Create a new file `src/lib/nzst-date.ts`:

```typescript
/**
 * Get today's date in Pacific/Auckland timezone as a Date object at midnight UTC.
 * Used by cron jobs that need NZ-local date boundaries.
 */
export function getNZSTToday(): Date {
  const nzFormatter = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = nzFormatter.formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;

  return new Date(`${year}-${month}-${day}T00:00:00`);
}

/**
 * Get tomorrow's date in Pacific/Auckland timezone.
 */
export function getNZSTTomorrow(): Date {
  const today = getNZSTToday();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow;
}
```

Now update 3 files to use this utility:

**File 1:** Read `src/lib/cron-checkin-reminders.ts` lines 12-30. Replace the manual NZST calculation:

```typescript
  // Calculate "tomorrow" in Pacific/Auckland timezone
  const nzFormatter = new Intl.DateTimeFormat("en-NZ", {
    ...
  });
  const now = new Date();
  const parts = nzFormatter.formatToParts(now);
  const year = ...
  const month = ...
  const day = ...
  const todayNZ = new Date(`${year}-${month}-${day}T00:00:00`);
  const tomorrowNZ = new Date(todayNZ);
  tomorrowNZ.setDate(tomorrowNZ.getDate() + 1);
  const dayAfterNZ = new Date(tomorrowNZ);
  dayAfterNZ.setDate(dayAfterNZ.getDate() + 1);
```

with:

```typescript
  import { getNZSTTomorrow } from "./nzst-date";
  // ... (move import to top of file)
  
  const now = new Date();
  const tomorrowNZ = getNZSTTomorrow();
  const dayAfterNZ = new Date(tomorrowNZ);
  dayAfterNZ.setDate(dayAfterNZ.getDate() + 1);
```

Add the import at the top of the file: `import { getNZSTTomorrow } from "./nzst-date";`

**File 2:** Read `src/lib/cron-capacity-warnings.ts` and find the same NZST calculation pattern. Replace it with `import { getNZSTToday } from "./nzst-date"` and use `getNZSTToday()`.

**File 3:** Read `src/lib/cron-feedback-requests.ts` and find the same NZST calculation pattern. Replace it similarly.

## Change 2 of 7: Fix SMTP health check

Read `src/app/api/health/route.ts` lines 86-102. You will see:

```typescript
async function checkSmtp(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const host = process.env.SMTP_HOST;
    const user = process.env.AWS_SES_ACCESS_KEY_ID;
    if (!host || !user) {
      return { status: "error", latencyMs: 0, error: "SMTP not configured" };
    }
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    ...
  }
}
```

Replace with an actual connectivity test using nodemailer's `verify()`:

```typescript
async function checkSmtp(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const host = process.env.SMTP_HOST;
    const user = process.env.AWS_SES_ACCESS_KEY_ID;
    if (!host || !user) {
      return { status: "error", latencyMs: 0, error: "SMTP not configured" };
    }
    // Actually test SMTP connectivity
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.default.createTransport({
      host,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.AWS_SES_ACCESS_KEY_ID || "",
        pass: process.env.AWS_SES_SECRET_ACCESS_KEY || "",
      },
    });
    await transporter.verify();
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: "error",
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
```

## Change 3 of 7: Fix hardcoded capacity in email template

Read `src/lib/email-templates.ts` line 510. You will see:

```typescript
      const pct = Math.round((d.occupiedBeds / 29) * 100);
```

First check if `LODGE_CAPACITY` is exported from `src/lib/capacity.ts`. Read that file and look for a constant like `export const LODGE_CAPACITY = 29`. If it exists, import it. If not, add it there first.

Then change line 510 to:

```typescript
      const pct = Math.round((d.occupiedBeds / LODGE_CAPACITY) * 100);
```

Also search for `29` on line 515 (`${d.occupiedBeds}/29`) and replace:

```typescript
      <td ...>${d.occupiedBeds}/${LODGE_CAPACITY}</td>
```

Add the import at the top of `email-templates.ts`:

```typescript
import { LODGE_CAPACITY } from "./capacity";
```

## Change 4 of 7: Create separate pruning cron job

Read `src/instrumentation.ts` and find where `pruneCronRuns()` and `pruneWebhookLogs()` are called (inside the backup cron, around lines 198-205).

Remove those calls from the backup cron. Then add a new dedicated cron job after the backup cron:

```typescript
    // Data pruning cron (daily at 3:00 AM NZST)
    cron.default.schedule("0 3 * * *", async () => {
      const startedAt = new Date();
      try {
        const { pruneCronRuns } = await import("./lib/cron-job-run");
        const { pruneWebhookLogs } = await import("./lib/webhook-log");
        await pruneCronRuns();
        await pruneWebhookLogs();
        // Prune expired tokens
        await prisma.emailVerificationToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        await prisma.emailChangeToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        await prisma.guestChoreToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        await prisma.passwordResetToken.deleteMany({
          where: { expiresAt: { lt: new Date() }, used: true },
        });
        logger.info({ job: "data-pruning" }, "Data pruning complete");
        await recordCronRun("data-pruning", startedAt, "SUCCESS");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, job: "data-pruning" }, "Error in data pruning");
        Sentry.captureException(err);
        await recordCronRun("data-pruning", startedAt, "FAILURE", undefined, message);
      }
    }, { timezone: "Pacific/Auckland" });

    logger.info({ job: "data-pruning" }, "Scheduled data pruning (daily at 3:00 AM NZST)");
```

Make sure `prisma` is imported at the top of instrumentation.ts. Check if it already is.

## Change 5 of 7: Add kiosk auto-refresh backoff

Read `src/app/(lodge)/lodge/kiosk/page.tsx` and find the auto-refresh `useEffect` and the `fetchData` function. Add a failure counter state:

```typescript
const [failCount, setFailCount] = useState(0);
```

In the `fetchData` function, on success add `setFailCount(0)`. On failure, add `setFailCount((c) => c + 1)`.

Then in the auto-refresh `useEffect`, change the interval to be dynamic:

```typescript
  useEffect(() => {
    const interval = failCount >= 3 ? 300000 : 60000; // 5 min after 3 failures, else 60s
    const timer = setInterval(fetchData, interval);
    return () => clearInterval(timer);
  }, [failCount]);
```

## Change 6 of 7: Add admin alert for exhausted email retries

Read `src/lib/cron-email-retry.ts`. Find where emails that exceed max attempts are skipped. After logging the skip, add an admin alert:

```typescript
    // Alert admin when email exhausts retries
    try {
      const { sendEmail } = await import("./email");
      const admins = await prisma.member.findMany({
        where: { role: "ADMIN", active: true },
        select: { email: true },
      });
      for (const admin of admins) {
        await sendEmail({
          to: admin.email,
          subject: "Email delivery permanently failed",
          html: `<p>Email to ${failedEmail.to} (template: ${failedEmail.templateName}) has failed after ${failedEmail.attempts} attempts and will not be retried.</p>`,
          templateName: "admin-email-failure",
        }).catch(() => {}); // Don't let alert failure break the cron
      }
    } catch {
      // Non-critical
    }
```

Read the file to find the exact location where retries are exhausted (likely where `attempts >= 3` or similar).

## Change 7 of 7: Write test for getNZSTToday utility

Create `src/lib/__tests__/nzst-date.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { getNZSTToday, getNZSTTomorrow } from "../nzst-date";

describe("getNZSTToday", () => {
  it("returns a Date object", () => {
    const today = getNZSTToday();
    expect(today).toBeInstanceOf(Date);
  });

  it("returns midnight (00:00:00)", () => {
    const today = getNZSTToday();
    expect(today.getHours()).toBe(0);
    expect(today.getMinutes()).toBe(0);
    expect(today.getSeconds()).toBe(0);
  });

  it("returns a date not in the future", () => {
    const today = getNZSTToday();
    const now = new Date();
    // Allow 1 day buffer for timezone differences
    expect(today.getTime()).toBeLessThanOrEqual(now.getTime() + 86400000);
  });
});

describe("getNZSTTomorrow", () => {
  it("returns exactly 1 day after getNZSTToday", () => {
    const today = getNZSTToday();
    const tomorrow = getNZSTTomorrow();
    const diffMs = tomorrow.getTime() - today.getTime();
    expect(diffMs).toBe(86400000); // 24 hours in ms
  });
});
```

## Verify

```bash
npm test
npm run build
```

## Commit

```bash
git add -A
git commit -m "Cron medium fixes: NZST utility, SMTP health, pruning, backoff, alerts

- M2: Extract getNZSTToday/getNZSTTomorrow shared utility
- M3: SMTP health check now tests actual connectivity
- M5: Replace hardcoded 29 with LODGE_CAPACITY in email template
- M6/M15: Dedicated daily pruning cron (tokens, webhook logs, cron runs)
- L3: Kiosk auto-refresh backs off to 5min after 3 failures
- L5: Admin alert when email retries exhausted"
```
